# Python backend (FastAPI)

The Python port of the Hearth backend on FastAPI. Implements the Flametrench
v0.1 + v0.2 spec subset under `/v1/*` (hand-rolled — there's no
`flametrench-server` Python package yet) plus Hearth-specific routes under
`/app/*`. Mirrors `backends/node` and `backends/php` route-for-route.

| Item           | Value                                                                |
| -------------- | -------------------------------------------------------------------- |
| Framework      | FastAPI                                                              |
| Runtime        | Python 3.12+                                                         |
| Port           | 5003                                                                 |
| Postgres       | `localhost:5503` (service `postgres-python` in `docker-compose.yml`) |
| Connection URL | `postgresql://hearth:hearth@localhost:5503/hearth`                   |

## SDKs

- `flametrench-ids`, `flametrench-identity`, `flametrench-tenancy`, `flametrench-authz` — all at `v0.3.0`
- PyPI publish is blocked on org approval; until it lands, the SDKs install
  as **editable installs from the sibling `flametrench-setup/*-python/`
  directories** (see `pyproject.toml` `[tool.uv.sources]`).

## Run

From the repo root:

```bash
docker compose up -d                              # mailpit + 4 Postgres
cd backends/python
cp .env.example .env
uv sync                                           # installs deps + editable SDKs
uv run uvicorn hearth_python.main:app --host 0.0.0.0 --port 5003
```

(`uv` is the project's chosen Python tool. If you prefer pip,
`pip install -e ../../../ids-python ../../../identity-python ../../../tenancy-python ../../../authz-python`
followed by `pip install fastapi 'uvicorn[standard]' 'psycopg[binary,pool]'`
gets you the same surface.)

The server applies `shared/sql/flametrench-schema.sql` and
`shared/sql/hearth-schema.sql` on startup if their tables are missing.

## Endpoints landed

Every route on `backends/node` is mirrored here at the same path + wire
shape. See the [Node README](../node/README.md) for the full route table —
the contract is identical.

Implementation notes specific to Python:

- **ADR 0013 caller-owned-connection** path uses `pool.connection() as conn`
  + `conn.transaction()` for the `BEGIN/COMMIT` scope, with
  `PostgresIdentityStore(conn)` / `PostgresTupleStore(conn)` /
  `PostgresTenancyStore(conn)` constructed against the same `conn`. The
  SDKs internally use psycopg's nested-transaction (`SAVEPOINT`) cooperation
  for their multi-statement methods.
- **C3 advisory-lock** uses the same `0x6865617274686e73` constant
  ("hearthns" packed) as Node + PHP so cross-backend install races
  serialize on the same key.
- **Auth dependencies** (`auth_deps.py`) replace the Fastify `addHook`
  pattern with FastAPI `Depends(...)`. Bearer extraction + share/session
  verification semantics mirror the Node implementation.
