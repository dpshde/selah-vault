#!/bin/sh
# Applies `migrations/` to the local `selah-vault-auth` D1 database inside `.wrangler/state`
# (the local Miniflare directory read by `cf dev`). Uses the id from src/d1-ids.ts —
# matching `mise run db:migrate:prod` (`cf` applies by id, not by name).
set -eu
cd "$(dirname "$0")/.."
id=$(bun -e 'import { SELAH_VAULT_AUTH_D1_ID } from "./src/d1-ids.ts"; process.stdout.write(SELAH_VAULT_AUTH_D1_ID)')
test -n "$id"
cf d1 migrations apply "$id" --local --dir migrations --persist-to .wrangler/state </dev/null
