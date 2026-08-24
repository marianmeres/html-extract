# Architecture

## Overview

One entry point, one parse, ten pure functions. `extract()` is a composition, not a
framework: it parses the document once and calls the same internal extractors the
granular exports call. There is no state, no registry, no lifecycle and no I/O.

The package sits beside the crawler, not under it:

```
@marianmeres/page-fetcher   transport      URL  -> bytes -> decoded string
@marianmeres/crawler        orchestration  links, scope, depth, jobs, persistence
@marianmeres/html-extract   document       string -> structured data      <- you are here
```

It imports neither of the others. That is what keeps it usable on an email body, a file
from disk, or a hand-fetched string.

## Component map

```
                         ┌───────────────┐
   html: string  ───────▶│  _dom.ts      │  the ONLY file that knows about linkedom
                         │  parseDocument│  wraps fragments, normalizes quirks
                         └───────┬───────┘
                                 │ ParsedDocument { root, body, truncated }
        ┌────────────────────────┼────────────────────────┬──────────────────┐
        ▼                        ▼                        ▼                  ▼
  metadata.ts              json-ld.ts               embedded-json.ts    microdata.ts
  (deterministic)          (deterministic)          (deterministic)     (deterministic)
        │                        │  ▲                     │                  │
        │   late fallback ───────┘  │ WeakMap memo        │                  │
        └───────────────────────────┘                     │                  │
                                 ▼                        ▼                  ▼
                         ┌───────────────────────────────────────────────────┐
                         │  extract.ts — composes, one parse for all of them │
                         └───────────────────────┬───────────────────────────┘
                                                 ▼
                                        main-content.ts   (the heuristic)
                                          ├── clean.ts        cleanNode()
                                          ├── to-markdown.ts  renderMarkdown()   lazy
                                          └── to-text.ts      renderText()       lazy

  standalone, not used by extract():  clean()   pick()
```

## Data flow

1. **Parse.** `parseDocument(html, { maxSize, logger })` truncates oversized input,
   wraps a bare fragment into a document, and returns `{ root, body, truncated }` — or
   `null` for input that is not a usable string at all.
2. **Deterministic extractors** read the tree. None of them mutates it.
3. **Main content** deep-clones `doc.body` and does all of its removal and scoring on
   the clone, so the extractors above cannot be corrupted by it. It runs last in
   `extract()` for the same reason, belt and braces.
4. **Rendering is lazy.** `MainContent.markdown()` / `.text()` call the node-level
   renderers on first use and memoize. `toJSON()` materializes both, so persisting the
   result is not silently lossy.

## The two-function pattern

Every extractor module exports exactly two entry points:

```ts
export function extractX(html: string, options?: XOptions): X; // public
export function xFromDocument(doc: ParsedDocument, options?): X; // internal
```

The public one asserts its argument type, parses, and delegates. `extract()` skips
straight to the internal ones. This is the only reason `extract()` is cheaper than
calling the granular functions in sequence — and it is why adding a new extractor means
adding both, not one.

## External dependencies

| Dependency          | Why                                                                   |
| ------------------- | --------------------------------------------------------------------- |
| `linkedom`          | The HTML parser. The only runtime dependency. Contained in `_dom.ts`. |
| `@marianmeres/clog` | The `Logger` **type** only — a type-only import, erased at runtime.   |

`scripts/build-npm.ts` must list both in `versionizeDeps`: the first because it is real
code, the second because the emitted `.d.ts` references its type and a consumer's `tsc`
has to resolve it.

## Key files

| File                  | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `src/_dom.ts`         | Parser adapter: parse, traverse, query, serialize. Swap point.       |
| `src/_util.ts`        | Guards, URL resolution, whitespace, dates, tag tables, link density. |
| `src/types.ts`        | Every public type. Imports nothing but clog's `Logger`.              |
| `src/extract.ts`      | The composition.                                                     |
| `src/main-content.ts` | The only heuristic in the package.                                   |
| `tests/_fixtures.ts`  | Corpus loader and the golden-file helper.                            |

## MCP surface

`mcp.ts` (root, discovered by `@marianmeres/mcp-server` via `mcp-include.txt`) exposes
five tools to AI agents. It is not part of the published library graph — JSR ships the
file, the npm build does not, and nothing in `src/` imports it.

| Tool                  | What it answers                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `extract-preview`     | "What does this page actually yield?" — the whole `extract()` result plus, on request, the library's decision log         |
| `diagnose-content`    | "The heuristic got it wrong — now what?" — what it did, which containers exist, and a ranked `contentSelector` suggestion |
| `convert-html`        | "Give me this page as markdown/text" — optionally main content only                                                       |
| `pick-fields`         | "Does this selector map work?" — `pick()` against a real document                                                         |
| `metadata-precedence` | "Which meta tag do I need?" — chains derived by elimination against the running library                                   |

The shared design rule: a tool **captures the library's own `Logger` trail** instead of
restating its rules. `metadata-precedence` goes further and derives chain _order_ by
elimination, so it cannot drift out of step with `src/metadata.ts` — a test fails the
moment its probe table stops covering the implementation.

## Boundaries

- **No network, ever.** No `fetch`, no file reads in `src/`. Input is a string.
- **No JavaScript execution.** Framework blobs are located textually and `JSON.parse`d;
  there is no `eval`, no `Function`, no sandbox.
- **No security boundary.** `clean()` is structural cleanup and says so loudly. Rendering
  untrusted HTML is DOMPurify's job, not this package's.
- **No parser types in the public API.** Every export returns plain data.
