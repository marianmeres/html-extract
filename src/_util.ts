/**
 * Internal shared helpers: argument guards, URL resolution, whitespace and date
 * normalization, and the tag classification tables that the text/markdown renderers and
 * the content scorer all read from.
 *
 * @module
 */

import { attr, type DomElement, isElement, query, queryAll, text } from "./_dom.ts";

/**
 * Throws for a genuinely wrong argument type.
 *
 * The robustness contract is "never throw on *bad input*", not "never throw" — passing
 * a `Buffer`, a `Response` or `undefined` where an HTML string belongs is a programmer
 * error and silently returning an empty result would only hide it.
 */
export function assertHtmlString(html: unknown, fn: string): asserts html is string {
	if (typeof html !== "string") {
		throw new TypeError(
			`${fn}(html) expects a string, got ${
				html === null ? "null" : Array.isArray(html) ? "array" : typeof html
			}`,
		);
	}
}

// ---------------------------------------------------------------------------------
// urls
// ---------------------------------------------------------------------------------

/**
 * Resolves `href` against `base`, returning `href` untouched when that is not possible.
 *
 * Never throws and never invents a URL: without a usable base, a relative href stays
 * relative, which is strictly better than dropping it.
 */
export function resolveUrl(
	href: string | undefined | null,
	base?: string,
): string | undefined {
	const raw = typeof href === "string" ? href.trim() : "";
	if (!raw) return undefined;
	if (!base) return raw;
	try {
		return new URL(raw, base).href;
	} catch {
		return raw;
	}
}

/**
 * The base URL to resolve document-relative links against: `<base href>` when the
 * document declares one (resolved against `url` if it is itself relative), otherwise
 * `url`.
 *
 * Mirrors browser behaviour, which matters more often than it sounds — docs sites and
 * CMS previews frequently serve pages from one path with `<base>` pointing at another.
 */
export function documentBase(
	root: DomElement | null | undefined,
	url?: string,
): string | undefined {
	const declared = attr(query(root, "base"), "href");
	if (declared) {
		const resolved = resolveUrl(declared, url);
		if (resolved && /^[a-z][a-z0-9+.-]*:/i.test(resolved)) return resolved;
	}
	return url;
}

// ---------------------------------------------------------------------------------
// whitespace & dates
// ---------------------------------------------------------------------------------

/** Collapses every run of whitespace (including newlines) to a single space, trimmed. */
export function collapseWs(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Collapses 3+ newlines to exactly two (one blank line) and trims the result. */
export function collapseBlankLines(value: string): string {
	return value
		.replace(/[ \t]+(\r?\n)/g, "$1")
		.replace(/(\r?\n){3,}/g, "\n\n")
		.trim();
}

/**
 * Normalizes a date-ish string to ISO 8601, **keeping the raw value when parsing
 * fails**.
 *
 * Dropping an unparseable date would be the worse failure: `"March 2024"` is still
 * information, and the caller can decide what to do with it. A value without four
 * consecutive digits is never even handed to `Date.parse`, which is far too eager
 * (`Date.parse("5")` happily returns a date).
 */
export function normalizeDate(raw: string | undefined): string | undefined {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value) return undefined;
	if (!/\d{4}/.test(value)) return value;
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) return value;
	try {
		return new Date(ms).toISOString();
	} catch {
		return value;
	}
}

// ---------------------------------------------------------------------------------
// tag tables
// ---------------------------------------------------------------------------------

/**
 * Elements that start a new line in plain text / a new block in markdown.
 *
 * This table is why a regex tag-strip is not acceptable: `<div>a</div><div>b</div>`
 * must yield `a\nb`, never `ab`.
 */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"body",
	"caption",
	"center",
	"dd",
	"details",
	"dialog",
	"dir",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hgroup",
	"hr",
	"html",
	"legend",
	"li",
	"main",
	"menu",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
]);

/** Elements dropped outright before any text/markdown/scoring work. */
export const NON_CONTENT_TAGS: readonly string[] = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"canvas",
	"object",
	"embed",
	"applet",
	"link",
	"meta",
	"base",
];

/** Additionally dropped when looking for *main content* (chrome, not content). */
export const BOILERPLATE_TAGS: readonly string[] = [
	"nav",
	"header",
	"footer",
	"aside",
	"form",
	"iframe",
	"dialog",
];

/** `class`/`id` fragments that suggest an element *is* the content. */
export const POSITIVE_HINTS =
	/(^|[\s_-])(content|article|post|entry|body|main|story|text|blog|page|hentry|markdown|prose)([\s_-]|$)/;

/** `class`/`id` fragments that suggest an element is *not* the content. */
export const NEGATIVE_HINTS =
	/(nav|sidebar|side-bar|menu|comment|footer|footnote|header|masthead|ad-|-ad|advert|promo|share|social|related|recommend|popular|widget|cookie|consent|banner|breadcrumb|pagination|pager|subscribe|newsletter|modal|popup|toolbar|meta|byline|tags|category|skip|hidden|search|login|signup)/;

/**
 * Fraction (0–1) of an element's text that sits inside `<a>`.
 *
 * The strongest single signal in content extraction: a block whose text is mostly link
 * text is navigation, whatever its tag name or class says.
 */
export function linkDensity(el: DomElement | null | undefined): number {
	if (!isElement(el)) return 0;
	const total = collapseWs(text(el)).length;
	if (!total) return 0;
	let linked = 0;
	for (const a of queryAll(el, "a")) linked += collapseWs(text(a)).length;
	return Math.min(1, linked / total);
}

/** Text length of an element after whitespace collapsing. */
export function textLength(el: DomElement | null | undefined): number {
	return collapseWs(text(el)).length;
}

/**
 * `true` for the `javascript:`-family URL forms.
 *
 * Deliberately narrow: it does **not** reject `data:`, because inline images are
 * legitimate content, and it exists for structural hygiene only. This is not a security
 * check; see {@linkcode "./clean.ts".clean} for why this package refuses to pretend
 * otherwise.
 */
export function isSuspiciousUrl(value: string | undefined): boolean {
	if (!value) return false;
	// strip whitespace and control characters, which HTML lets you hide a scheme behind
	// deno-lint-ignore no-control-regex -- stripping them is exactly the point
	const flat = value.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
	return /^(?:javascript|vbscript|livescript):/.test(flat);
}
