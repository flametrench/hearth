from __future__ import annotations

from typing import Any

import psycopg
from psycopg_pool import ConnectionPool


def _configure_conn(conn: psycopg.Connection) -> None:
    """Per-connection setup applied by the pool when each conn is created.

    Setting autocommit=True is critical: with the default autocommit=False,
    psycopg3 starts an implicit transaction on the first execute. When the
    Flametrench SDK then enters its own `conn.transaction()`, psycopg
    treats it as nested (SAVEPOINT/RELEASE) and the outer implicit txn
    is left open after the SDK call completes — leaving the connection
    "idle in transaction" and the row work uncommitted.

    With autocommit=True, every bare statement auto-commits; explicit
    transactions only exist when a caller wraps a `conn.transaction()`
    block, which is exactly when the SDK and our caller-owned (ADR 0013)
    install / onboard handlers want them.
    """
    conn.autocommit = True


def create_pool(database_url: str) -> ConnectionPool:
    pool = ConnectionPool(
        conninfo=database_url,
        min_size=1,
        max_size=10,
        open=False,
        configure=_configure_conn,
    )
    pool.open()
    pool.wait()
    return pool


def fetchone(pool: ConnectionPool, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    with pool.connection() as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchone()


def fetchall(pool: ConnectionPool, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with pool.connection() as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchall()


def execute(pool: ConnectionPool, sql: str, params: tuple[Any, ...] = ()) -> None:
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
