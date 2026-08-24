/**
 * The parser adapter — **the only file in this package that knows which HTML parser is
 * used**.
 *
 * Everything else works against the small structural types and helper functions below.
 * Two rules keep it that way, and both are load-bearing:
 *
 * 1. No parser type ever reaches the public API. Every exported function of the package
 *    returns plain data.
 * 2. Swapping the parser must touch this file and nothing else.
 *
 * The current parser is [linkedom](https://github.com/WebReflection/linkedom): fast,
 * small, real `querySelector`, and it npm-builds cleanly. It is *not* a spec-exact
 * HTML5 tree builder, and the helpers here paper over the differences that matter:
 *
 * - A fragment (input without `<html>`) parses into a document whose `documentElement`
 *   is the fragment's first element and whose `body` is an empty stub — so input is
 *   normalized into a full document before parsing.
 * - Attribute lookup is case-sensitive (`<DIV CLASS=x>` does not answer to
 *   `getAttribute("class")`) — so {@linkcode attr} falls back to a case-insensitive
 *   scan.
 * - No implied `<tbody>` is inserted — so row queries must never assume one.
 * - `<textarea>` and `<xmp>` are parsed as *raw* text: their `textContent` is the
 *   undecoded source. So they belong in {@linkcode RAW_TEXT_TAGS}, or serialization
 *   escapes them a second time.
 * - Serialization does not re-escape `&` in attribute values — so this module ships its
 *   own {@linkcode serialize}, which also gives us stable, canonical output (lowercased
 *   attribute names, deduped attributes) and therefore `clean(clean(x)) === clean(x)`.
 *
 * @module
 */

import { parseHTML } from "linkedom";
import { DEFAULT_MAX_SIZE, type Logger } from "./types.ts";

// ---------------------------------------------------------------------------------
// structural types — deliberately minimal: only what this package actually touches
// ---------------------------------------------------------------------------------

/** `Node.ELEMENT_NODE`. */
export const ELEMENT_NODE = 1;
/** `Node.TEXT_NODE`. */
export const TEXT_NODE = 3;
/** `Node.COMMENT_NODE`. */
export const COMMENT_NODE = 8;

/** A parsed attribute. */
export interface DomAttr {
	name: string;
	value: string;
}

/** The subset of `Node` this package uses. */
export interface DomNode {
	nodeType: number;
	nodeName: string;
	textContent: string | null;
	parentNode: DomNode | null;
	parentElement: DomElement | null;
	childNodes: Iterable<DomNode> & ArrayLike<DomNode>;
}

/** The subset of `Element` this package uses. */
export interface DomElement extends DomNode {
	tagName: string;
	children: Iterable<DomElement> & ArrayLike<DomElement>;
	attributes: Iterable<DomAttr> & ArrayLike<DomAttr>;
	firstElementChild: DomElement | null;
	nextElementSibling: DomElement | null;
	previousElementSibling: DomElement | null;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
	removeAttribute(name: string): void;
	setAttribute(name: string, value: string): void;
	querySelector(selector: string): DomElement | null;
	querySelectorAll(selector: string): Iterable<DomElement> & ArrayLike<DomElement>;
	closest(selector: string): DomElement | null;
	matches(selector: string): boolean;
	remove(): void;
	cloneNode(deep?: boolean): DomNode;
}

/**
 * A successfully parsed document, normalized.
 */
export interface ParsedDocument {
	/**
	 * Query root for the whole document, `<head>` included. Use for metadata,
	 * `<script>` blocks and anything else that may live outside the body.
	 */
	root: DomElement;
	/**
	 * Query root for content. The real `<body>` when the document has one with
	 * anything in it, otherwise the document element.
	 */
	body: DomElement;
	/** `true` when the input exceeded `maxSize` and was cut short. */
	truncated: boolean;
}

// ---------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------

