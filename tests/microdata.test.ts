import { assertEquals, assertThrows } from "@std/assert";
import { extractMicrodata } from "../src/microdata.ts";
import type { MicrodataItem } from "../src/types.ts";

Deno.test("extractMicrodata: reads a flat item", () => {
	const html = `<div itemscope itemtype="https://schema.org/Person">
		<span itemprop="name">Ada</span>
		<span itemprop="jobTitle">Analyst</span>
	</div>`;
	assertEquals(extractMicrodata(html), [{
		type: ["https://schema.org/Person"],
		properties: { name: ["Ada"], jobTitle: ["Analyst"] },
	}]);
});

Deno.test("extractMicrodata: a repeated property is an array", () => {
	const html =
		`<div itemscope><span itemprop="tag">a</span><span itemprop="tag">b</span></div>`;
	assertEquals(extractMicrodata(html), [{ properties: { tag: ["a", "b"] } }]);
});

Deno.test("extractMicrodata: multi-name itemprop lands under every name", () => {
	const html = `<div itemscope><span itemprop="name title">X</span></div>`;
	assertEquals(extractMicrodata(html), [{ properties: { name: ["X"], title: ["X"] } }]);
});

Deno.test("extractMicrodata: a nested item is a value, not a top-level item", () => {
	const html = `<div itemscope itemtype="https://schema.org/Product">
		<span itemprop="name">Rope</span>
		<div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
			<meta itemprop="price" content="49.90">
		</div>
	</div>`;
	const items = extractMicrodata(html);
	assertEquals(items.length, 1);
	const offer = items[0].properties.offers[0] as MicrodataItem;
	assertEquals(offer.type, ["https://schema.org/Offer"]);
	assertEquals(offer.properties.price, ["49.90"]);
	// the outer item must not also see the nested item's own properties
	assertEquals("price" in items[0].properties, false);
});

Deno.test("extractMicrodata: per-element value rules", () => {
	const html = `<div itemscope>
		<meta itemprop="m" content="M">
		<img itemprop="img" src="/i.png">
		<a itemprop="a" href="/x">label</a>
		<time itemprop="t" datetime="2024-01-02">Jan 2</time>
		<time itemprop="t2">Jan 3</time>
		<data itemprop="d" value="7">seven</data>
		<meter itemprop="mt" value="3">three</meter>
		<object itemprop="o" data="/o.swf"></object>
		<span itemprop="s">  spaced   text  </span>
	</div>`;
	const [item] = extractMicrodata(html, { url: "https://e.com/p/" });
	assertEquals(item.properties.m, ["M"]);
	assertEquals(item.properties.img, ["https://e.com/i.png"]);
	assertEquals(item.properties.a, ["https://e.com/x"]);
	assertEquals(item.properties.t, ["2024-01-02"]);
	assertEquals(item.properties.t2, ["Jan 3"]);
	assertEquals(item.properties.d, ["7"]);
	assertEquals(item.properties.mt, ["3"]);
	assertEquals(item.properties.o, ["https://e.com/o.swf"]);
	assertEquals(item.properties.s, ["spaced text"]);
});

Deno.test("extractMicrodata: <base href> wins over options.url", () => {
	const html =
		`<html><head><base href="https://b.com/d/"></head><body><div itemscope><a itemprop="u" href="x">l</a></div></body></html>`;
	const [item] = extractMicrodata(html, { url: "https://o.com/" });
	assertEquals(item.properties.u, ["https://b.com/d/x"]);
});

Deno.test("extractMicrodata: itemid and several top-level items", () => {
	const html = `<div itemscope itemid="urn:isbn:1"><span itemprop="n">a</span></div>
		<div itemscope itemid="urn:isbn:2"><span itemprop="n">b</span></div>`;
	const items = extractMicrodata(html);
	assertEquals(items.map((i) => i.id), ["urn:isbn:1", "urn:isbn:2"]);
});

Deno.test("extractMicrodata: maxItems caps the result", () => {
	const html = "<div itemscope><span itemprop=n>x</span></div>".repeat(50);
	assertEquals(extractMicrodata(html, { maxItems: 5 }).length, 5);
});

Deno.test("extractMicrodata: a document with no microdata yields an empty array", () => {
	assertEquals(extractMicrodata("<p>nothing here</p>"), []);
});

Deno.test("extractMicrodata: never throws on hostile input", () => {
	const nested = "<div itemscope itemprop=p>".repeat(200) + "x";
	for (
		const html of [
			"",
			"<<>>&&;",
			"<div itemscope>",
			nested,
			"<div itemscope itemprop=p>x</div>",
		]
	) {
		assertEquals(Array.isArray(extractMicrodata(html)), true);
	}
});

Deno.test("extractMicrodata: throws only on a wrong argument type", () => {
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractMicrodata(null as any), TypeError);
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractMicrodata(7 as any), TypeError);
});
