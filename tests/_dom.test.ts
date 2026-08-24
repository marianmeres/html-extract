import { assertEquals, assertNotEquals } from "@std/assert";
import {
	attr,
	attrs,
	classId,
	cloneElement,
	decodeReferences,
	dropAll,
	parseDocument,
	query,
	queryAll,
	serialize,
	serializeChildren,
	tag,
	text,
	unwrap,
	walkElements,
} from "../src/_dom.ts";

// The parser adapter is internal, but every quirk covered here is load-bearing for the
// public API: each of these behaved *differently* before the adapter normalized it.

Deno.test("parseDocument: a bare fragment is reachable through body", () => {
	const doc = parseDocument("<div><p>hello</p></div>")!;
	assertEquals(text(doc.body).trim(), "hello");
	assertEquals(serializeChildren(doc.body), "<div><p>hello</p></div>");
});

Deno.test("parseDocument: a full document, a body-only document and a fragment agree", () => {
	const variants = [
		"<!doctype html><html><body><p>x</p></body></html>",
		"<body><p>x</p></body>",
		"<p>x</p>",
	];
	for (const html of variants) {
		assertEquals(text(parseDocument(html)!.body).trim(), "x", html);
	}
});

Deno.test("parseDocument: returns null only for an empty/non-string input", () => {
	assertEquals(parseDocument(""), null);
	// deno-lint-ignore no-explicit-any
	assertEquals(parseDocument(null as any), null);
	assertNotEquals(parseDocument("   "), null);
	assertNotEquals(parseDocument("<!-- c -->"), null);
	assertNotEquals(parseDocument("<<>>&&;"), null);
});

Deno.test("parseDocument: truncates at maxSize and reports it", () => {
	const warnings: string[] = [];
	const doc = parseDocument(`<p>${"a".repeat(1000)}</p>`, {
		maxSize: 100,
		logger: {
			debug: () => {},
			log: () => {},
			warn: (m: unknown) => warnings.push(String(m)),
			error: () => {},
		},
	})!;
	assertEquals(doc.truncated, true);
	assertEquals(text(doc.body).length < 200, true);
	assertEquals(warnings.length, 1);
});

Deno.test("attr: is case-insensitive in both directions", () => {
	const doc = parseDocument(`<DIV CLASS="post main" ID="Top" DATA-X="1">t</DIV>`)!;
	const el = query(doc.body, "div")!;
	assertEquals(attr(el, "class"), "post main");
	assertEquals(attr(el, "CLASS"), "post main");
	assertEquals(attr(el, "id"), "Top");
	assertEquals(attr(el, "data-x"), "1");
	assertEquals(attr(el, "nope"), undefined);
	assertEquals(classId(el), "post main top");
});

Deno.test("attrs: lowercases names and keeps the first of a duplicate", () => {
	const doc = parseDocument(`<p CLASS="a" class="b" TITLE="t">x</p>`)!;
	assertEquals(attrs(query(doc.body, "p")!), { class: "a", title: "t" });
});

Deno.test("serialize: escapes text and attributes, and is idempotent", () => {
	const html =
		`<div CLASS="a"><a href="/x?a=1&amp;copy=2" title='q"q'>5 &lt; 6 &amp;&amp; 7</a><img src=y><br></div>`;
	const once = serializeChildren(parseDocument(html)!.body);
	const twice = serializeChildren(parseDocument(once)!.body);
	assertEquals(once, twice);
	assertEquals(once.includes("&amp;copy=2"), true);
	assertEquals(once.includes("5 &lt; 6 &amp;&amp; 7"), true);
	assertEquals(once.includes("<br>"), true);
});

Deno.test("serialize: keeps raw text elements unescaped", () => {
	const doc = parseDocument(`<script>if (a < b && c) { d("</p>") }</script>`)!;
	const out = serialize(query(doc.root, "script")!);
	assertEquals(out.includes("a < b && c"), true);
});

Deno.test("query/queryAll: an invalid selector yields nothing instead of throwing", () => {
	const doc = parseDocument("<p>x</p>")!;
	assertEquals(query(doc.body, "<<>>"), null);
	assertEquals(queryAll(doc.body, ":::").length, 0);
	assertEquals(query(doc.body, ""), null);
});

Deno.test("unwrap: keeps the children in place", () => {
	const doc = parseDocument("<div><span>a</span> b</div><p>keep</p>")!;
	unwrap(query(doc.body, "div"));
	assertEquals(serializeChildren(doc.body), "<span>a</span> b<p>keep</p>");
});

Deno.test("cloneElement: the clone is independent of the original", () => {
	const doc = parseDocument("<article><p>x</p></article>")!;
	const clone = cloneElement(doc.body)!;
	query(clone, "article")!.remove();
	assertEquals(serializeChildren(clone), "");
	assertEquals(serializeChildren(doc.body), "<article><p>x</p></article>");
});

Deno.test("dropAll: removes every match", () => {
	const doc = parseDocument("<div><script>a</script><style>b</style><p>c</p></div>")!;
	assertEquals(dropAll(doc.body, ["script", "style"]), 2);
	assertEquals(serializeChildren(doc.body), "<div><p>c</p></div>");
});

Deno.test("walkElements and serialize survive pathological nesting", () => {
	const deep = "<div>".repeat(20_000) + "x" + "</div>".repeat(20_000);
	const doc = parseDocument(deep)!;
	let n = 0;
	walkElements(doc.body, () => {
		n++;
	});
	assertEquals(n, 20_001);
	assertEquals(serialize(doc.body).includes("x"), true);
});