/**
 * Wraps input in a minimal document. Only ever called for input with no `<html>` of its
 * own, so the one decision left is whether it also needs a `<body>`: a stray `<body>` or
 * `<head>` must not end up nested inside a second one.
 */
function wrapDocument(html: string): string {
	return /<(?:body|head)[\s/>]/i.test(html)
		? `<!doctype html><html>${html}</html>`
		: `<!doctype html><html><body>${html}</body></html>`;
}

/**
 * Wraps bare fragments in a minimal document.
 *
 * linkedom does not do HTML5 tree construction, so `parseHTML("<div>x</div>")` yields a
 * document whose `documentElement` is that `<div>` and whose `body` is an empty stub —
 * a trap that silently returns "" from every body-based read. Wrapping first makes
 * `<p>hello</p>`, an email body and a full `<!doctype html>` page behave identically.
 *
 * The `<html>` test deliberately scans the **whole** input rather than a fixed-size head
 * of it. A window is worse than useless here: it is linear either way (and negligible
 * next to the parse that follows), while a document whose `<html>` sits past the window
 * — an 8 KB licence comment, a conditional-comment preamble — gets wrapped a second time
 * and loses its real root, taking `lang` with it. Being wrong only for long preambles is
 * the worst kind of wrong: it makes identical documents behave differently by length.
 *
 * The scan can still say yes to a fragment that merely *mentions* `<html` inside a
 * script string or a comment; {@linkcode parseDocument} catches that by checking what
 * the parser actually built.
 */
function wrapFragment(html: string): string {
	return /<html[\s/>]/i.test(html) ? html : wrapDocument(html);
}

/**
 * Parses HTML into a normalized {@linkcode ParsedDocument}. Never throws.
 *
 * Returns `null` only when the input is not a string, is empty, or the parser gave back
 * nothing usable — in every other case (broken markup, truncated documents, binary
 * noise) a degraded-but-usable document comes back.
 */
export function parseDocument(
	html: string,
	options?: { maxSize?: number; logger?: Logger },
): ParsedDocument | null {
	const logger = options?.logger;
	if (typeof html !== "string" || html.length === 0) return null;

	const maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
	let truncated = false;
	let src = html;
	if (Number.isFinite(maxSize) && maxSize >= 0 && html.length > maxSize) {
		src = html.slice(0, maxSize);
		truncated = true;
		logger?.warn(
			`[html-extract] input of ${html.length} chars truncated to maxSize ${maxSize}`,
		);
	}

	try {
		const parse = (input: string) =>
			(parseHTML(input) as unknown as {
				document: {
					documentElement: DomElement | null;
					body: DomElement | null;
				} | null;
			}).document;

		let document = parse(wrapFragment(src));
		let root = document?.documentElement;
		// `wrapFragment` sniffs text, so it says "already a document" for a fragment that
		// only mentions `<html` in a script string or a comment — and that fragment then
		// parses into the degenerate shape this whole dance exists to avoid. The parser's
		// own verdict is the reliable one: a real document roots at `<html>`. Re-parsing
		// wrapped costs a second parse, but only for input that was misread.
		if (root && tag(root) !== "html") {
			logger?.debug(
				`[html-extract] <${tag(root)}> root: re-parsing the input as a fragment`,
			);
			document = parse(wrapDocument(src));
			root = document?.documentElement;
		}
		if (!root) {
			logger?.debug("[html-extract] parser returned no document element");
			return null;
		}
		// reading `document.body` before the null check above would throw: linkedom's
		// getter walks `documentElement` unguarded
		const body = document?.body && document.body.childNodes.length > 0
			? document.body
			: root;
		return { root, body, truncated };
	} catch (e) {
		logger?.warn(`[html-extract] parse failed: ${e}`);
		return null;
	}
}

// ---------------------------------------------------------------------------------
// node predicates & traversal
// ---------------------------------------------------------------------------------

