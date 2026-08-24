import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseDocument } from "../src/_dom.ts";
import { markdownFromDocument, renderMarkdown, toMarkdown } from "../src/to-markdown.ts";

// ---------------------------------------------------------------------------------
// pre / code
// ---------------------------------------------------------------------------------

Deno.test("pre preserves whitespace exactly", () => {
	const md = toMarkdown(
		"<pre><code>const a = 1;\n  if (a) {\n    x();  \n  }\n</code></pre>",
	);
	assertEquals(md, "```\nconst a = 1;\n  if (a) {\n    x();  \n  }\n```");
});

Deno.test("pre keeps blank lines inside the fence", () => {
	assertEquals(toMarkdown("<pre>a\n\n\nb</pre>"), "```\na\n\n\nb\n```");
});

Deno.test("pre never escapes its content", () => {
	assertEquals(
		toMarkdown("<pre>a * b _ c [d] # e \\ f</pre>"),
		"```\na * b _ c [d] # e \\ f\n```",
	);
});

Deno.test("pre language comes from a language-/lang- class on pre or code", () => {
	assertEquals(
		toMarkdown('<pre><code class="language-ts">x</code></pre>'),
		"```ts\nx\n```",
	);
	assertEquals(toMarkdown('<pre class="lang-js highlight">x</pre>'), "```js\nx\n```");
});

Deno.test("pre fence widens past the longest backtick run in the content", () => {
	assertEquals(
		toMarkdown("<pre>a ``` b\n```` c</pre>"),
		"`````\na ``` b\n```` c\n`````",
	);
});

Deno.test("empty pre emits nothing", () => {
	assertEquals(toMarkdown("<pre></pre><p>x</p>"), "x");
});

Deno.test("pre keeps the line breaks a highlighter expresses structurally", () => {
	// a <div> (or a <br>) per line with no newline of its own — textContent welded
	// every one of these onto a single line while toText() got it right
	assertEquals(
		toMarkdown(
			'<pre class="highlight"><div class="line">const a = 1;</div>' +
				'<div class="line">const b = 2;</div></pre>',
		),
		"```\nconst a = 1;\nconst b = 2;\n```",
	);
	assertEquals(toMarkdown("<pre>line1<br>line2</pre>"), "```\nline1\nline2\n```");
});

Deno.test("a pre holding a long newline run renders in linear time", () => {
	// /(?:\r?\n)+[ \t]*$/ re-matched the whole run from every offset inside it: 80 000
	// newlines took ~22 s, and a truncated crawl dumps exactly this into a <pre>
	const t0 = performance.now();
	const md = toMarkdown("<pre>" + "\n".repeat(80_000) + "x</pre>");
	const elapsed = performance.now() - t0;
	// the newline right after <pre> is formatting; the other 79 999 are content
	assertEquals(md, "```\n" + "\n".repeat(79_999) + "x\n```");
	assert(elapsed < 3_000, `took ${Math.round(elapsed)} ms`);
});

Deno.test("inline code widens and pads its delimiters", () => {
	assertEquals(
		toMarkdown("<p>use <code>a `b` c</code> and <code>`x`</code></p>"),
		"use ``a `b` c`` and `` `x` ``",
	);
});

// ---------------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------------

Deno.test("links resolve against the base url", () => {
	assertEquals(
		toMarkdown('<a href="/a">A</a>', { url: "https://ex.com/p/q" }),
		"[A](https://ex.com/a)",
	);
});

Deno.test("links stay relative without a base url", () => {
	assertEquals(toMarkdown('<a href="../a">A</a>'), "[A](../a)");
});

Deno.test("a document base href wins over options.url", () => {
	assertEquals(
		toMarkdown(
			'<html><head><base href="https://b.com/d/"></head><body><a href="x">X</a></body></html>',
			{ url: "https://o.com/" },
		),
		"[X](https://b.com/d/x)",
	);
});

Deno.test("link titles are kept and quoted", () => {
	assertEquals(toMarkdown('<a href="/a" title=\'T "q"\'>A</a>'), '[A](/a "T \\"q\\"")');
});

Deno.test("urls with whitespace or unbalanced parens use the angle form", () => {
	assertEquals(toMarkdown('<a href="/x y">S</a>'), "[S](</x y>)");
	assertEquals(toMarkdown('<a href="/a(b">S</a>'), "[S](</a(b>)");
	// balanced parens survive bare
	assertEquals(toMarkdown('<a href="/a(b)c">S</a>'), "[S](/a(b)c)");
});

