# API

Everything is exported from the package root. Every function is pure, synchronous, and
never throws on malformed HTML — only a wrong argument _type_ raises a `TypeError`.

Options common to all functions ([`BaseOptions`](#baseoptions)):

- `logger` (`Logger`, optional) — console-compatible logger. Default: `undefined`
  (silent).
- `maxSize` (`number`, optional) — input is truncated to this many characters. Default:
  `10_000_000`. `Infinity` disables the cap.

---

## Functions

### `extract(html, options?)`

Metadata, structured data and main content in a single parse. The document is parsed
once and every extractor runs against the same tree.

**Parameters:**

- `html` (`string`) — a decoded HTML document or fragment
- `options` ([`ExtractOptions`](#extractoptions), optional)
  - `options.url` (`string`) — absolute URL of the document; used to resolve relative
    links/images and fill metadata gaps
  - `options.content` (`boolean`) — run main-content extraction. Default: `true`;
    `false` is the metadata-only fast path
  - `options.contentSelector` (`string`) — per-site override; if it matches, that subtree
    _is_ the content and scoring is skipped
  - `options.minTextLength` (`number`) — minimum text length for a content candidate.
    Default: `140`
  - `options.metadata` / `options.jsonLd` / `options.embeddedJson` /
    `options.microdata` (`boolean`) — Default: `true`
  - `options.embeddedJsonOptions` (`{ keys?, maxScriptSize? }`) — forwarded to
    [`extractEmbeddedJson`](#extractembeddedjsonhtml-options)
  - `options.markdown` ([`MarkdownOptions`](#markdownoptions)) — forwarded to the lazy
    `content.markdown()`
  - `options.text` ([`TextOptions`](#textoptions)) — forwarded to the lazy
    `content.text()`

**Returns:** [`ExtractedDocument`](#extracteddocument)

**Example:**

```typescript
const doc = extract(html, { url: "https://example.com/post/1" });
doc.title;
doc.metadata.publishedAt;
doc.jsonLd;
doc.embeddedJson.__NEXT_DATA__;
doc.content?.markdown(); // rendered only if you ask
```

---

### `extractMetadata(html, options?)`

Normalized document metadata. Fully deterministic — no heuristics, no judgment calls.

**Parameters:**

- `html` (`string`)
- `options` ([`MetadataOptions`](#metadataoptions), optional)
  - `options.url` (`string`) — base for resolving `canonical`, `image` and `favicon`. A
    document's own `<base href>` wins over it, exactly as in a browser.

**Returns:** [`Metadata`](#metadata)

**Precedence**, per field — explicit `<meta>`, then OpenGraph, then Twitter, then JSON-LD,
then document fallbacks:

| Field         | Chain                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | `meta[name=title]` → `og:title` → `twitter:title` → JSON-LD `headline` (any node) / `name` (content nodes only) → `<title>` → first `<h1>`                                                               |
| `description` | `meta[name=description]` → `og:description` → `twitter:description` → JSON-LD `description`                                                                                                              |
| `canonical`   | `link[rel=canonical]` → `og:url` → JSON-LD `url`                                                                                                                                                         |
| `lang`        | `<html lang>` → `meta[http-equiv=content-language]` → `og:locale`                                                                                                                                        |
| `siteName`    | `og:site_name` → `meta[name=application-name]` → JSON-LD `publisher.name`                                                                                                                                |
| `author`      | `meta[name=author]` → `article:author` → JSON-LD `author.name` → `twitter:creator`                                                                                                                       |
| `publishedAt` | `article:published_time` → `meta[name=date]` → `meta[name=pubdate]` → `meta[name=publish-date]` → `meta[itemprop=datePublished]` → JSON-LD → `<time datetime>`                                           |
| `modifiedAt`  | `article:modified_time` → `og:updated_time` → `meta[name=last-modified]` → `meta[itemprop=dateModified]` → JSON-LD `dateModified`                                                                        |
| `image`       | `og:image` → `og:image:url` → `twitter:image` → `twitter:image:src` → `link[rel=image_src]` → JSON-LD `image`                                                                                            |
| `favicon`     | `link[rel~=icon]` — token-based, so `rel="shortcut icon"` matches here too and document order decides → `link[rel=apple-touch-icon]` → `link[rel=mask-icon]` → `/favicon.ico` (only when `url` is given) |
| `type`        | `og:type`                                                                                                                                                                                                |

JSON-LD is only half-trusted. `headline`, `author`, `datePublished` and `dateModified`
are read from any node; the generic keys `name`, `url`, `description` and `publisher`
are read **only** from a node whose `@type` names page content (`Article` and friends,
any `…Page`, `Product`, `Recipe`, `Event`). On a page whose only JSON-LD is an
`Organization`, `WebSite` or `BreadcrumbList` — the CMS baseline on much of the web —
those steps are skipped entirely, so the publisher's name never becomes the title and
the site's homepage never becomes the canonical.

Dates are normalized to ISO 8601 only when the value matches a **recognised shape** —
ISO 8601, or an RFC 2822 / HTTP-date carrying an explicit zone — and are otherwise
**kept raw**: an unparseable date is still information, and `03/05/2024` is a day the
world disagrees about. A recognised value with a time but no zone is read as UTC. This
is deliberately stricter than `Date.parse`, which resolves `"March 2024"` against the
_host_ timezone and so gives the same document a different date on different machines.

**Example:**

```typescript
const meta = extractMetadata(html, { url: "https://example.com/post/1" });
meta.title;
meta.openGraph.image; // og:* keyed without the prefix
meta.twitter.card;
meta.meta["article:section"]; // everything else, raw
```

---

### `extractJsonLd(html, options?)`

Every `<script type="application/ld+json">` block, parsed, **in document order and
uninterpreted**. No merging, no `@graph` unwrapping, no schema.org awareness. Malformed
blocks are skipped (logged at `debug`); comment/CDATA wrappers and a trailing semicolon
are unwrapped first.

**Returns:** `unknown[]`

**Example:**

```typescript
const blocks = extractJsonLd(html);
const product = blocks.find((b) => (b as any)["@type"] === "Product");
```

---

### `flattenJsonLd(blocks)`

Flattens JSON-LD blocks into the plain object nodes they contain: top-level arrays are
spread and `@graph` wrappers expanded one level. The convenience
[`extractJsonLd`](#extractjsonldhtml-options) deliberately refuses to do.

**Returns:** `Record<string, unknown>[]`

---

### `extractEmbeddedJson(html, options?)`

Framework/state blobs, keyed by the global they were assigned to.

Looks for each key in two places: a `<script type="application/json" id="KEY">` block,
and a `KEY = {…}` / `window.KEY = {…}` / `KEY = JSON.parse("…")` assignment in an inline
script. The value is located textually and handed to `JSON.parse` — **nothing is ever
evaluated**, so non-JSON payloads (Nuxt 2's IIFE, for example) are skipped rather than
misread.

**Parameters:**

- `options.keys` (`string[]`) — replaces (does not merge with)
  [`DEFAULT_EMBEDDED_JSON_KEYS`](#default_embedded_json_keys)
- `options.maxScriptSize` (`number`) — skip inline scripts longer than this. Default:
  `2_000_000`

**Returns:** `Record<string, unknown>`

---

### `extractMicrodata(html, options?)`

HTML microdata (`itemscope`/`itemtype`/`itemprop`) as plain objects, in document order.

Each top-level `itemscope` element becomes one [`MicrodataItem`](#microdataitem); an
element carrying both `itemprop` and `itemscope` is a _nested value_ of its owner, not a
top-level item. Every property is an **array** — microdata lets a name repeat, and a
shape that changes from string to array depending on the page is worse than one that is
always an array.

URL-valued attributes (`href`, `src`, `data`) are resolved against `options.url`, with
the document's own `<base href>` winning. `itemref` is **not** supported: it is rare, it
makes the walk quadratic in the pathological case, and its absence costs a missing
property rather than a wrong one.

**Parameters:**

- `options.url` (`string`) — base for resolving URL-valued properties
- `options.maxItems` (`number`) — cap on top-level items. Default: `1000`

**Returns:** [`MicrodataItem[]`](#microdataitem) — each item's `properties` is a
**null-prototype** object, so an `itemprop` named `toString` or `constructor` is an
ordinary key. Read it as a dictionary; use `Object.hasOwn(props, k)` rather than
`props.hasOwnProperty(k)`.

**Example:**

```typescript
const items = extractMicrodata(html, { url });
const product = items.find((i) => i.type?.some((t) => t.endsWith("/Product")));
product?.properties.sku?.[0]; // "BW-4471"
```

---

### `extractMainContent(html, options?)`

The main content of the document, boilerplate removed — **a heuristic**, and honestly
so. Returns `null` when no content could be identified.

**Parameters:**

- `options.url` (`string`) — resolves links/images in the markdown and text renderings
- `options.selector` (`string`) — per-site override; same thing as
  `ExtractOptions.contentSelector`
- `options.minTextLength` (`number`) — Default: `140`
- `options.markdown` / `options.text` — forwarded to the lazy accessors

**Returns:** [`MainContent`](#maincontent) | `null`

**Strategies**, tried in order, reported in `via`:

1. `"selector"` — `options.selector` matched; no scoring at all.
2. `"semantic"` — `<main>`, `[role=main]` or `<article>`, when it carries at least
   `minTextLength` characters. The minimum is what stops an empty `<main>` shell (common
   in unhydrated SPA markup) from "successfully" extracting nothing.
3. `"scored"` — readability-style scoring: text length, comma count, tag weight, class/id
   hints, then multiplied by `(1 - linkDensity)`. Siblings scoring above a fraction of
   the winner are appended, which is what recovers articles split across sibling `<div>`s.

**Example:**

```typescript
const content = extractMainContent(html, { url });
if (!content) return; // nav-only page — expected, not an error
content.via; // "scored"
content.linkDensity; // 0.07
content.markdown(); // lazy + memoized
```

---

### `toMarkdown(html, options?)`

HTML → GitHub-flavoured markdown, rendered from the parsed tree (no `turndown`).

**Parameters:**

- `options.url` (`string`) — resolves relative `href`/`src`
- `options.links` (`boolean`) — Default: `true`; `false` renders link text only
- `options.images` (`boolean`) — Default: `true`; `false` drops images
- `options.escape` (`boolean`) — Default: `true`; minimal, context-aware escaping
- `options.bullet` (`"-" | "*" | "+"`) — Default: `"-"`

**Returns:** `string`

**Behaviour worth knowing:**

- `<pre>`/`<code>` whitespace is preserved exactly, never escaped, and the fence widens
  when the content itself contains backticks. The language comes from
  `class="language-x"`.
- Tables become GFM **only when rectangular**; a table with `colspan`/`rowspan` or ragged
  rows degrades to passthrough HTML rather than emitting broken markdown.
- Nested lists indent by the parent's marker width; `<ol start>` and `<li value>` are
  honoured. A nested `<ul>`/`<ol>` that sits directly inside a list rather than inside an
  `<li>` — invalid markup a browser still renders — is attached to the previous item
  rather than dropped.
- `<dl>` becomes `**Term**` followed by its definitions as a list: markdown has no
  definition list, and plain indented lines collapse into one run-on paragraph.
- A non-rectangular table's HTML passthrough is structurally cleaned first (no
  `<script>`/`<style>`/comments) and emitted without blank lines, because a blank line
  ends a CommonMark HTML block and the rest of the table would render as literal source.
- `<br>` becomes a backslash hard break (survives trailing-whitespace stripping),
  `<hr>` becomes `---`, and runs of blank lines collapse to one.
- Escaping also covers a line-leading `~` (an unescaped run opens a code fence that
  swallows the rest of the document), and two adjacent same-delimiter emphasis runs are
  separated by an empty HTML comment so they do not fuse into literal asterisks.
- `<textarea>` content is entity-decoded on read (HTML5 RCDATA); `<xmp>` is not (RAWTEXT
  — `&amp;` really is five characters there).

---

### `toText(html, options?)`

HTML → plain text, block-aware: `<div>a</div><div>b</div>` yields `a\nb`, never `ab`.

**Parameters:**

- `options.preserveCode` (`boolean`) — keep `<pre>` verbatim. Default: `true`

**Returns:** `string`

Paragraph-level blocks are separated by a blank line, other blocks by a newline, table
cells by a tab. Whitespace runs collapse; `<pre>` does not.

---

### `clean(html, options?)`

Structural cleanup for downstream processing. **Not an XSS sanitizer** — see the
[README](README.md#clean-is-not-an-xss-sanitizer) and the function's JSDoc.

**Parameters:**

- `options.allowTags` (`string[]`) — only these tags survive; others are _unwrapped_
  (children kept), never deleted
- `options.dropTags` (`string[]`) — dropped with their subtree, on top of the always
  dropped `script`, `style`, `noscript`, `template`
- `options.keepComments` (`boolean`) — Default: `false`
- `options.dropEmpty` (`boolean`) — Default: `true`
- `options.dropEventHandlers` (`boolean`) — Default: `true`; drops `on*` attributes and
  `javascript:` URLs

**Returns:** `string` — the document's body content (a fragment in gives a fragment out)

`clean(clean(x)) === clean(x)` holds, and is covered by tests.

---

### `pick(html, selectors, options?)`

A thin CSS-selector field picker. Text content by default, `attr` for attributes, `all`
for arrays, `undefined` for anything missing. **That is the whole feature** — no nesting,
no transforms, no conditionals, no config files. Callers who need more compose plain
functions.

**Parameters:**

- `selectors` ([`SelectorMap`](#selectorspec--selectormap)) — field name → selector spec
- `options.maxAll` (`number`) — cap on `all` results. Default: `1000`
- `options.trim` (`boolean`) — Default: `true`

**Returns:** `T` (a convenience cast, not a validated shape)

**Example:**

```typescript
pick(html, {
	title: "h1",
	price: { selector: ".price", attr: "data-value" },
	tags: { selector: ".tag", all: true },
});
// → { title: "…", price: "89.90", tags: ["…", "…"] }
```

---

## Types

### `ExtractedDocument`

```typescript
interface ExtractedDocument {
	title?: string;
	lang?: string;
	metadata: Metadata;
	jsonLd: unknown[];
	embeddedJson: Record<string, unknown>;
	microdata: MicrodataItem[];
	content: MainContent | null;
}
```

### `MainContent`

```typescript
interface MainContent {
	html: string; // the extracted subtree, cleaned but still HTML
	markdown(): string; // lazy + memoized
	text(): string; // lazy + memoized
	textLength: number;
	linkDensity: number; // 0–1, fraction of text inside <a>
	via: "selector" | "semantic" | "scored";
	toJSON(): {
		html: string;
		markdown: string;
		text: string;
		textLength: number;
		linkDensity: number;
		via: MainContentVia;
	};
}
```

`toJSON()` materializes the lazy renderings so `JSON.stringify()` is not silently lossy —
which is what makes storing the result in a JSONB column work. A caller who never
serializes never pays for the conversion.

### `Metadata`

```typescript
interface Metadata {
	title?: string;
	description?: string;
	canonical?: string; // absolute when resolvable
	lang?: string;
	siteName?: string;
	author?: string;
	publishedAt?: string; // ISO 8601 when parseable, else raw
	modifiedAt?: string;
	image?: string; // absolute when resolvable
	favicon?: string;
	type?: string; // og:type
	openGraph: Record<string, string>; // keyed without the "og:" prefix
	twitter: Record<string, string>; // keyed without the "twitter:" prefix
	meta: Record<string, string>; // everything else, raw
}
```

Absent fields are `undefined`, never `""`. The three maps are always present.

### `BaseOptions`

```typescript
interface BaseOptions {
	logger?: Logger;
	maxSize?: number;
}
```

### `ExtractOptions`

```typescript
interface ExtractOptions extends BaseOptions {
	url?: string;
	content?: boolean; // default true
	contentSelector?: string;
	minTextLength?: number; // default 140
	metadata?: boolean; // default true
	jsonLd?: boolean; // default true
	embeddedJson?: boolean; // default true
	microdata?: boolean; // default true
	embeddedJsonOptions?: { keys?: string[]; maxScriptSize?: number };
	markdown?: MarkdownOptions;
	text?: TextOptions;
}
```

### `MetadataOptions`

```typescript
interface MetadataOptions extends BaseOptions {
	url?: string;
}
```

### `MainContentOptions`

```typescript
interface MainContentOptions extends BaseOptions {
	url?: string;
	selector?: string;
	minTextLength?: number; // default 140
	markdown?: MarkdownOptions;
	text?: TextOptions;
}
```

### `MicrodataItem`

```typescript
interface MicrodataItem {
	type?: string[]; // itemtype tokens
	id?: string; // itemid
	properties: Record<string, (string | MicrodataItem)[]>;
}
```

### `MicrodataOptions`

```typescript
interface MicrodataOptions extends BaseOptions {
	url?: string;
	maxItems?: number; // default 1000
}
```

### `MarkdownOptions`

```typescript
interface MarkdownOptions extends BaseOptions {
	url?: string;
	links?: boolean; // default true
	images?: boolean; // default true
	escape?: boolean; // default true
	bullet?: "-" | "*" | "+"; // default "-"
}
```

### `TextOptions`

```typescript
interface TextOptions extends BaseOptions {
	preserveCode?: boolean; // default true
}
```

### `CleanOptions`

```typescript
interface CleanOptions extends BaseOptions {
	allowTags?: string[];
	dropTags?: string[];
	keepComments?: boolean; // default false
	dropEmpty?: boolean; // default true
	dropEventHandlers?: boolean; // default true
}
```

### `EmbeddedJsonOptions`

```typescript
interface EmbeddedJsonOptions extends BaseOptions {
	keys?: string[]; // replaces DEFAULT_EMBEDDED_JSON_KEYS
	maxScriptSize?: number; // default 2_000_000
}
```

### `SelectorSpec` / `SelectorMap`

```typescript
type SelectorSpec = string | {
	selector: string;
	attr?: string;
	all?: boolean;
	trim?: boolean;
};

type SelectorMap = Record<string, SelectorSpec>;
```

### `PickOptions`

```typescript
interface PickOptions extends BaseOptions {
	maxAll?: number; // default 1000
	trim?: boolean; // default true
}
```

### `MainContentVia`

```typescript
type MainContentVia = "selector" | "semantic" | "scored";
```

### `Logger`

The console-compatible logger interface from
[`@marianmeres/clog`](https://jsr.io/@marianmeres/clog), re-exported so you can type your
own logger without depending on clog. The import is type-only — no clog code is pulled in
at runtime, and `console` satisfies it as-is.

```typescript
interface Logger {
	debug: (...args: any[]) => any;
	log: (...args: any[]) => any;
	warn: (...args: any[]) => any;
	error: (...args: any[]) => any;
}
```

---

## Constants

### `DEFAULT_MAX_SIZE`

`10_000_000` — default input cap in characters, matching `@marianmeres/page-fetcher`'s
default body cap. Longer input is truncated, not rejected.

### `DEFAULT_EMBEDDED_JSON_KEYS`

```typescript
[
	"__NEXT_DATA__",
	"__NUXT__",
	"__APOLLO_STATE__",
	"__INITIAL_STATE__",
	"__PRELOADED_STATE__",
	"__REDUX_STATE__",
	"__remixContext",
	"__sveltekit_data",
];
```
