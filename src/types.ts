/**
 * Public types of `@marianmeres/html-extract`.
 *
 * Nothing here references the underlying HTML parser: every option is plain data and
 * every result is plain data (strings, plain objects, arrays). That is deliberate — the
 * parser is a contained implementation detail (see `src/_dom.ts`) and swapping it must
 * not be able to change this file.
 *
 * @module
 */

import type { Logger } from "@marianmeres/clog";

/**
 * Console-compatible logger interface (from `@marianmeres/clog`).
 *
 * Re-exported so consumers can type their own logger without depending on clog
 * themselves. The import is type-only — no clog code is pulled in at runtime, and
 * `console` satisfies it as-is.
 */
export type { Logger };

/**
 * Default hard cap on input length, in characters (~10 MB), mirroring
 * `@marianmeres/page-fetcher`'s default body cap.
 *
 * Input longer than the cap is **truncated** (not rejected — see
 * {@linkcode BaseOptions.maxSize}), which is what keeps the never-throws contract from
 * degenerating into "and it also never returns".
 */
export const DEFAULT_MAX_SIZE = 10_000_000;

/**
 * Options shared by every public function in this package.
 *
 * Both fields are about *bounding* and *observing* the work, never about what is
 * extracted — that is each function's own options.
 */
export interface BaseOptions {
	/**
	 * Console-compatible logger. Default: `undefined`, i.e. **silent**.
	 *
	 * This is a pure library, so nothing is written anywhere unless a logger is
	 * injected. Pass `console` for a quick look, or a namespaced
	 * `createClog("html-extract")` for real use. Everything interesting is logged at
	 * `debug`; only genuinely surprising input (truncation, an invalid selector you
	 * passed) reaches `warn`. A malformed JSON-LD block is ordinary and logged at
	 * `debug`.
	 */
	logger?: Logger;

	/**
	 * Hard cap on input length in characters. Default: {@linkcode DEFAULT_MAX_SIZE}.
	 *
	 * Longer input is truncated to the cap (and a `warn` is logged when a logger was
	 * injected) rather than rejected: a truncated document still yields usable
	 * metadata, and this package must never throw on hostile input. Set to
	 * `Infinity` to disable the cap.
	 */
	maxSize?: number;
}

/**
 * Options for {@linkcode "./metadata.ts".extractMetadata}.
 */
export interface MetadataOptions extends BaseOptions {
	/**
	 * Absolute URL of the document. When given, `canonical`, `image` and `favicon`
	 * are resolved against it (`<base href>` in the document wins over this, exactly
	 * as in a browser). Optional — everything still works without it, minus the
	 * resolution.
	 */
	url?: string;
}

/**
 * Options for {@linkcode "./embedded-json.ts".extractEmbeddedJson}.
 */
export interface EmbeddedJsonOptions extends BaseOptions {
	/**
	 * Global names to look for, in inline `<script>` bodies and in
	 * `<script type="application/json" id="…">` blocks.
	 *
	 * Default: {@linkcode DEFAULT_EMBEDDED_JSON_KEYS}. Passing your own list
	 * *replaces* the default (it is not merged), so include the defaults explicitly
	 * if you want them too.
	 */
	keys?: string[];

	/**
	 * Skip inline scripts longer than this, in characters. Default: `2_000_000`.
	 *
	 * A guard against pathological single-script documents; framework state blobs are
	 * comfortably below it in practice.
	 */
	maxScriptSize?: number;
}

/**
 * Framework/state globals {@linkcode "./embedded-json.ts".extractEmbeddedJson} looks
 * for by default. Result keys are these names verbatim.
 */
export const DEFAULT_EMBEDDED_JSON_KEYS: readonly string[] = [
	"__NEXT_DATA__",
	"__NUXT__",
	"__APOLLO_STATE__",
	"__INITIAL_STATE__",
	"__PRELOADED_STATE__",
	"__REDUX_STATE__",
	"__remixContext",
	"__sveltekit_data",
];

/**
 * Options for {@linkcode "./microdata.ts".extractMicrodata}.
 */
export interface MicrodataOptions extends BaseOptions {
	/**
	 * Absolute URL of the document, used to resolve URL-valued properties (`href`,
	 * `src`, `data`). The document's own `<base href>` wins over it.
	 */
	url?: string;

	/** Cap on the number of top-level items returned. Default: `1000`. */
	maxItems?: number;
}

