import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
		"**b** and*c*~~d~~~~e~~",
	);
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

Deno.test("dl puts dt on its own line and indents dd by two", () => {
	assertEquals(
		toMarkdown("<dl><dt>T</dt><dd>D1</dd><dd>D2</dd></dl>"),
		"T\n  D1\n  D2",
	);
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

Deno.test("renderMarkdown on a pre keeps the fence", () => {
	const doc = parseDocument("<pre>  x  </pre>")!;
	assertEquals(renderMarkdown(doc.body.querySelector("pre")!), "```\n  x  \n```");
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