Deno.test("a link with no href renders as its text", () => {
	assertEquals(toMarkdown("<p>x <a>A</a> y</p>"), "x A y");
});

Deno.test("links:false renders the text only", () => {
	assertEquals(toMarkdown('<a href="/a">A</a>', { links: false }), "A");
});

Deno.test("an image inside a link nests", () => {
	assertEquals(
		toMarkdown('<a href="/y"><img src="/i.png" alt="a"></a>'),
		"[![a](/i.png)](/y)",
	);
});

// ---------------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------------

Deno.test("images resolve and escape alt; a missing alt still renders", () => {
	assertEquals(
		toMarkdown('<img src="/i.png" alt="An [image]"><img src="/j.png">', {
			url: "https://ex.com/",
		}),
		"![An \\[image\\]](https://ex.com/i.png)![](https://ex.com/j.png)",
	);
});

Deno.test("images:false drops them entirely", () => {
	assertEquals(
		toMarkdown('<p>x<img src="/i.png" alt="a">y</p>', { images: false }),
		"xy",
	);
});

Deno.test("an image with no src emits nothing", () => {
	assertEquals(toMarkdown('<p><img alt="a">b</p>'), "b");
});

// ---------------------------------------------------------------------------------
// lists
// ---------------------------------------------------------------------------------

Deno.test("nested lists indent by the parent marker width", () => {
	const md = toMarkdown(
		"<ul><li>a<ul><li>b<ol><li>c</li></ol></li></ul></li><li>d</li></ul>",
	);
	assertEquals(md, "- a\n  - b\n    1. c\n- d");
});

Deno.test("ol start and li value drive the counter", () => {
	const md = toMarkdown('<ol start="5"><li>a</li><li value="9">b</li><li>c</li></ol>');
	assertEquals(md, "5. a\n9. b\n10. c");
});

Deno.test("ordered continuation content indents by the marker width", () => {
	const md = toMarkdown('<ol start="8"><li>a<p>second</p></li><li>b</li></ol>');
	assertEquals(md, "8. a\n\n   second\n9. b");
});

Deno.test("options.bullet picks the unordered marker", () => {
	assertEquals(toMarkdown("<ul><li>a</li></ul>", { bullet: "*" }), "* a");
	assertEquals(toMarkdown("<ul><li>a</li></ul>", { bullet: "+" }), "+ a");
});

Deno.test("a list nested directly in a list is kept, not dropped", () => {
	// invalid markup that editors and Word exports emit and browsers draw as a nested
	// list; filtering for <li> made the whole subtree vanish from the markdown
	assertEquals(
		toMarkdown(
			"<ul><li>Top level</li><ul><li>Sub A</li><li>Sub B</li></ul><li>Second</li></ul>",
		),
		"- Top level\n  - Sub A\n  - Sub B\n- Second",
	);
	assertEquals(toMarkdown("<ol><li>a</li><ul><li>b</li></ul></ol>"), "1. a\n   - b");
	assertEquals(
		toMarkdown("<ol><li>a</li><ol><li>b</li></ol><li>c</li></ol>"),
		"1. a\n   1. b\n2. c",
	);
});

Deno.test("content between list items reaches the output", () => {
	// the counter keeps running across the split, and every marker is explicit
	assertEquals(toMarkdown("<ol>stray<li>a</li></ol>"), "stray\n\n1. a");
	assertEquals(toMarkdown("<ol><li>a</li>mid<li>b</li></ol>"), "1. a\n\nmid\n\n2. b");
	assertEquals(
		toMarkdown("<ul><li>a</li><div>block</div><li>b</li></ul>"),
		"- a\n\nblock\n\n- b",
	);
});

Deno.test("whitespace between items never splits a list", () => {
	assertEquals(toMarkdown("<ul>\n\t<li>a</li>\n\t<li>b</li>\n</ul>"), "- a\n- b");
	assertEquals(toMarkdown("<ul><li>a</li><!-- c --><li>b</li></ul>"), "- a\n- b");
});

Deno.test("a list whose only child is a list, and a stray li", () => {
	assertEquals(toMarkdown("<ul><ul><li>a</li></ul></ul>"), "- a");
	assertEquals(toMarkdown("<ul><ul><li>b</li></ul><li>a</li></ul>"), "- b\n\n- a");
	// an <li> outside any list is still a container: its text must survive
	assertEquals(toMarkdown("<li>x</li>"), "x");
});

