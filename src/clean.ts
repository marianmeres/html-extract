/**
 * Structural HTML cleanup: drop the tags nothing downstream wants, the attributes that
 * only mean anything to a browser, and the wrappers that end up holding nothing.
 *
 * This module is **not** a security boundary — read {@linkcode clean}'s JSDoc before
 * reaching for any of it.
 *
 * @module
 */

import {
	childNodes,
	cloneElement,
	type DomElement,
	type DomNode,
	isComment,
	isElement,
	isText,
	type ParsedDocument,
	parseDocument,
	remove,
	serializeChildren,
	tag,
	unwrap,
	walkElements,
} from "./_dom.ts";
import { assertHtmlString, isSuspiciousUrl } from "./_util.ts";
import type { CleanOptions, Logger } from "./types.ts";

/**
 * Dropped with their entire subtree, always, whatever
 * {@linkcode CleanOptions.allowTags} says.
 *
 * These four carry no document text a reader would miss, and all four *do* carry text
 * that `textContent` happily hands back — a `<style>` body scored as prose is one of
 * the classic ways an extraction pipeline starts emitting CSS.
 */
const ALWAYS_DROP_TAGS: ReadonlySet<string> = new Set([
	"script",
	"style",
	"noscript",
	"template",
]);

/**
 * Elements that are content even when they hold no text, and that therefore make every
 * ancestor non-empty too.
 *
 * Without this list {@linkcode CleanOptions.dropEmpty} would quietly delete every
 * image, every embed and every table skeleton in the document — the exact opposite of
 * "removes empty wrappers".
 */
const MEDIA_TAGS: ReadonlySet<string> = new Set([
	"img",
	"picture",
	"video",
	"audio",
	"source",
	"iframe",
	"br",
	"hr",
	"input",
	"svg",
	"canvas",
	"embed",
	"object",
	"table",
	"td",
	"th",
]);

/**
 * Attributes whose value is a URL, and which are therefore checked against
 * {@linkcode "./_util.ts".isSuspiciousUrl}.
 *
 * Deliberately short: these are the ones that navigate or load on their own. Anything
 * broader (`data-*`, `style`, CSS `url()`) is a rabbit hole this package does not go
 * down, because it does not pretend to be a sanitizer.
 */
const URL_ATTRS: ReadonlySet<string> = new Set([
	"href",
	"src",
	"action",
	"formaction",
	"xlink:href",
]);

/** Options after defaults are applied — resolved once, not re-read per element. */
interface Resolved {
	drop: ReadonlySet<string>;
	allow: ReadonlySet<string> | null;
	keepComments: boolean;
	dropEmpty: boolean;
	dropEventHandlers: boolean;
	logger?: Logger;
}

/** What a cleaning pass did, for the one summary `debug` line. */
interface Stats {
	dropped: number;
	unwrapped: number;
	comments: number;
	attributes: number;
	empties: number;
}

/** Applies the documented defaults and lowercases both tag lists exactly once. */
function resolve(options?: CleanOptions): Resolved {
	const drop = new Set(ALWAYS_DROP_TAGS);
	for (const t of options?.dropTags ?? []) {
		if (typeof t === "string" && t.trim()) drop.add(t.trim().toLowerCase());
	}

	let allow: Set<string> | null = null;
	if (Array.isArray(options?.allowTags)) {
		allow = new Set<string>();
		for (const t of options.allowTags) {
			if (typeof t === "string" && t.trim()) allow.add(t.trim().toLowerCase());
		}
	}

	return {
		drop,
		allow,
		keepComments: options?.keepComments === true,
		dropEmpty: options?.dropEmpty !== false,
		dropEventHandlers: options?.dropEventHandlers !== false,
		logger: options?.logger,
	};
}

/**
 * Attribute names of an element, in source order, as a plain array.
 *
 * A snapshot on purpose: the live attribute map shifts under a `removeAttribute` call
 * and would skip every second doomed attribute.
 */
function attrPairs(el: DomElement): Array<{ name: string; value: string }> {
	const out: Array<{ name: string; value: string }> = [];
	const list = el.attributes;
	if (!list) return out;
	for (let i = 0; i < list.length; i++) {
		const a = list[i];
		if (a) out.push({ name: String(a.name), value: String(a.value ?? "") });
	}
	return out;
}

