"""FastAPI dependencies for share-bearer and session-bearer auth.

Mirrors the Node `share-auth.ts` + `@flametrench/server`'s `buildBearerAuthHook`.
Stores are acquired per-request via `stores.get_stores` so each verification
runs against a fresh connection from the pool.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, Request
from flametrench_authz import (
    InvalidShareTokenError,
    ShareConsumedError,
    ShareExpiredError,
    ShareNotFoundError,
    ShareRevokedError,
    VerifiedShare,
)

from .stores import RequestStores, get_stores


def _extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=401,
            detail={"error": {"code": "unauthenticated", "message": "Missing or malformed Authorization header"}},
        )
    return authorization[len("bearer ") :].strip()


def share_bearer(
    request: Request,
    authorization: str | None = Header(default=None),
    stores: RequestStores = Depends(get_stores),
) -> VerifiedShare:
    token = _extract_bearer(authorization)
    try:
        verified = stores.shares.verify_share_token(token)
    except (
        InvalidShareTokenError,
        ShareNotFoundError,
        ShareExpiredError,
        ShareRevokedError,
        ShareConsumedError,
    ):
        raise HTTPException(
            status_code=401,
            detail={
                "error": {
                    "code": "invalid_share_token",
                    "message": "Share token is invalid, expired, or revoked",
                }
            },
        )
    request.state.verified_share = verified
    return verified


@dataclass(frozen=True)
class VerifiedSession:
    usr_id: str
    cred_id: str
    ses_id: str


def session_bearer(
    request: Request,
    authorization: str | None = Header(default=None),
    stores: RequestStores = Depends(get_stores),
) -> VerifiedSession:
    token = _extract_bearer(authorization)
    try:
        session = stores.identity.verify_session_token(token)
    except Exception:
        raise HTTPException(
            status_code=401,
            detail={"error": {"code": "invalid_session", "message": "Session token is invalid, expired, or revoked"}},
        )
    if session.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(
            status_code=401,
            detail={"error": {"code": "session_expired", "message": "Session has expired"}},
        )
    verified = VerifiedSession(usr_id=session.usr_id, cred_id=session.cred_id, ses_id=session.id)
    request.state.verified_session = verified
    return verified
