/**
 * Internal shared helpers: argument guards, URL resolution, whitespace and date
 * normalization, and the tag classification tables that the text/markdown renderers and
 * the content scorer all read from.
 *
 * @module
 */

import { attr, type DomElement, isElement, queryAll, text } from "./_dom.ts";

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
	for (const el of queryAll(root, "base")) {
		// the spec picks the first `<base>` that *has* an href, not the first `<base>`:
		// a leading `<base target="_blank">` is legal and must not mask the real one
		const declared = attr(el, "href")?.trim();
		if (!declared) continue;
		const resolved = resolveUrl(declared, url);
		if (resolved && /^[a-z][a-z0-9+.-]*:/i.test(resolved)) return resolved;
		// a declared-but-unusable base (relative, with no `url` to resolve it against)
		// still ends the search — later `<base>` elements are inert in a browser too
		break;
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

/**
 * Strips horizontal whitespace from the end of each line, collapses runs of 3+ newlines
 * to exactly two (one blank line), normalizes line endings to `\n`, and trims the
 * result. Interior spacing within a line is left exactly as it was.
 *
 * The line-ending normalization is the one behaviour that differs from the pair of
 * regexes this replaced, which rewrote `\r\n\r\n\r\n` to `\n\n` but left a lone
 * `\r\n` alone. Nothing observes the difference — the renderers that call this only
 * ever emit `\n` — and "sometimes CRLF, sometimes LF, depending how many there were" is
 * not a contract worth preserving.
 *
 * A single index scan rather than the obvious pair of regexes. `/[ \t]+(\r?\n)/g` has
 * the backtracking shape that has already cost this package two hangs: on a run of
 * horizontal whitespace *not* followed by a newline it retries from every position after
 * consuming the whole run, which is O(n²) — measured at ~5.8 s for 80 000 tabs. Nothing
 * currently feeds it such a run, which is precisely why it would be found the hard way.
 */
export function collapseBlankLines(value: string): string {
	const out: string[] = [];
	let chunkStart = 0;
	let i = 0;

	while (i < value.length) {
		const ch = value[i];
		if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
			i++;
			continue;
		}

		// a whitespace run starts here — consume it whole, counting line breaks and
		// remembering where the horizontal whitespace after the last one begins
		const runStart = i;
		let newlines = 0;
		let afterLastNewline = i;
		while (i < value.length) {
			const c = value[i];
			if (c === "\n") {
				newlines++;
				afterLastNewline = ++i;
			} else if (c === "\r") {
				newlines++;
				i++;
				if (value[i] === "\n") i++;
				afterLastNewline = i;
			} else if (c === " " || c === "\t") {
				i++;
			} else {
				break;
			}
		}

		out.push(value.slice(chunkStart, runStart));
		if (newlines === 0) {
			// no line break in the run: it is interior spacing, keep it verbatim
			out.push(value.slice(runStart, i));
		} else {
			// at most one blank line, then whatever indented the following line
			out.push(newlines >= 2 ? "\n\n" : "\n");
			out.push(value.slice(afterLastNewline, i));
		}
		chunkStart = i;
	}

	out.push(value.slice(chunkStart));
	return out.join("").trim();
}

/**
 * ISO 8601: `YYYY-MM`, `YYYY-MM-DD`, optionally followed by `T` (or a space) and
 * `HH:MM[:SS[.frac]]` and an optional `Z` / `±HH[:]MM` zone.
 */
const ISO_SHAPE =
	/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * RFC 2822 / HTTP-date, and **only** with an explicit zone:
 * `Tue, 12 Mar 2024 06:41:00 GMT`. This is the shape a `Last-Modified` header has when
 * a page mirrors it into a `<meta>`. Without a zone the value is ambiguous, so it is
 * kept raw rather than guessed at.
 */
const RFC_SHAPE =
	/^(?:[a-z]{3,9},?\s+)?(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC?|Z|[+-]\d{2}:?\d{2})$/i;

/** Month abbreviations in calendar order, for {@linkcode RFC_SHAPE}. */
const RFC_MONTHS: readonly string[] = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];

