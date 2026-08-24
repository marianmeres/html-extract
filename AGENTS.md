# @marianmeres/html-extract — Agent Guide

HTML string in, structured content out: metadata, structured data, main content,
markdown/text. The **document** layer of the fetch → crawl → extract trio, and a sibling
of the crawler, not a layer on top of it.

## Quick Reference

- **Stack**: TypeScript, Deno-first, ESM, published to JSR + npm. **Exactly one runtime
  dependency** — `linkedom` (the HTML parser). `@marianmeres/clog` is a type-only import.
- **Test**: `deno task test` — pure and offline; no network, no PG, no browser.
- **Goldens**: `deno task test:golden` regenerates `tests/fixtures/*/expected.*`.
  Review the diff; never regenerate to make a failure disappear.
- **Docs gate**: `deno task doc:lint` — `deno doc --lint` plus `deno check --doc`, which
  type-checks the code inside every `@example`.
- **Build**: `deno task npm:build` (runs `tsc`, stricter than `deno check`).
- **Format/lint**: `deno fmt` / `deno lint`. Tabs, `lineWidth: 90`.

## Project Structure

```
src/mod.ts            — the single flat barrel; everything ships from the root
src/types.ts          — every public type; imports nothing but clog's Logger type
src/_dom.ts           — THE PARSER ADAPTER. The only file that may know about linkedom.
src/_util.ts          — shared helpers: guards, URLs, whitespace, dates, tag tables
src/metadata.ts       — extractMetadata            (deterministic)
src/json-ld.ts        — extractJsonLd, flattenJsonLd (deterministic)
src/embedded-json.ts  — extractEmbeddedJson        (deterministic)
src/microdata.ts      — extractMicrodata          (deterministic)
src/to-text.ts        — toText      + renderText   (node-level, internal)
src/to-markdown.ts    — toMarkdown  + renderMarkdown (node-level, internal)
src/main-content.ts   — extractMainContent         (the heuristic)
src/clean.ts          — clean + cleanNode          (NOT a sanitizer — see §7 of the design)
src/pick.ts           — pick
src/extract.ts        — extract: one parse, every extractor
tests/                — one file per module + _fixtures.ts (corpus loader, golden helper)
tests/fixtures/<case>/input.html + expected.md|txt|json
scripts/build-npm.ts  — npm build; `versionizeDeps` MUST list linkedom and clog
docs/                 — design.md (founding doc + resolutions), architecture.md,
                        conventions.md, tasks.md
```

## Critical Conventions

1. **The parser never escapes `src/_dom.ts`.** No other file imports `linkedom`, and no
   parser type appears in the public API — every exported function returns plain data
   (strings, plain objects, arrays). Returning a parser node would marry the package to
   linkedom forever. Swapping parsers must touch one file.
2. **Nothing throws on bad HTML.** Broken markup, truncated documents, binary noise, an
   empty string — all yield a degraded result. The _only_ permitted throw is
   `assertHtmlString(html, "fn")` (and `pick`'s selector-map guard): a wrong argument
   type is a programmer error and must be loud. Every public function is covered by
   `tests/robustness.test.ts`, which fuzzes the whole fixture corpus.
3. **Every module exports a public `fn(html, options)` and an internal
   `fnFromDocument(doc, options)`.** `extract()` parses once and calls the internal
   forms; that single parse is the only reason `extract()` is cheaper than calling the
   granular functions yourself.
4. **`logger` is optional and silent by default.** Optional-chained at every call site,
   every message prefixed `[html-extract]`. `debug` explains _why_ the output looks the
   way it does; `warn` is for genuinely surprising input only.
5. **Walks are iterative or depth-capped.** A recursive walk over a 20 000-deep document
   throws a `RangeError`, which would violate convention 2. `walkElements` and
   `serialize` in `_dom.ts` use explicit stacks; the renderers cap depth and degrade.
6. **Explicit return types on every export** (JSR "no slow types").
   `deno publish --dry-run` is the gate.
7. **Content extraction is a heuristic and says so.** `via` reports which strategy won,
   `content: null` is a legitimate outcome, and `contentSelector` is the documented
   escape hatch. Never assert exact output for it in a test — assert that a body phrase
   is present and a nav/footer phrase is absent.
8. **`clean()` is not a sanitizer.** Any change there keeps the loud disclaimer in the
   JSDoc and the README. Do not add anything that makes it look more like a security
   boundary.
9. **No second runtime dependency.** Not `turndown`, not `sanitize-html`, not `jsdom`.
   The tree is already parsed; write the conversion.

## Parser quirks that bite (all handled in `_dom.ts` — read its module JSDoc)

- A bare fragment parses into a document whose `body` is an **empty stub** → input is
  normalized into a full document before parsing.
- Attribute lookup is **case-sensitive** and special-cased for `class` → always use
  `attr()`, never `getAttribute()`.
- **No implied `<tbody>`** → find rows with a `tr` query.
- `innerHTML` does not re-escape `&` in attribute values → use `serialize()`, which also
  makes `clean(clean(x)) === clean(x)` hold.

## Before Making Changes

- [ ] Read [docs/design.md](./docs/design.md) — it records what was decided and why.
- [ ] Check the sibling module; every extractor follows the same two-function shape.
- [ ] `deno task test` — including the fuzz and idempotency suites.
- [ ] `deno lint && deno fmt && deno task doc:lint`.
- [ ] `deno task npm:build` when touching imports (`tsc` is stricter than `deno check`).
- [ ] `deno publish --dry-run` before anything that changes the public surface.
- [ ] Update `src/mod.ts`, `API.md` and `tests/extract.test.ts` together when the public
      surface changes.
- [ ] Review golden diffs by eye before regenerating them.

## Documentation Index

- [Architecture](./docs/architecture.md) — component map, data flow, the parse-once design
- [Conventions](./docs/conventions.md) — Do/Don't pairs for code and tests
- [Tasks](./docs/tasks.md) — add an extractor, add a fixture, tune the heuristic, swap the parser
- [Design](./docs/design.md) — the founding design document, its non-goals, and how its
  open questions were resolved
- [README](./README.md) — human overview, the honest caveats, crawler recipes
- [API](./API.md) — complete public reference incl. metadata precedence chains
