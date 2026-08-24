import { assertEquals, assertNotEquals } from "@std/assert";
import {
	attr,
	attrs,
	classId,
	cloneElement,
	dropAll,
	parseDocument,
	query,
	queryAll,
	serialize,
	serializeChildren,
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
