/**
 * JSON-LD extraction — `<script type="application/ld+json">` blocks, parsed and handed
 * back verbatim.
 *
 * @module
 */

import { attr, type ParsedDocument, parseDocument, queryAll, text } from "./_dom.ts";
import { assertHtmlString } from "./_util.ts";
import type { BaseOptions } from "./types.ts";

/**
 * Strips the wrappers CMSs habitually put around JSON-LD payloads.
 *
 * HTML-comment wrappers, CDATA sections and a trailing semicolon are all legal to a
 * browser — the script element's content is raw text either way — and all three make
 * `JSON.parse` fail, so they are worth undoing before giving up on a block.
 */
function unwrapJsonPayload(raw: string): string {
	let value = raw.trim();
	if (value.startsWith("<!--")) value = value.slice(4);
	if (value.endsWith("-->")) value = value.slice(0, -3);
	value = value.trim();
	value = value.replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, "").replace(
		/\/\*\s*\]\]>\s*\*\/$/,
		"",
	);
	value = value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
	value = value.trim();
	// a stray statement terminator after the object is common in hand-written blocks
	while (value.endsWith(";")) value = value.slice(0, -1).trim();
	return value;
}

/**
 * Per-document memo.
 *
 * Two callers want the JSON-LD of the same parse: {@linkcode "./extract.ts".extract}
 * itself, and {@linkcode "./metadata.ts".metadataFromDocument} as the late fallback in
 * its precedence chains. Keying on the `ParsedDocument` object (which `parseDocument`
 * mints fresh every time) means neither pays for the other's work and neither has to
 * know the other exists.
 */
const jsonLdMemo = new WeakMap<ParsedDocument, unknown[]>();

/**
 * Extracts every JSON-LD block from an already-parsed document, memoized per document.
 *
 * Internal counterpart of {@linkcode extractJsonLd}, used by
 * {@linkcode "./extract.ts".extract} so the document is only parsed once.
 */
export function jsonLdFromDocument(
	doc: ParsedDocument,
	options?: BaseOptions,
): unknown[] {
	const memoized = jsonLdMemo.get(doc);
	if (memoized) return memoized;

	const logger = options?.logger;
	const out: unknown[] = [];

	for (const el of queryAll(doc.root, "script", logger)) {
		const type = attr(el, "type") ?? "";
		if (!/application\/ld\+json/i.test(type)) continue;
		const raw = text(el);
		if (!raw.trim()) continue;
		try {
			out.push(JSON.parse(unwrapJsonPayload(raw)));
		} catch (e) {
			logger?.debug(
				`[html-extract] skipping malformed JSON-LD block (${raw.length} chars): ${e}`,
			);
		}
	}

	logger?.debug(`[html-extract] json-ld: ${out.length} block(s)`);
	jsonLdMemo.set(doc, out);
	return out;
}

/**
 * Parses every `<script type="application/ld+json">` block in the document and returns
 * them **in document order, uninterpreted**.
 *
 * No merging, no `@graph` unwrapping, no schema.org awareness: a document may carry
 * several blocks that disagree with each other, and deciding what that means is the
 * caller's job, not this package's. Malformed blocks are skipped (logged at `debug`) —
 * a single broken block never costs you the others, and this function never throws on
 * bad input.
 *
 * @example
 * ```ts
 * declare const html: string;
 * const blocks = extractJsonLd(html);
 * const product = blocks.find((b: any) => b["@type"] === "Product");
 * ```
 */
export function extractJsonLd(html: string, options?: BaseOptions): unknown[] {
	assertHtmlString(html, "extractJsonLd");
	const doc = parseDocument(html, options);
	return doc ? jsonLdFromDocument(doc, options) : [];
}

/**
 * Flattens JSON-LD blocks into the plain object nodes they contain: top-level arrays
 * are spread, and `@graph` wrappers are expanded one level.
 *
 * Used by metadata extraction, which needs to *look inside* the blocks;
 * {@linkcode extractJsonLd} itself deliberately does none of this.
 */
export function flattenJsonLd(blocks: unknown[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	const push = (value: unknown, depth: number) => {
		if (!value || depth > 4) return;
		if (Array.isArray(value)) {
			for (const v of value) push(v, depth + 1);
			return;
		}
		if (typeof value !== "object") return;
		const node = value as Record<string, unknown>;
		const graph = node["@graph"];
		if (graph) push(graph, depth + 1);
		out.push(node);
	};
	for (const block of blocks) push(block, 0);
	return out;
}