/** `true` for element nodes. */
export function isElement(node: DomNode | null | undefined): node is DomElement {
	return !!node && node.nodeType === ELEMENT_NODE;
}

/** `true` for text nodes. */
export function isText(node: DomNode | null | undefined): boolean {
	return !!node && node.nodeType === TEXT_NODE;
}

/** `true` for comment nodes. */
export function isComment(node: DomNode | null | undefined): boolean {
	return !!node && node.nodeType === COMMENT_NODE;
}

/** Lowercased tag name of an element (`""` for anything else). */
export function tag(node: DomNode | null | undefined): string {
	return isElement(node) ? String(node.tagName ?? "").toLowerCase() : "";
}

/** Child nodes as a real array (a stable snapshot — safe to mutate the tree while iterating). */
export function childNodes(node: DomNode | null | undefined): DomNode[] {
	if (!node) return [];
	const out: DomNode[] = [];
	const list = node.childNodes;
	for (let i = 0; i < list.length; i++) out.push(list[i]);
	return out;
}

/** Child *elements* as a real array (a stable snapshot). */
export function children(node: DomNode | null | undefined): DomElement[] {
	return childNodes(node).filter(isElement);
}

/**
 * Attribute value, looked up **case-insensitively**. Returns `undefined` when absent.
 *
 * The scan is what makes `<META NAME="description">` and `<DIV CLASS="post">` work:
 * linkedom keeps the source casing and its `getAttribute` is case-sensitive, while HTML
 * attribute names are not.
 *
 * An attribute that is present but empty (`content=""`) yields `""`, not `undefined` —
 * so `attr(el, "content") ?? attr(el, "value")` does **not** fall through for it; test
 * for emptiness yourself when that matters. The `getAttribute` fallback below is the one
 * exception: it treats `""` as absent, because it only ever runs for names the parser
 * fabricates a value for.
 */
export function attr(
	el: DomElement | null | undefined,
	name: string,
): string | undefined {
	if (!isElement(el)) return undefined;
	// scan first, `getAttribute` second: linkedom's is both case-sensitive *and*
	// special-cased for a few names (`getAttribute("class")` answers `""` rather than
	// `null` for an element whose source attribute was spelled `CLASS`), so the scan is
	// the only reliable reading
	const lower = name.toLowerCase();
	const list = el.attributes;
	if (list) {
		for (let i = 0; i < list.length; i++) {
			const a = list[i];
			if (a && String(a.name).toLowerCase() === lower) return a.value ?? "";
		}
	}
	const direct = el.getAttribute(name);
	return direct === null || direct === undefined || direct === "" ? undefined : direct;
}

/**
 * All attributes as a plain object with lowercased, deduplicated names (first wins).
 *
 * The map is **prototype-less** on purpose, and it is load-bearing rather than hygiene
 * theatre: attribute names come from the document, so they can be any string, including
 * the ones `Object.prototype` already answers to. On a normal `{}`,
 * `"constructor" in out` is `true` before a single attribute is read, so
 * `<div constructor="x">` looks like a duplicate and vanishes from every serialization;
 * `__proto__` is worse, being an inherited *setter* rather than a slot. With no
 * prototype there are no inherited names, `in` means exactly "already seen", and every
 * attribute round-trips.
 *
 * The flip side: no `out.hasOwnProperty(…)` and no `out.toString()` on the result. Use
 * `Object.hasOwn` / `Object.entries`, which is all this package does with it.
 */
export function attrs(el: DomElement | null | undefined): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	if (!isElement(el)) return out;
	const list = el.attributes;
	if (!list) return out;
	for (let i = 0; i < list.length; i++) {
		const a = list[i];
		if (!a) continue;
		const name = String(a.name).toLowerCase();
		if (!(name in out)) out[name] = a.value ?? "";
	}
	return out;
}

