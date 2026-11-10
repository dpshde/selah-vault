#!/bin/sh
# Apply D1 auth migrations to production. `cf d1 migrations apply` takes a
# database id (not a name) and has no `--remote` flag — remote is the default.
# The id comes from src/d1-ids.ts so hygiene can keep the placeholder/forbidden guards.
set -eu
cd "$(dirname "$0")/.."
id=$(bun -e 'import { SELAH_VAULT_AUTH_D1_ID } from "./src/d1-ids.ts"; process.stdout.write(SELAH_VAULT_AUTH_D1_ID)')
test -n "$id"
cf d1 migrations apply "$id" --dir migrations
