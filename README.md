# @marianmeres/html-extract

[![NPM](https://img.shields.io/npm/v/@marianmeres/html-extract)](https://www.npmjs.com/package/@marianmeres/html-extract)
[![JSR](https://jsr.io/badges/@marianmeres/html-extract)](https://jsr.io/@marianmeres/html-extract)
[![License](https://img.shields.io/npm/l/@marianmeres/html-extract)](LICENSE)

HTML string in, structured content out: metadata, embedded structured data, the main
content with boilerplate removed, and that content rendered as markdown or plain text.

No network, no JavaScript execution, no persistence — pure functions over a string.

## Installation

```bash
deno add jsr:@marianmeres/html-extract
```

```bash
npm install @marianmeres/html-extract
```

## Usage

```typescript
import { extract } from "@marianmeres/html-extract";

const doc = extract(html, { url: "https://example.com/blog/post-1" });

doc.title; // "How we cut our build time in half"
doc.metadata.publishedAt; // "2024-03-12T06:41:00.000Z"
doc.metadata.openGraph.image; // "https://example.com/og/post-1.png"
doc.jsonLd; // [ { "@type": "BlogPosting", … } ]
doc.embeddedJson.__NEXT_DATA__; // { props: { pageProps: … } }
doc.microdata; // [ { type: ["https://schema.org/Product"], properties: … } ]

doc.content?.via; // "semantic" | "selector" | "scored"
doc.content?.markdown(); // converted on demand, then memoized
doc.content?.text();
```

Every piece is also available on its own — `extract()` is only the composition:

```typescript
import {
	clean,
	extractEmbeddedJson,
	extractJsonLd,
	extractMainContent,
	extractMetadata,
	extractMicrodata,
	pick,
	toMarkdown,
	toText,
} from "@marianmeres/html-extract";

extractMetadata(html, { url }); // deterministic, no heuristics
extractJsonLd(html); // parsed blocks, in document order
extractEmbeddedJson(html); // __NEXT_DATA__, __NUXT__, Apollo, …
extractMicrodata(html, { url }); // itemscope/itemprop trees
extractMainContent(html, { url }); // readability-style, or null
toMarkdown(html, { url }); // GFM
toText(html); // block-aware plain text
clean(html); // structural cleanup — NOT a sanitizer, see below
pick(html, { price: { selector: ".price", attr: "data-value" } });
```

## What it is for

This is the **document** layer of a three-package pipeline, and a _sibling_ of the
crawler rather than a layer on top of it:

| Package                                                                 | Job                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`@marianmeres/page-fetcher`](https://jsr.io/@marianmeres/page-fetcher) | transport — fetch one URL, normalized result                        |
| [`@marianmeres/crawler`](https://jsr.io/@marianmeres/crawler)           | orchestration — links, scope, depth, politeness, jobs, persistence  |
| **`@marianmeres/html-extract`**                                         | **document — HTML in, structured content out** (depends on neither) |

Because it depends on neither, it works just as well on an email body, a file from
disk, or a single hand-fetched string.

### Out of scope, on purpose

Fetching, charset decoding, JavaScript execution, a scraping DSL, semantic understanding
(summarize/classify — that is [`@marianmeres/llm-task`](https://jsr.io/@marianmeres/llm-task)),
persistence, non-HTML formats, and XSS sanitization (see below).

## Main-content extraction is a heuristic

`extractMainContent()` tries three strategies in order and tells you which one won in
`via`:

1. **`contentSelector`** — if you gave one and it matches, that subtree _is_ the content.
2. **semantic** — `<main>`, `[role=main]`, `<article>`, when they carry enough text.
3. **scored** — readability-style scoring: text length, comma count, tag weight,
   class/id hints, and link density (a block whose text is mostly link text is
   navigation, whatever else it looks like).

**It will sometimes be wrong.** That is exactly why `contentSelector` exists, and why
every granular function is exported. `content: null` — a nav-only page, an unhydrated
SPA shell — is a legitimate, expected outcome, not an error.

```typescript
// the escape hatch for a site the heuristic gets wrong
extract(html, { url, contentSelector: "#article-body" });
```

## `clean()` is NOT an XSS sanitizer

`clean()` does **structural** cleanup for downstream processing: it drops `script`,
`style`, `noscript`, `template`, comments, event-handler attributes and empty wrappers,
and can restrict the result to a tag allowlist. Its purpose is to make HTML pleasant to
convert or store.

**It does not make untrusted HTML safe to render in a browser, and it must not be used
for that.** Making crawled HTML safe to render is a security-critical problem with a long
tail of mutation-XSS and namespace-confusion attacks; a bespoke allowlist walker will get
it wrong. If you intend to _render_ HTML you did not write, use
[DOMPurify](https://github.com/cure53/DOMPurify) against a real DOM, and treat this
package's output as untrusted input to it.

## Robustness

Nothing in the public API throws on malformed input. Broken markup, truncated documents,
mismatched tags, binary noise — all yield a degraded result. A caller processing 50 000
crawled pages must never have one bad page kill the batch.

Only a genuine programmer error throws: passing something that is not a string raises a
`TypeError`.

Work is bounded: input is truncated at `maxSize` (default 10 MB, matching page-fetcher's
default body cap), `pick()` array results are capped, and deeply nested documents are
walked iteratively rather than recursively.

## Logging

Every function accepts an optional `logger` (the `Logger` interface from
[`@marianmeres/clog`](https://jsr.io/@marianmeres/clog); `console` satisfies it). The
default is `undefined` — completely silent, as a pure library should be.

```typescript
import { createClog } from "@marianmeres/clog";

const doc = extract(html, { url, logger: createClog("html-extract") });
// [html-extract] metadata: 12 meta tag(s) -> 5 og, 2 twitter, 4 other, 1 skipped
// [html-extract] metadata: title from og:title
// [html-extract] metadata: publishedAt from article:published_time
// [html-extract] json-ld: 1 block(s)
// [html-extract] main content: semantic main won (1 match(es), 983 chars of text)
// [html-extract] main content: via=semantic
```

`debug` explains _why_ the output looks the way it does — which strategy won, what was
skipped, which JSON-LD block was malformed. `warn` is reserved for genuinely surprising
input (truncation, an invalid selector you passed).

## Using it with the crawler

Two seams, both of which already exist — no crawler changes required.

**Inline, during the crawl.** `onPage` returns extracted data, which the crawler stores
in `__crawler_page.data` (JSONB). One pass, no body re-read — the body lives on
`ctx.fetchResult`, because `PageResult` deliberately carries none:

```typescript
const options: CrawlOptions = {
	onPage: async (res, ctx) => {
		const html = (await ctx.fetchResult?.text()) ?? "";
		return html ? extract(html, { url: res.finalUrl }) : null;
	},
};
```

`JSON.stringify` on the result materializes `content.markdown()` and `content.text()`
(via `toJSON()`), so nothing is silently lost on the way into the column — while a
caller who never serializes never pays for the conversion.

**Post-hoc, over stored bodies.** The crawler archives raw bodies latest-per-URL; read
them back and re-extract offline as many times as your rules change. Crawls are expensive
and rate-limited, extraction rules churn weekly — re-extraction must never require
re-crawling.

**Change detection.** A rendered DOM is a noisy change signal: timestamps, ad slots and
hydration markers move on every fetch, so a hash of the raw body over-reports changes. A
hash of the _extracted text_ is a far better "did this page actually change?"
fingerprint:

```typescript
const text = extract(html, { url }).content?.text() ?? "";
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
const fingerprint = [...new Uint8Array(digest)]
	.map((b) => b.toString(16).padStart(2, "0"))
	.join("");
```

## API

See [API.md](API.md) for the complete API reference.

## License

[MIT](LICENSE)
