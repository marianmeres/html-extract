import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { preservedText, renderText, textFromDocument, toText } from "../src/to-text.ts";
import { parseDocument } from "../src/_dom.ts";
import type { Logger } from "../src/types.ts";

// ---------------------------------------------------------------------------------
// the block/inline rule — the whole reason this function exists
// ---------------------------------------------------------------------------------

Deno.test("block elements produce newlines, never welded words", () => {
	assertEquals(toText("<div>a</div><div>b</div>"), "a\nb");
	// the same thing a regex tag-strip gets wrong, in the shapes it shows up in
	assertEquals(toText("<li>a</li><li>b</li>"), "a\nb");
	assertEquals(toText("<div>a</div>\n  \n<div>b</div>"), "a\nb");
});

Deno.test("inline elements produce spaces only where the source has them", () => {
	assertEquals(toText("<b>a</b> <i>b</i>"), "a b");
	assertEquals(toText("<span>a</span><span>b</span>"), "ab");
	assertEquals(toText("<p>a <a href='#'>link</a> b</p>"), "a link b");
	assertEquals(toText("<p>war<em>ning</em>s</p>"), "warnings");
});

Deno.test("paragraph-level blocks are separated by a blank line", () => {
	assertEquals(toText("<h1>Title</h1><p>One.</p><p>Two.</p>"), "Title\n\nOne.\n\nTwo.");
	assertEquals(toText("<p>a</p><blockquote>b</blockquote>"), "a\n\nb");
	assertEquals(toText("<p>a</p><hr><p>b</p>"), "a\n\nb");
});

Deno.test("adjacent separators collapse to the strongest one", () => {
	// </p> asks for a blank line, <div> for a newline — the blank line wins, and the
	// whitespace between the tags does not add a third
	assertEquals(toText("<p>a</p>\n<div>b</div>"), "a\n\nb");
	// no leading or trailing newlines survive
	assertEquals(toText("<div><p>x</p></div>"), "x");
	assertEquals(toText("  <p>x</p>  "), "x");
});

Deno.test("nested block structures", () => {
	const html = `
		<article>
			<header><h1>T</h1><div class="byline">by me</div></header>
			<section>
				<p>First.</p>
				<ul><li>one</li><li>two</li></ul>
				<p>Last.</p>
			</section>
		</article>`;
	assertEquals(toText(html), "T\n\nby me\n\nFirst.\n\none\ntwo\n\nLast.");
});

// ---------------------------------------------------------------------------------
// <pre>
// ---------------------------------------------------------------------------------

Deno.test("<pre> is preserved verbatim, indentation and blank lines included", () => {
	const html = [
		"<p>before</p>",
		"<pre>",
		"  indented one",
		"",
		"    indented two",
		"</pre>",
		"<p>after</p>",
	].join("\n");
	assertEquals(toText(html), "before\n\n  indented one\n\n    indented two\n\nafter");
});

Deno.test("<pre> keeps leading indentation even as the whole document", () => {
	assertEquals(toText("<pre>    x\n      y</pre>"), "    x\n      y");
});

Deno.test("<pre> descends into highlighter markup without collapsing", () => {
	const html = "<pre><code><span>if</span> (a) {\n\treturn   1;\n}</code></pre>";
	assertEquals(toText(html), "if (a) {\n\treturn   1;\n}");
	// a highlighter that emits one block per line and no real newlines still lines up
	assertEquals(
		toText('<pre><div class="l">a  b</div><div class="l">  c</div></pre>'),
		"a  b\n  c",
	);
	assertEquals(toText("<pre>x<div>y</div></pre>"), "x\ny");
	// …and one that emits real newlines does not get doubled ones
	assertEquals(
		toText('<pre><span class="l">a</span>\n<span class="l">b</span></pre>'),
		"a\nb",
	);
	// <br> inside <pre> is still a line break
	assertEquals(toText("<pre>a<br>  b</pre>"), "a\n  b");
});

Deno.test("preserveCode: false renders <pre> like any other paragraph block", () => {
	const html = "<p>before</p><pre>\n  a\n\n    b\n</pre><p>after</p>";
	assertEquals(toText(html, { preserveCode: false }), "before\n\na b\n\nafter");
});