/**
 * Strips `on*` handlers and `javascript:`-family URLs from one element.
 *
 * **Structural hygiene, not security.** It exists so that stored or converted markup
 * does not carry behaviour that only made sense in the original page; an attacker with
 * a mutation-XSS payload walks straight past it. See {@linkcode clean}.
 */
function cleanAttributes(el: DomElement, opts: Resolved): number {
	if (!opts.dropEventHandlers) return 0;
	let n = 0;
	for (const { name, value } of attrPairs(el)) {
		const lower = name.toLowerCase();
		const doomed = lower.startsWith("on") ||
			(URL_ATTRS.has(lower) && isSuspiciousUrl(value));
		if (!doomed) continue;
		el.removeAttribute(name);
		// HTML attribute names are case-insensitive but the parser's removeAttribute
		// is not guaranteed to be — try the canonical spelling too
		if (name !== lower) el.removeAttribute(lower);
		n++;
	}
	return n;
}

/**
 * The drop / unwrap / attribute pass, iterative over the whole subtree.
 *
 * Iterative for the same reason {@linkcode "./_dom.ts".walkElements} is: hostile
 * documents nest deep enough to blow a recursive walk's stack, and a thrown
 * `RangeError` is exactly what the never-throws contract forbids.
 */
function structuralPass(root: DomElement, opts: Resolved, stats: Stats): void {
	stats.attributes += cleanAttributes(root, opts);

	const stack: DomNode[] = [];
	const push = (node: DomNode) => {
		const kids = childNodes(node);
		for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
	};
	push(root);

	while (stack.length) {
		const node = stack.pop()!;

		if (isComment(node)) {
			if (!opts.keepComments) {
				remove(node);
				stats.comments++;
			}
			continue;
		}
		if (!isElement(node)) continue;

		const name = tag(node);
		if (opts.drop.has(name)) {
			remove(node);
			stats.dropped++;
			continue;
		}

		if (opts.allow && !opts.allow.has(name)) {
			// snapshot before unwrapping: afterwards the children belong to the parent
			// and the element is gone, but they still need visiting themselves
			const kids = childNodes(node);
			unwrap(node);
			stats.unwrapped++;
			for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
			continue;
		}

		stats.attributes += cleanAttributes(node, opts);
		push(node);
	}
}

/** `true` when the element holds text, or a comment we were told to keep, directly. */
function hasOwnSubstance(el: DomElement, opts: Resolved): boolean {
	for (const child of childNodes(el)) {
		if (isText(child) && (child.textContent ?? "").trim() !== "") return true;
		if (opts.keepComments && isComment(child)) return true;
	}
	return false;
}

/**
 * Removes elements that hold no text and no media, bottom-up.
 *
 * Bottom-up is the whole point: `<div><div><span></span></div></div>` must collapse to
 * nothing in a single pass, and it only does so if a wrapper is judged *after* the
 * children that emptied it. The "has media" flag is propagated upwards as we go rather
 * than re-queried per element, which keeps the pass linear on documents that nest
 * pathologically.
 */
function dropEmptyPass(root: DomElement, opts: Resolved, stats: Stats): void {
	const all: DomElement[] = [];
	walkElements(root, (el) => {
		if (el !== root) all.push(el);
	});

	// reversing a parents-before-children walk visits every descendant before its parent
	const substantial = new Set<DomElement>();
	for (let i = all.length - 1; i >= 0; i--) {
		const el = all[i];
		if (
			!MEDIA_TAGS.has(tag(el)) && !substantial.has(el) && !hasOwnSubstance(el, opts)
		) {
			remove(el);
			stats.empties++;
			continue;
		}
		// a surviving child is, by definition, substance for its parent
		const parent = el.parentElement;
		if (parent) substantial.add(parent);
	}
}

/**
 * Cleans one subtree **in place**, mutating the element it is given.
 *
 * The in-place variant exists for main-content extraction, which has already cloned the
 * candidate subtree out of the document and wants it tidied without another
 * parse/serialize round trip. `el` itself is treated as a container: it is never
 * dropped and never unwrapped, however {@linkcode CleanOptions.dropTags} or
 * {@linkcode CleanOptions.allowTags} classify it — removing the caller's own handle
 * would leave them holding a detached node.
 *
 * Everything else follows {@linkcode clean}, including the "not a sanitizer" caveat.
 */