Deno.test("a code block inside a list item stays inside it, verbatim", () => {
	assertEquals(
		toMarkdown("<ul><li><p>step</p><pre>a  \nb</pre></li></ul>"),
		"- step\n\n  ```\n  a  \n  b\n  ```",
	);
});

// ---------------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------------

Deno.test("a rectangular table becomes GFM", () => {
	const md = toMarkdown(
		"<table><thead><tr><th>H1</th><th>H2</th></tr></thead>" +
			"<tbody><tr><td>a|b</td><td><b>c</b></td></tr></tbody></table>",
	);
	assertEquals(md, "| H1 | H2 |\n| --- | --- |\n| a\\|b | **c** |");
});

Deno.test("without a thead the first row is promoted to the header", () => {
	const md = toMarkdown(
		"<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
	);
	assertEquals(md, "| a | b |\n| --- | --- |\n| c | d |");
});

Deno.test("a caption is emitted as its own paragraph before the table", () => {
	const md = toMarkdown(
		"<table><caption>Cap</caption><tr><th>a</th></tr><tr><td>b</td></tr></table>",
	);
	assertEquals(md, "Cap\n\n| a |\n| --- |\n| b |");
});

Deno.test("cell newlines become spaces", () => {
	const md = toMarkdown("<table><tr><th>h</th></tr><tr><td>a<br>b</td></tr></table>");
	assertEquals(md, "| h |\n| --- |\n| a b |");
});

Deno.test("a colspan table degrades to passthrough HTML", () => {
	const html =
		'<table><tr><td colspan="2">a</td></tr><tr><td>b</td><td>c</td></tr></table>';
	assertEquals(toMarkdown(html), html);
});

Deno.test("a rowspan table degrades to passthrough HTML", () => {
	const html =
		'<table><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>';
	assertEquals(toMarkdown(html), html);
});

Deno.test("a ragged table degrades to passthrough HTML", () => {
	const html = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>";
	assertEquals(toMarkdown(html), html);
});

Deno.test("a nested table degrades to passthrough HTML", () => {
	const html = "<table><tr><td><table><tr><td>in</td></tr></table></td></tr></table>";
	assertEquals(toMarkdown(html), html);
});

Deno.test("passthrough HTML drops script, style and comments like everything else", () => {
	// serialize() writes raw-text elements unescaped, so an unfiltered passthrough
	// carried live script out of a crawled page into output documented as script-free
	assertEquals(
		toMarkdown(
			'<table><tr><td colspan="2">a</td></tr>' +
				"<tr><td>b<script>alert(1)</script></td><td>c<!--secret--></td></tr></table>",
		),
		'<table><tr><td colspan="2">a</td></tr><tr><td>b</td><td>c</td></tr></table>',
	);
});

Deno.test("passthrough HTML carries no blank line", () => {
	// one blank line ends a CommonMark HTML block: the rest of the table would render
	// as escaped literal source
	const md = toMarkdown(
		'<table>\n\t<tr>\n\t\t<td>a</td>\n\n\t\t<td colspan="2">b</td>\n\t</tr>\n</table>',
	);
	assertEquals(
		md,
		'<table>\n\t<tr>\n\t\t<td>a</td>\n\t\t<td colspan="2">b</td>\n\t</tr>\n</table>',
	);
	assert(!/\n[ \t]*\n/.test(md), "a blank line survived the passthrough");

	// including the blank lines of a <pre> inside such a table — losing those is the
	// deliberate trade-off against losing the table
	const withPre = toMarkdown(
		'<table><tr><th colspan="2">E</th></tr>' +
			"<tr><td>js</td><td><pre>const a = 1;\n\nconst b = 2;</pre></td></tr></table>",
	);
	assertStringIncludes(withPre, "const a = 1;\nconst b = 2;");
	assert(!/\n[ \t]*\n/.test(withPre), "a blank line survived the passthrough");
});

Deno.test("passthrough HTML leaves the shared document untouched", () => {
	// the filtering runs on a clone — extract() hands the same tree to every extractor
	const doc = parseDocument(
		'<table><tr><td colspan="2">a<script>x</script></td></tr>' +
			"<tr><td>b</td><td>c</td></tr></table>",
	)!;
	markdownFromDocument(doc);
	assertEquals(doc.body.querySelectorAll("script").length, 1);
});

