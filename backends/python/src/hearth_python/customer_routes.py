"""/app/tickets/submit (public), /app/customer/ticket, /app/customer/comment.

Customer flow — share-bearer authenticated. All DB work runs on the
request-scoped conn from `get_stores` — acquiring a second conn from
the pool inside the same async handler can deadlock the event loop.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from flametrench_authz import VerifiedShare

from .auth_deps import share_bearer
from .email_ import Mailer
from .ids import (
    generate_hearth_id,
    normalize_object_id_to_uuid,
    uuid_from_hearth_id,
    uuid_to_wire,
)
from .stores import RequestStores, get_stores

_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60


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


def _find_org_by_slug_conn(conn, slug: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id::text, name, slug FROM org WHERE slug = %s AND status = 'active'",
            (slug,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        uuid_, name, slug_ = row
        return {"id": uuid_to_wire("org", uuid_), "uuid": uuid_, "name": name, "slug": slug_}


def _list_org_admin_emails_conn(conn, org_uuid: str) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT cred.identifier
              FROM mem
              JOIN cred ON cred.usr_id = mem.usr_id
             WHERE mem.org_id = %s
               AND mem.status = 'active'
               AND mem.role IN ('owner', 'admin')
               AND cred.status = 'active'
               AND cred.type = 'password'
            """,
            (org_uuid,),
        )
        return [r[0] for r in cur.fetchall()]


def _get_installed_by_conn(conn) -> str | None:
    with conn.cursor() as cur:
        cur.execute("SELECT installed_by::text FROM inst LIMIT 1")
        row = cur.fetchone()
        return row[0] if row else None


