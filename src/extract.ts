/**
 * The primary call: everything above, composed over a single parse.
 *
 * @module
 */

import { parseDocument } from "./_dom.ts";
import { assertHtmlString } from "./_util.ts";
import { embeddedJsonFromDocument } from "./embedded-json.ts";
import { jsonLdFromDocument } from "./json-ld.ts";
import { mainContentFromDocument } from "./main-content.ts";
import { metadataFromDocument } from "./metadata.ts";
import { microdataFromDocument } from "./microdata.ts";
import type { ExtractedDocument, ExtractOptions, Metadata } from "./types.ts";

/** An empty {@linkcode Metadata} — the three maps are always present. */
function emptyMetadata(): Metadata {
	return { openGraph: {}, twitter: {}, meta: {} };
}

/**
 * Extracts metadata, structured data and main content from an HTML document in one
 * pass.
 *
 * The document is parsed **once** and every extractor runs against the same tree, which
 * is the only reason calling this is cheaper than calling the granular functions
 * yourself. Each part can be switched off individually; `content: false` is the
 * metadata-only fast path and skips all of the scoring and rendering work.
 *
 * Nothing here throws on bad input. Broken markup, a truncated document, binary noise or
 * an empty string all produce a degraded result — a caller processing 50 000 crawled
 * pages must never have one bad page kill the batch. `content: null` is likewise a
 * legitimate outcome (a nav-only page, an unhydrated SPA shell), not an error.
 *
 * Main-content extraction is a **heuristic** and will sometimes be wrong. That is what
 * {@linkcode ExtractOptions.contentSelector} is for, and why the granular functions are
 * exported.
 *
 * @example
 * ```ts
 * declare const html: string;
 * declare const url: string;
 * // the motivating case: one pass during a crawl
 * const doc = extract(html, { url: "https://example.com/post/1" });
 * doc.metadata.title;        // "…"
 * doc.jsonLd;                // [ { "@type": "Article", … } ]
 * doc.content?.markdown();   // rendered only if you ask
 * ```
 *
 * @example
 * ```ts
 * declare const html: string;
 * declare const url: string;
 * // metadata only, over a large document
 * const meta = extract(html, { content: false, url }).metadata;
 * ```
 */
export function extract(html: string, options?: ExtractOptions): ExtractedDocument {
	assertHtmlString(html, "extract");

	const logger = options?.logger;
	const doc = parseDocument(html, options);
	if (!doc) {
		logger?.debug("[html-extract] nothing to extract (unparseable or empty input)");
		return {
			metadata: emptyMetadata(),
			jsonLd: [],
			embeddedJson: {},
			microdata: [],
			content: null,
		};
	}

	const base = { logger, maxSize: options?.maxSize };

	const metadata = options?.metadata === false
		? emptyMetadata()
		: metadataFromDocument(doc, { ...base, url: options?.url });

	const jsonLd = options?.jsonLd === false ? [] : jsonLdFromDocument(doc, base);

	const embeddedJson = options?.embeddedJson === false
		? {}
		: embeddedJsonFromDocument(doc, { ...options?.embeddedJsonOptions, ...base });

	const microdata = options?.microdata === false
		? []
		: microdataFromDocument(doc, { ...base, url: options?.url });

	// content extraction runs last on purpose: it is the only extractor that rewrites a
	// tree, and although it works on a clone, keeping it last means a future change
	// there can never quietly corrupt the extractors above
	const content = options?.content === false ? null : mainContentFromDocument(doc, {
		...base,
		url: options?.url,
		selector: options?.contentSelector,
		minTextLength: options?.minTextLength,
		markdown: options?.markdown,
		text: options?.text,
	});

	return {
		title: metadata.title,
		lang: metadata.lang,
		metadata,
		jsonLd,
		embeddedJson,
		microdata,
		content,
	};
}
