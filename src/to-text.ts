/**
 * HTML → plain text.
 *
 * The whole reason this file exists instead of a regex is the block/inline distinction:
 * `<div>a</div><div>b</div>` must render as `a\nb`, never `ab`. A tag-strip has no idea
 * where a line ends, so it silently welds words together — and because the damage is
 * invisible in the output (there is no stray markup to notice), it survives all the way
 * into whatever consumes the text. Rendering from the parsed tree is the only way to get
 * this right.
 *
 * How much separation a tag produces:
 *
 * | Tag | Separator |
 * |---|---|
 * | `p`, `h1`–`h6`, `blockquote`, `pre`, `ul`, `ol`, `dl`, `table`, `figure`, `section`, `article`, `hr` | blank line (`\n\n`) |
 * | every other block tag — `div`, `li`, `tr`, `header`, `footer`, `nav`, … (see {@linkcode "./_util.ts".BLOCK_TAGS}) | newline (`\n`) |
 * | `td`, `th` | tab (`\t`) |
 * | `br` | newline — two in a row give a blank line |
 * | everything else (`span`, `a`, `b`, `code`, `img`, …) | nothing; source whitespace decides |
 *
 * Separators are *requested*, not written: adjacent requests collapse to the strongest
 * one, so a `</p>\n<div>` boundary is one blank line rather than a pile of newlines, and
 * a request before the first or after the last piece of text is dropped entirely. That
 * is what keeps the output free of leading, trailing and tripled newlines without a
 * clean-up pass that would also flatten `<pre>`.
 *
 * @module
 */

import {
	childNodes,
	type DomNode,
	isElement,
	isText,
	type ParsedDocument,
	parseDocument,
	tag,
	text,
} from "./_dom.ts";
import { assertHtmlString, BLOCK_TAGS, NON_CONTENT_TAGS } from "./_util.ts";
import type { TextOptions } from "./types.ts";

// ---------------------------------------------------------------------------------
// separators
// ---------------------------------------------------------------------------------

/** No separation at all — inline elements. */
const SEP_NONE = 0;
/** A single space. Requested by whitespace in the source text. */
const SEP_SPACE = 1;
/** A tab — between cells of a table row. */
const SEP_TAB = 2;
/** A newline — ordinary block elements and `<br>`. */
const SEP_LINE = 3;
/** A blank line — paragraph-level blocks. */
const SEP_BLANK = 4;

/** Separator strength → what it actually writes. Indexed by the `SEP_*` constants. */
const SEPARATORS = ["", " ", "\t", "\n", "\n\n"] as const;

/**
 * Blocks that read as their own paragraph and therefore get a blank line around them.
 *
 * The distinction from the rest of {@linkcode "./_util.ts".BLOCK_TAGS} is about how the
 * result reads, not about CSS: a `<div>` is a layout artifact and a `<li>` is a line in
 * a list, while a `<p>` or an `<h2>` is a unit of prose that wants air around it.
 */
const PARAGRAPH_TAGS: ReadonlySet<string> = new Set([
	"article",
	"blockquote",
	"dl",
	"figure",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"ul",
]);

/** Table cells, which are separated from each other by a tab rather than a newline. */
const CELL_TAGS: ReadonlySet<string> = new Set(["td", "th"]);

/** {@linkcode "./_util.ts".NON_CONTENT_TAGS} as a set — this is a per-node lookup. */
const NON_CONTENT: ReadonlySet<string> = new Set(NON_CONTENT_TAGS);

/** How much separation an element's boundaries request. See the module table. */
function separatorFor(name: string): number {
	if (name === "br") return SEP_LINE;
	if (CELL_TAGS.has(name)) return SEP_TAB;
	if (PARAGRAPH_TAGS.has(name)) return SEP_BLANK;
	if (BLOCK_TAGS.has(name)) return SEP_LINE;
	return SEP_NONE;
}

// ---------------------------------------------------------------------------------
// character references
// ---------------------------------------------------------------------------------

