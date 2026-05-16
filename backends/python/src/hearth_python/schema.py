from __future__ import annotations

from pathlib import Path

from psycopg_pool import ConnectionPool

# __file__ → .../hearth/backends/python/src/hearth_python/schema.py
# parents[4] → .../hearth/
_SQL_DIR = Path(__file__).resolve().parents[4] / "shared" / "sql"


def _table_exists(pool: ConnectionPool, name: str) -> bool:
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = current_schema() AND table_name = %s
                )
                """,
                (name,),
            )
            row = cur.fetchone()
            return bool(row and row[0])


def _apply_file(pool: ConnectionPool, filename: str) -> None:
    sql = (_SQL_DIR / filename).read_text(encoding="utf-8")
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)


def ensure_schema(pool: ConnectionPool) -> None:
    if not _table_exists(pool, "usr"):
        _apply_file(pool, "flametrench-schema.sql")
    if not _table_exists(pool, "ticket"):
        _apply_file(pool, "hearth-schema.sql")
