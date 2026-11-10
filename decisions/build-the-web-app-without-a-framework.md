# Build the web app without a framework

Date: 2026-11-02

## Status

Accepted

## Context

The web app is a reference and a convenience, not the product: the format is. It should be hyper-minimal, load instantly, and stay readable for anyone implementing Selah Vault elsewhere. Frameworks like Next.js add a build step, a runtime, and code that obscures the protocol.

## Decision

The web app is static HTML, CSS and plain ES modules in `public/`, with no build step and no dependencies. The reference client (`public/sync.js`) uses only WebCrypto and `fetch`, so the same file runs in browsers, Bun, Node 20+, Deno and Workers, and the tests import it directly.

## Consequences

- The code people read to learn the protocol is the code that runs.
- No bundler, no framework upgrades, nothing to compile before deploying.
- UI state and rendering are hand-written. That is manageable at this size; a much larger UI would warrant reconsidering.
- The client is plain JavaScript and is not typechecked; the test suite (`mise run test`) is what guards it. Only the worker is TypeScript.