Deno.test("<code> outside <pre> is inline and collapsed", () => {
	assertEquals(toText("<p>use <code>a   b</code> here</p>"), "use a b here");
});

// ---------------------------------------------------------------------------------
// tables, breaks, non-content
// ---------------------------------------------------------------------------------

Deno.test("table cells are tab separated, rows newline separated", () => {
	const html = "<table>" +
		"<tr><th>h1</th><th>h2</th></tr>" +
		"<tr><td>a</td><td>b</td></tr>" +
		"<tr><td>c</td><td>d</td></tr>" +
		"</table>";
	assertEquals(toText(html), "h1\th2\na\tb\nc\td");
	// and the table as a whole is a paragraph-level block
	assertEquals(toText(`<p>x</p>${html}<p>y</p>`), "x\n\nh1\th2\na\tb\nc\td\n\ny");
});

Deno.test("<br> is a newline, two in a row are a blank line", () => {
	assertEquals(toText("<p>a<br>b</p>"), "a\nb");
	assertEquals(toText("<div>a<br><br>b</div>"), "a\n\nb");
	assertEquals(toText("<div>a<br><br><br><br>b</div>"), "a\n\nb");
});

Deno.test("script, style, noscript, template, svg, canvas and comments render nothing", () => {
	assertEquals(
		toText("<div>a</div><script>var x = 'nope';</script><div>b</div>"),
		"a\nb",
	);
	assertEquals(toText("<style>.x{color:red}</style><p>a</p>"), "a");
	assertEquals(toText("<p>a</p><noscript>enable js</noscript><p>b</p>"), "a\n\nb");
	assertEquals(toText("<p>a</p><template><p>hidden</p></template>"), "a");
	assertEquals(toText("<div>a<svg><text>zz</text></svg>b</div>"), "ab");
	assertEquals(toText("<div>a<canvas>fallback</canvas>b</div>"), "ab");
	assertEquals(toText("<div>a<!-- comment -->b</div>"), "ab");
});

Deno.test("<img alt> contributes nothing — alt text is a markdown concern", () => {
	assertEquals(toText('<p>a<img alt="a picture" src="x.png">b</p>'), "ab");
});

// ---------------------------------------------------------------------------------
// entities & whitespace
// ---------------------------------------------------------------------------------

Deno.test("entities arrive decoded from the parser and are not decoded again", () => {
	assertEquals(toText("<p>Tom &amp; Jerry</p>"), "Tom & Jerry");
	assertEquals(toText("<p>&#65;&#66;&#67;</p>"), "ABC");
	assertEquals(toText("<p>&copy; 2026</p>"), "© 2026");
	assertEquals(toText("<p>&lt;div&gt;</p>"), "<div>");
	// already-decoded text is left alone — no second pass
	assertEquals(toText("<p>&amp;amp;</p>"), "&amp;");
});

Deno.test("&nbsp; collapses to an ordinary space", () => {
	const out = toText("<p>a&nbsp;b</p>");
	assertEquals(out, "a b");
	// U+00A0 must not survive into extracted text — it breaks string comparison
	// downstream in ways nobody notices until they do
	assertEquals(out.includes("\u00a0"), false);
});

Deno.test("whitespace runs collapse but paragraph breaks survive", () => {
	assertEquals(toText("<p>a   \n\t  b</p>"), "a b");
	assertEquals(toText("<p>  a  </p>\n\n\n<p>  b  </p>"), "a\n\nb");
	// no line ever ends in whitespace
	assertEquals(/[ \t]\n/.test(toText("<div>a   </div><div>   b</div>")), false);
	// and never three newlines in a row
	assertEquals(
		/\n{3}/.test(toText("<p>a</p><section><article><p>b</p></article></section>")),
		false,
	);
});

// ---------------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------------

Deno.test("20 000 levels of nesting does not throw", () => {
	const deep = "<div>".repeat(20_000) + "x" + "</div>".repeat(20_000);
	assertEquals(toText(deep), "x");
});

Deno.test("empty and whitespace-only input", () => {
	assertEquals(toText(""), "");
	assertEquals(toText("   "), "");
	assertEquals(toText("<p></p>"), "");
	assertEquals(toText("plain text, no tags"), "plain text, no tags");
});

