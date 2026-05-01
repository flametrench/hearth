# Hearth

A customer-support inbox built against the [Flametrench](https://flametrench.dev)
v0.2 specification — the same wire contract, four different language stacks.

> Hearth is a **reference application**, not a product. Every flow exists to
> demonstrate a Flametrench v0.2 capability end-to-end.

## What it shows

Hearth implements a Zendesk-shaped support inbox: support teams (Flametrench
`org`s) receive tickets from external customers, agents triage them, and
customers reply via emailed share links — without ever creating an account.

The interesting part is the **dual-population model**: agents have full
Flametrench identity (credentials + sessions + MFA), while customers carry
only a 30-day reusable share token bound to a single ticket. Two
populations, no upgrade path between them.

| Capability                       | Where it shows up                             |
| -------------------------------- | --------------------------------------------- |
| Identity (signup / signin / MFA) | Agent flow                                    |
| Tenancy (org / mem / invitation) | Support team setup, agent invite, role change |
| Share tokens (ADR 0012)          | **Load-bearing throughout the customer flow** |
| Postgres txn nesting (ADR 0013)  | Install wizard's multi-SDK atomic bootstrap   |
| App-defined object IDs           | `ticket_<hex>`, `comment_<hex>`, `inst_<hex>` |
| `listUsers` (ADR 0015)           | Sysadmin `/admin/users` page                  |

A complete ADR coverage matrix lives in `~/Documents/FlameTrench/hearth-plan.md`
(internal) or will be summarised in `docs/spec-coverage.md` at M2.

## Pick your language

Each backend implements the same routes against the same OpenAPI document.
Pick one and follow its README.

| Backend | Status                                      | Framework | Port | README                                         |
| ------- | ------------------------------------------- | --------- | ---- | ---------------------------------------------- |
| Node    | M1 — in progress                            | Fastify   | 5001 | [`backends/node`](backends/node/README.md)     |
| PHP     | M3 — planned                                | Laravel   | 5002 | [`backends/php`](backends/php/README.md)       |
| Python  | M4 — gated on PyPI publish unblock          | FastAPI   | 5003 | [`backends/python`](backends/python/README.md) |
| Java    | M5 — gated on Maven Central publish unblock | Javalin   | 5004 | [`backends/java`](backends/java/README.md)     |

The React SPA in [`web/`](web/) is backend-agnostic; point `FT_API_URL` at
whichever backend port you brought up.

## Local infrastructure

```bash
docker compose up -d              # mailpit + 4 Postgres (one per backend)
open http://localhost:8025        # mailpit web UI for share-link / notification capture
```

| Service         | Host port | Purpose                                                       |
| --------------- | --------- | ------------------------------------------------------------- |
| mailpit (SMTP)  | 1025      | Outbound mail capture for share links and admin notifications |
| mailpit (UI)    | 8025      | Browse captured email                                         |
| postgres-node   | 5501      | Database for the Node backend                                 |
| postgres-php    | 5502      | Database for the PHP backend                                  |
| postgres-python | 5503      | Database for the Python backend                               |
| postgres-java   | 5504      | Database for the Java backend                                 |

Each Postgres is initialised with database `hearth`, user `hearth`, password
`hearth`. Backends own their own migrations.

## Repo layout

```
hearth/
├── shared/openapi/        Vendored Flametrench v0.2 OpenAPI (see VENDORED-FROM)
├── web/                   Vite + React + TypeScript SPA (M1)
├── backends/
│   ├── node/              Fastify  (M1, Node 20+)
│   ├── php/               Laravel  (M3, PHP 8.3+)
│   ├── python/            FastAPI  (M4, Python 3.12+)
│   └── java/              Javalin  (M5, JDK 21+)
├── e2e/                   Playwright suite (M2 onward)
├── docker-compose.yml     mailpit + 4 Postgres
└── README.md              You are here.
```

## Spec source of truth

`shared/openapi/` contains the v0.2.0-tagged OpenAPI documents from
[`github.com/flametrench/spec`](https://github.com/flametrench/spec), pinned
to commit `4d1f49f`. To refresh against a newer spec tag:

```bash
HEARTH_SPEC_TAG=v0.3.0 ./shared/openapi/refresh.sh
```

This is the same `raw.githubusercontent.com` path an external adopter would
use — no internal shortcuts.

## Status

Milestone 0 (repo skeleton) — done.
Milestone 1 (Node backend + SPA shell) — next.

For the full milestone plan see `~/Documents/FlameTrench/hearth-plan.md`.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