/**
 * One microdata item: an `itemscope` element read into plain data.
 *
 * Every property is an **array**, even when the document only uses it once. Microdata
 * allows a name to repeat, and a shape that silently changes from string to array
 * depending on the page is far worse to consume than one that is always an array.
 */
export interface MicrodataItem {
	/** `itemtype` tokens, e.g. `["https://schema.org/Product"]`. */
	type?: string[];
	/** `itemid`, verbatim. */
	id?: string;
	/** `itemprop` name → values: strings, or nested items. */
	properties: Record<string, (string | MicrodataItem)[]>;
}

/**
 * Options for {@linkcode "./main-content.ts".extractMainContent}.
 */
export interface MainContentOptions extends BaseOptions {
	/**
	 * Absolute URL of the document, used to resolve links and images in the
	 * markdown/text renderings of the extracted content.
	 */
	url?: string;

	/**
	 * Per-site override. If this CSS selector matches, its subtree **is** the main
	 * content and the scoring heuristic is skipped entirely (`via: "selector"`).
	 *
	 * This is the escape hatch for pages the heuristic gets wrong; reach for it
	 * before trying to tune anything else. Same thing as
	 * {@linkcode ExtractOptions.contentSelector}. An invalid or non-matching
	 * selector is not an error — extraction just falls through to the normal
	 * strategies.
	 */
	selector?: string;

	/**
	 * Minimum text length (characters) a candidate must have to be accepted.
	 * Default: `140`.
	 *
	 * Its main job is guarding the semantic fast path: an empty `<main>` shell is
	 * extremely common in unhydrated SPA markup, and without this a page would
	 * "successfully" extract to nothing. Below this, extraction falls through to
	 * scoring and ultimately returns `null`.
	 */
	minTextLength?: number;

	/** Options forwarded to the lazy {@linkcode MainContent.markdown} accessor. */
	markdown?: MarkdownOptions;

	/** Options forwarded to the lazy {@linkcode MainContent.text} accessor. */
	text?: TextOptions;
}

/**
 * Options for {@linkcode "./to-markdown.ts".toMarkdown}.
 */
export interface MarkdownOptions extends BaseOptions {
	/** Absolute URL used to resolve relative `href`/`src` values. */
	url?: string;

	/** Emit `[text](url)` for links. Default: `true` (`false` emits the text only). */
	links?: boolean;

	/** Emit `![alt](src)` for images. Default: `true` (`false` drops them). */
	images?: boolean;

	/**
	 * Escape markdown-significant characters in text nodes. Default: `true`.
	 *
	 * The escaping is deliberately minimal and context-aware (see the function's
	 * JSDoc) — turn it off only when you know the source text is markdown-safe.
	 */
	escape?: boolean;

	/** Bullet marker for unordered lists. Default: `"-"`. */
	bullet?: "-" | "*" | "+";
}

/**
 * Options for {@linkcode "./to-text.ts".toText}.
 */
export interface TextOptions extends BaseOptions {
	/**
	 * Keep `<pre>` content verbatim (no whitespace collapsing). Default: `true`.
	 */
	preserveCode?: boolean;
}

/**
 * Options for {@linkcode "./clean.ts".clean}.
 *
 * **`clean()` is not an XSS sanitizer** — see its JSDoc before using any of this.
 */
export interface CleanOptions extends BaseOptions {
	/**
	 * If given, **only** these tags survive; any other element is unwrapped (its
	 * children are kept in place). Tag names are matched case-insensitively.
	 *
	 * Note "unwrapped", not "dropped": an allowlist that excluded `<div>` would
	 * otherwise delete most of a document's text with it.
	 */
	allowTags?: string[];

	/**
	 * Extra tags to drop **with their subtree**, on top of the always-dropped
	 * `script`, `style`, `noscript` and `template`.
	 */
	dropTags?: string[];

	/** Keep HTML comments. Default: `false`. */
	keepComments?: boolean;

	/**
	 * Drop elements that end up with no text, no media and no attributes of value
	 * ("empty wrappers"). Default: `true`. Void/media elements (`img`, `br`, `hr`,
	 * `input`, `iframe`, …) are never considered empty.
	 */
	dropEmpty?: boolean;

	/**
	 * Drop `on*` event-handler attributes and `javascript:` URLs. Default: `true`.
	 *
	 * This is **structural hygiene, not a security boundary** — read the function's
	 * JSDoc. Turning it off simply keeps them.
	 */
	dropEventHandlers?: boolean;
}

