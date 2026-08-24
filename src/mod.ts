/**
 * `@marianmeres/html-extract` — HTML string in, structured content out: metadata,
 * embedded structured data, the main content with boilerplate removed, and that content
 * rendered as markdown or plain text.
 *
 * This is the *document* layer of a three-package pipeline and a **sibling** of the
 * crawler, not a layer on top of it: it never imports `@marianmeres/page-fetcher` or
 * `@marianmeres/crawler`, never touches the network, never runs JavaScript and never
 * decodes bytes. You hand it a decoded string — a crawled page, an email body, a file
 * from disk — and it hands back plain data. The consumer composes the three.
 *
 * Everything is exported from this single entry point, and everything is a pure
 * function: nothing here is stateful, nothing is persisted, and nothing throws on
 * malformed input.
 *
 * @example
 * ```ts
 * declare const html: string;
 * declare const url: string;
 * import { extract } from "@marianmeres/html-extract";
 *
 * const doc = extract(html, { url: "https://example.com/post/1" });
 * doc.metadata.title;
 * doc.jsonLd;
 * doc.content?.markdown();   // lazy: only converted if you ask
 * ```
 *
 * @module
 */

export { extract } from "./extract.ts";
export { extractMetadata } from "./metadata.ts";
export { extractJsonLd, flattenJsonLd } from "./json-ld.ts";
export { extractEmbeddedJson } from "./embedded-json.ts";
export { extractMainContent } from "./main-content.ts";
export { extractMicrodata } from "./microdata.ts";
export { toMarkdown } from "./to-markdown.ts";
export { toText } from "./to-text.ts";
export { clean } from "./clean.ts";
export { pick } from "./pick.ts";

export { DEFAULT_EMBEDDED_JSON_KEYS, DEFAULT_MAX_SIZE } from "./types.ts";

export type {
	BaseOptions,
	CleanOptions,
	EmbeddedJsonOptions,
	ExtractedDocument,
	ExtractOptions,
	Logger,
	MainContent,
	MainContentOptions,
	MainContentVia,
	MarkdownOptions,
	Metadata,
	MetadataOptions,
	MicrodataItem,
	MicrodataOptions,
	PickOptions,
	SelectorMap,
	SelectorSpec,
	TextOptions,
} from "./types.ts";
