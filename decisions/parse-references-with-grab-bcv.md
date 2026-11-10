# Parse references with grab-bcv

Date: 2026-11-02

## Status

Accepted. The web app's own parser (`parseRef` in `public/refs.js`) is retired.

## Context

People type references loosely ("jn 3.16", "1 Cor 13:4-7", "Phlm 6") and paste links from Bible apps. The web app had its own small parser. grab-bcv, by the same author, already handles natural text, OSIS refs, verse lists, cross-chapter ranges, typo correction, verse-count limits, and links from bible.com, BibleGateway, Logos and route.bible. Save links (`/save?ref=…`) make that breadth matter, because apps will send whatever they have.

The web app has no build step ([Build the web app without a framework](build-the-web-app-without-a-framework.md)), and grab-bcv's package root bundles about 280 KB of paragraph data the app doesn't need.

## Decision

The web app parses everything people enter with grab-bcv, through `public/passage.js`:

- `mise run vendor` bundles only grab-bcv's `parse` and `books` sub-paths into `public/vendor/grab-bcv.js` (about 28 KB, minified ESM). The bundle is committed; grab-bcv is a pinned dev dependency.
- `readPassage(text)` tries grab-bcv's single-passage parser first (in 0.1.7 it reads "jn 3.16" and "I John 4:8" correctly where the any-passage parser doesn't), then the any-passage parser for links, free text and verse lists. It reads "Jude 3" as Jude 1:3, since books of one chapter are cited by verse alone. It expands the result to whole verses, at most 500.
- `public/refs.js` keeps only canonical-ref helpers (labels, sorting) that the sync code also uses.

## Consequences

- Typing, pasting a link, and save links all accept the same, much wider set of inputs, with specific errors ("John has 21 chapters.").
- Updating grab-bcv means bumping the version and running `mise run vendor`.
- When grab-bcv's any-passage parser is fixed for the inputs above, `readPassage` can call it alone.
- The format is unchanged: grab-bcv's canonical refs are the same USFM codes as [Identify passages with USFM references](identify-passages-with-usfm-references.md).

## Update 2026-11-03: the add field suggests passages

The add form's reference field is now `<si-passage-input>` from [scripture-inline](https://github.com/cameronapak/scripture-inline) 0.3.1 (Cameron Pak, MIT), which is built on grab-bcv too. It suggests books, chapters, verses and ranges ("rom 5:3-" lists Romans 5:3-4, 5:3-5, …) and settles on a USFM id such as `ROM.5.3-5`.

- `mise run vendor` bundles only its `definePassageInput` into `public/vendor/scripture-inline.js`, with its license beside it. The bundle has no YouVersion client and makes no requests. The field styles its shadow root with one `<style>` block, which the CSP allows by hash; `mise run vendor` recomputes it.
- Submitting still goes through `readPassage`, so ranges still become one record per verse. It reads the field's passage id when it has one, and the typed text otherwise: the field rejects passages that cross chapters ("Genesis 1-2"), which Selah Vault accepts, and readPassage reads "Jude 3" as Jude 1:3 where the field reads it as a chapter.
- A whole chapter ("Psalm 23", id `PSA.23`) highlights every verse of the chapter, as before.
- Enter highlights once the field has settled a passage; Enter on a partial book name ("rom") fills in the book instead.
