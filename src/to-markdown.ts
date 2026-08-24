/**
 * HTML → Markdown, written directly against the already-parsed tree.
 *
 * There is deliberately no `turndown` here (design §6): it wants a DOM of its own, which
 * would make the parser dependency non-swappable and add a second tree to keep in sync,
 * and its rules are not the ones this package needs. We already hold a tree, and the
 * cases that actually matter — `<pre>` fidelity, table degradation, list indentation,
 * minimal escaping — are exactly the cases a general-purpose converter gets wrong.
 *
 * The renderer is built around two mutually recursive halves:
 *
 * - **blocks** ({@linkcode renderBlockElement} and friends) produce an array of
 *   independent strings that are finally joined with a blank line. Nothing is
 *   post-processed with regexes over the whole document — a stray `#` inside a fenced
 *   code block is exactly the kind of bug that approach ships.
 * - **inline** ({@linkcode renderInlineChildren}) produces a single string, tracking
 *   whether it currently sits at the start of a line so that the line-start escaping
 *   rules can be applied without ever looking at the finished output.
 *
 * Recursion is capped at {@linkcode MAX_DEPTH} levels and degrades to flat text below
 * it. Hostile documents nest tens of thousands of elements deep, and a `RangeError`
 * would violate the never-throws contract.
 *
 * @module
 */

import {
	attr,
	childNodes,
	children,
	cloneElement,
	decodeReferences,
	type DomElement,
	type DomNode,
	isComment,
	isElement,
	isText,
	type ParsedDocument,
	parseDocument,
	query,
	queryAll,
	remove,
	serialize,
	tag,
	text,
	UNDECODED_TEXT_TAGS,
} from "./_dom.ts";
import {
	assertHtmlString,
	BLOCK_TAGS,
	collapseBlankLines,
	collapseWs,
	documentBase,
	NON_CONTENT_TAGS,
	resolveUrl,
} from "./_util.ts";
import { preservedText } from "./to-text.ts";
import type { Logger, MarkdownOptions } from "./types.ts";

/**
 * How deep the renderer recurses before it gives up and flattens the rest to text.
 *
 * Two frames per element level, so this stays an order of magnitude below any realistic
 * stack limit while being an order of magnitude above any real document.
 */
const MAX_DEPTH = 400;

/**
 * Elements that contribute **nothing** to the output, subtree included.
 *
 * The shared {@linkcode NON_CONTENT_TAGS} table plus `iframe` (an embed, not content)
 * and `head`/`title` — the latter two matter because `parseDocument` falls back to the
 * document element when the body is empty, and without them an unhydrated SPA shell
 * would render its `<title>` as a stray paragraph.
 */
const SKIP_TAGS: ReadonlySet<string> = new Set([
	...NON_CONTENT_TAGS,
	"iframe",
	"head",
	"title",
]);

/** Resolved rendering options plus the little mutable state the inline pass carries. */
interface Ctx {
	logger?: Logger;
	/** Base URL for `href`/`src` resolution; `undefined` leaves relative URLs relative. */
	base?: string;
	links: boolean;
	images: boolean;
	escape: boolean;
	bullet: string;
	/**
	 * `true` while nothing but whitespace has been emitted on the current line — the
	 * only thing the line-start escaping rules need to know.
	 */
	lineStart: boolean;
	/** Whether the depth cap has already been reported; it is worth saying exactly once. */
	depthReported: boolean;
}

/**
 * One rendered block.
 *
 * `list` and `raw` exist for exactly one reason each: `list` lets an `<li>` glue a
 * nested list to its own text without a blank line (a loose list would otherwise wrap
 * every item in `<p>`), and `raw` marks output whose whitespace is load-bearing —
 * fenced code and passthrough HTML — so the blank-line collapsing never touches it.
 */
interface Block {
	md: string;
	list?: boolean;
	raw?: boolean;
}

// ---------------------------------------------------------------------------------
// escaping
// ---------------------------------------------------------------------------------

/**
 * Escapes the markdown-significant characters of a **text node**, context-aware.
 *
 * This is deliberately narrower than the design sketch's `*_[]()#`` ` `` list. Escaping
 * all of those unconditionally turns ordinary prose into backslash soup — every `(`, every
 * `#` in a hashtag, every `)` at the end of an aside — and the noise is permanent,
 * because nothing downstream can tell an escape we added from one the author wrote. The
 * ruleset here is the smallest one that cannot change how the output parses:
 *
 * - everywhere: `\`, `` ` ``, `*`, `_`, `[`, `]`, `~`
 * - `<` only when a letter, `/`, `!` or `?` follows it, i.e. when it looks like a tag,
 *   a comment or a processing instruction
 * - `(` only directly after a `]`, i.e. where an inline link could form
 * - at the start of a line only: `#`, `>`, `-`, `+`, `=`, `|`, and a `1.`/`1)` ordered
 *   list marker
 *
 * The failure mode this defends against is a paragraph that silently becomes a heading,
 * a list item or a table row because it happened to start with the wrong character.
 * Everything else — `.`, `!`, `:`, a mid-sentence `#` — cannot start a construct and is
 * left alone on purpose.
 *
 * `~` is in the unconditional list rather than the line-start one, and it earns its
 * place there twice over: `~~~` opens a CommonMark **code fence**, so a paragraph that
 * is an ASCII rule swallows the whole rest of the document, and `~~x~~` (`~x~` in
 * cmark-gfm) is GFM strikethrough, so a pair of tildes anywhere in a paragraph strikes
 * the text between them. Escaping only at the line start would fix the first and leave
 * the second, and escaping only doubled tildes would leave the single-tilde form — this
 * is the same reasoning that already puts `_` in the list despite `snake_case` prose.
 */
