# `@marianmeres/html-extract` — Design Sketch

> **Status: implemented.** This is the founding design document, kept verbatim below as
> the record of intent. The open questions of §12 were resolved as follows — read this
> before re-litigating any of them.
>
> | §    | Question             | Resolution                                                                                                                                                                                                                                                                                                                                                                                                              |
> | ---- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 12.1 | Parser               | **`linkedom`**, confirmed end-to-end (Deno + `deno task npm:build` through `@marianmeres/npmbuild`). Its non-spec behaviours are documented and normalized in `src/_dom.ts`: fragments get wrapped into a document, attribute lookup goes through a case-insensitive `attr()`, no implied `<tbody>` is assumed, and the package ships its own serializer because linkedom's does not re-escape `&` in attribute values. |
> | 12.2 | Does `clean()` ship? | **Yes**, with the §7 disclaimer stated loudly in its JSDoc, in `README.md` and in `API.md`. Dropping it would not have removed the need, only pushed callers to hand-roll something worse.                                                                                                                                                                                                                              |
> | 12.3 | Ragged tables        | **Passthrough HTML**, as recommended. A table with `colspan`/`rowspan` or ragged rows is emitted as its serialized HTML block rather than as broken GFM.                                                                                                                                                                                                                                                                |
> | 12.4 | Content fingerprint  | **Not in the API.** A synchronous hash would mean shipping a hash function, and `crypto.subtle` is async and would infect the whole surface. The README documents the four-line recipe over `content.text()` instead, which also lets callers match whatever digest their crawler already uses.                                                                                                                         |
> | 12.5 | Language detection   | **Out of scope**, as recommended. `metadata.lang` reports what the document declares and nothing more.                                                                                                                                                                                                                                                                                                                  |
> | 12.6 | Is `pick()` in v1?   | **Yes**, deliberately thin (§8) and documented as the boundary that keeps the scraping DSL out.                                                                                                                                                                                                                                                                                                                         |
>
> Three additions were made beyond the sketch, each because the sketch's own motivating
> use case needed it:
>
> - **`MainContent.toJSON()`** materializes `markdown()`/`text()`. Without it, §10's
>   `onPage: (res) => extract(…)` → JSONB recipe would have silently dropped both
>   renderings on serialization, since methods do not survive `JSON.stringify`. Laziness
>   is preserved for every caller who does not serialize.
> - **`ExtractOptions.content` defaults to `true`**, matching its sibling flags
>   (`metadata`, `jsonLd`, `embeddedJson`). The sketch's "Default false" was attached to
>   a _"skip"_ phrasing; an enable-flag that defaults to off would have made
>   `extract(html)` silently skip the package's headline feature.
> - **`extractMicrodata()` exists.** §1 lists microdata as in-scope structured data while
>   §3's _sketch_ of the public surface omits it; the in-scope statement won, since the
>   §3 heading calls itself a sketch. It is a granular function plus an
>   `ExtractedDocument.microdata` field and an `ExtractOptions.microdata` flag, matching
>   the shape of its JSON-LD and embedded-JSON siblings. `itemref` is deliberately
>   unsupported.
> - **`maxSize` truncates rather than rejects.** Rejecting would have meant either
>   throwing (forbidden by §9) or returning nothing for a document that still carries
>   perfectly good metadata in its first kilobyte.
>
> Two corrections to the text below. §5's "Propagate scores to ancestors (parent full,
> grandparent half)" describes a rule that loses the article whenever its container sits
> more than two levels above its paragraphs — ordinary page-builder markup. The
> implementation propagates up to five ancestors with a decaying divider and stops at the
> first negatively-hinted one; `src/main-content.ts` documents why. And §10's inline-crawl
> snippet
> (`onPage: async (res) => extract(await res.text(), …)`) does not compile. The crawler's
> `PageResult` deliberately carries no body — it is on the second argument, as
> `ctx.fetchResult`. `README.md` carries the corrected, type-checked form.

> High-level design document for a coding agent. Describes intent, boundaries and the
> public surface. Internals are the agent's call, but the contracts below are binding.

---

## 1. Purpose

Given an HTML document as a **string**, produce clean, structured, consumer-ready data:
metadata, embedded structured data, the main content (boilerplate removed), and that
content rendered as markdown or plain text.

This is the third package in a deliberately factored pipeline:

