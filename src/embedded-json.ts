/**
 * Framework state blobs — `__NEXT_DATA__`, `__NUXT__`, Apollo, Redux preload and
 * friends — pulled out of inline `<script>` bodies.
 *
 * For a JavaScript-rendered page this is frequently the best data on the document: a
 * hydration payload is the same structured object the site's own UI renders from, which
 * is cleaner than anything scraped back out of the DOM text.
 *
 * Nothing here evaluates anything. The JSON substring is located by a brace scanner and
 * handed to `JSON.parse`; if that fails, the blob is skipped. There is no `eval`, no
 * `Function` constructor and no sandbox — extraction runs on hostile input by
 * definition.
 *
 * @module
 */

import { attr, type ParsedDocument, parseDocument, queryAll, text } from "./_dom.ts";
import { assertHtmlString } from "./_util.ts";
import {
	DEFAULT_EMBEDDED_JSON_KEYS,
	type EmbeddedJsonOptions,
	type Logger,
} from "./types.ts";

/** Default cap on the size of a single inline script we are willing to scan. */
const DEFAULT_MAX_SCRIPT_SIZE = 2_000_000;

/**
 * How many characters of a script the scanners may consume per key, as a multiple of the
 * script's own length.
 *
 * `maxScriptSize` bounds a script's *length*, not the *work*: every `KEY = {` whose
 * literal never closes costs a scan to end-of-source and finds nothing, so a script
 * repeating that shape is quadratic and a 1.7 MB body — comfortably inside every
 * documented limit — burned ~20 s of CPU. Charging every scanned character against one
 * budget makes the scan linear in the script's length. An honest page spends one scan on
 * its single payload plus a little slack for decoy occurrences, so 4x is far more than it
 * will ever ask for; a page that wants more than that is not paying us in data.
 */
const SCAN_BUDGET_FACTOR = 4;

/** What a scanner found, and how many characters it had to read to find out. */
interface ScanResult<T> {
	/** The literal (or its value), or `null` if it never terminated within `limit`. */
	value: T | null;
	/** Characters consumed, to be charged against the caller's scan budget. */
	scanned: number;
}

/**
 * Reads the balanced `{…}`/`[…]` literal starting at `start`, or `null` if it does not
 * close before `limit`.
 *
 * String-aware (and escape-aware inside strings), because a brace inside `"a } b"` is
 * not a brace — the single most common way a naive scanner truncates a payload right in
 * the middle of a product description.
 *
 * `limit` is the caller's remaining work budget, not a property of the input: stopping
 * short only ever costs a payload nobody could parse anyway (see
 * {@linkcode SCAN_BUDGET_FACTOR}).
 */
function readJsonLiteral(
	source: string,
	start: number,
	limit: number,
): ScanResult<string> {
	const open = source[start];
	const close = open === "{" ? "}" : open === "[" ? "]" : "";
	if (!close) return { value: null, scanned: 0 };

	const end = Math.min(source.length, limit);
	let depth = 0;
	let inString = false;
	let quote = "";
	for (let i = start; i < end; i++) {
		const ch = source[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === quote) inString = false;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			continue;
		}
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) {
				return { value: source.slice(start, i + 1), scanned: i + 1 - start };
			}
		}
	}
	return { value: null, scanned: Math.max(0, end - start) };
}

/**
 * Reads a JavaScript string literal starting at `start` and returns its *value*.
 *
 * Needed for the `JSON.parse("…")` assignment form that Nuxt 3 and several
 * server-rendered frameworks emit: the payload is a JSON document inside a JS string, so
 * it has to be unescaped once before it can be parsed. The unescaping goes through
 * `JSON.parse` on a re-quoted literal rather than any form of evaluation — JSON's string
 * escapes are a subset of JavaScript's, so the few JS-only forms (`\\x41`, `\\0`) simply
 * fail to parse and the blob is skipped, which is the correct outcome for a scanner that
 * must never evaluate its input.
 *
 * Budget-bounded like {@linkcode readJsonLiteral}, and for the same reason: an
 * unterminated quote otherwise runs to end-of-source once per occurrence.
 */
