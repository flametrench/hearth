"""Per-request Flametrench store factory.

The Python SDK stores take a single psycopg3 Connection, not a ConnectionPool —
unlike the Node SDK which accepts either. To preserve the request-scoped
connection model the SDK expects, each route acquires a connection from the
shared pool via FastAPI's Depends mechanism, constructs the stores against it,
and the dependency's teardown returns the connection at request end.

The install + onboard routes opt out of this — they construct stores against
a manually-acquired connection inside a single `pool.connection()` + `.transaction()`
block (ADR 0013 caller-owned pattern). See install_route.py / onboard_route.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

from fastapi import Depends, Request
from flametrench_authz.postgres import PostgresShareStore, PostgresTupleStore
from flametrench_identity.postgres import PostgresIdentityStore
from flametrench_tenancy.postgres import PostgresTenancyStore
from psycopg import Connection
from psycopg_pool import ConnectionPool


def get_pool(request: Request) -> ConnectionPool:
    return request.app.state.pool


def get_connection(pool: ConnectionPool = Depends(get_pool)) -> Iterator[Connection]:
    with pool.connection() as conn:
        yield conn


@dataclass
class RequestStores:
    """Bag of stores all constructed against the same request-scoped connection.

    ``conn`` is exposed too so handlers can run raw SQL against the same
    connection rather than acquiring a second one from the pool — the
    Python SDK keeps the conn checked out for the duration of the request
    via FastAPI's yield-based dependency, and a second concurrent
    ``pool.connection()`` call from the same handler can deadlock the
    event loop when the pool is under back-pressure (see commit log).
    """

    conn: Connection
    identity: PostgresIdentityStore
    tenancy: PostgresTenancyStore
    tuples: PostgresTupleStore
    shares: PostgresShareStore


def get_stores(conn: Connection = Depends(get_connection)) -> RequestStores:
    return RequestStores(
        conn=conn,
        identity=PostgresIdentityStore(conn),
        tenancy=PostgresTenancyStore(conn),
        tuples=PostgresTupleStore(conn),
        shares=PostgresShareStore(conn),
    )