/** `class` + `id` of an element, lowercased and joined — the string the scorer sniffs. */
export function classId(el: DomElement | null | undefined): string {
	const c = attr(el, "class") ?? "";
	const i = attr(el, "id") ?? "";
	return `${c} ${i}`.toLowerCase();
}

/** `textContent` as a string, never `null`. */
export function text(node: DomNode | null | undefined): string {
	if (!node) return "";
	try {
		return node.textContent ?? "";
	} catch {
		return "";
	}
}

/**
 * `querySelector`, never throwing.
 *
 * The selector engine throws on invalid selectors; user-supplied selectors are a
 * first-class input here (`pick()`, `contentSelector`), so they must degrade to "no
 * match" instead.
 */
export function query(
	root: DomElement | null | undefined,
	selector: string,
	logger?: Logger,
): DomElement | null {
	if (!isElement(root) || typeof selector !== "string" || !selector.trim()) return null;
	try {
		return root.querySelector(selector) ?? null;
	} catch (e) {
		logger?.warn(`[html-extract] invalid selector ${JSON.stringify(selector)}: ${e}`);
		return null;
	}
}

/** `querySelectorAll` as a real array, never throwing. See {@linkcode query}. */
export function queryAll(
	root: DomElement | null | undefined,
	selector: string,
	logger?: Logger,
): DomElement[] {
	if (!isElement(root) || typeof selector !== "string" || !selector.trim()) return [];
	try {
		const list = root.querySelectorAll(selector);
		const out: DomElement[] = [];
		for (let i = 0; i < list.length; i++) out.push(list[i]);
		return out;
	} catch (e) {
		logger?.warn(`[html-extract] invalid selector ${JSON.stringify(selector)}: ${e}`);
		return [];
	}
}

/** Detaches a node from its parent. Never throws. */
export function remove(node: DomNode | null | undefined): void {
	if (!node) return;
	try {
		if (isElement(node)) node.remove();
		else {(node.parentNode as unknown as { removeChild?: (n: DomNode) => void })
				?.removeChild?.(node);}
	} catch {
		// detached already, or a parser that disagrees — either way, nothing to do
	}
}

/**
 * Replaces an element with its own children ("unwrap"), keeping their order and
 * position. Never throws; a detached or parent-less element is left alone.
 *
 * This is what a tag allowlist has to do rather than delete: unwrapping a `<div>` keeps
 * the paragraphs inside it, while dropping it would take most of the document's text
 * along.
 */
export function unwrap(el: DomElement | null | undefined): void {
	if (!isElement(el)) return;
	const parent = el.parentNode as unknown as {
		insertBefore?: (node: DomNode, ref: DomNode | null) => void;
	} | null;
	if (!parent?.insertBefore) return;
	try {
		for (const child of childNodes(el)) parent.insertBefore(child, el);
		el.remove();
	} catch {
		// parser disagreed — leaving the element in place is the safe degradation
	}
}

/** Deep-clones an element. Returns `null` if the parser refuses. */
export function cloneElement(el: DomElement): DomElement | null {
	try {
		const c = el.cloneNode(true);
		return isElement(c) ? c : null;
	} catch {
		return null;
	}
}

/**
 * Iterative depth-first walk over elements, parents before children.
 *
 * Iterative on purpose: hostile documents nest tens of thousands of levels deep and a
 * recursive walk would blow the stack — which would be a thrown exception, which the
 * robustness contract does not allow.
 *
 * Return `false` from `visit` to skip an element's subtree.
 */
export function walkElements(
	root: DomElement,
	visit: (el: DomElement, depth: number) => boolean | void,
): void {
	const stack: Array<{ el: DomElement; depth: number }> = [{ el: root, depth: 0 }];
	while (stack.length) {
		const { el, depth } = stack.pop()!;
		if (visit(el, depth) === false) continue;
		const kids = children(el);
		for (let i = kids.length - 1; i >= 0; i--) {
			stack.push({ el: kids[i], depth: depth + 1 });
		}
	}
}

