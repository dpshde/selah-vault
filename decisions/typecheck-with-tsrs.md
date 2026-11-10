# Typecheck with tsrs

Date: 2026-11-02

## Status

Accepted

## Context

The worker (`src/`) is TypeScript and was typechecked with `tsc --noEmit`. tsrs is Cloudflare's Rust port of the TypeScript checker. On this repo it ran in about 0.1 seconds against about 0.4 seconds for `tsc`, and caught the same errors. It is a beta (`0.20.1-ts7.1.0-beta`, tracking TypeScript 7.1).

## Decision

`mise run typecheck` runs both `tsrs --noEmit -p tsconfig.json` (pinned to `0.20.1-ts7.1.0-beta`) and `tsc --noEmit` (TypeScript 5.9) so every local and CI check gets fast feedback plus dual-checker verification.

## Consequences

- Faster checks, using the same `tsconfig.json`.
- tsrs tracks a newer TypeScript than the installed `typescript` package, so the two checkers can disagree on edge cases. When they do, investigate before trusting either, and record the outcome here.
- If tsrs regresses or is abandoned, switch `check` back to `tsc --noEmit` and mark this record superseded.