/**
 * How a single field is picked out of the document by
 * {@linkcode "./pick.ts".pick}.
 *
 * A bare string is shorthand for `{ selector }`.
 */
export type SelectorSpec = string | {
	/** CSS selector. Invalid selectors yield `undefined`, never an exception. */
	selector: string;
	/** Read this attribute instead of the element's text. */
	attr?: string;
	/** Return an array of every match instead of the first one. Default: `false`. */
	all?: boolean;
	/** Trim the extracted value. Default: `true`. */
	trim?: boolean;
};

/** Field name → how to pick it. See {@linkcode "./pick.ts".pick}. */
export type SelectorMap = Record<string, SelectorSpec>;

/**
 * Options for {@linkcode "./pick.ts".pick}.
 */
export interface PickOptions extends BaseOptions {
	/**
	 * Cap on the number of values returned for an `all: true` spec. Default:
	 * `1000`. The tail is dropped (and a `debug` is logged).
	 */
	maxAll?: number;

	/** Default `trim` for specs that do not set it. Default: `true`. */
	trim?: boolean;
}

/**
 * Options for {@linkcode "./extract.ts".extract}.
 */
export interface ExtractOptions extends BaseOptions {
	/**
	 * Absolute URL of the document. Used to resolve relative links/images and to fill
	 * metadata gaps. Optional — everything still works without it, minus resolution.
	 */
	url?: string;

	/**
	 * Run main-content extraction. Default: `true`.
	 *
	 * Set to `false` for the metadata-only fast path: the document is still parsed
	 * once, but none of the scoring, cleaning or rendering work happens.
	 */
	content?: boolean;

	/**
	 * Per-site override: if this selector matches, its subtree **is** the main
	 * content and the scoring heuristic is skipped entirely. The escape hatch for
	 * sites the heuristic gets wrong.
	 */
	contentSelector?: string;

	/** Minimum text length for a content candidate. See {@linkcode MainContentOptions.minTextLength}. */
	minTextLength?: number;

	/** Extract metadata. Default: `true`. */
	metadata?: boolean;

	/** Extract JSON-LD blocks. Default: `true`. */
	jsonLd?: boolean;

	/** Extract framework state blobs. Default: `true`. */
	embeddedJson?: boolean;

	/** Extract microdata (`itemscope`/`itemprop`) items. Default: `true`. */
	microdata?: boolean;

	/** Options forwarded to {@linkcode "./embedded-json.ts".extractEmbeddedJson}. */
	embeddedJsonOptions?: Omit<EmbeddedJsonOptions, "logger" | "maxSize">;

	/** Options forwarded to the lazy {@linkcode MainContent.markdown} accessor. */
	markdown?: MarkdownOptions;

	/** Options forwarded to the lazy {@linkcode MainContent.text} accessor. */
	text?: TextOptions;
}

/**
 * Document metadata, normalized.
 *
 * Every field except the three maps is optional and simply absent when the document
 * does not carry it — there are no empty-string placeholders to test against.
 */
