import { assertEquals, assertThrows } from "@std/assert";
import { extractJsonLd, flattenJsonLd } from "../src/json-ld.ts";

Deno.test("extractJsonLd: reads blocks in document order", () => {
	const html = `<!doctype html><html><head>
		<script type="application/ld+json">{"@type":"WebSite","name":"first"}</script>
	</head><body>
		<script type="application/ld+json">{"@type":"Article","name":"second"}</script>
	</body></html>`;
	const blocks = extractJsonLd(html) as Record<string, string>[];
	assertEquals(blocks.length, 2);
	assertEquals(blocks[0].name, "first");
	assertEquals(blocks[1].name, "second");
});

Deno.test("extractJsonLd: tolerates a type with parameters and odd casing", () => {
	const html = `<script type="Application/LD+JSON; charset=utf-8">{"ok":true}</script>`;
	assertEquals(extractJsonLd(html), [{ ok: true }]);
});

Deno.test("extractJsonLd: skips malformed blocks but keeps the good ones", () => {
	const html = `<head>
		<script type="application/ld+json">{ not json at all }</script>
		<script type="application/ld+json">{"good":1}</script>
		<script type="application/ld+json"></script>
	</head>`;
	assertEquals(extractJsonLd(html), [{ good: 1 }]);
});

Deno.test("extractJsonLd: unwraps comment, CDATA and trailing-semicolon wrappers", () => {
	const commented = `<script type="application/ld+json"><!--{"a":1}--></script>`;
	const cdata =
		`<script type="application/ld+json">/*<![CDATA[*/{"b":2}/*]]>*/</script>`;
	const semi = `<script type="application/ld+json">{"c":3};</script>`;
	assertEquals(extractJsonLd(commented), [{ a: 1 }]);
	assertEquals(extractJsonLd(cdata), [{ b: 2 }]);
	assertEquals(extractJsonLd(semi), [{ c: 3 }]);
});

Deno.test("extractJsonLd: ignores non-ld scripts", () => {
	const html = `<script type="application/json">{"a":1}</script>
		<script>{"b":2}</script>`;
	assertEquals(extractJsonLd(html), []);
});

Deno.test("extractJsonLd: does not merge or interpret @graph", () => {
	const html =
		`<script type="application/ld+json">{"@graph":[{"@type":"A"},{"@type":"B"}]}</script>`;
	const blocks = extractJsonLd(html) as Record<string, unknown>[];
	assertEquals(blocks.length, 1);
	assertEquals(Array.isArray(blocks[0]["@graph"]), true);
});

Deno.test("extractJsonLd: never throws on hostile input", () => {
	for (
		const html of [
			"",
			"   ",
			"<<>>&&;",
			"<script type=application/ld+json>",
			"<script type='application/ld+json'>{\"a\":",
			"<div>".repeat(5000),
		]
	) {
		assertEquals(Array.isArray(extractJsonLd(html)), true);
	}
});

Deno.test("extractJsonLd: throws only on a wrong argument type", () => {
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractJsonLd(null as any), TypeError);
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractJsonLd(undefined as any), TypeError);
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractJsonLd(123 as any), TypeError);
});

Deno.test("flattenJsonLd: expands arrays and @graph one level", () => {
	const nodes = flattenJsonLd([
		[{ "@type": "A" }, { "@type": "B" }],
		{ "@graph": [{ "@type": "C" }] },
		"not an object",
		null,
	]);
	const types = nodes.map((n) => n["@type"]).filter(Boolean);
	assertEquals(types.sort(), ["A", "B", "C"]);
});

Deno.test("flattenJsonLd: keeps the @graph wrapper itself as a node", () => {
	const nodes = flattenJsonLd([{ "@graph": [{ "@type": "C" }], url: "u" }]);
	assertEquals(nodes.length, 2);
	assertEquals(nodes.some((n) => n.url === "u"), true);
});