/**
 * Tags whose text the parser hands over with its character references **unresolved**.
 *
 * Everything else in this file may assume decoded text, because that is what the parser
 * normally gives — `<div>Tom &amp; Jerry</div>` arrives as `Tom & Jerry`. `<textarea>`
 * is the exception: linkedom tokenizes it as raw text, so its `textContent` is the
 * literal source, and the eight characters `Tom &amp;` would otherwise reach the
 * extracted plain text of every page with a pre-filled comment box, indistinguishable
 * from content that really did contain an ampersand.
 *
 * HTML5 calls `<textarea>` an *RCDATA* element, and RCDATA does resolve references — so
 * decoding here restores what the parser owed us rather than inventing a rule.
 * `<xmp>`, `<iframe>`, `<noembed>` and `<noframes>` are *RAWTEXT*, where `&amp;` really
 * is five literal characters in every browser, and are deliberately **not** listed:
 * decoding them would corrupt what the page displays.
 */
const UNDECODED_TEXT_TAGS: ReadonlySet<string> = new Set(["textarea"]);

/** The named references an HTML serializer emits. See {@linkcode decodeReferences}. */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: "\u00a0",
	quot: '"',
};

/**
 * Resolves the character references in {@linkcode UNDECODED_TEXT_TAGS} text.
 *
 * Deliberately *not* a full HTML5 named-entity table: that table has 2231 entries, it
 * belongs to the parser, and a second copy of it in a renderer is a copy that drifts.
 * What is covered is what an encoder actually produces — the five XML names plus
 * `&nbsp;` — together with every numeric reference, which is the whole long tail
 * (`&#169;` and `&#xa9;` both come out as `©`). An unrecognized name is left exactly as
 * it stands: `&copy` without a semicolon is ordinary text far more often than it is a
 * broken entity.
 *
 * Out-of-range and surrogate code points become U+FFFD rather than reaching
 * `String.fromCodePoint`, which throws a `RangeError` for them — and a throw from here
 * would break the never-throws contract for a document that only had a typo in it. The
 * quantifiers in the pattern are bounded for the same class of reason: an unbounded
 * `\d+` before a literal `;` backtracks over every digit of a run that never ends in
 * one, and this text comes off the open web.
 */
function decodeReferences(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(
		/&(?:#(\d{1,10})|#[xX]([\da-fA-F]{1,8})|([a-zA-Z]{2,8}));/g,
		(match, dec: string | undefined, hex: string | undefined, name: string) => {
			if (dec === undefined && hex === undefined) {
				return NAMED_REFERENCES[name] ?? match;
			}
			const code = dec !== undefined
				? Number.parseInt(dec, 10)
				: Number.parseInt(hex!, 16);
			// U+FFFD for U+0000, the surrogate block and anything past the top of
			// Unicode — what a real parser does, and what keeps `fromCodePoint`
			// (which throws a `RangeError` on exactly those) inside the contract
			const bad = code === 0 || code > 0x10ffff ||
				(code >= 0xd800 && code <= 0xdfff);
			return bad ? "\ufffd" : String.fromCodePoint(code);
		},
	);
}

// ---------------------------------------------------------------------------------
// <pre>
// ---------------------------------------------------------------------------------

/**
 * Collects the text of a `<pre>` subtree **without touching its whitespace**.
 *
 * Separate from the main walk on purpose: everywhere else whitespace is the renderer's
 * to decide, and inside `<pre>` it is the document's. Syntax highlighters wrap every
 * token in a `<span>`, so the collection has to descend rather than read one text node,
 * and some of them emit a `<div>` per line with no newline between them — hence the
 * newline on block boundaries, which is a no-op for the (far more common) markup that
 * already carries real newlines.
 *
 * The one liberty taken is the HTML rule that a newline immediately after `<pre>` is
 * formatting rather than content, plus a trailing-whitespace trim so that a `</pre>`
 * sitting on its own indented line does not become a dangling blank line. Interior
 * lines, including their indentation and any blank lines between them, come through
 * untouched.
 *
 * Exported because `src/to-markdown.ts` needs exactly this for a fenced code block, and
 * reading `textContent` there instead silently welds every `<br>`-separated line
 * together. A code block that lost its line breaks is worse than no code block at all,
 * and a second copy of this walk is a copy that drifts — so there is one copy.
 */
export function preservedText(node: DomNode): string {
	const parts: string[] = [];
	/** Pushed onto the stack to mark "a block ended here". */
	const BLOCK_END = 0;

	/** Starts a new line unless one has just started — never doubles up. */
	const endLine = () => {
		if (parts.length && !parts[parts.length - 1].endsWith("\n")) parts.push("\n");
	};

	const stack: Array<DomNode | number> = [];
	const roots = childNodes(node);
	for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);

	while (stack.length) {
		const item = stack.pop()!;
		if (typeof item === "number") {
			endLine();
			continue;
		}
		if (isText(item)) {
			parts.push(item.textContent ?? "");
			continue;
		}
		// comments (and anything else exotic) contribute nothing
		if (!isElement(item)) continue;

		const name = tag(item);
		if (!name || NON_CONTENT.has(name)) continue;
		if (UNDECODED_TEXT_TAGS.has(name)) {
			parts.push(decodeReferences(text(item)));
			continue;
		}
		if (name === "br") {
			parts.push("\n");
			continue;
		}
		if (BLOCK_TAGS.has(name)) {
			endLine();
			stack.push(BLOCK_END);
		}
		const kids = childNodes(item);
		for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
	}

	// `.trimEnd()`, never `.replace(/\s+$/, "")`: that pattern is unanchored, so on
	// verbatim text holding a long whitespace run followed by anything else the engine
	// retries the match from every offset in the run — a `<pre>` with 100 000 newlines
	// and one trailing `x` took ~7 s to render. A hang is worse than a throw, and the
	// never-throws contract is worth nothing if the call never returns. The two forms
	// remove exactly the same characters: JS `\s` *is* WhiteSpace plus LineTerminator.
	return parts
		.join("")
		.replace(/\r\n?/g, "\n")
		.replace(/^\n/, "")
		.trimEnd();
}