export interface Metadata {
	/**
	 * `<meta name="title">` → `og:title` → `twitter:title` → JSON-LD `headline`/`name`
	 * → `<title>` → first `<h1>`.
	 */
	title?: string;
	/**
	 * `<meta name="description">` → `og:description` → `twitter:description` → JSON-LD
	 * `description`.
	 */
	description?: string;
	/**
	 * `<link rel="canonical">` → `og:url` → JSON-LD `url`. Absolute when resolvable.
	 */
	canonical?: string;
	/** `<html lang>` → `<meta http-equiv="content-language">` → `og:locale`. */
	lang?: string;
	/**
	 * `og:site_name` → `<meta name="application-name">` → JSON-LD `publisher.name`.
	 */
	siteName?: string;
	/**
	 * `<meta name="author">` → `article:author` → JSON-LD `author.name` →
	 * `twitter:creator`.
	 */
	author?: string;
	/**
	 * `article:published_time` → `<meta name="date">` → `<meta name="pubdate">` →
	 * `<meta name="publish-date">` → `<meta itemprop="datePublished">` → JSON-LD
	 * `datePublished` → first `<time datetime>`.
	 *
	 * ISO 8601 when the source value could be parsed, otherwise the raw string.
	 */
	publishedAt?: string;
	/**
	 * `article:modified_time` → `og:updated_time` → `<meta name="last-modified">` →
	 * `<meta itemprop="dateModified">` → JSON-LD `dateModified`.
	 *
	 * ISO 8601 when the source value could be parsed, otherwise the raw string.
	 */
	modifiedAt?: string;
	/**
	 * `og:image` → `og:image:url` → `twitter:image` → `twitter:image:src` →
	 * `<link rel="image_src">` → JSON-LD `image`. Absolute when resolvable.
	 */
	image?: string;
	/**
	 * `<link rel="icon">` → `<link rel="apple-touch-icon">` → `<link rel="mask-icon">`
	 * → `/favicon.ico` (only when a document URL was given). Absolute when resolvable.
	 *
	 * `rel` is matched by token, so `rel="shortcut icon"` is caught by the first step
	 * and document order decides between them.
	 */
	favicon?: string;
	/** `og:type`. */
	type?: string;
	/** Every `og:*` meta, keyed **without** the `og:` prefix. */
	openGraph: Record<string, string>;
	/** Every `twitter:*` meta, keyed **without** the `twitter:` prefix. */
	twitter: Record<string, string>;
	/**
	 * Everything else, raw: `name`/`property`/`itemprop`/`http-equiv` → `content`.
	 *
	 * First occurrence wins, keys are lowercased, `og:*`/`twitter:*` are *not*
	 * repeated here (they have their own maps).
	 */
	meta: Record<string, string>;
}

/**
 * Which strategy produced a {@linkcode MainContent}.
 *
 * - `"selector"` — {@linkcode MainContentOptions.selector} matched; no heuristics ran.
 * - `"semantic"` — the document's own `<main>`/`[role=main]`/`<article>` was used.
 * - `"scored"` — the readability-style scoring fallback picked it.
 */
export type MainContentVia = "selector" | "semantic" | "scored";

/**
 * The extracted main content of a document.
 *
 * {@linkcode markdown} and {@linkcode text} are **lazy and memoized**: conversion only
 * runs when you call them, and only once. A caller who wanted metadata must not pay for
 * markdown conversion of a 2 MB document.
 */
export interface MainContent {
	/** The extracted subtree, serialized. Cleaned, but still HTML. */
	html: string;
	/** The content as markdown. Lazy + memoized. */
	markdown(): string;
	/** The content as plain text. Lazy + memoized. */
	text(): string;
	/** Length of the content's plain text, in characters. */
	textLength: number;
	/**
	 * Fraction (0–1) of the content's text that sits inside `<a>` elements.
	 *
	 * The single most useful "is this actually navigation?" signal: above ~0.5 you are
	 * almost certainly looking at a link list, whatever else the markup suggests.
	 */
	linkDensity: number;
	/** Which strategy produced this. */
	via: MainContentVia;
	/**
	 * Materializes everything, including the lazy renderings, so that
	 * `JSON.stringify(content)` is not silently lossy.
	 *
	 * Calling `JSON.stringify()` on a result therefore *does* pay for markdown and
	 * text conversion — which is exactly what you want when persisting it (e.g. into
	 * the crawler's `__crawler_page.data` JSONB column), and never happens otherwise.
	 */
	toJSON(): {
		html: string;
		markdown: string;
		text: string;
		textLength: number;
		linkDensity: number;
		via: MainContentVia;
	};
}

/**
 * Everything {@linkcode "./extract.ts".extract} could find, composed.
 */
export interface ExtractedDocument {
	/** Shorthand for `metadata.title`. */
	title?: string;
	/** Shorthand for `metadata.lang`. */
	lang?: string;
	/** Always present (possibly with only its three empty maps filled in). */
	metadata: Metadata;
	/**
	 * Parsed JSON-LD blocks, in document order. Never throws on malformed JSON — bad
	 * blocks are skipped (and logged at `debug`).
	 */
	jsonLd: unknown[];
	/** Framework state blobs, keyed by source: `"__NEXT_DATA__"`, `"__NUXT__"`, … */
	embeddedJson: Record<string, unknown>;
	/** Microdata items, in document order. Empty when the document carries none. */
	microdata: MicrodataItem[];
	/**
	 * `null` when no main content could be identified — a nav-only page, an
	 * unhydrated SPA shell, an empty document. This is a legitimate, expected
	 * outcome, not an error.
	 */
	content: MainContent | null;
}