Deno.test("table degradation is logged at debug", () => {
	const messages: string[] = [];
	const logger = {
		debug: (...a: unknown[]) => messages.push(a.join(" ")),
		info: () => {},
		log: () => {},
		warn: () => {},
		error: () => {},
	};
	toMarkdown(
		'<table><tr><td colspan="2">a</td></tr><tr><td>b</td><td>c</td></tr></table>',
		{ logger },
	);
	assertStringIncludes(messages.join("\n"), "not rectangular");
});

// ---------------------------------------------------------------------------------
// escaping
// ---------------------------------------------------------------------------------

Deno.test("escaping is minimal and context aware", () => {
	const md = toMarkdown(
		"<p>a * b _ c [d] # e</p><p># heading?</p><p>1. not a list</p>" +
			"<p>- dash</p><p>a &lt;b&gt; 3 &lt; 4</p>",
	);
	assertEquals(
		md,
		"a \\* b \\_ c \\[d\\] # e\n\n\\# heading?\n\n1\\. not a list\n\n" +
			"\\- dash\n\na \\<b> 3 < 4",
	);
});

Deno.test("every line-start marker is escaped", () => {
	assertEquals(
		toMarkdown("<p>1) x</p><p>| y</p><p>= z</p><p>+ w</p><p>&gt; q</p>"),
		"1\\) x\n\n\\| y\n\n\\= z\n\n\\+ w\n\n\\> q",
	);
});

Deno.test("tildes are escaped everywhere, not just at a line start", () => {
	// `~~~` opens a CommonMark code fence and swallows the rest of the document;
	// `~~x~~` (and `~x~` in cmark-gfm) is GFM strikethrough
	assertEquals(
		toMarkdown("<p>~~~</p><p>The rest of the document.</p>"),
		"\\~\\~\\~\n\nThe rest of the document.",
	);
	assertEquals(toMarkdown("<p>a ~~strike~~ b</p>"), "a \\~\\~strike\\~\\~ b");
	assertEquals(toMarkdown("<p>see ~/.bashrc</p>"), "see \\~/.bashrc");
	// ours are still ours
	assertEquals(toMarkdown("<p><del>x</del></p>"), "~~x~~");
	assertEquals(toMarkdown("<p><code>~/.bashrc</code></p>"), "`~/.bashrc`");
});

Deno.test("a text < is escaped before a comment or an instruction too", () => {
	// an unescaped one renders as a real HTML comment, i.e. as nothing at all
	assertEquals(toMarkdown("<p>&lt;!-- note --&gt;</p>"), "\\<!-- note -->");
	assertEquals(toMarkdown("<p>a &lt;? b</p>"), "a \\<? b");
});

Deno.test("escape:false leaves text alone", () => {
	assertEquals(toMarkdown("<p>a * b _ c [d]</p>", { escape: false }), "a * b _ c [d]");
});

// ---------------------------------------------------------------------------------
// blocks and inline
// ---------------------------------------------------------------------------------

Deno.test("br is a backslash hard break, hr is its own block", () => {
	assertEquals(toMarkdown("<p>a<br>b</p><hr><p>c</p>"), "a\\\nb\n\n---\n\nc");
});

Deno.test("a trailing br does not leave a dangling backslash", () => {
	assertEquals(toMarkdown("<p>a<br><br></p>"), "a");
	assertEquals(toMarkdown("<p>a<br> \t <br>  </p>"), "a");
	// only the *trailing* run goes
	assertEquals(toMarkdown("<p>a<br>b<br></p>"), "a\\\nb");
});

Deno.test("a paragraph of br renders in linear time", () => {
	// /(?:\s*\\\n)+\s*$/ backtracked over the whole run from every start position:
	// 40 000 <br> (157 KB) took ~15 s, and <br>-per-line is ordinary email markup
	const t0 = performance.now();
	assertEquals(
		toMarkdown("<p>" + "<br>".repeat(40_000) + "x</p>"),
		"\\\n".repeat(40_000) + "x",
	);
	// any long run of characters that survives the markdown whitespace collapse but is
	// still `\s` triggered it as well - U+00A0 is the everyday one
	assertEquals(toMarkdown("<p>word" + "\u00a0".repeat(80_000) + "</p>"), "word");
	const elapsed = performance.now() - t0;
	assert(elapsed < 3_000, `took ${Math.round(elapsed)} ms`);
});