function escapeInline(value: string, lineStart: boolean): string {
	let out = "";
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (
			ch === "\\" || ch === "`" || ch === "*" || ch === "_" || ch === "[" ||
			ch === "]" || ch === "~"
		) {
			out += "\\" + ch;
		} else if (ch === "<" && /[a-zA-Z/!?]/.test(value[i + 1] ?? "")) {
			out += "\\<";
		} else if (ch === "(" && value[i - 1] === "]") {
			out += "\\(";
		} else {
			out += ch;
		}
	}
	if (!lineStart) return out;
	// leading whitespace is dropped when the block is tidied, so a marker hiding behind
	// it is still a marker
	const indent = /^[ \t]*/.exec(out)![0];
	return indent + escapeLineStart(out.slice(indent.length));
}

/** Escapes a leading block-construct marker. See {@linkcode escapeInline}. */
function escapeLineStart(value: string): string {
	const ordered = /^(\d{1,9})([.)])/.exec(value);
	if (ordered) return `${ordered[1]}\\${ordered[2]}${value.slice(ordered[0].length)}`;
	const ch = value[0];
	return ch && "#>-+=|".includes(ch) ? `\\${ch}${value.slice(1)}` : value;
}

// ---------------------------------------------------------------------------------
// small string helpers
// ---------------------------------------------------------------------------------

/** Longest run of consecutive backticks in `value`. Used to size a fence. */
function maxBacktickRun(value: string): number {
	let max = 0;
	let run = 0;
	for (let i = 0; i < value.length; i++) {
		if (value[i] === "`") {
			run++;
			if (run > max) max = run;
		} else {
			run = 0;
		}
	}
	return max;
}

/** One character against JS `\s`. A literal set would drift from the spec's. */
const WS_CHAR = /\s/;

/**
 * Trims an inline run into a paragraph-ready string.
 *
 * The trailing-hard-break strip matters: a `<br>` immediately before `</p>` would
 * otherwise leave a lone backslash on the last line, which renders as a literal
 * backslash rather than as nothing.
 *
 * Scanned by index rather than with the obvious `/(?:\s*\\\n)+\s*$/`. That pattern
 * backtracks quadratically: on a run that does *not* end in hard breaks the engine
 * re-tries the whole tail from every offset in it, and `<br>`-per-line paragraphs are
 * ordinary WYSIWYG and email markup — 40 000 of them (157 KB of input) took ~15 s, and
 * a document at the default 10 MB cap takes hours. A hang is worse than a throw, and
 * the never-throws contract is worth nothing if the call never returns. Any
 * `(?:\s*X)+…$` spelling has the same blow-up, so this is index arithmetic on purpose:
 * walk left over whitespace, take a `\\\n` unit, repeat. Every character is visited at
 * most once.
 */
function tidyInline(value: string): string {
	/** Start of the trailing hard-break run, or `-1` when there is none. */
	let cut = -1;
	let i = value.length;
	for (;;) {
		// whitespace, except the `\n` of a `\\\n` — that one belongs to the unit below
		let j = i;
		while (
			j > 0 && WS_CHAR.test(value[j - 1]) &&
			!(value[j - 1] === "\n" && j >= 2 && value[j - 2] === "\\")
		) j--;
		if (!(j >= 2 && value[j - 1] === "\n" && value[j - 2] === "\\")) break;
		cut = j - 2;
		i = cut;
	}
	return (cut < 0 ? value : value.slice(0, cut)).trim();
}

/** Flattens an inline run onto one line — for headings, link labels and table cells. */
function flatten(value: string): string {
	// a hard break's backslash is meaningless once the newline is gone
	return collapseWs(value.replace(/\\?\r?\n/g, " "));
}

/** Wraps `inner` in `delim`, hoisting outer whitespace out of the delimiters. */
function emphasize(inner: string, delim: string): string {
	const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
	// `** foo **` is not emphasis; `_` and `*` need to hug their content
	return m[2] ? `${m[1]}${delim}${m[2]}${delim}${m[3]}` : inner;
}

/** Lays `body` out under a list marker, indenting continuation lines to the marker width. */
function indentUnderMarker(marker: string, body: string): string {
	const pad = " ".repeat(marker.length);
	const lines = body.split("\n");
	const rest = lines.slice(1).map((line) => (line ? pad + line : ""));
	return [marker + (lines[0] ?? ""), ...rest].join("\n").trimEnd();
}

/** `true` when every `(` in `url` is closed — an unbalanced one breaks `[t](url)`. */
function hasBalancedParens(url: string): boolean {
	let depth = 0;
	for (let i = 0; i < url.length; i++) {
		if (url[i] === "(") depth++;
		else if (url[i] === ")" && --depth < 0) return false;
	}
	return depth === 0;
}

/**
 * Formats a link destination, reaching for the `<…>` form when the bare one would not
 * survive.
 *
 * Whitespace and unbalanced parentheses both terminate a bare destination early, which
 * silently truncates the URL and leaves the tail as visible prose — a much worse failure
 * than the slightly noisier angle-bracket spelling.
 */
function formatUrl(url: string): string {
	if (!/[\s<>]/.test(url) && hasBalancedParens(url)) return url;
	return `<${url.replace(/[<>]/g, (c) => `\\${c}`)}>`;
}

/** Formats an optional link/image title suffix. */
function formatTitle(title: string | undefined): string {
	const value = title?.trim();
	return value ? ` "${value.replace(/"/g, '\\"')}"` : "";
}