def build_router(*, mailer: Mailer) -> APIRouter:
    router = APIRouter(tags=["customer"])

    @router.post("/tickets/submit", status_code=201)
    async def submit(
        req: Request,
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        body = await req.json()
        org_slug = body.get("org_slug")
        customer_email = body.get("customer_email")
        subject = body.get("subject")
        body_text = body.get("body")
        if not isinstance(org_slug, str) or not org_slug:
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "org_slug is required"}})
        if not isinstance(customer_email, str) or "@" not in customer_email:
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "customer_email must be an email string"}})
        if not isinstance(subject, str) or not subject.strip():
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "subject is required"}})
        if not isinstance(body_text, str) or not body_text.strip():
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "body is required"}})
        if len(subject) > 200:
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "subject must be 200 characters or fewer"}})
        if len(body_text) > 20_000:
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "body must be 20000 characters or fewer"}})
        subject = subject.strip()
        body_text = body_text.strip()

        org = _find_org_by_slug_conn(stores.conn, org_slug)
        if not org:
            raise HTTPException(404, {"error": {"code": "org_not_found", "message": f"No active org with slug '{org_slug}'"}})

        installed_by = _get_installed_by_conn(stores.conn)
        if not installed_by:
            raise HTTPException(409, {"error": {"code": "not_installed", "message": "Hearth is not installed yet"}})
        sysadmin_wire_id = uuid_to_wire("usr", installed_by)

        ticket_wire_id = generate_hearth_id("ticket")
        ticket_uuid = uuid_from_hearth_id(ticket_wire_id)

        with stores.conn.transaction():
            with stores.conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO ticket (id, org_id, customer_email, subject, body) VALUES (%s, %s, %s, %s, %s)",
                    (ticket_uuid, org["uuid"], customer_email, subject, body_text),
                )

        # C2: relation 'commenter' (BOTH read AND write).
        result = stores.shares.create_share(
            object_type="ticket",
            object_id=ticket_wire_id,
            relation="commenter",
            created_by=sysadmin_wire_id,
            expires_in_seconds=_SHARE_TTL_SECONDS,
        )

        mailer.send_share_link_email(
            to=customer_email,
            org_name=org["name"] or org["slug"] or "support",
            ticket_subject=subject,
            share_token=result.token,
        )

        return {
            "ticket": {"id": ticket_wire_id, "status": "open"},
            "share": {"id": result.share.id, "expires_at": result.share.expires_at.isoformat()},
            "share_url": mailer.share_url(result.token),
        }

    @router.get("/customer/ticket")
    async def view_ticket(
        verified: VerifiedShare = Depends(share_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        if verified.object_type != "ticket":
            raise HTTPException(403, {"error": {"code": "wrong_resource", "message": "Share does not authorize a ticket view"}})
        if verified.relation != "commenter":
            raise HTTPException(403, {"error": {"code": "wrong_relation", "message": "Share does not authorize ticket access"}})
        ticket_uuid = normalize_object_id_to_uuid(verified.object_id)

        with stores.conn.cursor() as cur:
            cur.execute(
                "SELECT id::text AS id, org_id::text AS org_id, customer_email, subject, body, status, resolved_at, created_at, updated_at FROM ticket WHERE id = %s",
                (ticket_uuid,),
            )
            cols = [d[0] for d in cur.description or []]
            t = cur.fetchone()
            if t is None:
                raise HTTPException(404, {"error": {"code": "ticket_not_found", "message": "Ticket no longer exists"}})
            ticket = dict(zip(cols, t))

            cur.execute(
                "SELECT id::text AS id, ticket_id::text AS ticket_id, source, author_usr_id::text AS author_usr_id, body, created_at FROM comment WHERE ticket_id = %s ORDER BY created_at ASC",
                (ticket_uuid,),
            )
            ccols = [d[0] for d in cur.description or []]
            comments = [dict(zip(ccols, r)) for r in cur.fetchall()]

        return {
            "ticket": _serialize_ticket(ticket),
            "comments": [_serialize_comment(c) for c in comments],
        }

    @router.post("/customer/comment", status_code=201)
    async def post_comment(
        req: Request,
        verified: VerifiedShare = Depends(share_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        body = await req.json()
        comment_body = body.get("body")
        if not isinstance(comment_body, str) or not comment_body.strip():
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "body is required"}})
        if len(comment_body) > 20_000:
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "body must be 20000 characters or fewer"}})
        comment_body = comment_body.strip()

        if verified.object_type != "ticket":
            raise HTTPException(403, {"error": {"code": "wrong_resource", "message": "Share does not authorize a ticket reply"}})
        if verified.relation != "commenter":
            raise HTTPException(403, {"error": {"code": "wrong_relation", "message": "Share does not authorize a ticket reply"}})

        ticket_uuid = normalize_object_id_to_uuid(verified.object_id)

        saved_comment: dict[str, Any]
        ticket_after: dict[str, Any]
        with stores.conn.transaction():
            with stores.conn.cursor() as cur:
                cur.execute(
                    "SELECT status, org_id::text, customer_email, subject FROM ticket WHERE id = %s FOR UPDATE",
                    (ticket_uuid,),
                )
                row = cur.fetchone()
                if row is None:
                    raise HTTPException(404, {"error": {"code": "ticket_not_found", "message": "Ticket no longer exists"}})
                status_, _org_id, _customer_email, _subject = row
                was_resolved = status_ == "resolved"

                comment_wire_id = generate_hearth_id("comment")
                comment_uuid = uuid_from_hearth_id(comment_wire_id)
                cur.execute(
                    "INSERT INTO comment (id, ticket_id, source, author_usr_id, body) VALUES (%s, %s, 'customer', NULL, %s) RETURNING id::text, ticket_id::text, source, author_usr_id::text, body, created_at",
                    (comment_uuid, ticket_uuid, comment_body),
                )
                c = cur.fetchone()
                saved_comment = {
                    "id": c[0], "ticket_id": c[1], "source": c[2],
                    "author_usr_id": c[3], "body": c[4], "created_at": c[5],
                }

                new_status = "open" if was_resolved else status_
                cur.execute(
                    """
                    UPDATE ticket
                       SET status = %s,
                           resolved_at = CASE WHEN %s = 'resolved' THEN resolved_at ELSE NULL END,
                           updated_at = now()
                     WHERE id = %s
                     RETURNING id::text, org_id::text, customer_email, subject, body, status, resolved_at, created_at, updated_at
                    """,
                    (new_status, new_status, ticket_uuid),
                )
                t = cur.fetchone()
                ticket_after = {
                    "id": t[0], "org_id": t[1], "customer_email": t[2], "subject": t[3],
                    "body": t[4], "status": t[5], "resolved_at": t[6],
                    "created_at": t[7], "updated_at": t[8],
                }

        reopened = was_resolved
        admin_emails = _list_org_admin_emails_conn(stores.conn, ticket_after["org_id"])
        with stores.conn.cursor() as cur:
            cur.execute("SELECT name, slug FROM org WHERE id = %s", (ticket_after["org_id"],))
            org_row = cur.fetchone()
        org_name = (org_row[0] or org_row[1] or "support") if org_row else "support"

        mailer.send_customer_reply_notification(
            to=admin_emails,
            org_name=org_name,
            ticket_subject=ticket_after["subject"],
            customer_email=ticket_after["customer_email"],
            reopened=reopened,
        )

        return {
            "comment": _serialize_comment(saved_comment),
            "ticket": _serialize_ticket(ticket_after),
            "reopened": reopened,
        }

    return router