Deno.test("table rows are reachable without an implied tbody", () => {
	const doc = parseDocument("<table><tr><td>a</td></tr></table>")!;
	assertEquals(queryAll(doc.body, "tr").length, 1);
});

// --- regressions -----------------------------------------------------------------

Deno.test("attrs: keeps attributes named like Object.prototype members", () => {
	// `"constructor" in {}` is true before a single attribute is read, and `__proto__`
	// is an inherited setter rather than a slot — on a prototyped map both attributes
	// look like duplicates of something already there and disappear from every
	// serialization.
	const html = `<div constructor="c" __proto__="p" toString="t" id="y">hello</div>`;
	const doc = parseDocument(html)!;
	// compared as entries on purpose: an object *literal* cannot carry a `__proto__`
	// key either — the very trap this test is about
	assertEquals(Object.entries(attrs(query(doc.body, "div")!)), [
		["constructor", "c"],
		["__proto__", "p"],
		["tostring", "t"],
		["id", "y"],
	]);
	assertEquals(
		serializeChildren(doc.body),
		`<div constructor="c" __proto__="p" tostring="t" id="y">hello</div>`,
	);
});

Deno.test("parseDocument: a real <html> is found however long the preamble is", () => {
	// the sniff used to look at the first 8 KB only, so an oversized licence comment or
	// conditional-comment preamble got the document wrapped a second time — and the
	// synthetic root then answered for `lang`
	for (const pad of [1, 9000, 40_000]) {
		const html = `<!--${"x".repeat(pad)}--><html lang="en"><head>` +
			`<title>T</title></head><body><p>hello</p></body></html>`;
		const doc = parseDocument(html)!;
		assertEquals(tag(doc.root), "html", `pad=${pad}`);
		assertEquals(attr(doc.root, "lang"), "en", `pad=${pad}`);
		assertEquals(text(doc.body).trim(), "hello", `pad=${pad}`);
	}
});

Deno.test("parseDocument: a fragment that only mentions <html> still gets a body", () => {
	// the textual sniff says "already a document"; the parser's verdict (root is <p>,
	// not <html>) is the one that counts, and triggers a wrapped re-parse
	for (
		const frag of [
			`<p>hi there</p><script>var s = "<html> ";</script>`,
			`<p>hi there</p><!-- <html lang="en"> -->`,
			`<p>hi there</p><div data-tpl="<html >"></div>`,
		]
	) {
		const doc = parseDocument(frag)!;
		assertEquals(tag(doc.root), "html", frag);
		assertEquals(text(doc.body).includes("hi there"), true, frag);
	}
});

Deno.test("parseDocument: the re-parse keeps an explicit <body> reachable", () => {
	// the misread input carries its own <body>, so the wrap must not bury it in a
	// second one — everything in it stays readable either way
	const doc = parseDocument(`<p>x</p><script>"<html>"</script><body><b>y</b></body>`)!;
	assertEquals(tag(doc.root), "html");
	const body = text(doc.body);
	assertEquals(body.includes("x"), true, body);
	assertEquals(body.includes("y"), true, body);
	assertEquals(query(doc.root, "b") !== null, true);
});

Deno.test("serialize: <textarea> and <xmp> content is not escaped a second time", () => {
	// linkedom parses both as *raw* text — `textContent` is the undecoded source — so
	// escaping it again adds an `&amp;` layer per pass and breaks idempotency
	const cases = [
		`<form><textarea name="q">Tom &amp; Jerry &lt;3</textarea></form>`,
		`<xmp><b>x</b> &amp; y</xmp>`,
	];
	for (const html of cases) {
		const once = serializeChildren(parseDocument(html)!.body);
		const twice = serializeChildren(parseDocument(once)!.body);
		assertEquals(once, twice, html);
		assertEquals(once, html, html);
	}
	// the raw text really is preserved, not merely stable
	const doc = parseDocument(cases[0])!;
	assertEquals(text(query(doc.body, "textarea")!), "Tom &amp; Jerry &lt;3");
});

Deno.test("serialize: <title> is escaped, because linkedom decodes its entities", () => {
	// the counterpart of the test above: `<title>` is RCDATA-ish here (entities decoded,
	// tags not parsed), so escaping is what round-trips — it must stay out of
	// RAW_TEXT_TAGS or `<b>` would be emitted as live markup
	const once = serializeChildren(
		parseDocument(`<title>a &amp; <b>b</b></title>`)!.root,
	);
	const twice = serializeChildren(parseDocument(once)!.root);
	assertEquals(once, twice);
	assertEquals(once.includes("&lt;b&gt;b&lt;/b&gt;"), true);
});

Deno.test("decodeReferences: a prototype-named reference is left alone", () => {
	// `&toString;` and `&valueOf;` both match the name pattern, and a prototyped lookup
	// table answers them with a function — which then reaches the page's text as
	// "function toString() { [native code] }"
	assertEquals(decodeReferences("&toString;"), "&toString;");
	assertEquals(decodeReferences("&valueOf;"), "&valueOf;");
	assertEquals(decodeReferences("&constructor;"), "&constructor;");
	// and the real ones still resolve
	assertEquals(decodeReferences("a &amp; b &lt;c&gt; &#169; &#xa9;"), "a & b <c> © ©");
	assertEquals(decodeReferences("&copy;"), "&copy;");
});
