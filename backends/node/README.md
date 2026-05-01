# Node backend (Fastify)

The reference Hearth backend on Node.js. Implements the Flametrench v0.1+v0.2
spec surface under `/v1/*` via `@flametrench/server`, plus Hearth-specific
routes under `/app/*`.

| Item           | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| Framework      | Fastify 5                                                          |
| Runtime        | Node 20+                                                           |
| Port           | 5001                                                               |
| Postgres       | `localhost:5501` (service `postgres-node` in `docker-compose.yml`) |
| Connection URL | `postgres://hearth:hearth@localhost:5501/hearth`                   |

## SDKs

- `@flametrench/server@0.0.1` — Fastify wiring of v0.1+v0.2 OpenAPI surface
- `@flametrench/ids@0.2.0`, `@flametrench/identity@0.2.0`, `@flametrench/tenancy@0.2.0`, `@flametrench/authz@0.2.0`

The repo root's `pnpm.overrides` pins `@flametrench/{ids,identity,tenancy,authz}`
to `0.2.0` to dedupe the rc-versioned transitive deps in
`@flametrench/server@0.0.1`. Will be unnecessary once `@flametrench/server`
publishes a v0.2.0-aligned release.

## Run

From the repo root:

```bash
docker compose up -d                              # mailpit + 4 Postgres
cd backends/node
cp .env.example .env
pnpm install
pnpm dev                                          # tsx watch
```

The server applies `shared/sql/flametrench-schema.sql` and
`shared/sql/hearth-schema.sql` on startup if their tables are missing.

## Endpoints landed

### Spec surface (`/v1/*`)

Mounted via `createFlametrenchServer`. See `shared/openapi/` for the wire
contract — every route in the v0.1 + v0.2 OpenAPI is live.

### Hearth surface (`/app/*`)

Install + onboarding (public):

| Route                      | Status                                          |
| -------------------------- | ----------------------------------------------- |
| `GET  /app/install/status` | live                                            |
| `POST /app/install`        | live — atomic multi-SDK bootstrap (ADR 0013)    |
| `POST /app/onboard`        | live — creates usr+cred+org+session in one call |

Customer flow (share-bearer): `POST /app/tickets/submit` (public),
`GET /app/customer/ticket`, `POST /app/customer/comment`.

Agent flow (session-bearer): `GET /app/orgs/:slug/tickets`,
`GET /app/tickets/:id`, `POST /app/tickets/:id/{comment,assign,resolve,reopen,share}`,
`POST /app/shares/:id/revoke`, `POST /app/orgs/:org_id/settings`.

The install wizard is the load-bearing **ADR 0013** demo: one `PoolClient`
backs all four SDKs across one transaction, atomically writing the first
`usr` + `cred` + `inst` row + `(usr, sysadmin, inst)` tuple.

The onboard endpoint replaces the SPA's previous 6-call signup chain with
a single call. **Note: not fully atomic on Node** because the Node
`PostgresTenancyStore.createOrg` and `PostgresIdentityStore.createSession`
internally call `this.pool.connect()` for their own BEGIN/COMMIT, which
fails when handed a `PoolClient` — so the route pre-checks slug
uniqueness and runs the SDK calls sequentially against the pool. The PHP
backend's onboard endpoint IS fully atomic via Laravel's `DB::transaction`
plus the PHP SDKs' `nested()` SAVEPOINT cooperation. Patching the Node
SDKs to support caller-owned-transactions is tracked upstream.

### Misc

| Route          | Purpose              |
| -------------- | -------------------- |
| `GET /healthz` | Liveness for compose |

## Reset state

To re-run the install wizard against a cleaned database:

```bash
docker compose down -v                            # nuke pg-node volume
docker compose up -d
pnpm dev                                          # re-applies schema on boot
```

## Try the install wizard

```bash
curl -X POST http://localhost:5001/app/install \
  -H 'Content-Type: application/json' \
  -d '{
    "sysadmin_email": "you@example.com",
    "sysadmin_password": "correcthorsebatterystaple",
    "sysadmin_display_name": "Sysadmin",
    "mfa_policy": "off"
  }'
```

Response:

```json
{
  "inst": { "id": "inst_<32hex>", "mfa_policy": "off" },
  "sysadmin": {
    "id": "usr_<32hex>",
    "email": "you@example.com",
    "display_name": "Sysadmin"
  }
}
```

Re-running the same call returns `409 already_installed`.
