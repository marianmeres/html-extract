/**
 * A CSS-selector field picker — the deliberately thin escape hatch for site-specific
 * extraction, for when the generic metadata and content extractors do not know about
 * the one `<span class="price">` you actually came for.
 *
 * @module
 */

import {
	attr,
	type DomElement,
	type ParsedDocument,
	parseDocument,
	query,
	queryAll,
	text,
} from "./_dom.ts";
import { assertHtmlString, collapseWs } from "./_util.ts";
import type { PickOptions, SelectorMap, SelectorSpec } from "./types.ts";

/** Default cap on the number of values a single `all: true` spec may return. */
const DEFAULT_MAX_ALL = 1000;

/**
 * Throws for a `selectors` argument that is not a plain object.
 *
 * Same reasoning as {@linkcode "./_util.ts".assertHtmlString}: an array, a `Map` or a
 * stray `undefined` here is a programmer error, and quietly returning `{}` would hide
 * it behind a result that looks like "the page had none of those fields".
 */
function assertSelectorMap(
	selectors: unknown,
	fn: string,
): asserts selectors is SelectorMap {
	if (
		selectors === null || typeof selectors !== "object" || Array.isArray(selectors)
	) {
		throw new TypeError(
			`${fn}(html, selectors) expects a plain object, got ${
				selectors === null
					? "null"
					: Array.isArray(selectors)
					? "array"
					: typeof selectors
			}`,
		);
	}
}

/** A {@linkcode SelectorSpec} with the shorthand expanded and defaults applied. */
interface Spec {
	selector: string;
	attr?: string;
	all: boolean;
	trim: boolean;
}

/**
 * Expands the bare-string shorthand and applies defaults, or returns `null` for a spec
 * that cannot mean anything.
 *
 * An unusable spec (no `selector`, a number, `null`) is *not* a throw: `selectors` maps
 * are frequently loaded from per-site config, and one bad field must not cost the
 * caller the other twenty.
 */
function normalizeSpec(spec: SelectorSpec, defaultTrim: boolean): Spec | null {
	if (typeof spec === "string") {
		return { selector: spec, all: false, trim: defaultTrim };
	}
	if (!spec || typeof spec !== "object") return null;
	if (typeof spec.selector !== "string") return null;
	return {
		selector: spec.selector,
		attr: typeof spec.attr === "string" && spec.attr ? spec.attr : undefined,
		all: spec.all === true,
		trim: spec.trim ?? defaultTrim,
	};
}

/**
 * Reads one value off a matched element.
 *
 * Text is whitespace-collapsed (source indentation is not data), attribute values are
 * only trimmed — collapsing them would corrupt anything structured that happens to live
 * in an attribute, a `content="a,  b"` list or a JSON `data-*` blob being the obvious
 * cases.
 */
function valueOf(el: DomElement, spec: Spec): string | undefined {
	if (spec.attr) {
		const raw = attr(el, spec.attr);
		if (raw === undefined) return undefined;
		return spec.trim ? raw.trim() : raw;
	}
	const raw = text(el);
	return spec.trim ? collapseWs(raw) : raw;
}

/**
 * The shared picking loop, tolerant of a missing root.
 *
 * `root === null` is how unparseable input is handled: every selector simply misses,
 * which keeps the `all: true` → array contract intact instead of handing the caller an
 * `undefined` to crash `.map()` on.
 */