Deno.test("headings are ATX and an empty one emits nothing", () => {
	assertEquals(
		toMarkdown("<h1>A</h1><h2></h2><h3>C <em>d</em></h3><h6>F</h6>"),
		"# A\n\n### C *d*\n\n###### F",
	);
});

Deno.test("emphasis hoists outer whitespace out of the delimiters", () => {
	assertEquals(
		toMarkdown("<p><strong> b </strong>and<em>c</em><del>d</del><s>e</s></p>"),
		"**b** and*c*~~d~~<!-- -->~~e~~",
	);
});

Deno.test("adjacent same-type emphasis does not merge into one run", () => {
	// `*a**b*` re-parses as a single <em> holding two literal asterisks — the second
	// element disappears. The empty comment renders to nothing and breaks the run.
	assertEquals(toMarkdown("<p><em>a</em><em>b</em></p>"), "*a*<!-- -->*b*");
	assertEquals(
		toMarkdown("<p><strong>a</strong><strong>b</strong></p>"),
		"**a**<!-- -->**b**",
	);
	assertEquals(toMarkdown("<p><del>a</del><s>b</s></p>"), "~~a~~<!-- -->~~b~~");
	assertEquals(toMarkdown("<p><code>a</code><code>b</code></p>"), "`a`<!-- -->`b`");
});

Deno.test("only an abutting delimiter gets a separator", () => {
	// a different delimiter character, whitespace between, and an escaped literal are
	// all incapable of merging, so none of them pays for one
	assertEquals(toMarkdown("<p><strong>a</strong><del>b</del></p>"), "**a**~~b~~");
	assertEquals(toMarkdown("<p><em>a</em> <em>b</em></p>"), "*a* *b*");
	assertEquals(toMarkdown("<p>a*<em>b</em></p>"), "a\\**b*");
});

Deno.test("mark and unknown inline elements are transparent", () => {
	assertEquals(
		toMarkdown("<p><mark>a</mark> <span>b</span> <foo>c</foo></p>"),
		"a b c",
	);
});

Deno.test("blockquotes nest their prefix", () => {
	assertEquals(
		toMarkdown("<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>"),
		"> a\n>\n> > b",
	);
});

Deno.test("dl renders as a bold term with its definitions as a list", () => {
	// two-space indentation is a lazy continuation line, not a construct: the old
	// output collapsed into one run-on paragraph when rendered
	assertEquals(
		toMarkdown("<dl><dt>T</dt><dd>D1</dd><dd>D2</dd><dt>U</dt><dd>E</dd></dl>"),
		"**T**\n\n- D1\n- D2\n\n**U**\n\n- E",
	);
});

Deno.test("dl reads through an html5 grouping div", () => {
	assertEquals(
		toMarkdown("<dl><div><dt>T</dt><dd>D</dd></div></dl>"),
		"**T**\n\n- D",
	);
});

Deno.test("dl keeps content that is neither dt nor dd", () => {
	assertEquals(
		toMarkdown("<dl><dt>T</dt><p>note</p><dd>D</dd></dl>"),
		"**T**\n\nnote\n\n- D",
	);
});

Deno.test("a definition holding blocks indents them under its marker", () => {
	assertEquals(
		toMarkdown("<dl><dt>T</dt><dd><p>a</p><p>b</p></dd></dl>"),
		"**T**\n\n- a\n\n  b",
	);
	assertEquals(toMarkdown("<dl></dl><p>x</p>"), "x");
});

Deno.test("figure content comes first, then the caption", () => {
	assertEquals(
		toMarkdown(
			'<figure><figcaption>Cap</figcaption><img src="/i.png" alt="a"></figure>',
		),
		"![a](/i.png)\n\nCap",
	);
});

Deno.test("blank-line runs collapse to at most one", () => {
	assertEquals(
		toMarkdown("<div><p>a</p><div></div><div>   </div><p></p><p>b</p></div>"),
		"a\n\nb",
	);
});

Deno.test("script, style, svg, iframe, template and comments produce nothing", () => {
	const md = toMarkdown(
		"<p>a</p><script>var x=1</script><style>p{}</style><noscript>n</noscript>" +
			"<!-- c --><svg><path/></svg><canvas>x</canvas><iframe src=x></iframe>" +
			"<template><p>t</p></template><p>b</p>",
	);
	assertEquals(md, "a\n\nb");
});