// ---------------------------------------------------------------------------------
// inline rendering
// ---------------------------------------------------------------------------------

/**
 * Delimiters that merge into the wrong construct when two inline runs abut.
 *
 * `*a**b*` is not two emphasised words: the parser reads the middle `**` as literal
 * text inside one long `<em>`, so the second element disappears and two stray asterisks
 * appear in the prose. Same for `**`, for `~~`, and for two adjacent code spans, whose
 * `` `a``b` `` swallows the boundary.
 *
 * The test is deliberately blunt — *any* run of the same character meeting another. A
 * mixed pair like `**a***b*` does happen to survive, by CommonMark's rule of three, but
 * that rule is an emphasis-only subtlety that parsers implement with varying enthusiasm,
 * and the same "unequal lengths" shape is broken for backticks (`` ``a```b` ``) and for
 * tildes. One invariant that always holds beats a table of exceptions that mostly does.
 */
const MERGING_DELIMS = "*_~`";

/**
 * Emitted between two runs whose delimiters would otherwise merge.
 *
 * An empty HTML comment is the standard CommonMark "nothing" — it renders to no output
 * in every parser while still breaking the delimiter run, which is exactly what an
 * `<em>a</em><em>b</em>` boundary needs. The alternative, emitting the second run as a
 * literal `<em>` tag, gives up markdown for the rest of that run.
 */
const RUN_SEPARATOR = "<!-- -->";

/** Appends `value` and updates the "am I at the start of a line" flag from its tail. */
function pushInline(ctx: Ctx, parts: string[], value: string): void {
	if (!value) return;
	const prev = parts.length ? parts[parts.length - 1] : "";
	const last = prev[prev.length - 1];
	// a backslash in front of it means the previous run ended in an *escaped* literal,
	// which cannot pair with anything — `escapeInline` never emits a lone backslash
	if (
		last && last === value[0] && MERGING_DELIMS.includes(last) &&
		prev[prev.length - 2] !== "\\"
	) {
		parts.push(RUN_SEPARATOR);
	}
	parts.push(value);
	const nl = value.lastIndexOf("\n");
	if (nl >= 0) ctx.lineStart = !/\S/.test(value.slice(nl + 1));
	else if (/\S/.test(value)) ctx.lineStart = false;
}

/**
 * Renders a run of text: HTML whitespace collapsing, then escaping.
 *
 * Non-breaking spaces are left alone — the author put them there precisely because they
 * are not collapsible, and markdown has no other way to say so.
 */
function renderText(raw: string, ctx: Ctx): string {
	if (!raw) return "";
	const flat = raw.replace(/[\t\n\r\f\v ]+/g, " ");
	return ctx.escape ? escapeInline(flat, ctx.lineStart) : flat;
}

/**
 * Flattens a node list into elements and **coalesced** runs of text.
 *
 * The parser hands back every decoded entity as a text node of its own, so
 * `a &lt;b&gt;` arrives as `"a "`, `"<"`, `"b"`, `">"`. Escaping decisions that need to
 * look at the next character — `<` only escapes when a tag could follow it — would then
 * always be made against the end of a node and never fire. Comments are dropped here
 * rather than later for the same reason: they render to nothing, so the text on either
 * side of one really is adjacent in the output.
 */
function groupNodes(nodes: DomNode[]): Array<DomElement | string> {
	const out: Array<DomElement | string> = [];
	for (const node of nodes) {
		if (isComment(node)) continue;
		if (isText(node)) {
			const value = String(node.textContent ?? "");
			if (!value) continue;
			const last = out[out.length - 1];
			if (typeof last === "string") out[out.length - 1] = last + value;
			else out.push(value);
		} else if (isElement(node)) {
			out.push(node);
		}
	}
	return out;
}

/** Renders a node's children as one inline run. */
function renderInlineChildren(parent: DomNode, ctx: Ctx, depth: number): string {
	const parts: string[] = [];
	for (const child of groupNodes(childNodes(parent))) {
		if (typeof child === "string") {
			pushInline(ctx, parts, renderText(child, ctx));
		} else {
			pushInline(
				ctx,
				parts,
				renderInlineElement(child, tag(child), ctx, depth + 1),
			);
		}
	}
	return parts.join("");
}

/** Renders children as an inline run that is known not to start a line (emphasis, labels). */
function renderInlineRun(parent: DomNode, ctx: Ctx, depth: number): string {
	const outer = ctx.lineStart;
	ctx.lineStart = false;
	const value = renderInlineChildren(parent, ctx, depth);
	ctx.lineStart = outer;
	return value;
}

/**
 * Inline `<code>`: content verbatim, never escaped, delimiters widened to clear it.
 *
 * A code span cannot contain a run of backticks as long as its own delimiter, and it
 * loses a leading or trailing backtick to the delimiter unless padded with a space —
 * both are silent corruptions of the very content the reader is most likely to copy.
 */
