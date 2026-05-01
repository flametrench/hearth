# Node backend (Fastify)

Wired in **Milestone 1**. Until then this directory is a placeholder.

| Item           | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| Framework      | Fastify                                                            |
| Runtime        | Node 20+                                                           |
| Port           | 5001                                                               |
| Postgres       | `localhost:5501` (service `postgres-node` in `docker-compose.yml`) |
| Connection URL | `postgres://hearth:hearth@localhost:5501/hearth`                   |

## SDKs

- `@flametrench/server` (foundation)
- `@flametrench/ids`, `@flametrench/identity`, `@flametrench/tenancy`, `@flametrench/authz`

All four are live on npm at v0.2.0.