// ---------------------------------------------------------------------------------
// the renderer
// ---------------------------------------------------------------------------------

/**
 * Renders a single node's subtree (the node included) to plain text.
 *
 * The node-level entry point, used by main-content extraction to render an already
 * isolated subtree without re-parsing it. {@linkcode toText} and
 * {@linkcode textFromDocument} are thin wrappers around this.
 *
 * The walk is iterative rather than recursive, and that is not a style preference: real
 * documents in a crawl queue nest tens of thousands of elements deep (usually a mangled
 * table, occasionally on purpose), a recursive renderer blows the stack on them, and a
 * `RangeError` escaping from here would break the never-throws contract for every
 * caller downstream.
 */
export function renderText(node: DomNode, options?: TextOptions): string {
	const logger = options?.logger;
	const preserveCode = options?.preserveCode !== false;

	const out: string[] = [];
	/** Strongest separator requested since the last emitted chunk. */
	let pending = SEP_NONE;
	/** Whether anything at all has been emitted — leading separators are dropped. */
	let started = false;
	/** Whether the first / last chunk came out of a `<pre>`, i.e. must not be trimmed. */
	let opensVerbatim = false;
	let endsVerbatim = false;
	/** Whether the last thing seen was a `<br>` with no text after it. */
	let afterBreak = false;
	let preBlocks = 0;
	let skipped = 0;

	const separate = (strength: number) => {
		if (started && strength > pending) pending = strength;
	};

	const emit = (chunk: string, verbatim: boolean) => {
		if (!chunk) return;
		if (started) {
			if (pending) out.push(SEPARATORS[pending]);
		} else {
			opensVerbatim = verbatim;
		}
		out.push(chunk);
		pending = SEP_NONE;
		started = true;
		endsVerbatim = verbatim;
		afterBreak = false;
	};

	/**
	 * Emits a text node with its whitespace runs collapsed but its *edges* preserved as
	 * space requests — that is what makes `<b>a</b> <i>b</i>` come out as `a b` while
	 * `<span>a</span><span>b</span>` stays `ab`. Trimming each node instead would eat
	 * the space between two inline elements, and not collapsing at all would drag the
	 * source's indentation into the output.
	 */
	const emitText = (raw: string) => {
		const collapsed = raw.replace(/\s+/g, " ");
		if (!collapsed) return;
		if (collapsed === " ") {
			separate(SEP_SPACE);
			return;
		}
		if (collapsed.startsWith(" ")) separate(SEP_SPACE);
		const trailing = collapsed.endsWith(" ");
		emit(collapsed.trim(), false);
		if (trailing) separate(SEP_SPACE);
	};

	const stack: Array<DomNode | number> = [node];
	while (stack.length) {
		const item = stack.pop()!;

		// a deferred closing separator, pushed when the element was entered
		if (typeof item === "number") {
			separate(item);
			continue;
		}
		if (isText(item)) {
			emitText(item.textContent ?? "");
			continue;
		}
		// comments (and anything else exotic) contribute nothing
		if (!isElement(item)) continue;

		const name = tag(item);
		if (!name) continue;

		// script/style/svg/… contribute nothing at all — not even separation, so that
		// `<div>a</div><script>…</script><div>b</div>` is still exactly `a\nb`
		if (NON_CONTENT.has(name)) {
			skipped++;
			continue;
		}

		// the parser stores this one's text undecoded, and it has no element children
		// to descend into — read it here so `&amp;` does not reach the output
		if (UNDECODED_TEXT_TAGS.has(name)) {
			emitText(decodeReferences(text(item)));
			continue;
		}

		if (name === "pre" && preserveCode) {
			separate(SEP_BLANK);
			const raw = preservedText(item);
			if (raw) {
				emit(raw, true);
				preBlocks++;
			}
			separate(SEP_BLANK);
			continue;
		}

		// a run of `<br>` is the oldest paragraph break in HTML; honouring the second
		// one costs nothing and the third is capped by the same collapse as everything
		// else
		if (name === "br") {
			separate(afterBreak ? SEP_BLANK : SEP_LINE);
			afterBreak = true;
			continue;
		}

		const strength = separatorFor(name);
		if (strength) {
			separate(strength);
			stack.push(strength);
		}
		const kids = childNodes(item);
		for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
	}

	let result = out.join("");
	// by construction there is nothing to trim — separators are never written before the
	// first or after the last chunk — but a `<pre>` at either end is the one case where
	// trimming would be actively wrong, so guard it and keep the rest as a safety net.
	// `trimStart`/`trimEnd` rather than `/^\s+/` and `/\s+$/`: same characters removed,
	// but the trailing pattern backtracks quadratically over a long verbatim whitespace
	// run — see {@linkcode preservedText}.
	if (!opensVerbatim) result = result.trimStart();
	if (!endsVerbatim) result = result.trimEnd();

	logger?.debug(
		`[html-extract] text: ${result.length} chars, ${preBlocks} <pre> block(s) preserved, ${skipped} non-content element(s) skipped`,
	);
	return result;
}

