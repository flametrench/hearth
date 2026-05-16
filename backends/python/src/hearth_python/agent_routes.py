"""Agent flow — session-bearer authenticated.

Mirrors backends/node/src/agent.ts. All DB work uses the request-scoped
conn from `stores.conn` — don't acquire a second `pool.connection()`
inside the same async handler (event-loop deadlock risk).
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from flametrench_authz import (
    DuplicateTupleError,
    ShareNotFoundError,
)

from .auth_deps import VerifiedSession, session_bearer
from .email_ import Mailer
from .ids import (
    generate_hearth_id,
    uuid_from_hearth_id,
    uuid_to_wire,
)
from .stores import RequestStores, get_stores

_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60
_ORG_ROLE_RELATIONS = ["owner", "admin", "member"]
_ORG_ADMIN_RELATIONS = ["owner", "admin"]


def _serialize_ticket(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": uuid_to_wire("ticket", row["id"]),
        "org_id": uuid_to_wire("org", row["org_id"]),
        "customer_email": row["customer_email"],
        "subject": row["subject"],
        "body": row["body"],
        "status": row["status"],
        "resolved_at": row["resolved_at"].isoformat() if row.get("resolved_at") else None,
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


def _serialize_comment(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": uuid_to_wire("comment", row["id"]),
        "ticket_id": uuid_to_wire("ticket", row["ticket_id"]),
        "source": row["source"],
        "author_usr_id": uuid_to_wire("usr", row["author_usr_id"]) if row.get("author_usr_id") else None,
        "body": row["body"],
        "created_at": row["created_at"].isoformat(),
    }


def _serialize_share(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": uuid_to_wire("shr", row["id"]),
        "expires_at": row["expires_at"].isoformat() if row.get("expires_at") else None,
        "revoked_at": row["revoked_at"].isoformat() if row.get("revoked_at") else None,
        "consumed_at": row["consumed_at"].isoformat() if row.get("consumed_at") else None,
    }


def _load_ticket(conn, ticket_uuid: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id::text AS id, org_id::text AS org_id, customer_email, subject, body, status, resolved_at, created_at, updated_at FROM ticket WHERE id = %s",
            (ticket_uuid,),
        )
        cols = [d[0] for d in cur.description or []]
        row = cur.fetchone()
        return dict(zip(cols, row)) if row else None


def _find_org_by_slug(conn, slug: str) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute("SELECT id::text, name, slug FROM org WHERE slug = %s AND status = 'active'", (slug,))
        row = cur.fetchone()
        if row is None:
            return None
        return {"id": uuid_to_wire("org", row[0]), "uuid": row[0], "name": row[1], "slug": row[2]}


def _check_org_role(stores: RequestStores, usr_id: str, org_id: str, relations: list[str]) -> bool:
    result = stores.tuples.check_any(
        subject_type="usr",
        subject_id=usr_id,
        relations=relations,
        object_type="org",
        object_id=org_id,
    )
    return result.allowed


def build_router(*, mailer: Mailer) -> APIRouter:
    router = APIRouter(tags=["agent"])

    @router.get("/orgs/{slug}/tickets")
    async def inbox(
        slug: str = Path(...),
        status: str | None = Query(default=None),
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        org = _find_org_by_slug(stores.conn, slug)
        if not org:
            raise HTTPException(404, {"error": {"code": "org_not_found", "message": "Org not found"}})
        if not _check_org_role(stores, session.usr_id, org["id"], _ORG_ROLE_RELATIONS):
            raise HTTPException(403, {"error": {"code": "forbidden", "message": "Not a member of this org"}})

        filter_all = not status or status == "all"
        if not filter_all and status not in ("open", "pending", "resolved"):
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "status must be one of all|open|pending|resolved"}})

        with stores.conn.cursor() as cur:
            if filter_all:
                cur.execute(
                    "SELECT id::text AS id, org_id::text AS org_id, customer_email, subject, body, status, resolved_at, created_at, updated_at FROM ticket WHERE org_id = %s ORDER BY updated_at DESC LIMIT 50",
                    (org["uuid"],),
                )
            else:
                cur.execute(
                    "SELECT id::text AS id, org_id::text AS org_id, customer_email, subject, body, status, resolved_at, created_at, updated_at FROM ticket WHERE org_id = %s AND status = %s ORDER BY updated_at DESC LIMIT 50",
                    (org["uuid"], status),
                )
            cols = [d[0] for d in cur.description or []]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]

        return {
            "tickets": [_serialize_ticket(r) for r in rows],
            "org": {"id": org["id"], "name": org["name"], "slug": org["slug"]},
        }

    @router.get("/tickets/{ticket_id}")
    async def ticket_detail(
        ticket_id: str = Path(...),
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        ticket_uuid = uuid_from_hearth_id(ticket_id)
        ticket = _load_ticket(stores.conn, ticket_uuid)
        if not ticket:
            raise HTTPException(404, {"error": {"code": "ticket_not_found", "message": "Ticket not found"}})
        org_wire = uuid_to_wire("org", ticket["org_id"])
        if not _check_org_role(stores, session.usr_id, org_wire, _ORG_ROLE_RELATIONS):
            raise HTTPException(403, {"error": {"code": "forbidden", "message": "Not a member of this ticket's org"}})
        with stores.conn.cursor() as cur:
            cur.execute(
                "SELECT id::text AS id, ticket_id::text AS ticket_id, source, author_usr_id::text AS author_usr_id, body, created_at FROM comment WHERE ticket_id = %s ORDER BY created_at ASC",
                (ticket_uuid,),
            )
            ccols = [d[0] for d in cur.description or []]
            comments = [dict(zip(ccols, r)) for r in cur.fetchall()]
            cur.execute(
                "SELECT id::text AS id, expires_at, revoked_at, consumed_at FROM shr WHERE object_type = 'ticket' AND object_id = %s ORDER BY created_at DESC",
                (ticket_uuid,),
            )
            scols = [d[0] for d in cur.description or []]
            shares = [dict(zip(scols, r)) for r in cur.fetchall()]
        return {
            "ticket": _serialize_ticket(ticket),
            "comments": [_serialize_comment(c) for c in comments],
            "shares": [_serialize_share(s) for s in shares],
        }

    @router.post("/tickets/{ticket_id}/comment", status_code=201)
    async def post_comment(
        req: Request,
        ticket_id: str = Path(...),
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        body = await req.json()
        comment_body = body.get("body")
        if not isinstance(comment_body, str) or not comment_body.strip():
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "body is required"}})
        if len(comment_body) > 20_000:
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "body must be 20000 characters or fewer"}})
        trimmed = comment_body.strip()

        ticket_uuid = uuid_from_hearth_id(ticket_id)
        ticket = _load_ticket(stores.conn, ticket_uuid)
        if not ticket:
            raise HTTPException(404, {"error": {"code": "ticket_not_found", "message": "Ticket not found"}})
        org_wire = uuid_to_wire("org", ticket["org_id"])
        if not _check_org_role(stores, session.usr_id, org_wire, _ORG_ROLE_RELATIONS):
            raise HTTPException(403, {"error": {"code": "forbidden", "message": "Not a member of this ticket's org"}})

        comment_wire_id = generate_hearth_id("comment")
        comment_uuid = uuid_from_hearth_id(comment_wire_id)

        with stores.conn.transaction():
            with stores.conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO comment (id, ticket_id, source, author_usr_id, body) VALUES (%s, %s, 'agent', %s, %s)",
                    (comment_uuid, ticket_uuid, uuid_from_hearth_id(session.usr_id), trimmed),
                )
                cur.execute(
                    "UPDATE ticket SET status = CASE WHEN status = 'open' THEN 'pending' ELSE status END, updated_at = now() WHERE id = %s",
                    (ticket_uuid,),
                )

        refreshed = _load_ticket(stores.conn, ticket_uuid)
        return {
            "comment": {
                "id": comment_wire_id,
                "ticket_id": ticket_id,
                "source": "agent",
                "author_usr_id": session.usr_id,
                "body": trimmed,
            },
            "ticket": _serialize_ticket(refreshed) if refreshed else None,
        }

    @router.post("/tickets/{ticket_id}/assign")
    async def assign(
        req: Request,
        ticket_id: str = Path(...),
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        body = await req.json()
        assignee_wire = body.get("assignee_usr_id")
        if not isinstance(assignee_wire, str) or not assignee_wire.startswith("usr_"):
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "assignee_usr_id must be a usr_<32hex> id"}})
        ticket_uuid = uuid_from_hearth_id(ticket_id)
        ticket = _load_ticket(stores.conn, ticket_uuid)
        if not ticket:
            raise HTTPException(404, {"error": {"code": "ticket_not_found", "message": "Ticket not found"}})
        org_wire = uuid_to_wire("org", ticket["org_id"])
        if not _check_org_role(stores, session.usr_id, org_wire, _ORG_ROLE_RELATIONS):
            raise HTTPException(403, {"error": {"code": "forbidden", "message": "Not a member of this ticket's org"}})
        if not _check_org_role(stores, assignee_wire, org_wire, _ORG_ROLE_RELATIONS):
            raise HTTPException(400, {"error": {"code": "invalid_assignee", "message": "Assignee is not a member of this org"}})

        try:
            stores.tuples.create_tuple(
                subject_type="usr",
                subject_id=assignee_wire,
                relation="assignee",
                object_type="ticket",
                object_id=ticket_id,
                created_by=session.usr_id,
            )
        except DuplicateTupleError:
            pass  # idempotent

        with stores.conn.cursor() as cur:
            cur.execute("UPDATE ticket SET updated_at = now() WHERE id = %s", (ticket_uuid,))

        refreshed = _load_ticket(stores.conn, ticket_uuid)
        return {
            "assignment": {"ticket_id": ticket_id, "assignee_usr_id": assignee_wire, "relation": "assignee"},
            "ticket": _serialize_ticket(refreshed) if refreshed else None,
        }

    async def _set_status(
        ticket_id: str,
        new_status: str,
        resolved_at_sql: str,
        session: VerifiedSession,
        stores: RequestStores,
    ) -> dict[str, Any]:
        ticket_uuid = uuid_from_hearth_id(ticket_id)
        ticket = _load_ticket(stores.conn, ticket_uuid)
        if not ticket:
            raise HTTPException(404, {"error": {"code": "ticket_not_found", "message": "Ticket not found"}})
        org_wire = uuid_to_wire("org", ticket["org_id"])
        if not _check_org_role(stores, session.usr_id, org_wire, _ORG_ROLE_RELATIONS):
            raise HTTPException(403, {"error": {"code": "forbidden", "message": "Not a member of this ticket's org"}})
        with stores.conn.cursor() as cur:
            cur.execute(
                f"UPDATE ticket SET status = %s, resolved_at = {resolved_at_sql}, updated_at = now() WHERE id = %s RETURNING id::text AS id, org_id::text AS org_id, customer_email, subject, body, status, resolved_at, created_at, updated_at",
                (new_status, ticket_uuid),
            )
            cols = [d[0] for d in cur.description or []]
            row = cur.fetchone()
            if row is None:
                raise HTTPException(404, {"error": {"code": "ticket_not_found", "message": "Ticket not found"}})
            result_row = dict(zip(cols, row))
        return {"ticket": _serialize_ticket(result_row)}

    @router.post("/tickets/{ticket_id}/resolve")
    async def resolve(
        ticket_id: str = Path(...),
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        return await _set_status(ticket_id, "resolved", "now()", session, stores)

    @router.post("/tickets/{ticket_id}/reopen")
    async def reopen(
        ticket_id: str = Path(...),
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        return await _set_status(ticket_id, "open", "NULL", session, stores)

    @router.post("/tickets/{ticket_id}/share", status_code=201)
    async def mint_share(
        req: Request,
        ticket_id: str = Path(...),
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        body = await _maybe_json(req)
        ticket_uuid = uuid_from_hearth_id(ticket_id)
        ticket = _load_ticket(stores.conn, ticket_uuid)
        if not ticket:
            raise HTTPException(404, {"error": {"code": "ticket_not_found", "message": "Ticket not found"}})
        org_wire = uuid_to_wire("org", ticket["org_id"])
        if not _check_org_role(stores, session.usr_id, org_wire, _ORG_ADMIN_RELATIONS):
            raise HTTPException(403, {"error": {"code": "forbidden", "message": "Only org admins can mint share tokens"}})

        result = stores.shares.create_share(
            object_type="ticket",
            object_id=ticket_id,
            relation="commenter",
            created_by=session.usr_id,
            expires_in_seconds=_SHARE_TTL_SECONDS,
        )

        if body.get("resend_email") is not False:
            with stores.conn.cursor() as cur:
                cur.execute("SELECT name, slug FROM org WHERE id = %s", (ticket["org_id"],))
                org_row = cur.fetchone()
            org_name = (org_row[0] or org_row[1] or "support") if org_row else "support"
            mailer.send_share_link_email(
                to=ticket["customer_email"],
                org_name=org_name,
                ticket_subject=ticket["subject"],
                share_token=result.token,
            )

        return {
            "share": {"id": result.share.id, "expires_at": result.share.expires_at.isoformat()},
            "share_url": mailer.share_url(result.token),
        }

    @router.post("/orgs/{org_id}/settings")
    async def org_settings(
        req: Request,
        org_id: str = Path(...),
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        if not org_id.startswith("org_"):
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "Path must be an org_<32hex> id"}})
        if not _check_org_role(stores, session.usr_id, org_id, _ORG_ADMIN_RELATIONS):
            raise HTTPException(403, {"error": {"code": "forbidden", "message": "Only org admins can update settings"}})
        body = await _maybe_json(req)

        kwargs: dict[str, Any] = {}
        if "name" in body:
            kwargs["name"] = body["name"]
        if "slug" in body:
            kwargs["slug"] = body["slug"]
        updated = stores.tenancy.update_org(org_id, **kwargs)
        return {
            "org": {
                "id": updated.id,
                "name": updated.name,
                "slug": updated.slug,
                "status": updated.status.value,
            }
        }

    @router.post("/shares/{shr_id}/revoke")
    async def revoke_share(
        shr_id: str = Path(...),
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        if not shr_id.startswith("shr_"):
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "Path must be a shr_<32hex> id"}})
        try:
            share = stores.shares.get_share(shr_id)
        except ShareNotFoundError:
            raise HTTPException(404, {"error": {"code": "share_not_found", "message": "Share not found"}})
        if share.object_type != "ticket":
            raise HTTPException(400, {"error": {"code": "wrong_resource", "message": "Share does not reference a ticket"}})
        ticket_uuid = (
            share.object_id
            if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", share.object_id)
            else uuid_from_hearth_id(share.object_id)
        )
        ticket = _load_ticket(stores.conn, ticket_uuid)
        if not ticket:
            raise HTTPException(404, {"error": {"code": "ticket_not_found", "message": "Ticket no longer exists"}})
        org_wire = uuid_to_wire("org", ticket["org_id"])
        if not _check_org_role(stores, session.usr_id, org_wire, _ORG_ADMIN_RELATIONS):
            raise HTTPException(403, {"error": {"code": "forbidden", "message": "Only org admins can revoke shares"}})
        revoked = stores.shares.revoke_share(shr_id)
        return {
            "share": {
                "id": revoked.id,
                "revoked_at": revoked.revoked_at.isoformat() if revoked.revoked_at else None,
                "expires_at": revoked.expires_at.isoformat() if revoked.expires_at else None,
            }
        }

    return router


async def _maybe_json(req: Request) -> dict[str, Any]:
    raw = await req.body()
    if not raw:
        return {}
    import json
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}
