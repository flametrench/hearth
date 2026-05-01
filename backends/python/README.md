# Python backend (FastAPI)

Wired in **Milestone 4**, gated on PyPI publish unblock. Until then this
directory is a placeholder; during the block, install SDKs from local wheels
in the `flametrench-setup/*-python/dist/` directories.

| Item           | Value                                                                |
| -------------- | -------------------------------------------------------------------- |
| Framework      | FastAPI                                                              |
| Runtime        | Python 3.12+                                                         |
| Port           | 5003                                                                 |
| Postgres       | `localhost:5503` (service `postgres-python` in `docker-compose.yml`) |
| Connection URL | `postgres://hearth:hearth@localhost:5503/hearth`                     |

## SDKs

- `flametrench-ids`, `flametrench-identity`, `flametrench-tenancy`, `flametrench-authz`

All four are PyPI-publish-blocked as of 2026-05-01. Local wheels: see
`flametrench-setup/{ids,identity,tenancy,authz}-python/dist/`.