export function cleanNode(el: DomElement, options?: CleanOptions): void {
	if (!isElement(el)) return;
	const opts = resolve(options);
	const stats: Stats = {
		dropped: 0,
		unwrapped: 0,
		comments: 0,
		attributes: 0,
		empties: 0,
	};

	structuralPass(el, opts, stats);
	if (opts.dropEmpty) dropEmptyPass(el, opts, stats);

	opts.logger?.debug(
		`[html-extract] clean <${
			tag(el) || "?"
		}>: dropped ${stats.dropped} element(s), ` +
			`unwrapped ${stats.unwrapped}, removed ${stats.comments} comment(s), ` +
			`${stats.attributes} attribute(s), ${stats.empties} empty element(s)`,
	);
}

/**
 * Cleans an already-parsed document and returns its body content as HTML.
 *
 * Internal counterpart of {@linkcode clean}, used by
 * {@linkcode "./extract.ts".extract} so the document is only parsed once — and for that
 * reason it works on a **deep clone** of the body rather than mutating the shared tree
 * out from under the other extractors. When the parser refuses to clone (it should not,
 * but the contract here is never to throw) the original is cleaned in place and a
 * `warn` says so.
 */
export function cleanFromDocument(doc: ParsedDocument, options?: CleanOptions): string {
	const logger = options?.logger;
	const clone = cloneElement(doc.body);
	if (!clone) {
		logger?.warn(
			"[html-extract] clean: could not clone the document body, cleaning in place",
		);
	}
	const root = clone ?? doc.body;
	cleanNode(root, options);
	return serializeChildren(root);
}

/**
 * Structurally tidies an HTML string: drops `script`/`style`/`noscript`/`template`,
 * comments, event-handler attributes and empty wrappers, and optionally restricts the
 * document to a tag allowlist.
 *
 * ## This is NOT an XSS sanitizer
 *
 * Do not use it to make untrusted HTML safe to render in a browser. Sanitization is a
 * security-critical problem with a long tail of mutation-XSS, namespace-confusion and
 * parser-differential attacks, and a bespoke allowlist walker like this one *will* get
 * it wrong — a string that survives this function can still execute. If you intend to
 * render crawled HTML, run it through [DOMPurify](https://github.com/cure53/DOMPurify)
 * against a real DOM instead. The `on*`/`javascript:` handling below is structural
 * hygiene so that stored markup does not carry stale behaviour; it is not a boundary
 * and must never be treated as one.
 *
 * What it actually does, in order:
 *
 * 1. Drops `script`, `style`, `noscript`, `template` and every tag in
 *    {@linkcode CleanOptions.dropTags}, with their subtrees.
 * 2. Drops comments unless {@linkcode CleanOptions.keepComments}.
 * 3. Unwraps — never deletes — elements outside
 *    {@linkcode CleanOptions.allowTags}, so a `<div>` that is not on the list loses the
 *    tag but keeps its paragraphs.
 * 4. Strips `on*` attributes and `javascript:`-family URLs, unless
 *    {@linkcode CleanOptions.dropEventHandlers} is `false`.
 * 5. Removes elements left with no text and no media, bottom-up, unless
 *    {@linkcode CleanOptions.dropEmpty} is `false`.
 *
 * The return value is the **body content**: a fragment in gives a fragment out, a whole
 * `<!doctype html>` page in gives just what was inside `<body>` (its `<head>` is not
 * part of the output). Output is canonically serialized — lowercased tag and attribute
 * names, deduplicated attributes, properly escaped text — which is what makes
 * `clean(clean(x)) === clean(x)` hold, a property this package tests explicitly.
 *
 * Never throws on bad input: broken markup, truncated documents and binary noise all
 * yield a degraded string, and unparseable input yields `""`.
 *
 * @example
 * ```ts
 * declare const html: string;
 * // tidy a crawled article before storing or converting it
 * const tidy = clean(html, { dropTags: ["nav", "footer", "aside"] });
 *
 * // or reduce it to a small prose-only vocabulary — the divs are unwrapped, their
 * // text survives
 * const prose = clean(html, {
 * 	allowTags: ["p", "h1", "h2", "h3", "ul", "ol", "li", "a", "strong", "em", "code"],
 * });
 * ```
 */
export function clean(html: string, options?: CleanOptions): string {
	assertHtmlString(html, "clean");
	const doc = parseDocument(html, options);
	if (!doc) {
		options?.logger?.debug('[html-extract] clean: nothing to parse, returning ""');
		return "";
	}
	return cleanFromDocument(doc, options);
}
