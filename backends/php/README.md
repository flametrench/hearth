# PHP backend (Laravel)

The PHP/Laravel port of Hearth. Implements the install wizard against the
Flametrench v0.2 PHP SDKs; customer and agent flows are M3-continued.

| Item           | Value                                                             |
| -------------- | ----------------------------------------------------------------- |
| Framework      | Laravel 13                                                        |
| Runtime        | PHP 8.3+                                                          |
| Port           | 5002                                                              |
| Postgres       | `localhost:5502` (service `postgres-php` in `docker-compose.yml`) |
| Connection URL | `pgsql://hearth:hearth@localhost:5502/hearth`                     |

## SDKs

- `flametrench/laravel@0.2.0` — service-provider wiring of the four PHP SDKs into Laravel
- `flametrench/{ids,identity,tenancy,authz}@0.2.0` — Postgres-backed stores

`AppServiceProvider::register()` overrides the default in-memory bindings
shipped by `flametrench/laravel` to use Postgres adapters constructed from
Laravel's configured `pgsql` connection PDO.

## Run

From the repo root:

```bash
docker compose up -d                      # mailpit + 4 Postgres
cd backends/php
composer install                          # if a fresh checkout
php artisan hearth:apply-schema           # one-time, idempotent
php artisan serve --port=5002
```

The `hearth:apply-schema` artisan command applies
`shared/sql/flametrench-schema.sql` then `shared/sql/hearth-schema.sql`.
Both checks are idempotent (skip if `usr` / `ticket` table exists).

## Endpoints landed

| Route                      | Auth   | Status |
| -------------------------- | ------ | ------ |
| `GET  /healthz`            | public | live   |
| `GET  /app/install/status` | public | live   |
| `POST /app/install`        | public | live   |

The install wizard uses `DB::transaction` around `PostgresIdentityStore` +
`PostgresTupleStore` operations and a raw `INSERT INTO inst` — atomic
multi-SDK bootstrap (ADR 0013) demonstrated in PHP/Laravel.

## Smoke test

```bash
curl -X POST http://localhost:5002/app/install \
  -H 'Content-Type: application/json' \
  -d '{
    "sysadmin_email": "you@example.com",
    "sysadmin_password": "correcthorsebatterystaple",
    "sysadmin_display_name": "You",
    "mfa_policy": "off"
  }'
```

Response shape matches the Node backend exactly:

```json
{
    "inst": { "id": "inst_<32hex>", "mfa_policy": "off" },
    "sysadmin": { "id": "usr_<32hex>", "email": "you@example.com", "display_name": "You" }
}
```

A second call returns `409 already_installed`.

## Reset state

```bash
docker compose down -v
docker compose up -d
php artisan hearth:apply-schema
```

## TODO — M3-continued

The Node backend's customer + agent surfaces are not yet ported:

- `POST /app/tickets/submit` (public)
- `GET /app/customer/ticket`, `POST /app/customer/comment` (share-bearer)
- `GET /app/orgs/:slug/tickets`, `GET /app/tickets/:id`, `POST /app/tickets/:id/{comment,assign,resolve,reopen,share}`, `POST /app/shares/:id/revoke` (session-bearer)
- `POST /app/orgs/:org_id/settings`
- Mail integration (Laravel Mail facade pointed at mailpit)
- CORS for SPA origin
- Playwright suite green at `WEB_URL=…` and `FT_API_URL=http://localhost:5002`

Status matrix at the repo root README reflects this gap.
