# Vendored SQL

Postgres schema sources used by every Hearth backend at startup.

## Files

| File                     | Source                                                            | Purpose                                                                                                   |
| ------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `flametrench-schema.sql` | `github.com/flametrench/spec @ v0.2.0` (`reference/postgres.sql`) | Core Flametrench tables: `usr`, `cred`, `ses`, `org`, `mem`, `inv`, `tup`, `mfa`, `usr_mfa_policy`, `shr` |
| `hearth-schema.sql`      | Hearth (this repo)                                                | App-side tables: `inst` (singleton install row), `ticket`, `comment`                                      |
| `VENDORED-FROM`          | n/a                                                               | Pinning record for the upstream sources                                                                   |
| `refresh.sh`             | n/a                                                               | Re-fetch script (pinned to a tag, never `main`)                                                           |

## Apply order

Backends apply in this order at startup:

1. `flametrench-schema.sql` — Flametrench core (idempotent guard via `usr` table existence check)
2. `hearth-schema.sql` — Hearth tables (idempotent guard via `ticket` table existence check)

Each backend's startup code owns the idempotency check; the SQL files
themselves are plain DDL (no `IF NOT EXISTS` modifications to the
vendored content).

## Refreshing the Flametrench schema

```bash
./shared/sql/refresh.sh                       # uses HEARTH_SPEC_TAG, defaults to v0.2.0
HEARTH_SPEC_TAG=v0.3.0 ./shared/sql/refresh.sh
```

After running:

1. Inspect the diff: `git diff -- shared/sql/`
2. Update `VENDORED-FROM` with the new tag, commit SHA, and fetch date
3. Re-run the e2e suite — backends must still bootstrap cleanly

## Why vendor at all?

Same reasoning as `shared/openapi/`: pin reproducibility to a tag, decouple
from network access at boot time, and use the same `raw.githubusercontent.com`
fetch path an external adopter would. No internal shortcuts.
