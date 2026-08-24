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

/**
 * Reads a property by a runtime key. TypeScript resolves `props.constructor` and
 * `props.toString` against `Object`, not against the index signature, so the literal
 * form does not type-check even though it is exactly what a caller writes.
 */
function prop(item: MicrodataItem, name: string): (string | MicrodataItem)[] {
	return item.properties[name];
}

/** Every own member of `Object.prototype` a page could name an `itemprop` after. */
const PROTO_NAMES = [
	"constructor",
	"toString",
	"toLocaleString",
	"valueOf",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"__proto__",
];

Deno.test("extractMicrodata: an itemprop named after Object.prototype is data", () => {
	for (const name of PROTO_NAMES) {
		const html = `<div itemscope><span itemprop="${name}">v</span></div>`;
		const items = extractMicrodata(html);
		assertEquals(items.length, 1, `${name}: no item`);
		assertEquals(items[0].properties[name], ["v"], `${name}: wrong value`);
		// repeats still accumulate rather than overwrite or blow up
		const twice = extractMicrodata(
			`<div itemscope><span itemprop="${name}">a</span><span itemprop="${name}">b</span></div>`,
		);
		assertEquals(twice[0].properties[name], ["a", "b"], `${name}: not accumulated`);
	}
});

Deno.test("extractMicrodata: properties is a plain dictionary, prototype and all", () => {
	const [item] = extractMicrodata(
		`<div itemscope><span itemprop="toString">v</span></div>`,
	);
	// the null prototype is the fix, and is documented — a page's property name can
	// never collide with an inherited member again
	assertEquals(Object.getPrototypeOf(item.properties), null);
	// …and everything a caller does with a dictionary keeps working
	assertEquals(Object.keys(item.properties), ["toString"]);
	assertEquals(Object.entries(item.properties), [["toString", ["v"]]]);
	assertEquals(JSON.stringify(item), `{"properties":{"toString":["v"]}}`);
	assertEquals(JSON.parse(JSON.stringify(item)).properties.toString, ["v"]);
	const spread: Record<string, unknown> = { ...item.properties };
	assertEquals(Object.entries(spread), [["toString", ["v"]]]);
});

Deno.test("extractMicrodata: a nested item's properties behave the same", () => {
	const html = `<div itemscope itemtype="https://schema.org/Product">
		<span itemprop="valueOf">outer</span>
		<div itemprop="offers" itemscope>
			<meta itemprop="constructor" content="inner">
		</div>
	</div>`;
	const [item] = extractMicrodata(html);
	const offer = item.properties.offers[0] as MicrodataItem;
	assertEquals(prop(offer, "constructor"), ["inner"]);
	assertEquals(Object.getPrototypeOf(offer.properties), null);
	assertEquals(
		JSON.stringify(item),
		`{"type":["https://schema.org/Product"],"properties":` +
			`{"valueOf":["outer"],"offers":[{"properties":{"constructor":["inner"]}}]}}`,
	);
});

Deno.test("extractMicrodata: a tag named after Object.prototype has no value attr", () => {
	// `<constructor>` used to hit `VALUE_ATTR["constructor"]` and hand the `Object`
	// function to attr() as an attribute name
	for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
		const html =
			`<div itemscope><${name} itemprop="p" content="ignored">v</${name}></div>`;
		assertEquals(prop(extractMicrodata(html)[0], "p"), ["v"], name);
	}
});