/**
 * Renders an already-parsed document's body to plain text.
 *
 * Internal counterpart of {@linkcode toText}, used by
 * {@linkcode "./extract.ts".extract} so the document is only parsed once.
 */
export function textFromDocument(doc: ParsedDocument, options?: TextOptions): string {
	return renderText(doc.body, options);
}

/**
 * Converts an HTML string to plain text, respecting block structure.
 *
 * Block elements become newlines and inline elements become spaces, so
 * `<div>a</div><div>b</div>` yields `a\nb` — the thing a regex tag-strip gets wrong and
 * the reason this is a tree walk. Paragraph-level blocks are separated by a blank line,
 * ordinary blocks by a newline, table cells by a tab; see the module documentation for
 * the full table. Whitespace runs are collapsed to single spaces, `&nbsp;` included
 * (leaving U+00A0 in extracted text is a lasting nuisance: it breaks string comparison
 * and shows up as a stray character everywhere downstream), while `<pre>` is passed
 * through verbatim unless {@linkcode TextOptions.preserveCode} is `false`. Entities are
 * already decoded by the parser, `<textarea>` excepted: the parser hands that one over
 * raw, so its references are resolved here rather than leaking `&amp;` into the text
 * (`<xmp>` and friends stay literal, which is what a browser shows). `script`, `style`,
 * `noscript`, `template`, `svg`,
 * `canvas`, comments and `<img alt>` contribute nothing — alt text is a markdown
 * concern.
 *
 * Never throws on bad input: malformed markup, a truncated document or binary noise all
 * render to whatever text could be recovered, and unparseable input renders to `""`.
 * The only exception is a non-string argument, which is a programmer error.
 *
 * @example
 * ```ts
 * toText("<h1>Title</h1><p>One.</p><p>Two.</p>");
 * // → "Title\n\nOne.\n\nTwo."
 *
 * toText("<div>a</div><div>b</div>");
 * // → "a\nb"   (a regex strip would give you "ab")
 * ```
 */
export function toText(html: string, options?: TextOptions): string {
	assertHtmlString(html, "toText");
	const doc = parseDocument(html, options);
	if (!doc) {
		options?.logger?.debug("[html-extract] text: nothing to render");
		return "";
	}
	return textFromDocument(doc, options);
}