function pickFromRoot<T>(
	root: DomElement | null,
	selectors: SelectorMap,
	options?: PickOptions,
): T {
	const logger = options?.logger;
	const maxAll = options?.maxAll ?? DEFAULT_MAX_ALL;
	const defaultTrim = options?.trim !== false;
	const out: Record<string, unknown> = {};

	for (const [field, rawSpec] of Object.entries(selectors)) {
		const spec = normalizeSpec(rawSpec, defaultTrim);
		if (!spec) {
			logger?.warn(
				`[html-extract] pick: field ${
					JSON.stringify(field)
				} has no usable selector, skipped`,
			);
			continue;
		}

		if (spec.all) {
			let els = queryAll(root, spec.selector, logger);
			if (Number.isFinite(maxAll) && els.length > maxAll) {
				logger?.debug(
					`[html-extract] pick: ${field} matched ${els.length}, capped at maxAll ${maxAll}`,
				);
				els = els.slice(0, Math.max(0, maxAll));
			}
			const values: string[] = [];
			for (const el of els) {
				const value = valueOf(el, spec);
				if (value !== undefined) values.push(value);
			}
			if (values.length !== els.length) {
				logger?.debug(
					`[html-extract] pick: ${field} dropped ${
						els.length - values.length
					} match(es) without a ${JSON.stringify(spec.attr)} attribute`,
				);
			}
			out[field] = values;
			logger?.debug(`[html-extract] pick: ${field} -> ${values.length} value(s)`);
			continue;
		}

		const el = query(root, spec.selector, logger);
		if (!el) {
			logger?.debug(
				`[html-extract] pick: ${field} -> no match for ${
					JSON.stringify(spec.selector)
				}`,
			);
			continue;
		}
		const value = valueOf(el, spec);
		if (value === undefined) {
			logger?.debug(
				`[html-extract] pick: ${field} matched, but it has no ${
					JSON.stringify(spec.attr)
				} attribute`,
			);
			continue;
		}
		out[field] = value;
	}

	return out as T;
}

/**
 * Picks fields out of an already-parsed document.
 *
 * Internal counterpart of {@linkcode pick}, so a caller holding a parsed document can
 * pick from it without a second parse. Selectors are matched against the **whole**
 * document, `<head>` included, so `"title"` and `"meta[name=sku]"` work alongside body
 * selectors.
 */
export function pickFromDocument<T = Record<string, unknown>>(
	doc: ParsedDocument,
	selectors: SelectorMap,
	options?: PickOptions,
): T {
	assertSelectorMap(selectors, "pickFromDocument");
	return pickFromRoot<T>(doc.root, selectors, options);
}

/**
 * Extracts a flat object of fields from an HTML string using CSS selectors.
 *
 * Text content by default, {@linkcode SelectorSpec.attr} for an attribute,
 * {@linkcode SelectorSpec.all} for an array, and a bare string as shorthand for
 * `{ selector }`. **That is the whole feature**, on purpose: there is no nesting, no
 * transforms, no conditionals, no config-file format and no expression language. The
 * moment those appear this package has grown a scraping DSL and become something it
 * explicitly refuses to be — callers who need more compose plain functions around this
 * one, which is cheaper for everybody than a half-built DSL.
 *
 * Nothing here throws on the document: a selector that is invalid, matches nothing, or
 * matches an element without the requested attribute simply produces no value, and the
 * field is absent from the result (reading it still gives `undefined`). An `all` field
 * is always present, as an array, empty when nothing matched — so `.map()` on it is
 * safe even for empty or unparseable input. Results are capped at
 * {@linkcode PickOptions.maxAll} with the tail dropped, because a selector like `"div"`
 * on a hostile page is otherwise unbounded work.
 *
 * A wrong-typed `selectors` argument *is* a throw ({@linkcode TypeError}) — that is a
 * programmer error, not bad input.
 *
 * The generic `T` is a **convenience cast, not a validation**: nothing checks that the
 * document actually produced the shape you asked for, and every field can be missing.
 * Validate downstream if it matters.
 *
 * @example
 * ```ts
 * declare const html: string;
 * const p = pick(html, {
 * 	title: "h1",
 * 	price: { selector: ".price", attr: "data-value" },
 * 	tags: { selector: ".tag", all: true },
 * });
 * // → { title: "Widget", price: "19.90", tags: ["new", "sale"] }
 * ```
 */
export function pick<T = Record<string, unknown>>(
	html: string,
	selectors: SelectorMap,
	options?: PickOptions,
): T {
	assertHtmlString(html, "pick");
	assertSelectorMap(selectors, "pick");
	const doc = parseDocument(html, options);
	if (!doc) {
		options?.logger?.debug("[html-extract] pick: nothing to parse");
	}
	return pickFromRoot<T>(doc?.root ?? null, selectors, options);
}
