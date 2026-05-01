# Vendored OpenAPI

The Flametrench v0.2 wire contract, vendored verbatim from
[`github.com/flametrench/spec`](https://github.com/flametrench/spec) at the
`v0.2.0` tag.

## Files

| File                              | Source path in `flametrench/spec`         | Purpose                                                                |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `flametrench-v0.1.yaml`           | `openapi/flametrench-v0.1.yaml`           | v0.1 base specification                                                |
| `flametrench-v0.2-additions.yaml` | `openapi/flametrench-v0.2-additions.yaml` | v0.2 additive surface (MFA enrollment + verification, MFA policy CRUD) |
| `VENDORED-FROM`                   | n/a                                       | Pinning record: tag, commit SHA, fetch date                            |
| `refresh.sh`                      | n/a                                       | Re-fetch script (pinned to a tag, never `main`)                        |

The two YAML documents compose additively. Every Hearth backend's `/v1/...`
surface MUST diff-equivalent to a bundle of these two documents.

## Refreshing

```bash
./shared/openapi/refresh.sh                 # uses HEARTH_SPEC_TAG, defaults to v0.2.0
HEARTH_SPEC_TAG=v0.3.0 ./shared/openapi/refresh.sh
```

After running:

1. Inspect the diff: `git diff -- shared/openapi/`
2. Update `VENDORED-FROM` with the new tag, commit SHA, and fetch date
3. Re-run the e2e suite — backends must still match the bundled doc

## Why vendor at all?

The vendored copy decouples Hearth's reproducibility from network access at
build/test time. The `refresh.sh` path uses the same `raw.githubusercontent.com`
URLs an external adopter would use — so this is the canonical "consume the
public spec" workflow, not an internal shortcut.
