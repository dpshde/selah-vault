# Use colors as categories instead of bookmarks

Date: 2026-11-02

## Status

Accepted. Version 0.1 had a `bookmark` record kind; version 0.2 removes it.

## Context

Version 0.1 had highlights, notes and bookmarks. In practice a bookmark is a verse you marked to come back to, which is what a highlight already is. People also use highlight colors as categories (promises, prayer, questions), and want to name them and add their own.

## Decision

Drop bookmarks. Model categories as named colors via `color.set` and `color.removed` events:

- Six built-in color ids: `yellow`, `green`, `blue`, `pink`, `purple`, `orange`. A `color.set` event with a built-in `id` gives it a custom `name`.
- A library can add custom colors with an id (`c-` plus random characters), a `name`, and a `#RRGGBB` `hex` value, ordered by earliest `createdTs` after the built-ins.
- A highlight whose color is unknown or removed falls back to yellow. Apps recolor highlights before removing a color.

## Consequences

- One mechanism (highlight + named color) covers bookmarks and categories, and the web app can filter by color.
- Color names sync through the event log and converge by the same deterministic `(ts, id)` rule as highlights and passages.
- Apps that don't support custom colors still show those highlights, as yellow, so nothing disappears.
- Anyone who relied on 0.1 bookmarks has to re-mark them as highlights. There were no released 0.1 clients, so the cost is nil.
