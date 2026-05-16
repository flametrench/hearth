from __future__ import annotations

from dataclasses import dataclass

from psycopg_pool import ConnectionPool

from .ids import uuid_to_wire


@dataclass(frozen=True)
class OrgRecord:
    id: str
    uuid: str
    name: str | None
    slug: str | None


def find_org_by_slug(pool: ConnectionPool, slug: str) -> OrgRecord | None:
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id::text, name, slug FROM org WHERE slug = %s AND status = 'active'",
                (slug,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            uuid_, name, slug_ = row
            return OrgRecord(id=uuid_to_wire("org", uuid_), uuid=uuid_, name=name, slug=slug_)


def list_org_admin_emails(pool: ConnectionPool, org_uuid: str) -> list[str]:
    with pool.connection() as conn:
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


def get_installed_by_uuid(pool: ConnectionPool) -> str | None:
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT installed_by::text FROM inst LIMIT 1")
            row = cur.fetchone()
            return row[0] if row else None