| Package                         | Job                                                                | Depends on      |
| ------------------------------- | ------------------------------------------------------------------ | --------------- |
| `@marianmeres/page-fetcher`     | transport — fetch one URL, normalized result                       | —               |
| `@marianmeres/crawler`          | orchestration — links, scope, depth, politeness, jobs, persistence | page-fetcher    |
| **`@marianmeres/html-extract`** | **document — HTML in, structured content out**                     | **— (nothing)** |

**`html-extract` is a sibling of the crawler, not a layer on top of it.** It must never
import crawler or page-fetcher types. The consumer composes them. This is the same
relationship page-fetcher already has with the crawler, and it is what keeps this package
usable on a single hand-fetched HTML string, an email body, or a file on disk.

### In scope

- Metadata: `<title>`, description, OpenGraph, Twitter cards, canonical, lang, author,
  published/modified dates, favicon
- Structured data: JSON-LD (`<script type="application/ld+json">`), microdata, and
  framework state blobs (`__NEXT_DATA__`, `__NUXT__`, Apollo, Redux preload)
- Main-content extraction (readability-style boilerplate removal)
- HTML → markdown, HTML → plain text
- Structural cleanup (`clean()` — **not** an XSS sanitizer, see §7)
- A thin CSS-selector picker for site-specific field extraction

### Explicitly out of scope (non-goals)

- **Fetching anything.** No network, ever. Input is a string.
- **Charset decoding.** The caller hands over a decoded string; bytes→string is
  page-fetcher's job.
- **JavaScript execution.** If the page needs rendering, the caller fetched it through
  page-fetcher's browser adapter and passes the rendered DOM here.
- **A scraping DSL.** No config-driven field-mapping engine, no pagination rules, no
  crawl definitions. If it grows one, it has become Scrapy and the boundary has failed.
- **Semantic understanding** (summarize / classify / infer) → `@marianmeres/llm-task`.
  This package stops at "clean text + structured facts" and hands off.
- **Persistence.** Pure functions. Extracted data is the caller's to store.
- **Non-HTML formats** (PDF, docx, RSS). HTML only.
- **XSS sanitization for rendering** — see §7, this is a deliberate refusal.

---

## 2. Package shape

- TypeScript, ESM only. JSR primary + npm via `@marianmeres/npmbuild`. Deno first, Node
  compatible.
- **A single entry point.** Everything exports from the root. Unlike the crawler (whose
  submodules exist so `./url` can be used without the crawl loop), everything here shares
  one parser, so submodule splitting buys nothing. Boring name, boring layout.
- `logger?: Logger` (type-only import from `@marianmeres/clog`, re-exported like
  page-fetcher does it), default `undefined` = silent, optional-chained call sites. This
  is a pure-library package, so it follows page-fetcher's silent default, not
  steve/cron's namespaced-clog default.
- **Exactly one runtime dependency: the HTML parser.** Resist a second.

### 2.1 The parser decision (the biggest call in this package)