/** Removes every element matching any of `selectors` from `root`'s subtree. */
export function dropAll(
	root: DomElement,
	selectors: string[],
	logger?: Logger,
): number {
	let n = 0;
	for (const sel of selectors) {
		for (const el of queryAll(root, sel, logger)) {
			remove(el);
			n++;
		}
	}
	return n;
}

// ---------------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------------

/** Elements that never have children or a closing tag. */
export const VOID_TAGS: ReadonlySet<string> = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

/**
 * Elements whose text content is raw — never escape it, never descend into it.
 *
 * This is the **parser's** list, not the spec's, and the two disagree. What matters for
 * {@linkcode serialize} is only whether `textContent` still holds the *source* text: if
 * it does, escaping on the way out adds an `&amp;` layer per pass and
 * `clean(clean(x)) === clean(x)` fails — `<textarea>Tom &amp; Jerry</textarea>` came back
 * out as `Tom &amp;amp; Jerry`, then `&amp;amp;amp;`, without bound.
 *
 * Verified against linkedom 0.18 by parsing `<TAG>&amp;<b>x</b></TAG>` and inspecting the
 * children: `script`, `style`, `textarea` and `xmp` each keep one text child holding the
 * untouched source (`"&amp;<b>x</b>"`), so they go here. `plaintext`, `listing`,
 * `noembed`, `noframes`, `noscript`, `iframe` and `pre` decode the entity and build a
 * real `<b>` element — ordinary elements, and adding them would emit unescaped text.
 * `<title>` is the third case, decoding entities but not building tags; escaping its
 * text is what round-trips, so it stays off the list too.
 */
export const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
	"script",
	"style",
	"textarea",
	"xmp",
]);

/** Escapes a text node for HTML output. */
export function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes an attribute value for double-quoted HTML output. */
export function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Serializes a node's subtree back to HTML.
 *
 * This is deliberately *our* serializer rather than the parser's `outerHTML`, for three
 * reasons: the parser does not re-escape `&` in attribute values (so `&amp;copy` could
 * come back out as `&copy`), attribute name casing is preserved from the source (so
 * output is not canonical), and duplicate attributes survive. Ours lowercases attribute
 * names, drops duplicates and escapes properly, which is also what makes
 * `clean(clean(x)) === clean(x)` hold.
 *
 * Iterative, for the same stack-safety reason as {@linkcode walkElements}.
 */
export function serialize(node: DomNode, includeSelf = true): string {
	const out: string[] = [];
	// a "close" frame is a plain string pushed onto the same stack
	const stack: Array<DomNode | string> = [];
	if (includeSelf) stack.push(node);
	else {
		const kids = childNodes(node);
		for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
	}

	while (stack.length) {
		const item = stack.pop()!;
		if (typeof item === "string") {
			out.push(item);
			continue;
		}
		if (isText(item)) {
			out.push(escapeText(item.textContent ?? ""));
			continue;
		}
		if (isComment(item)) {
			out.push(
				`<!--${String(item.textContent ?? "").replace(/-->/g, "--&gt;")}-->`,
			);
			continue;
		}
		if (!isElement(item)) continue;

		const name = tag(item);
		if (!name) continue;
		let open = `<${name}`;
		for (const [k, v] of Object.entries(attrs(item))) {
			open += v === "" ? ` ${k}=""` : ` ${k}="${escapeAttr(v)}"`;
		}
		open += ">";
		out.push(open);

		if (VOID_TAGS.has(name)) continue;

		if (RAW_TEXT_TAGS.has(name)) {
			out.push(text(item));
			out.push(`</${name}>`);
			continue;
		}

		stack.push(`</${name}>`);
		const kids = childNodes(item);
		for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
	}

	return out.join("");
}

/** Serializes a node's children (its "innerHTML"). See {@linkcode serialize}. */
export function serializeChildren(node: DomNode): string {
	return serialize(node, false);
}
