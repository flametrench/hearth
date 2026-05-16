"""/app/onboard — atomic agent + org bootstrap (ADR 0013 caller-owned conn).

Mirrors backends/node/src/onboard.ts. Single conn through createUser →
createPasswordCredential → createOrg → createSession.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from flametrench_identity import DuplicateCredentialError
from flametrench_identity.postgres import PostgresIdentityStore
from flametrench_tenancy import OrgSlugConflictError
from flametrench_tenancy.postgres import PostgresTenancyStore
from psycopg_pool import ConnectionPool

_SESSION_TTL_SECONDS = 3600
_SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _validate(body: dict[str, Any]) -> dict[str, Any]:
    display_name = body.get("display_name")
    email = body.get("email")
    password = body.get("password")
    org_name = body.get("org_name")
    org_slug = body.get("org_slug")
    if not isinstance(display_name, str) or not display_name.strip():
        raise HTTPException(400, {"error": {"code": "invalid_request", "message": "display_name is required"}})
    if not isinstance(email, str) or "@" not in email:
        raise HTTPException(400, {"error": {"code": "invalid_request", "message": "email must be an email string"}})
    # Hearth F7 password floor — 12 chars (NIST SP 800-63B floor + adopter discipline).
    if not isinstance(password, str) or len(password) < 12:
        raise HTTPException(400, {"error": {"code": "invalid_request", "message": "password must be a string of at least 12 characters"}})
    if not isinstance(org_name, str) or not org_name.strip():
        raise HTTPException(400, {"error": {"code": "invalid_request", "message": "org_name is required"}})
    if not isinstance(org_slug, str) or not _SLUG_PATTERN.match(org_slug):
        raise HTTPException(400, {"error": {"code": "invalid_request", "message": "org_slug must match ^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"}})
    return {
        "display_name": display_name.strip(),
        "email": email,
        "password": password,
        "org_name": org_name.strip(),
        "org_slug": org_slug,
    }


def build_router(*, pool: ConnectionPool) -> APIRouter:
    router = APIRouter(tags=["onboard"])

    @router.post("/onboard", status_code=201)
    async def onboard(req: Request) -> dict[str, Any]:
        body = _validate(await req.json())

        with pool.connection() as conn:
            with conn.transaction():
                identity_store = PostgresIdentityStore(conn)
                tenancy_store = PostgresTenancyStore(conn)

                try:
                    usr = identity_store.create_user(display_name=body["display_name"])
                    cred = identity_store.create_password_credential(
                        usr.id, body["email"], body["password"]
                    )
                    org_result = tenancy_store.create_org(
                        usr.id, name=body["org_name"], slug=body["org_slug"]
                    )
                    session_result = identity_store.create_session(
                        usr.id, cred.id, _SESSION_TTL_SECONDS
                    )
                except OrgSlugConflictError:
                    raise HTTPException(409, {"error": {"code": "slug_taken", "message": f"Org slug '{body['org_slug']}' is already taken"}})
                except DuplicateCredentialError:
                    raise HTTPException(409, {"error": {"code": "email_taken", "message": f"Email '{body['email']}' already has a credential"}})

        return {
            "usr": {
                "id": usr.id,
                "display_name": body["display_name"],
                "email": body["email"],
            },
            "org": {
                "id": org_result.org.id,
                "name": org_result.org.name,
                "slug": org_result.org.slug,
            },
            "session": {
                "id": session_result.session.id,
                "token": session_result.token,
                "expires_at": session_result.session.expires_at.isoformat(),
            },
        }

    return router