function renderInlineCode(el: DomElement): string {
	const content = text(el).replace(/\r?\n/g, " ");
	if (!content) return "";
	const fence = "`".repeat(maxBacktickRun(content) + 1);
	const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${pad}${content}${pad}${fence}`;
}

/** `[label](url "title")`, or just the label when there is nothing to link to. */
function renderLink(el: DomElement, ctx: Ctx, depth: number): string {
	const label = flatten(renderInlineRun(el, ctx, depth));
	if (!ctx.links) return label;
	const url = resolveUrl(attr(el, "href"), ctx.base);
	if (!url || !label) return label;
	return `[${label}](${formatUrl(url)}${formatTitle(attr(el, "title"))})`;
}

/** `![alt](src "title")`. An image without `alt` still renders — the `src` is the point. */
function renderImage(el: DomElement, ctx: Ctx): string {
	if (!ctx.images) return "";
	const src = resolveUrl(attr(el, "src"), ctx.base);
	if (!src) return "";
	const alt = collapseWs(attr(el, "alt") ?? "").replace(/[\\[\]]/g, (c) => `\\${c}`);
	return `![${alt}](${formatUrl(src)}${formatTitle(attr(el, "title"))})`;
}

/** Renders one element in inline position. */
function renderInlineElement(
	el: DomElement,
	name: string,
	ctx: Ctx,
	depth: number,
): string {
	if (SKIP_TAGS.has(name)) return "";
	if (depth > MAX_DEPTH) return degradeToText(el, ctx, false);
	// linkedom hands `<textarea>` over as raw source, so its references have to be
	// resolved on read — otherwise the literal `&amp;` of a pre-filled comment box reaches
	// the markdown. See {@linkcode "./_dom.ts".UNDECODED_TEXT_TAGS}.
	if (UNDECODED_TEXT_TAGS.has(name)) {
		const value = decodeReferences(text(el));
		return ctx.escape ? escapeInline(value, ctx.lineStart) : value;
	}

	switch (name) {
		// CommonMark's backslash hard break rather than two trailing spaces: trailing
		// whitespace is invisible, gets stripped by editors, formatters and by
		// `collapseBlankLines` below, and then the break is silently gone
		case "br":
			return "\\\n";
		case "wbr":
			return "";
		case "img":
			return renderImage(el, ctx);
		case "a":
			return renderLink(el, ctx, depth);
		case "code":
			return renderInlineCode(el);
		case "strong":
		case "b":
			return emphasize(renderInlineRun(el, ctx, depth), "**");
		case "em":
		case "i":
			return emphasize(renderInlineRun(el, ctx, depth), "*");
		case "del":
		case "s":
		case "strike":
			return emphasize(renderInlineRun(el, ctx, depth), "~~");
		default:
			// a block element in inline position (a `<div>` inside a table cell, say):
			// render it properly, then flatten — dropping it would lose text
			if (BLOCK_TAGS.has(name)) {
				return flatten(joinBlocks(renderBlockElement(el, name, ctx, depth)));
			}
			// `mark`, `span`, `abbr`, `sup`, everything unknown: transparent
			return renderInlineChildren(el, ctx, depth);
	}
}

// ---------------------------------------------------------------------------------
// block rendering
// ---------------------------------------------------------------------------------

/** Joins blocks the ordinary way — one blank line between them. */
function joinBlocks(blocks: Block[]): string {
	return blocks.map((b) => b.md).filter(Boolean).join("\n\n");
}

/**
 * Joins the blocks of a single list item or definition.
 *
 * A nested list is glued on with a single newline; anything else gets a blank line. The
 * blank line is what makes a list *loose*, and a loose list wraps every item's text in
 * `<p>` — which is never what nesting a list was meant to express.
 */
function joinItemBlocks(blocks: Block[]): string {
	let out = "";
	for (let i = 0; i < blocks.length; i++) {
		if (!blocks[i].md) continue;
		if (out) out += blocks[i].list ? "\n" : "\n\n";
		out += blocks[i].md;
	}
	return out;
}

/** The depth-cap escape hatch: everything below the cap becomes one flat run of text. */
function degradeToText(el: DomElement, ctx: Ctx, lineStart: boolean): string {
	if (!ctx.depthReported) {
		ctx.depthReported = true;
		ctx.logger?.warn(
			`[html-extract] markdown: nesting deeper than ${MAX_DEPTH} levels, rendering the remainder as plain text`,
		);
	}
	const flat = collapseWs(text(el));
	if (!flat) return "";
	return ctx.escape ? escapeInline(flat, lineStart) : flat;
}

/** Renders a list of sibling nodes into blocks, grouping inline runs into paragraphs. */
function renderNodeList(nodes: DomNode[], ctx: Ctx, depth: number): Block[] {
	const blocks: Block[] = [];
	let parts: string[] = [];
	ctx.lineStart = true;

	const flush = () => {
		const md = tidyInline(parts.join(""));
		parts = [];
		ctx.lineStart = true;
		if (md) blocks.push({ md });
	};

	for (const node of groupNodes(nodes)) {
		if (typeof node === "string") {
			pushInline(ctx, parts, renderText(node, ctx));
			continue;
		}
		const name = tag(node);
		if (SKIP_TAGS.has(name)) continue;
		if (BLOCK_TAGS.has(name)) {
			flush();
			for (const b of renderBlockElement(node, name, ctx, depth + 1)) {
				blocks.push(b);
			}
			continue;
		}
		pushInline(ctx, parts, renderInlineElement(node, name, ctx, depth + 1));
	}
	flush();
	return blocks;
}

/** Renders an element's children into blocks. */
function renderChildBlocks(el: DomElement, ctx: Ctx, depth: number): Block[] {
	return renderNodeList(childNodes(el), ctx, depth);
}

/** ATX heading. An empty heading emits nothing — `###` alone is noise, not structure. */
function renderHeading(el: DomElement, level: number, ctx: Ctx, depth: number): Block[] {
	const label = flatten(renderInlineRun(el, ctx, depth));
	return label ? [{ md: `${"#".repeat(level)} ${label}` }] : [];
}

/** Reads `language-xxx` / `lang-xxx` off a class attribute. */
function languageFromClass(value: string | undefined): string | undefined {
	const m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/i.exec(value ?? "");
	return m ? m[1] : undefined;
}

/**
 * Fenced code block, with the content preserved **byte for byte**.
 *
 * No escaping, no whitespace collapsing, no re-indentation: this is the single most
 * commonly botched conversion, and a code block that has been "tidied" is worse than no
 * code block at all. The only edits are the newline HTML itself drops right after
 * `<pre>` and the trailing whitespace before `</pre>`, neither of which is content.
 *
 * The content comes from {@linkcode "./to-text.ts".preservedText}, not from
 * `textContent`, and that is the whole point of sharing it: syntax highlighters and
 * pasted-from-an-editor markup routinely emit a `<div>` (or a `<br>`) per line with no
 * newline of their own, and reading `textContent` welded every one of those blocks onto
 * a single line — `toText()` on the same input got it right, so the two renderers
 * disagreed about how many lines the document had. It also replaces a
 * `/(?:\r?\n)+[ \t]*$/` trailing strip that backtracked quadratically over a long
 * newline run (80 000 newlines inside a `<pre>` took ~22 s), which a truncated or
 * mangled crawled document produces without trying.
 */
function renderPre(el: DomElement, ctx: Ctx): Block[] {
	const inner = el.firstElementChild;
	const lang = languageFromClass(attr(el, "class")) ??
		(inner && tag(inner) === "code"
			? languageFromClass(attr(inner, "class"))
			: undefined);

	const content = preservedText(el);
	if (!content) return [];

	// a fence must be longer than the longest backtick run it contains, or the block
	// ends in the middle of the code
	const fence = "`".repeat(Math.max(3, maxBacktickRun(content) + 1));
	ctx.logger?.debug(
		`[html-extract] markdown: code block (${content.length} chars${
			lang ? `, lang=${lang}` : ""
		})`,
	);
	return [{ md: `${fence}${lang ?? ""}\n${content}\n${fence}`, raw: true }];
}

/** Blockquote — every line prefixed, so nesting composes for free. */
function renderBlockquote(el: DomElement, ctx: Ctx, depth: number): Block[] {
	const inner = renderChildBlocks(el, ctx, depth);
	const body = joinBlocks(inner);
	if (!body) return [];
	// blank lines become a bare ">" so the quote stays one block
	const md = body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
	return [{ md, raw: inner.some((b) => b.raw) }];
}

/** Parses an integer attribute, falling back to `fallback` for anything unusable. */
function intAttr(el: DomElement, name: string, fallback: number): number {
	const n = Number.parseInt(attr(el, name) ?? "", 10);
	return Number.isFinite(n) ? n : fallback;
}

/** List containers that hang off the item above them when they are a list's own child. */
const NESTED_LIST_TAGS: ReadonlySet<string> = new Set(["ul", "ol", "menu", "dir"]);

/**
 * Ordered or unordered list.
 *
 * Continuation and child content is indented by exactly the marker's width — 2 for
 * `"- "`, 3 for `"1. "`, 4 for `"10. "` — which is what keeps a nested list nested
 * instead of turning into a code block.
 *
 * **Every child is rendered, not only the `<li>`s.** A `<ul>` nested directly inside
 * another list instead of inside an `<li>` is invalid HTML that TinyMCE-era editors,
 * Word exports and hand-written CMS content all emit, and that every browser draws as a
 * nested list; filtering for `li` made its entire subtree vanish from the markdown while
 * `toText()` still reported it, so the same document had two different amounts of
 * content depending on which renderer you asked. Silent content loss is the worst
 * failure mode this package has, so:
 *
 * - a nested list joins the item above it — the same `{list: true}` glue an `<li>`'s own
 *   nested list already gets, so it indents under that item's marker;
 * - with no item above it, or for anything else (stray text, a `<div>`), the content is
 *   flushed out as its own block between two runs of items. The ordered counter keeps
 *   running across the split, and since every marker is written out explicitly the
 *   numbering survives being two lists.
 */
function renderList(el: DomElement, ctx: Ctx, depth: number, ordered: boolean): Block[] {
	const out: Block[] = [];
	/** The item run being built; content between two items ends it. */
	let items: Array<{ marker: string; blocks: Block[] }> = [];
	/** Children that are neither an item nor a nested list, rendered together. */
	const stray: DomNode[] = [];
	let n = ordered ? intAttr(el, "start", 1) : 0;

	const flushItems = () => {
		if (!items.length) return;
		const lines = items.map((it) =>
			indentUnderMarker(it.marker, joinItemBlocks(it.blocks))
		);
		const raw = items.some((it) => it.blocks.some((b) => b.raw));
		items = [];
		out.push({ md: lines.join("\n"), list: true, raw });
	};

	// rendered *before* the item run is ended, never after: the whitespace between two
	// `<li>`s is a child node too, and splitting every list on it would be an own goal
	const flushStray = () => {
		if (!stray.length) return;
		const blocks = renderNodeList(stray, ctx, depth);
		stray.length = 0;
		if (!blocks.length) return;
		flushItems();
		for (const b of blocks) out.push(b);
	};

	for (const node of childNodes(el)) {
		if (isElement(node)) {
			const name = tag(node);
			if (name === "li") {
				flushStray();
				if (ordered) n = intAttr(node, "value", n);
				items.push({
					marker: ordered ? `${n}. ` : `${ctx.bullet} `,
					blocks: renderChildBlocks(node, ctx, depth + 1),
				});
				if (ordered) n++;
				continue;
			}
			if (NESTED_LIST_TAGS.has(name)) {
				flushStray();
				if (items.length) {
					const item = items[items.length - 1];
					const nested = renderBlockElement(node, name, ctx, depth + 1);
					// only the first block glues to the item's text; anything the
					// nested list flushed out of itself keeps its own spacing
					for (let i = 0; i < nested.length; i++) {
						item.blocks.push(i ? nested[i] : { ...nested[i], list: true });
					}
					continue;
				}
			}
		}
		stray.push(node);
	}
	flushStray();
	flushItems();
	return out;
}

/**
 * A `<dl>`'s children with one level of grouping `<div>` flattened away.
 *
 * HTML5 explicitly allows `<dl><div><dt>…</dt><dd>…</dd></div></dl>` — MDN's own
 * reference pages are written that way — and exactly one level of it, so this needs no
 * recursion. Without the flattening every term and definition inside such a wrapper is
 * neither `dt` nor `dd` from the list's point of view.
 */
function dlNodes(el: DomElement): DomNode[] {
	const out: DomNode[] = [];
	for (const node of childNodes(el)) {
		if (tag(node) === "div") {
			for (const inner of childNodes(node)) out.push(inner);
		} else {
			out.push(node);
		}
	}
	return out;
}

/**
 * Definition list: each `<dt>` a bold line, its `<dd>`s a bullet list under it.
 *
 * The obvious rendering — the term on its own line, the definition indented two spaces
 * beneath it — is not a markdown construct at all. Two spaces of indentation makes a
 * *lazy continuation line*, so the whole glossary collapses into a single run-on
 * paragraph the moment it is rendered, which on an API-parameter page means every term
 * runs into its own definition.
 *
 * `**Term**` followed by a blank line and a `-` list is plain CommonMark, renders the
 * same in GFM, keeps the pairing visible to a reader, and lets a `<dd>` that holds
 * blocks of its own indent under the marker like any other list item. The blank line is
 * deliberate: a list may interrupt a paragraph in CommonMark but not in every other
 * parser, and a definition swallowed into the term's paragraph is the bug being fixed.
 * Consecutive `<dd>`s stay glued as items of one list.
 *
 * Children that are neither `<dt>` nor `<dd>` are rendered as their own blocks rather
 * than skipped, for the same reason as in {@linkcode renderList}: dropping them loses
 * text with no trace.
 */
function renderDl(el: DomElement, ctx: Ctx, depth: number): Block[] {
	const out: Block[] = [];
	const lines: string[] = [];
	const stray: DomNode[] = [];
	let raw = false;
	let prev = "";

	const flushDl = () => {
		if (!lines.length) return;
		out.push({ md: lines.join("\n"), raw });
		lines.length = 0;
		raw = false;
		prev = "";
	};

	const flushStray = () => {
		if (!stray.length) return;
		const blocks = renderNodeList(stray, ctx, depth);
		stray.length = 0;
		if (!blocks.length) return;
		flushDl();
		for (const b of blocks) out.push(b);
	};

	for (const node of dlNodes(el)) {
		const name = isElement(node) ? tag(node) : "";
		if (!isElement(node) || (name !== "dt" && name !== "dd")) {
			stray.push(node);
			continue;
		}
		// a term or a definition ends whatever ran before it
		flushStray();
		const inner = renderChildBlocks(node, ctx, depth + 1);
		// a term is one line by construction — `**` cannot span a blank line
		const body = name === "dt" ? flatten(joinBlocks(inner)) : joinItemBlocks(inner);
		if (!body) continue;
		if (inner.some((b) => b.raw)) raw = true;
		if (lines.length && !(name === "dd" && prev === "dd")) lines.push("");
		lines.push(
			name === "dt" ? `**${body}**` : indentUnderMarker(`${ctx.bullet} `, body),
		);
		prev = name;
	}
	flushStray();
	flushDl();
	return out;
}

/**
 * The figure's content, then its caption as a separate paragraph.
 *
 * Explicitly reordered rather than taken in document order: `<figcaption>` is legal
 * first *or* last, and a caption that reads as an introduction is a different document.
 */
function renderFigure(el: DomElement, ctx: Ctx, depth: number): Block[] {
	const kids = childNodes(el);
	const isCaption = (n: DomNode) => isElement(n) && tag(n) === "figcaption";
	const content = renderNodeList(kids.filter((n) => !isCaption(n)), ctx, depth);
	const caption: Block[] = [];
	for (const n of kids.filter(isCaption)) {
		for (const b of renderChildBlocks(n as DomElement, ctx, depth + 1)) {
			caption.push(b);
		}
	}
	return [...content, ...caption];
}

/** Nearest ancestor `<table>`, walking parents with a guard against pathological depth. */
function nearestTable(el: DomElement): DomElement | null {
	let parent = el.parentElement;
	for (let i = 0; parent && i < MAX_DEPTH * 4; i++) {
		if (tag(parent) === "table") return parent;
		parent = parent.parentElement;
	}
	return null;
}

/** The `<td>`/`<th>` children of a row. Direct children only — nested tables are theirs. */
function rowCells(row: DomElement): DomElement[] {
	return children(row).filter((c) => tag(c) === "td" || tag(c) === "th");
}

/** Renders one cell's content, flattened and `|`-escaped for a GFM row. */
function renderCell(cell: DomElement, ctx: Ctx, depth: number): string {
	return flatten(renderInlineRun(cell, ctx, depth)).replace(/\|/g, "\\|");
}

/**
 * The table's own HTML, filtered down to what the rest of this renderer may emit.
 *
 * Two things have to happen before a degraded table can be handed to a markdown
 * consumer, and neither is optional:
 *
 * - **Non-content is removed.** The passthrough used to hand back `serialize(el)`
 *   directly, which walked straight past {@linkcode SKIP_TAGS} — and since
 *   {@linkcode "./_dom.ts".serialize} writes raw-text elements *unescaped*, a
 *   `<script>` inside a cell of a crawled page came through byte for byte into output
 *   this module documents as script-free. Markdown renderers pass raw HTML through by
 *   default, so that is live script in whatever renders the result. Comments go for the
 *   same reason: they are documented as producing nothing.
 * - **Blank lines are removed.** A single blank line *ends* a CommonMark HTML block, so
 *   a pretty-printed table, or one holding a `<pre>` with a blank line in it,
 *   disintegrates halfway through: the remainder renders as escaped literal source, and
 *   a stray `<p>` gets injected into the middle of the markup. Losing the blank lines
 *   inside such a `<pre>` is a real cost, and it is far smaller than losing the table.
 *
 * The filtering runs on a **clone**: `extract()` shares one parsed document between
 * every extractor, so mutating the real tree here would change what the others see.
 * Returns `null` when the parser refuses to clone, which is the caller's cue to degrade
 * further rather than emit an unfiltered copy.
 */
function passthroughTable(el: DomElement): string | null {
	const clone = cloneElement(el);
	if (!clone) return null;

	// iterative, like every other walk here — a table nested 20 000 deep is real input
	const stack: DomNode[] = [clone];
	while (stack.length) {
		const node = stack.pop()!;
		// a snapshot, so removing as we go is safe
		for (const child of childNodes(node)) {
			if (isComment(child) || (isElement(child) && SKIP_TAGS.has(tag(child)))) {
				remove(child);
			} else if (isElement(child)) {
				stack.push(child);
			}
		}
	}

	return serialize(clone)
		.split("\n")
		.filter((line) => line.trim() !== "")
		.join("\n");
}

/**
 * GFM table when the table is rectangular, the table's own HTML when it is not.
 *
 * "Rectangular" means no cell spans more than one row or column and every row has the
 * same number of cells. GFM cannot express anything else, and the alternatives to
 * degrading — dropping the cells that do not fit, or emitting a row of the wrong width —
 * both lose or reorder data silently. Passthrough HTML is ugly and honest; a markdown
 * consumer that cares can parse it, and one that does not still sees every value. What
 * it is *not* is a hole in the rules the rest of the renderer follows — see
 * {@linkcode passthroughTable}.
 *
 * The header row is `<thead>`'s first row when there is a `<thead>`, and otherwise the
 * first row — including when that row is plain `<td>`s. GFM has no headerless table, so
 * *something* has to be promoted, and promoting the first row is what every reader
 * expects. Note that the parser inserts no implied `<tbody>`, so rows are found by
 * query, never by assuming a wrapper.
 */
function renderTable(el: DomElement, ctx: Ctx, depth: number): Block[] {
	const rows = queryAll(el, "tr", ctx.logger).filter((r) => nearestTable(r) === el);
	if (!rows.length) {
		ctx.logger?.debug(
			"[html-extract] markdown: <table> with no rows, rendering inline",
		);
		return renderChildBlocks(el, ctx, depth);
	}

	const grid = rows.map(rowCells);
	const width = grid[0].length;
	const rectangular = width > 0 && grid.every((cells) =>
		cells.length === width &&
		cells.every((c) =>
			intAttr(c, "colspan", 1) <= 1 && intAttr(c, "rowspan", 1) <= 1 &&
			// a table inside a cell is no more expressible in GFM than a colspan is
			!query(c, "table", ctx.logger)
		)
	);

	if (!rectangular) {
		ctx.logger?.debug(
			`[html-extract] markdown: table is not rectangular (${rows.length} row(s)), degrading to passthrough HTML`,
		);
		const html = passthroughTable(el);
		if (html) return [{ md: html, raw: true }];
		ctx.logger?.warn(
			"[html-extract] markdown: could not clone the table for passthrough, rendering its cells as text",
		);
		return renderChildBlocks(el, ctx, depth);
	}

	const blocks: Block[] = [];
	const caption = children(el).find((c) => tag(c) === "caption");
	if (caption) {
		for (const b of renderChildBlocks(caption, ctx, depth + 1)) blocks.push(b);
	}

	let headerIdx = rows.findIndex((r) => tag(r.parentElement) === "thead");
	if (headerIdx < 0) headerIdx = 0;

	const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
	const header = grid[headerIdx].map((c) => renderCell(c, ctx, depth + 1));
	const lines = [line(header), line(header.map(() => "---"))];
	for (let i = 0; i < grid.length; i++) {
		if (i === headerIdx) continue;
		lines.push(line(grid[i].map((c) => renderCell(c, ctx, depth + 1))));
	}

	ctx.logger?.debug(
		`[html-extract] markdown: GFM table ${grid.length}x${width} (header row ${headerIdx})`,
	);
	blocks.push({ md: lines.join("\n") });
	return blocks;
}

/** Renders one element in block position. */
function renderBlockElement(
	el: DomElement,
	name: string,
	ctx: Ctx,
	depth: number,
): Block[] {
	if (SKIP_TAGS.has(name)) return [];
	if (depth > MAX_DEPTH) {
		const md = degradeToText(el, ctx, true);
		return md ? [{ md }] : [];
	}

	switch (name) {
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6":
			return renderHeading(el, Number(name[1]), ctx, depth);
		case "pre":
			return renderPre(el, ctx);
		case "hr":
			return [{ md: "---" }];
		case "blockquote":
			return renderBlockquote(el, ctx, depth);
		case "ul":
		case "menu":
		case "dir":
			return renderList(el, ctx, depth, false);
		case "ol":
			return renderList(el, ctx, depth, true);
		case "dl":
			return renderDl(el, ctx, depth);
		case "table":
			return renderTable(el, ctx, depth);
		case "figure":
			return renderFigure(el, ctx, depth);
		default:
			// `p`, `div`, `section`, `li` outside a list, … — transparent containers
			return renderChildBlocks(el, ctx, depth);
	}
}

/** Renders any node as blocks, dispatching on what it actually is. */
function renderNode(node: DomNode, ctx: Ctx, depth: number): Block[] {
	if (isComment(node)) return [];
	if (isText(node)) {
		ctx.lineStart = true;
		const md = tidyInline(renderText(String(node.textContent ?? ""), ctx));
		return md ? [{ md }] : [];
	}
	if (!isElement(node)) return renderNodeList(childNodes(node), ctx, depth);

	const name = tag(node);
	if (SKIP_TAGS.has(name)) return [];
	if (BLOCK_TAGS.has(name)) return renderBlockElement(node, name, ctx, depth);

	ctx.lineStart = true;
	const md = tidyInline(renderInlineElement(node, name, ctx, depth));
	return md ? [{ md }] : [];
}

/**
 * Joins blocks into the finished document.
 *
 * {@linkcode collapseBlankLines} runs **per block and never on `raw` blocks**. Run over
 * the whole output it would also strip the trailing whitespace inside fenced code and
 * inside passthrough HTML — which is exactly the content this renderer promises to keep
 * byte for byte.
 */
function finalize(blocks: Block[]): string {
	const out: string[] = [];
	for (const b of blocks) {
		const md = b.raw ? b.md : collapseBlankLines(b.md);
		if (md) out.push(md);
	}
	return out.join("\n\n").trim();
}

/** Resolves options into a rendering context. */
function makeCtx(options: MarkdownOptions | undefined, base: string | undefined): Ctx {
	const bullet = options?.bullet;
	return {
		logger: options?.logger,
		base,
		links: options?.links !== false,
		images: options?.images !== false,
		escape: options?.escape !== false,
		bullet: bullet === "*" || bullet === "+" ? bullet : "-",
		lineStart: true,
		depthReported: false,
	};
}

// ---------------------------------------------------------------------------------
// public surface
// ---------------------------------------------------------------------------------

/**
 * Renders a single node's subtree as markdown.
 *
 * The node-level entry point, used by main-content extraction once it has picked a
 * subtree — it is not exported from `mod.ts` because it would put a parser node in the
 * public API, which is the one thing `_dom.ts` exists to prevent.
 *
 * Unlike {@linkcode markdownFromDocument} there is no `<base href>` to consult, so
 * `options.url` is used as the base verbatim.
 */
export function renderMarkdown(node: DomNode, options?: MarkdownOptions): string {
	if (!node) return "";
	return finalize(renderNode(node, makeCtx(options, options?.url), 0));
}

/**
 * Renders an already-parsed document's body as markdown.
 *
 * Internal counterpart of {@linkcode toMarkdown}, used by
 * {@linkcode "./extract.ts".extract} so the document is only parsed once. The base URL
 * follows browser rules — a `<base href>` in the document wins over `options.url`.
 */
export function markdownFromDocument(
	doc: ParsedDocument,
	options?: MarkdownOptions,
): string {
	const ctx = makeCtx(options, documentBase(doc.root, options?.url));
	const md = finalize(renderNode(doc.body, ctx, 0));
	ctx.logger?.debug(`[html-extract] markdown: ${md.length} chars rendered`);
	return md;
}

/**
 * Converts an HTML document to markdown.
 *
 * What the conversion guarantees, in the order the cases actually bite:
 *
 * - `<pre>`/`<code>` content is preserved exactly — never escaped, never collapsed, and
 *   fenced with enough backticks to clear any run inside it. The language comes from a
 *   `language-xxx`/`lang-xxx` class on the `<pre>` or its `<code>`.
 * - Tables become GFM **only when rectangular**; anything with a `colspan`, a `rowspan`
 *   or a ragged row degrades to its own HTML rather than to a broken table. That HTML
 *   is filtered the same way the rest of the output is — no `<script>`, no comments —
 *   and stripped of blank lines, which would otherwise end the HTML block halfway
 *   through the table.
 * - Lists render every child, including a `<ul>` nested directly inside another list
 *   rather than inside an `<li>`; a `<dl>` becomes a bold term with its definitions as
 *   a list under it, both of which survive being rendered.
 * - Links and images resolve against `<base href>` or {@linkcode MarkdownOptions.url};
 *   destinations that need it get the `<…>` form.
 * - Escaping is minimal and context-aware (see the module source) rather than the usual
 *   blanket `*_[]()#`, which turns prose into backslash soup.
 * - `script`, `style`, `noscript`, `template`, `svg`, `canvas`, `iframe` and comments
 *   produce nothing; unknown elements are transparent.
 *
 * Never throws on bad input: broken markup, a truncated document or binary noise all
 * yield a degraded string, and unparseable input yields `""`.
 *
 * @example
 * ```ts
 * declare const url: string;
 * toMarkdown(`<h1>Title</h1><p>See <a href="/x">this</a>.</p>`, {
 * 	url: "https://example.com/post",
 * });
 * // "# Title\n\nSee [this](https://example.com/x)."
 * ```
 */
export function toMarkdown(html: string, options?: MarkdownOptions): string {
	assertHtmlString(html, "toMarkdown");
	const doc = parseDocument(html, options);
	if (!doc) {
		options?.logger?.debug("[html-extract] markdown: nothing to render");
		return "";
	}
	return markdownFromDocument(doc, options);
}
