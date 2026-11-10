# Derive route.bible links instead of storing them

Date: 2026-11-02

## Status

Accepted

## Context

People want to open a highlighted passage in their preferred Bible app. route.bible is a canonical passage URL launcher that uses the same USFM book codes in lowercase (`https://route.bible/jhn.3.16`). Storing a link per record was considered.

## Decision

Records don't store links. Any app that wants one derives it: `https://route.bible/` followed by the lowercased `ref`. The web app shows an "Open" link on each highlight built this way. `SPEC.md` section 4 documents it.

## Consequences

- No redundant data that can drift from `ref`, and no dependency of the format on route.bible.
- Swapping to another launcher, or a native deep link, is a client change only.
- If route.bible ever changes its URL scheme, clients change one function; libraries stay as they are.