Deno.test("block elements separate, they never run together", () => {
	assertEquals(toMarkdown("<div>a</div><div>b</div>"), "a\n\nb");
});

// ---------------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------------

Deno.test("renderMarkdown renders one node's subtree", () => {
	const doc = parseDocument(
		"<html><body><article><h2>H</h2><p>p</p></article></body></html>",
	)!;
	assertEquals(renderMarkdown(doc.body.querySelector("article")!), "## H\n\np");
});

Deno.test("renderMarkdown uses options.url as the base verbatim", () => {
	const doc = parseDocument('<div><a href="/a">A</a></div>')!;
	assertEquals(
		renderMarkdown(doc.body.querySelector("div")!, { url: "https://ex.com/x" }),
		"[A](https://ex.com/a)",
	);
});

Deno.test("renderMarkdown on a pre keeps the fence and the indent", () => {
	// trailing whitespace on the last line goes with the `</pre>`, exactly as in
	// toText(); interior lines keep theirs
	const doc = parseDocument("<pre>  x  </pre>")!;
	assertEquals(renderMarkdown(doc.body.querySelector("pre")!), "```\n  x\n```");
});

Deno.test("markdownFromDocument renders the body", () => {
	const doc = parseDocument("<html><body><p>a</p></body></html>")!;
	assertEquals(markdownFromDocument(doc), "a");
});

// ---------------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------------

Deno.test("empty string yields an empty string", () => {
	assertEquals(toMarkdown(""), "");
});

Deno.test("a head-only document yields an empty string", () => {
	assertEquals(
		toMarkdown("<html><head><title>T</title></head><body></body></html>"),
		"",
	);
});

Deno.test("broken markup degrades instead of throwing", () => {
	const md = toMarkdown("<p>unclosed <b>bold <i>ital</p><div>next");
	assertStringIncludes(md, "unclosed");
	assertStringIncludes(md, "next");
});

Deno.test("never throws on hostile input", () => {
	const cases = [
		"<",
		"<<<>>>&&&",
		"<p",
		'<a href=">',
		"<table><tr><td>",
		"<ul><li><ol><li>",
		"<pre><code>",
		"<!-- unterminated",
		" �<x",
		"<div ".repeat(500),
		"<td>orphan</td>",
		"<ol start='not-a-number'><li value='x'>a</li></ol>",
		"<img src>",
		"<a href=''>x</a>",
		"<table><tr><th></th></tr></table>",
	];
	for (const html of cases) {
		assertEquals(
			typeof toMarkdown(html),
			"string",
			`failed for ${JSON.stringify(html)}`,
		);
	}
});

Deno.test("20 000 levels of nesting do not throw", () => {
	const deep = "<div>".repeat(20_000) + "deep text" + "</div>".repeat(20_000);
	assertEquals(toMarkdown(deep), "deep text");

	const deepList = "<ul><li>".repeat(20_000) + "x" + "</li></ul>".repeat(20_000);
	assertStringIncludes(toMarkdown(deepList), "x");

	const deepInline = "<b>".repeat(20_000) + "x" + "</b>".repeat(20_000);
	assertStringIncludes(toMarkdown(deepInline), "x");
});

Deno.test("a wrong argument type is a programmer error and throws", () => {
	const bad = toMarkdown as unknown as (h: unknown) => string;
	assertThrows(() => bad(null), TypeError);
	assertThrows(() => bad(undefined), TypeError);
	assertThrows(() => bad(42), TypeError);
});

Deno.test("<textarea> is RCDATA and arrives decoded, <xmp> is RAWTEXT and does not", () => {
	// linkedom hands both over as raw source; only textarea owes us a decode, and the
	// plain-text renderer has to agree with this one or the same page reads differently
	// depending on which output you asked for
	assertEquals(
		toMarkdown("<textarea>Tom &amp; Jerry &lt;3</textarea>"),
		"Tom & Jerry <3",
	);
	assertEquals(toMarkdown("<xmp>a &amp; b</xmp>"), "a &amp; b");
	assertEquals(toMarkdown("<textarea>&toString;</textarea>"), "&toString;");
	// decoded content is still markdown-escaped, like any other text
	assertEquals(toMarkdown("<textarea>a *b* c</textarea>"), "a \\*b\\* c");
	assertEquals(
		toMarkdown("<textarea>a *b* c</textarea>", { escape: false }),
		"a *b* c",
	);
});
