/**
 * HTML microdata — `itemscope` / `itemtype` / `itemprop` trees, read into plain objects.
 *
 * The oldest of the three structured-data vocabularies this package understands, and
 * still the one e-commerce templates reach for. Unlike JSON-LD it is woven into the
 * markup, so it survives page builders that strip `<script>` blocks — which is exactly
 * when it turns out to be the only structured data left on the page.
 *
 * This implements the useful subset of the WHATWG microdata algorithm: top-level items,
 * nested items, multi-name `itemprop`, and the per-element value rules. It does **not**
 * implement `itemref` (an item assembling properties from elsewhere in the document by
 * id) — it is rare, it makes the walk quadratic in the pathological case, and the
 * failure mode without it is a missing property rather than a wrong one.
 *
 * @module
 */

import {
	attr,
	children,
	type DomElement,
	type ParsedDocument,
	parseDocument,
	queryAll,
	tag,
	text,
} from "./_dom.ts";
import { assertHtmlString, collapseWs, documentBase, resolveUrl } from "./_util.ts";
import type { Logger, MicrodataItem, MicrodataOptions } from "./types.ts";

/** Deepest nesting of items we follow before giving up on a pathological document. */
const MAX_ITEM_DEPTH = 12;

/** Default cap on the number of top-level items returned. */
const DEFAULT_MAX_ITEMS = 1000;

/** Elements whose microdata value is an attribute rather than their text. */
const VALUE_ATTR: Record<string, string> = {
	meta: "content",
	audio: "src",
	embed: "src",
	iframe: "src",
	img: "src",
	source: "src",
	track: "src",
	video: "src",
	a: "href",
	area: "href",
	link: "href",
	object: "data",
	data: "value",
	meter: "value",
	time: "datetime",
};

/** Value attributes that hold a URL and are therefore resolved against the base. */
const URL_VALUE_TAGS: ReadonlySet<string> = new Set([
	"audio",
	"embed",
	"iframe",
	"img",
	"source",
	"track",
	"video",
	"a",
	"area",
	"link",
	"object",
]);

/**
 * The value of a property element, per the microdata rules: an attribute for the
 * elements that have one, the element's text otherwise.
 *
 * `<time>` falls back to its text when it carries no `datetime`, which is what the spec
 * says and also what the markup in the wild expects.
 */
function propertyValue(el: DomElement, base: string | undefined): string {
	const name = tag(el);
	const source = VALUE_ATTR[name];
	if (source) {
		const raw = attr(el, source);
		if (raw !== undefined && raw !== "") {
			return URL_VALUE_TAGS.has(name) ? resolveUrl(raw, base) ?? raw : raw.trim();
		}
		if (name !== "time") return "";
	}
	return collapseWs(text(el));
}

/**
 * Reads one item: its type/id, and every `itemprop` in its subtree that is not claimed
 * by a nested item.
 *
 * The "not claimed by a nested item" part is the whole subtlety of microdata: an element
 * carrying both `itemprop` and `itemscope` is a *value* of the outer item and the *owner*
 * of everything below it, so the walk must stop descending there and recurse instead.
 *
 * The walk is an explicit stack rather than recursion over children — only *nested items*
 * recurse, and those are depth-capped — so a document nested tens of thousands of levels
 * deep costs memory, not a `RangeError`.
 */
function readItem(
	el: DomElement,
	base: string | undefined,
	depth: number,
): MicrodataItem {
	const properties: Record<string, (string | MicrodataItem)[]> = {};

	if (depth < MAX_ITEM_DEPTH) {
		const stack: DomElement[] = children(el).reverse();
		while (stack.length) {
			const node = stack.pop()!;
			const names = attr(node, "itemprop")?.trim().split(/\s+/).filter(Boolean) ??
				[];
			const isScope = attr(node, "itemscope") !== undefined;

			if (names.length) {
				const value = isScope
					? readItem(node, base, depth + 1)
					: propertyValue(node, base);
				for (const name of names) (properties[name] ??= []).push(value);
			}

			// a nested item owns its own subtree; anything else is still ours to walk
			if (!isScope) {
				const kids = children(node);
				for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
			}
		}
	}

	const typeAttr = attr(el, "itemtype")?.trim().split(/\s+/).filter(Boolean) ?? [];
	const idAttr = attr(el, "itemid")?.trim();
	return {
		...(typeAttr.length ? { type: typeAttr } : {}),
		...(idAttr ? { id: idAttr } : {}),
		properties,
	};
}

/**
 * Extracts microdata items from an already-parsed document.
 *
 * Internal counterpart of {@linkcode extractMicrodata}, used by
 * {@linkcode "./extract.ts".extract} so the document is only parsed once.
 */
export function microdataFromDocument(
	doc: ParsedDocument,
	options?: MicrodataOptions,
): MicrodataItem[] {
	const logger: Logger | undefined = options?.logger;
	const base = documentBase(doc.root, options?.url);
	const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;

	const out: MicrodataItem[] = [];
	for (const el of queryAll(doc.root, "[itemscope]", logger)) {
		// an element with both is a nested item and is reached through its owner
		if (attr(el, "itemprop") !== undefined) continue;
		if (out.length >= maxItems) {
			logger?.debug(`[html-extract] microdata: capped at ${maxItems} item(s)`);
			break;
		}
		out.push(readItem(el, base, 0));
	}

	if (out.length) {
		logger?.debug(`[html-extract] microdata: ${out.length} top-level item(s)`);
	}
	return out;
}

/**
 * Extracts HTML microdata as plain objects, in document order.
 *
 * Each top-level `itemscope` element becomes one {@linkcode MicrodataItem}; an element
 * carrying both `itemprop` and `itemscope` is not top-level, it is a nested value of its
 * owner. Property values are strings, or nested items, and every property is an **array**
 * — microdata lets the same name repeat, and a shape that changes from string to array
 * depending on the page is worse than one that is always an array.
 *
 * URL-valued attributes (`href`, `src`, `data`) are resolved against
 * {@linkcode MicrodataOptions.url}, with the document's own `<base href>` winning over
 * it. `itemref` is not supported (see the module doc). Never throws.
 *
 * @example
 * ```ts
 * declare const html: string;
 * declare const url: string;
 * const items = extractMicrodata(html, { url });
 * const product = items.find((i) => i.type?.some((t) => t.endsWith("/Product")));
 * const price = product?.properties.price?.[0];
 * ```
 */
export function extractMicrodata(
	html: string,
	options?: MicrodataOptions,
): MicrodataItem[] {
	assertHtmlString(html, "extractMicrodata");
	const doc = parseDocument(html, options);
	return doc ? microdataFromDocument(doc, options) : [];
}
