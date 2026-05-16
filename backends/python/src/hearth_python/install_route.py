"""/app/install + /app/install/status — atomic Hearth bootstrap.

Mirrors backends/node/src/install.ts. ADR 0013 multi-SDK transaction
cooperation: one Postgres connection, BEGIN/advisory-lock/COMMIT, with
PostgresIdentityStore + PostgresTupleStore both constructed against the
same connection so their nested SAVEPOINTs cooperate.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from flametrench_identity.postgres import PostgresIdentityStore
from flametrench_authz.postgres import PostgresTupleStore
from psycopg_pool import ConnectionPool

from .ids import generate_hearth_id, uuid_from_hearth_id

# 0x6865617274686e73 = "hearthns" packed (h-e-a-r-t-h-n-s, 8 ASCII bytes).
# MUST match the Node + PHP backends so the three serialize against the
# same Postgres advisory-lock key.
_HEARTH_INSTALL_ADVISORY_LOCK_KEY = 0x6865617274686E73


def _validate(body: dict[str, Any]) -> dict[str, Any]:
    email = body.get("sysadmin_email")
    password = body.get("sysadmin_password")
    display_name = body.get("sysadmin_display_name")
    mfa_policy = body.get("mfa_policy")
    if not isinstance(email, str) or "@" not in email:
        raise HTTPException(400, {"error": {"code": "invalid_request", "message": "sysadmin_email must be an email string"}})
    if not isinstance(password, str) or len(password) < 8:
        raise HTTPException(400, {"error": {"code": "invalid_request", "message": "sysadmin_password must be a string of at least 8 characters"}})
    if not isinstance(display_name, str) or not display_name:
        raise HTTPException(400, {"error": {"code": "invalid_request", "message": "sysadmin_display_name must be a non-empty string"}})
    if mfa_policy not in ("off", "admins", "all"):
        raise HTTPException(400, {"error": {"code": "invalid_request", "message": "mfa_policy must be one of 'off' | 'admins' | 'all'"}})
    return {
        "sysadmin_email": email,
        "sysadmin_password": password,
        "sysadmin_display_name": display_name,
        "mfa_policy": mfa_policy,
    }


def _is_installed(pool: ConnectionPool) -> bool:
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM inst")
            row = cur.fetchone()
            return bool(row and row[0] > 0)


def build_router(*, pool: ConnectionPool) -> APIRouter:
    router = APIRouter(tags=["install"])

    @router.get("/install/status")
    async def status() -> dict[str, Any]:
        return {"installed": _is_installed(pool)}

    @router.post("/install", status_code=201)
    async def install(req: Request) -> dict[str, Any]:
        body = _validate(await req.json())

        # Cheap pre-check outside the lock for the common-case
        # already-installed response (avoid taking the lock at all).
        if _is_installed(pool):
            raise HTTPException(409, {"error": {"code": "already_installed", "message": "Hearth has already been installed"}})

        with pool.connection() as conn:
            # ADR 0013 caller-owned-connection pattern. psycopg3
            # autocommits per-statement by default outside a transaction;
            # `conn.transaction()` opens a BEGIN/COMMIT scope.
            with conn.transaction():
                with conn.cursor() as cur:
                    # C3 advisory-lock serialization (security-audit-v0.3.md).
                    cur.execute(
                        "SELECT pg_advisory_xact_lock(%s)",
                        (_HEARTH_INSTALL_ADVISORY_LOCK_KEY,),
                    )
                    cur.execute("SELECT EXISTS (SELECT 1 FROM inst)")
                    locked_row = cur.fetchone()
                    if locked_row and locked_row[0]:
                        raise HTTPException(409, {"error": {"code": "already_installed", "message": "Hearth has already been installed"}})

                identity_store = PostgresIdentityStore(conn)
                tuple_store = PostgresTupleStore(conn)

                sysadmin = identity_store.create_user(display_name=body["sysadmin_display_name"])
                identity_store.create_password_credential(
                    sysadmin.id, body["sysadmin_email"], body["sysadmin_password"]
                )

                inst_id = generate_hearth_id("inst")
                with conn.cursor() as cur:
                    cur.execute(
                        "INSERT INTO inst (id, mfa_policy, installed_by) VALUES (%s, %s, %s)",
                        (uuid_from_hearth_id(inst_id), body["mfa_policy"], uuid_from_hearth_id(sysadmin.id)),
                    )

                tuple_store.create_tuple(
                    subject_type="usr",
                    subject_id=sysadmin.id,
                    relation="sysadmin",
                    object_type="inst",
                    object_id=inst_id,
                    created_by=sysadmin.id,
                )

        return {
            "inst": {"id": inst_id, "mfa_policy": body["mfa_policy"]},
            "sysadmin": {
                "id": sysadmin.id,
                "email": body["sysadmin_email"],
                "display_name": body["sysadmin_display_name"],
            },
        }

    return router
