"""Hand-rolled v0.1 + v0.2 spec subset the Hearth SPA hits.

Mirrors backends/php/app/Http/Controllers/SpecController.php. The Node
backend gets these for free via `@flametrench/server`; Python + PHP both
hand-roll them.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from flametrench_identity import (
    DuplicateCredentialError,
    InvalidCredentialError,
    NotFoundError,
)
from flametrench_tenancy import OrgSlugConflictError

from .auth_deps import VerifiedSession, session_bearer
from .stores import RequestStores, get_stores


def build_router() -> APIRouter:
    router = APIRouter(prefix="/v1", tags=["spec"])

    @router.post("/users", status_code=201)
    async def create_user(req: Request, stores: RequestStores = Depends(get_stores)) -> dict[str, Any]:
        body = await req.json()
        display_name = body.get("display_name")
        user = stores.identity.create_user(display_name=display_name)
        return {
            "id": user.id,
            "status": user.status.value,
            "displayName": user.display_name,
            "createdAt": user.created_at.isoformat(),
            "updatedAt": user.updated_at.isoformat(),
        }

    @router.post("/credentials", status_code=201)
    async def create_credential(req: Request, stores: RequestStores = Depends(get_stores)) -> dict[str, Any]:
        body = await req.json()
        usr_id = body.get("usr_id")
        type_ = body.get("type")
        identifier = body.get("identifier")
        password = body.get("password")
        if type_ != "password":
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "only password credentials supported"}})
        if not isinstance(usr_id, str) or not isinstance(identifier, str) or not isinstance(password, str):
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "usr_id, identifier, password required"}})
        try:
            cred = stores.identity.create_password_credential(usr_id, identifier, password)
        except DuplicateCredentialError as exc:
            raise HTTPException(409, {"error": {"code": "duplicate_credential", "message": str(exc)}})
        return {
            "id": cred.id,
            "usrId": cred.usr_id,
            "type": "password",
            "identifier": cred.identifier,
            "status": cred.status.value,
        }

    @router.post("/credentials/verify")
    async def verify_credential(req: Request, stores: RequestStores = Depends(get_stores)) -> dict[str, Any]:
        body = await req.json()
        type_ = body.get("type")
        identifier = body.get("identifier")
        proof = body.get("proof") or {}
        password = proof.get("password") if isinstance(proof, dict) else None
        if type_ != "password" or not isinstance(identifier, str) or not isinstance(password, str):
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "type=password + identifier + proof.password required"}})
        try:
            verified = stores.identity.verify_password(identifier, password)
        except (InvalidCredentialError, NotFoundError):
            raise HTTPException(401, {"error": {"code": "invalid_credential", "message": "Identifier or password did not verify"}})
        return {"usr_id": verified.usr_id, "cred_id": verified.cred_id}

    @router.post("/sessions", status_code=201)
    async def create_session(req: Request, stores: RequestStores = Depends(get_stores)) -> dict[str, Any]:
        body = await req.json()
        usr_id = body.get("usr_id")
        cred_id = body.get("cred_id")
        ttl_seconds = body.get("ttl_seconds")
        if not isinstance(usr_id, str) or not isinstance(cred_id, str) or not isinstance(ttl_seconds, int):
            raise HTTPException(400, {"error": {"code": "invalid_request", "message": "usr_id, cred_id, ttl_seconds required"}})
        result = stores.identity.create_session(usr_id, cred_id, ttl_seconds)
        s = result.session
        # Mirror Node `@flametrench/server` + PHP SpecController shape:
        # { session: { id, usrId, credId, createdAt, expiresAt, revokedAt? }, token }
        return {
            "session": {
                "id": s.id,
                "usrId": s.usr_id,
                "credId": s.cred_id,
                "createdAt": s.created_at.isoformat(),
                "expiresAt": s.expires_at.isoformat(),
                "revokedAt": s.revoked_at.isoformat() if s.revoked_at else None,
            },
            "token": result.token,
        }

    @router.post("/orgs", status_code=201)
    async def create_org(
        req: Request,
        session: VerifiedSession = Depends(session_bearer),
        stores: RequestStores = Depends(get_stores),
    ) -> dict[str, Any]:
        try:
            result = stores.tenancy.create_org(session.usr_id)
        except OrgSlugConflictError as exc:
            raise HTTPException(409, {"error": {"code": "slug_taken", "message": str(exc)}})
        org = result.org
        return {
            "org": {
                "id": org.id,
                "name": org.name,
                "slug": org.slug,
                "status": org.status.value,
                "createdAt": org.created_at.isoformat(),
                "updatedAt": org.updated_at.isoformat(),
            }
        }

    return router