Deno.test("broken markup and unclosed tags degrade instead of throwing", () => {
	assertEquals(toText("<div><p>a<div>b"), "a\n\nb");
	assertEquals(toText("<p>a</p></div></section>"), "a");
	assertStringIncludes(toText("<div class=>x</p></div><<>"), "x");
	assertStringIncludes(toText("<ul><li>a<li>b</ul>"), "a");
});

Deno.test("never throws, whatever the input", () => {
	const hostile = [
		"",
		" ",
		"<",
		"<<<<>>>>",
		"<!doctype html>",
		"<!-- unterminated comment",
		"<script>",
		"<pre>",
		"<table><tr><td>",
		"  binary \u0000\ufffd\u001b noise",
		"<div ".repeat(500),
		"<p>&notanentity;</p>",
		'<a href="javascript:alert(1)">x</a>',
		"<div>".repeat(5000),
	];
	for (const html of hostile) {
		const out = toText(html);
		assertEquals(typeof out, "string", `non-string for ${JSON.stringify(html)}`);
		// same again with every option flipped
		assertEquals(typeof toText(html, { preserveCode: false }), "string");
		assertEquals(typeof toText(html, { maxSize: 8 }), "string");
	}
});

Deno.test("a non-string argument is a programmer error and throws", () => {
	// deno-lint-ignore no-explicit-any
	const bad = (v: any) => () => toText(v);
	assertThrows(bad(undefined), TypeError);
	assertThrows(bad(null), TypeError);
	assertThrows(bad(123), TypeError);
	assertThrows(bad({}), TypeError);
	assertThrows(bad(["<p>a</p>"]), TypeError);
});

Deno.test("oversized input is truncated, not rejected", () => {
	const html = "<p>hello world</p><p>and more</p>";
	// cut mid-word, mid-tag — still a usable result rather than an exception
	assertEquals(toText(html, { maxSize: 12 }), "hello wor");
});

// ---------------------------------------------------------------------------------
// the internal entry points
// ---------------------------------------------------------------------------------

Deno.test("textFromDocument renders the body of an already-parsed document", () => {
	const doc = parseDocument(
		"<html><head><title>T</title></head><body><p>a</p><p>b</p></body></html>",
	);
	assertEquals(textFromDocument(doc!), "a\n\nb");
	// <head> is not part of the body, so the title does not leak into the text
	assertEquals(textFromDocument(doc!).includes("T"), false);
});

Deno.test("renderText renders one subtree, the node included", () => {
	const doc = parseDocument(
		"<div><p>outside</p><section id='x'><p>a</p><p>b</p></section></div>",
	);
	const section = doc!.body.querySelector("#x")!;
	assertEquals(renderText(section), "a\n\nb");
});

// ---------------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------------

Deno.test("the injected logger explains the result and is silent by default", () => {
	const lines: string[] = [];
	const logger = {
		debug: (...a: unknown[]) => lines.push(a.join(" ")),
		log: () => {},
		info: () => {},
		warn: (...a: unknown[]) => lines.push(a.join(" ")),
		error: () => {},
	} as unknown as Logger;

	toText("<pre>x</pre><script>y</script>", { logger });
	assertEquals(lines.length > 0, true);
	assertEquals(lines.every((l) => l.startsWith("[html-extract] ")), true);
	assertStringIncludes(lines.join("\n"), "1 <pre> block(s) preserved");
	assertStringIncludes(lines.join("\n"), "1 non-content element(s) skipped");

	// no logger, no output — nothing to assert beyond "it does not blow up"
	assertEquals(toText("<p>a</p>"), "a");
});

// ---------------------------------------------------------------------------------
// regressions
// ---------------------------------------------------------------------------------