Text extraction genuinely needs a tree — link-density scoring, ancestor score
propagation, and `pick()` all need `querySelector` and parent/child traversal. Writing a
tokenizer instead (like the crawler's deliberately tree-less `_html.ts`) would mean
hand-rolling a selector engine, which is a bad trade.

**Recommendation: `linkedom`** (`npm:linkedom`) — fast, small, has `querySelector`/
`querySelectorAll`, works in both Deno and Node. Alternative if spec-exact parsing
matters more than selectors: `parse5` + own traversal. **Do not use `jsdom`** (full
browser emulation, far too heavy). `deno-dom` is Deno-native but its Node story is
weaker, and this package must npm-build cleanly.

Two binding rules regardless of choice:

1. **The parser type never appears in the public API.** Every exported function returns
   plain data — strings, plain objects, arrays. Never a parser node. Returning
   `linkedom` nodes marries the package to linkedom forever; returning strings and
   objects makes the parser a contained, swappable implementation detail.
2. Isolate the parser behind one small internal module (`src/_dom.ts`) exposing the
   handful of traversal primitives the rest of the code uses. Swapping parsers should
   touch one file.

> Packaging gotcha inherited from the crawler: `scripts/build-npm.ts` uses
> `versionizeDeps([""])`, which carries **no** runtime deps into the npm `package.json`.
> The parser must be added to that list or the npm build ships broken.

---

## 3. Public surface (sketch)

```ts
/** The primary call: everything, composed. */
function extract(html: string, options?: ExtractOptions): ExtractedDocument;

/** The granular pieces — each usable standalone, each used by extract(). */
function extractMetadata(html: string, options?: { url?: string }): Metadata;
function extractJsonLd(html: string): unknown[];
function extractEmbeddedJson(
	html: string,
	options?: EmbeddedJsonOptions,
): Record<string, unknown>;
function extractMainContent(
	html: string,
	options?: MainContentOptions,
): MainContent | null;
function toMarkdown(html: string, options?: MarkdownOptions): string;
function toText(html: string, options?: TextOptions): string;
function clean(html: string, options?: CleanOptions): string;
function pick<T>(html: string, selectors: SelectorMap, options?: PickOptions): T;
```

### Options

```ts
interface ExtractOptions {
	/** Absolute URL of the document. Used to resolve relative links/images and to fill
	 *  metadata gaps. Optional — everything still works without it, minus resolution. */
	url?: string;
	/** Skip main-content extraction (metadata-only fast path). Default false. */
	content?: boolean;
	/** Per-site override: if this selector matches, its subtree IS the main content and
	 *  the scoring heuristic is skipped entirely. The escape hatch for sites the
	 *  heuristic gets wrong. */
	contentSelector?: string;
	metadata?: boolean; // default true
	jsonLd?: boolean; // default true
	embeddedJson?: boolean; // default true
	markdown?: MarkdownOptions;
	text?: TextOptions;
	logger?: Logger;
}
```

### Result

```ts
interface ExtractedDocument {
	title?: string;
	lang?: string;
	metadata: Metadata;
	/** Parsed JSON-LD blocks, in document order. Never throws on malformed JSON — bad
	 *  blocks are skipped (and logged at debug). */
	jsonLd: unknown[];
	/** Framework state blobs, keyed by source: "__NEXT_DATA__", "__NUXT__", … */
	embeddedJson: Record<string, unknown>;
	/** null when no main content could be identified (e.g. a nav-only page). */
	content: MainContent | null;
}

interface MainContent {
	/** The extracted subtree, serialized. Cleaned but still HTML. */
	html: string;
	/** LAZY + MEMOIZED — conversion only runs if you ask for it. */
	markdown(): string;
	text(): string;
	/** Rough signals, useful for deciding whether extraction succeeded. */
	textLength: number;
	linkDensity: number;
	/** Which strategy produced this: the fast path, the selector override, or scoring. */
	via: "selector" | "semantic" | "scored";
}

interface Metadata {
	title?: string;
	description?: string;
	canonical?: string; // absolute when `url` was given
	lang?: string;
	siteName?: string;
	author?: string;
	publishedAt?: string; // ISO 8601 when parseable, else raw
	modifiedAt?: string;
	image?: string; // absolute when `url` was given
	favicon?: string;
	type?: string; // og:type
	openGraph: Record<string, string>;
	twitter: Record<string, string>;
	/** Everything else, raw: name/property → content. */
	meta: Record<string, string>;
}
```

**`markdown()`/`text()` are lazy memoized accessors, not eager strings** — deliberately
mirroring page-fetcher's `text()`/`bytes()`. Callers who only want metadata must not pay
for markdown conversion of a 2 MB document.

---

## 4. Metadata & structured data — do this first

This is the highest-value, lowest-risk part: fully deterministic, no heuristics, no
judgment calls. It is also, for JavaScript-rendered sites, frequently **the best data on
the page** — a framework-rendered product page usually carries a complete JSON-LD
`Product` block or a `__NEXT_DATA__` payload that is cleaner than anything scraped out
of the DOM text.

- Precedence for each metadata field: explicit `<meta>` → OpenGraph → Twitter → JSON-LD
  → `<title>`/first `<h1>`. Document the chain; make it predictable, not clever.
- Resolve `canonical`, `image`, `favicon` against `options.url` when given.
- Dates: attempt ISO-8601 normalization, but **keep the raw string when parsing fails**
  rather than dropping the value.
- JSON-LD: a document may hold several blocks, and `@graph` wrappers are common. Return
  them parsed and in order; do not merge or interpret. Malformed blocks are skipped.
- Embedded JSON: match a configurable set of known patterns (`__NEXT_DATA__`,
  `__NUXT__`, `window.__APOLLO_STATE__`, `__INITIAL_STATE__`). These live in inline
  `<script>` bodies and need tolerant extraction of the JSON substring — not `eval`,
  ever. If the substring does not `JSON.parse`, skip it silently.

---

## 5. Main-content extraction — the fuzzy part

Three strategies, tried in order. Record which one won in `MainContent.via`.

1. **Selector override** (`contentSelector`) — if given and it matches, use it. No
   scoring. This exists because heuristics fail and users need a way out.
2. **Semantic fast path** — `<main>`, `[role=main]`, `<article>`. When a page uses
   semantic HTML honestly, that markup is authoritative and beats any scoring. Guard
   with a minimum text length so an empty `<main>` shell (common in SPAs) doesn't win.
3. **Scoring** (readability-style) — the fallback:
   - Strip non-content outright: `script`, `style`, `noscript`, `nav`, `header`,
     `footer`, `aside`, `form`, `iframe`, `svg`.
   - Score candidate blocks by text length, comma count, and tag weight.
   - **Link density is the strongest single signal** — a block whose text is mostly
     inside `<a>` is navigation, whatever else it looks like.
   - Class/id hints: `content|article|post|entry|body|main` positive;
     `nav|sidebar|comment|footer|ad|promo|share|related|cookie|banner` negative.
   - Propagate scores to ancestors (parent full, grandparent half).
   - Take the top candidate, then append siblings scoring above a fraction of it —
     this is what recovers multi-`<div>` articles.

**Be honest in the docs that this is heuristic and will sometimes be wrong.** That is
precisely why `contentSelector` and the granular functions exist. `extract()` returning
`content: null` is a legitimate, expected outcome — not an error.

---

## 6. HTML → markdown / text — where the bugs live

Write these against the already-parsed tree. **Do not add `turndown`**: it wants its own
DOM, would be a second dependency with overlapping responsibilities, and brings its own
quirks — while we already hold a tree and want control over exactly the cases below.

Markdown, non-negotiable details:

- `<pre>`/`<code>`: preserve whitespace **exactly**, fence with backticks, never escape
  content, never collapse. This is the single most commonly botched case.
- Links/images: resolve `href`/`src` against `options.url` when given; emit
  `[text](url)` / `![alt](src)`.
- Nested lists: correct indentation per level; `<ol>` numbering continues correctly.
- Tables → GFM tables **only when rectangular**; a table with `colspan`/`rowspan` or
  ragged rows should degrade to passthrough HTML rather than emit broken markdown.
- Escape markdown-significant characters (`*_[]()#` ``) in text nodes.
- `<br>` → hard break; `<hr>` → `---`; collapse runs of blank lines to at most one.

Plain text:

- Block elements produce newlines, inline elements produce spaces. `<div>a</div><div>b</div>`
  must yield `a\nb`, never `ab` — this is why a regex tag-strip is not acceptable.
- Collapse whitespace runs but preserve paragraph breaks; `<pre>` preserved verbatim.
- Decode entities.

---

## 7. `clean()` is NOT a sanitizer — read this before implementing

`clean()` performs **structural** cleanup for downstream processing: drop `script`,
`style`, `noscript`, comments, event-handler attributes, and empty wrappers, and
optionally restrict to a tag allowlist. Its purpose is to make HTML pleasant to convert
or store.

**It is explicitly not an XSS sanitizer and must be documented as such, loudly, in the
JSDoc and the README.** Making untrusted HTML safe to render in a browser is a
security-critical problem with a long tail of mutation-XSS and namespace-confusion
attacks; a bespoke allowlist walker will get it wrong. If the caller intends to _render_
crawled HTML, the docs must point at DOMPurify (with a real DOM) and say plainly that
this package does not cover that case.

Shipping a function that _looks_ like a sanitizer without saying this is the single
worst outcome available in this package's design space.

---

## 8. `pick()` — thin by design

```ts
type SelectorSpec = string | {
	selector: string;
	attr?: string;
	all?: boolean;
	trim?: boolean;
};
type SelectorMap = Record<string, SelectorSpec>;

pick(html, {
	title: "h1",
	price: { selector: ".price", attr: "data-value" },
	tags: { selector: ".tag", all: true },
});
// → { title: "…", price: "…", tags: ["…", "…"] }
```

Text content by default, `attr` for attributes, `all` for arrays, missing selectors give
`undefined` (never throw). **That is the whole feature.** No nesting, no transforms, no
conditionals, no config files — the moment those appear, the non-goal in §1 has been
violated. Callers who need more compose plain functions.

---

## 9. Robustness contract

- **Nothing in the public API throws on malformed input.** Broken markup, truncated
  documents, mismatched tags, binary noise — all yield a degraded result, never an
  exception. A caller processing 50,000 crawled pages must never have one bad page kill
  the batch. Mirror the crawler's `extractLinks` guarantee.
- Only genuine programmer errors (wrong argument type) may throw.
- Bound the work: cap input size (default ~10 MB, matching page-fetcher's default body
  cap), cap `pick()` result counts, cap recursion depth on pathological nesting.
- Idempotency where meaningful: `toText(toText(x))` is not sensible, but
  `clean(clean(x)) === clean(x)` should hold and is worth a test.

---

## 10. Integration with the crawler (the motivating use case)

Two seams, both of which already exist in the crawler — **no crawler changes are
required**:

**Inline, during the crawl** — `onPage` returns extracted data, which the crawler stores
in `__crawler_page.data` (JSONB). One pass, no body re-read. Note the JSON-serializable
constraint on that column.

```ts
onPage: (async (res) => extract(await res.text(), { url: res.finalUrl }));
```

**Post-hoc, over stored bodies** — the crawler's `./pg` layer archives raw bodies
latest-per-URL. Read them back and extract offline, as many times as the rules change.
**This is the whole reason the crawler stores bodies**: crawls are expensive and
rate-limited, extraction rules churn weekly. Re-extraction must never require re-crawling.

Two notes specific to JavaScript-rendered sites (the driving use case):

- Bodies fetched through page-fetcher's browser adapter are the **post-JS serialized
  DOM**, so `__NEXT_DATA__`-style blobs and hydrated content are present. Good input.
- A rendered DOM makes a **noisy change signal** — timestamps, ad slots and hydration
  markers move on every fetch, so the crawler's raw-body `content_hash` over-reports
  changes. A hash of _extracted text_ is a far better "did this page actually change?"
  fingerprint. Worth offering as a documented recipe.

---

## 11. Testing

- **Fixture corpus of real-world messy HTML** — `tests/fixtures/` with a directory per
  case, same pattern the crawler uses. Include: a news article, a docs page, an
  e-commerce product page with JSON-LD, a Next.js-rendered page with `__NEXT_DATA__`, a
  nav-heavy page with no real content, a page with tables and code blocks, and at least
  two genuinely broken documents.
- **Golden-file tests** for markdown/text output — easy to review in diffs, and they
  make regressions in the whitespace rules obvious.
- **Never-throws fuzz** over truncated/mutated fixtures.
- **Main-content assertions must be fuzzy**: assert the result _contains_ a known body
  phrase and _excludes_ a known nav/footer phrase, rather than matching exact output.
  Exact-output tests on a heuristic are a maintenance trap.
- All tests are pure and offline. No network, no PG, no browser.

---

## 12. Open questions to resolve before v1

1. **Parser choice** — `linkedom` recommended above; confirm it npm-builds cleanly
   through `@marianmeres/npmbuild` before committing to it.
2. **Does `clean()` ship at all?** Given §7, an alternative is to drop it and expose only
   the internal cleanup used by content extraction, removing the temptation to
   misread it as a security boundary.
3. **Ragged tables in markdown** — passthrough HTML (recommended), best-effort GFM, or
   skip entirely?
4. **Should `extract()` return a content fingerprint** (hash of extracted text) directly,
   given §10's change-detection use case, or leave it to the caller?
5. **Language detection** — out of scope entirely (recommended: report the `lang`
   attribute and nothing more), or ship a small n-gram detector?
6. **Is `pick()` in v1 at all**, or deferred until a real need appears? It is the item
   most likely to attract scope creep.

---

## 13. Implementation order

Deliberately **deterministic-before-fuzzy**: the reliable, no-heuristic parts land first
and are independently useful. For JS-rendered sites, steps 2–3 alone may cover the
motivating use case entirely.

1. Parser adapter (`src/_dom.ts`) + traversal primitives + the never-throws harness.
2. `extractMetadata` + `extractJsonLd` + `extractEmbeddedJson` — deterministic, high
   value, no judgment calls.
3. `toText` — the whitespace/block rules, with golden fixtures.
4. `toMarkdown` — the §6 detail list, with golden fixtures.
5. `extractMainContent` — semantic fast path first, then the scoring heuristic.
6. `clean()` (subject to open question 2) and `pick()` (subject to open question 6).
7. `extract()` composition + the lazy memoized accessors.
8. Fixture corpus rounded out; fuzz suite.
9. README (per `HUMAN_DOCUMENTATION_GUIDE.md`), `AGENTS.md` (per
   `AGENT_DOCUMENTATION_GUIDE.md`), the §10 crawler-integration recipes, JSR/npm publish
   config incl. the `versionizeDeps` fix.
