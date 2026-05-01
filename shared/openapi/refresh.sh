#!/usr/bin/env bash
# Re-fetch the vendored OpenAPI documents from github.com/flametrench/spec.
#
# Pin to a tag — never to main — so the wire contract is reproducible.
# After a refresh, update VENDORED-FROM and review the diff before committing.

set -euo pipefail

TAG="${HEARTH_SPEC_TAG:-v0.2.0}"
BASE="https://raw.githubusercontent.com/flametrench/spec/${TAG}/openapi"

cd "$(dirname "$0")"

echo "Fetching OpenAPI from flametrench/spec @ ${TAG}"

curl -fsSL -o flametrench-v0.1.yaml "${BASE}/flametrench-v0.1.yaml"
curl -fsSL -o flametrench-v0.2-additions.yaml "${BASE}/flametrench-v0.2-additions.yaml"

echo "Done. Review changes:"
echo "  git diff -- shared/openapi/"
echo
echo "Update shared/openapi/VENDORED-FROM with the new tag, commit SHA, and date."
