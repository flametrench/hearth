#!/usr/bin/env bash
# Re-fetch the vendored Postgres schema from github.com/flametrench/spec.
#
# Pin to a tag — never main — so the schema is reproducible.
# After a refresh, update VENDORED-FROM and review the diff before committing.

set -euo pipefail

TAG="${HEARTH_SPEC_TAG:-v0.2.0}"
BASE="https://raw.githubusercontent.com/flametrench/spec/${TAG}/reference"

cd "$(dirname "$0")"

echo "Fetching reference schema from flametrench/spec @ ${TAG}"

curl -fsSL -o flametrench-schema.sql "${BASE}/postgres.sql"

echo "Done. Review changes:"
echo "  git diff -- shared/sql/"
echo
echo "Update shared/sql/VENDORED-FROM with the new tag, commit SHA, and date."