Deno.test("a long verbatim whitespace run does not hang the trailing trim", () => {
	// `/\s+$/` is unanchored, so on a `<pre>` holding a long whitespace run followed by
	// anything else it retried from every offset in the run: both of these took ~7 s
	// before the trim became `.trimEnd()`. A hang is a never-throws violation with worse
	// manners than a throw, so the budget here is generous but hard.
	const run = "\n".repeat(100_000);

	// preservedText's own trim
	let started = performance.now();
	const pre = toText(`<pre>${run}x</pre>`);
	const preMs = performance.now() - started;
	// the leading newline after `<pre>` is formatting, the rest is content
	assertEquals(pre.length, 100_000);
	assertEquals(pre.endsWith("\n\nx"), true);
	assertEquals(preMs < 2000, true, `preservedText took ${preMs.toFixed(0)}ms`);

	// and renderText's, reached whenever the document does not end in a `<pre>`
	started = performance.now();
	const doc = toText(`<pre>a${run}b</pre><p>tail</p>`);
	const docMs = performance.now() - started;
	assertEquals(doc.startsWith("a\n\n"), true);
	assertEquals(doc.endsWith("b\n\ntail"), true);
	assertEquals(docMs < 2000, true, `renderText took ${docMs.toFixed(0)}ms`);
});

Deno.test("trimming still removes exactly what the old regex removed", () => {
	// `\s` in a JS regex is WhiteSpace + LineTerminator, which is precisely what
	// `trimStart`/`trimEnd` remove — including the exotic spaces
	assertEquals(toText("<p> 　 a   </p>"), "a");
	assertEquals(toText("<pre>x　  </pre>"), "x");
	assertEquals(toText("<pre>  x  </pre><p>y</p>"), "  x\n\ny");
});

Deno.test("<textarea> content arrives decoded, like every other element's", () => {
	// linkedom parses `<textarea>` as raw text and never resolves its references, so
	// the undecoded source used to reach the output and be indistinguishable from
	// content that really did contain an ampersand
	assertEquals(toText("<textarea>Tom &amp; Jerry</textarea>"), "Tom & Jerry");
	// the control, which was always right
	assertEquals(toText("<div>Tom &amp; Jerry</div>"), "Tom & Jerry");
	assertEquals(
		toText('<form><textarea name="q">a &lt;b&gt; &quot;c&quot;</textarea></form>'),
		'a <b> "c"',
	);
	// numeric references, decimal and hex, are the long tail
	assertEquals(toText("<textarea>&#169; &#xa9; &#65;</textarea>"), "© © A");
	// `&nbsp;` collapses like any other space, U+00A0 included
	assertEquals(toText("<textarea>a&nbsp;b</textarea>"), "a b");
	// an unknown name is far more often ordinary text than a broken entity
	assertEquals(
		toText("<textarea>Q &copy R &notreal;</textarea>"),
		"Q &copy R &notreal;",
	);
	// exactly one pass — an escaped entity stays escaped, as in a `<div>`
	assertEquals(toText("<textarea>&amp;amp;</textarea>"), "&amp;");
	// and inside a `<pre>`, where the text is preserved verbatim
	assertEquals(toText("<pre>a\n<textarea>&amp;</textarea>\nb</pre>"), "a\n&\nb");
});

Deno.test("an out-of-range numeric reference degrades instead of throwing", () => {
	// `String.fromCodePoint` throws a RangeError for these, which would break the
	// never-throws contract for a document whose only defect is a typo
	assertEquals(toText("<textarea>&#0;&#xD800;&#x110000;</textarea>"), "���");
	assertEquals(
		typeof toText("<textarea>&#99999999999999;&#x;&#;&amp</textarea>"),
		"string",
	);
});

Deno.test("<xmp> and friends stay literal — they are RAWTEXT, not RCDATA", () => {
	// deliberately *not* decoded: `&amp;` inside `<xmp>` is five characters in every
	// browser, so decoding it would corrupt what the page actually displays
	assertEquals(toText("<xmp><b>x</b> &amp; y</xmp>"), "<b>x</b> &amp; y");
});

Deno.test("preservedText is reachable and keeps <br>-separated lines", () => {
	// exported for to-markdown's fenced code blocks, where reading `textContent`
	// instead would silently weld every `<br>`-separated line together
	const doc = parseDocument("<pre id='p'>a<br>  b<br>c</pre>")!;
	const pre = doc.body.querySelector("#p")!;
	assertEquals(preservedText(pre), "a\n  b\nc");
	// the leading-newline rule, the trailing trim and \r\n normalization all hold
	const doc2 = parseDocument("<pre id='p'>\r\n  x\r\n  y\r\n</pre>")!;
	assertEquals(preservedText(doc2.body.querySelector("#p")!), "  x\n  y");
});