function readStringLiteral(
	source: string,
	start: number,
	limit: number,
): ScanResult<string> {
	const quote = source[start];
	if (quote !== '"' && quote !== "'") return { value: null, scanned: 0 };

	const end = Math.min(source.length, limit);
	let body = "";
	for (let i = start + 1; i < end; i++) {
		const ch = source[i];
		if (ch === "\\") {
			body += ch + (source[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === quote) {
			// `\'` is legal in JS and illegal in JSON; a bare `"` cannot occur inside a
			// double-quoted literal, but can inside a single-quoted one
			const json = quote === '"'
				? body.replace(/\\'/g, "'")
				: body.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/"/g, '\\"');
			const scanned = i + 1 - start;
			try {
				return { value: JSON.parse(`"${json}"`), scanned };
			} catch {
				return { value: null, scanned };
			}
		}
		body += ch;
	}
	return { value: null, scanned: Math.max(0, end - start) };
}

/**
 * Finds `key` used as an assignment target in `source` and returns the parsed value of
 * whatever is assigned to it.
 *
 * Handles the three shapes that cover essentially every framework in the wild:
 * `KEY = {…}`, `window.KEY = {…}` and `KEY = JSON.parse("…")`. Anything else — most
 * notably Nuxt 2's `__NUXT__=(function(a,b){…})(…)` IIFE — is not JSON and is skipped
 * on purpose rather than evaluated.
 *
 * Every occurrence of `key` is retried until one parses, so the scanning is bounded by a
 * per-key budget (see {@linkcode SCAN_BUDGET_FACTOR}) rather than by the number of
 * occurrences: a script can otherwise repeat an unbalanced `KEY = {` thousands of times
 * and make each retry scan to end-of-source. Running out of budget is reported as "no
 * value", which is what such a script has.
 */
function findAssignedJson(
	source: string,
	key: string,
	logger?: Logger,
): unknown | undefined {
	// the leading guard keeps `SOMETHING__NEXT_DATA__` from matching, but must NOT
	// exclude `.` — `window.__NEXT_DATA__ = …` is the single most common form there is
	const pattern = new RegExp(
		`(?:^|[^\\w$])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*`,
		"g",
	);
	let budget = source.length * SCAN_BUDGET_FACTOR;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source)) !== null) {
		if (budget <= 0) {
			logger?.warn(
				`[html-extract] embedded json: ${key} scan budget exhausted after ` +
					`${source.length * SCAN_BUDGET_FACTOR} char(s), giving up`,
			);
			return undefined;
		}
		let i = match.index + match[0].length;
		while (i < source.length && /\s/.test(source[i])) i++;
		const limit = i + budget;

		// KEY = JSON.parse("…")
		if (source.startsWith("JSON.parse(", i)) {
			let j = i + "JSON.parse(".length;
			while (j < source.length && /\s/.test(source[j])) j++;
			const literal = readStringLiteral(source, j, limit);
			budget -= literal.scanned;
			if (literal.value !== null) {
				try {
					return JSON.parse(literal.value);
				} catch {
					continue;
				}
			}
			continue;
		}

		// KEY = {…} / KEY = […]
		const raw = readJsonLiteral(source, i, limit);
		budget -= raw.scanned;
		if (raw.value === null) continue;
		try {
			return JSON.parse(raw.value);
		} catch {
			continue;
		}
	}
	return undefined;
}

/**
 * Extracts framework state blobs from an already-parsed document.
 *
 * Internal counterpart of {@linkcode extractEmbeddedJson}, used by
 * {@linkcode "./extract.ts".extract} so the document is only parsed once.
 */
export function embeddedJsonFromDocument(
	doc: ParsedDocument,
	options?: EmbeddedJsonOptions,
): Record<string, unknown> {
	const logger = options?.logger;
	const keys = options?.keys ?? DEFAULT_EMBEDDED_JSON_KEYS;
	const maxScriptSize = options?.maxScriptSize ?? DEFAULT_MAX_SCRIPT_SIZE;
	const out: Record<string, unknown> = {};
	if (!keys.length) return out;

	const scripts = queryAll(doc.root, "script", logger);
	const pending = new Set(keys);

	// pass 1: `<script type="application/json" id="KEY">` — the whole body is the
	// payload, no scanning needed. This is how Next.js ships `__NEXT_DATA__`.
	for (const el of scripts) {
		if (!pending.size) break;
		const id = attr(el, "id");
		if (!id || !pending.has(id)) continue;
		const raw = text(el).trim();
		if (!raw || raw.length > maxScriptSize) continue;
		try {
			out[id] = JSON.parse(raw);
			pending.delete(id);
			logger?.debug(
				`[html-extract] embedded json: ${id} (script#${id}, ${raw.length} chars)`,
			);
		} catch (e) {
			logger?.debug(`[html-extract] embedded json: ${id} is not valid JSON: ${e}`);
		}
	}

	// pass 2: assignments inside inline scripts
	if (pending.size) {
		for (const el of scripts) {
			if (!pending.size) break;
			const type = attr(el, "type");
			// module/importmap/ld+json bodies never carry these assignments
			if (type && !/javascript|^module$|^text\/plain$/i.test(type)) continue;
			const source = text(el);
			if (!source || source.length > maxScriptSize) {
				if (source.length > maxScriptSize) {
					logger?.debug(
						`[html-extract] embedded json: skipping ${source.length} char script (maxScriptSize ${maxScriptSize})`,
					);
				}
				continue;
			}
			for (const key of [...pending]) {
				if (!source.includes(key)) continue;
				const value = findAssignedJson(source, key, logger);
				if (value !== undefined) {
					out[key] = value;
					pending.delete(key);
					logger?.debug(
						`[html-extract] embedded json: ${key} (inline assignment)`,
					);
				} else {
					logger?.debug(
						`[html-extract] embedded json: ${key} present but not JSON-parseable, skipped`,
					);
				}
			}
		}
	}

	return out;
}

/**
 * Extracts known framework/state JSON blobs, keyed by the global they were assigned to.
 *
 * Looks in two places for each key in {@linkcode EmbeddedJsonOptions.keys} (default
 * {@linkcode DEFAULT_EMBEDDED_JSON_KEYS}): a `<script type="application/json" id="KEY">`
 * block, and a `KEY = {…}` / `window.KEY = {…}` / `KEY = JSON.parse("…")` assignment in
 * an inline script. The value is located textually and passed to `JSON.parse` —
 * **nothing is ever evaluated** — so payloads that are not JSON (an IIFE, a function
 * call, a template) are skipped rather than misread.
 *
 * Never throws, and never hangs: a key that is absent, unparseable or oversized is
 * simply missing from the result, and a script crafted so that the scan never finishes
 * — thousands of unbalanced `KEY = {` starts, each of which would be rescanned to the
 * end — is abandoned once it has cost more than a few passes over its own length.
 *
 * @example
 * ```ts
 * declare const html: string;
 * const blobs = extractEmbeddedJson(html);
 * const props = (blobs.__NEXT_DATA__ as any)?.props?.pageProps;
 * ```
 */
export function extractEmbeddedJson(
	html: string,
	options?: EmbeddedJsonOptions,
): Record<string, unknown> {
	assertHtmlString(html, "extractEmbeddedJson");
	const doc = parseDocument(html, options);
	return doc ? embeddedJsonFromDocument(doc, options) : {};
}
