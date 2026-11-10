#!/bin/sh
# Applies `migrations/` to the local `selah-vault-auth` D1 database inside `.wrangler/state`
# (the local Miniflare directory read by `cf dev`). Always targets the database by binding name,
# matching `mise run db:migrate:prod` — never by a hard-coded uuid.
set -eu
cf d1 migrations apply selah-vault-auth --local --dir migrations --persist-to .wrangler/state </dev/null