/**
 * Minutes to subtract from a wall-clock reading to reach UTC, or `undefined` when the
 * value carries no zone at all.
 */
function zoneOffsetMinutes(zone: string | undefined): number | undefined {
	if (!zone) return undefined;
	const z = zone.toUpperCase();
	if (z === "Z" || z === "GMT" || z === "UTC" || z === "UT") return 0;
	const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(z);
	if (!m) return undefined;
	const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
	return m[1] === "-" ? -minutes : minutes;
}

/**
 * Builds the ISO instant for an already-validated set of calendar fields, or
 * `undefined` when they do not describe a real date.
 *
 * Everything is assembled in UTC on purpose: `Date.UTC`/`setUTC*` are the only date
 * constructors that cannot consult the host timezone, which is what makes the output of
 * {@linkcode normalizeDate} identical on every machine.
 */
function utcInstant(
	year: number,
	month: number,
	day: number,
	hours: number,
	minutes: number,
	seconds: number,
	millis: number,
	offsetMinutes: number,
): string | undefined {
	if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
	// `Date.UTC` folds years 0–99 into 1900–1999; `setUTCFullYear` does not
	const d = new Date(0);
	d.setUTCFullYear(year, month - 1, day);
	d.setUTCHours(hours, minutes, seconds, millis);
	// a component that moved is a date that does not exist (`2024-02-31` → 2 March)
	const rolled = d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 ||
		d.getUTCDate() !== day;
	if (rolled) return undefined;
	const ms = d.getTime() - offsetMinutes * 60_000;
	// unreachable for a 4-digit year, but `toISOString` is the one call here that throws
	if (!Number.isFinite(ms)) return undefined;
	return new Date(ms).toISOString();
}

/**
 * Normalizes a date-ish string to ISO 8601, **keeping the raw value when it is not a
 * shape we recognise**.
 *
 * Only two shapes are recognised: ISO 8601, and the RFC 2822 / HTTP-date form *with an
 * explicit zone*. Everything else is returned untouched, for two reasons:
 *
 * - Dropping an unparseable date would be the worse failure: `"March 2024"` is still
 *   information, and the caller can decide what to do with it.
 * - `Date.parse` must never see it. Outside ISO input it falls back to an
 *   implementation-defined guess evaluated in the **host** timezone, so
 *   `"March 5, 2024"` became `2024-03-04T23:00:00.000Z` in `+01:00` and
 *   `2024-03-05T00:00:00.000Z` in UTC — the same document producing a different
 *   stored `publishedAt` per machine. It is also far too eager (`Date.parse("5")`
 *   happily returns a date), and it silently resolves `03/05/2024` to one of the two
 *   days the world disagrees about.
 *
 * A recognised value with no zone (`2024-03-12T06:41`) is read as UTC. That is a guess
 * too, but a *fixed* one: the publisher's zone is unknowable and the consumer's is
 * certainly not it, so the output stays stable wherever the library runs.
 */
export function normalizeDate(raw: string | undefined): string | undefined {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value) return undefined;

	const iso = ISO_SHAPE.exec(value);
	if (iso) {
		const frac = iso[7] ? Number((iso[7] + "000").slice(0, 3)) : 0;
		return utcInstant(
			Number(iso[1]),
			Number(iso[2]),
			iso[3] ? Number(iso[3]) : 1,
			Number(iso[4] ?? 0),
			Number(iso[5] ?? 0),
			Number(iso[6] ?? 0),
			frac,
			zoneOffsetMinutes(iso[8]) ?? 0,
		) ?? value;
	}

	const rfc = RFC_SHAPE.exec(value);
	if (rfc) {
		return utcInstant(
			Number(rfc[3]),
			RFC_MONTHS.indexOf(rfc[2].toLowerCase()) + 1,
			Number(rfc[1]),
			Number(rfc[4]),
			Number(rfc[5]),
			Number(rfc[6] ?? 0),
			0,
			zoneOffsetMinutes(rfc[7]) ?? 0,
		) ?? value;
	}

	return value;
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
