#!/bin/sh
# Applies `migrations/` to the local `selah-vault-auth` D1 database inside `.wrangler/state`
# (the local Miniflare directory read by `cf dev`), resolving the D1 UUID from `cloudflare.config.ts`.
set -eu
id=$(sed -n 's/.*id: "\([0-9a-f-]\{36\}\)".*/\1/p' cloudflare.config.ts | head -n 1)
cf d1 migrations apply "$id" --local --dir migrations --persist-to .wrangler/state </dev/null
