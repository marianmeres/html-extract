import { assertEquals, assertThrows } from "@std/assert";
import { extractEmbeddedJson } from "../src/embedded-json.ts";

Deno.test("extractEmbeddedJson: reads __NEXT_DATA__ from a typed script block", () => {
	const html =
		`<body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"a":1}}}</script></body>`;
	const out = extractEmbeddedJson(html) as {
		__NEXT_DATA__: { props: { pageProps: { a: number } } };
	};
	assertEquals(out.__NEXT_DATA__.props.pageProps.a, 1);
});

Deno.test("extractEmbeddedJson: reads a window.KEY = {…} assignment", () => {
	const html = `<script>window.__INITIAL_STATE__ = {"theme":"dark"};</script>`;
	assertEquals(extractEmbeddedJson(html), { __INITIAL_STATE__: { theme: "dark" } });
});

Deno.test("extractEmbeddedJson: reads a bare KEY={…} assignment without spaces", () => {
	const html = `<script>__APOLLO_STATE__={"ROOT_QUERY":{"x":1}}</script>`;
	assertEquals(extractEmbeddedJson(html), {
		__APOLLO_STATE__: { ROOT_QUERY: { x: 1 } },
	});
});

Deno.test("extractEmbeddedJson: braces inside strings do not truncate the payload", () => {
	const html =
		`<script>window.__PRELOADED_STATE__ = {"title":"a } b { c","ok":true};</script>`;
	const out = extractEmbeddedJson(html) as {
		__PRELOADED_STATE__: { title: string; ok: boolean };
	};
	assertEquals(out.__PRELOADED_STATE__.title, "a } b { c");
	assertEquals(out.__PRELOADED_STATE__.ok, true);
});

Deno.test('extractEmbeddedJson: handles the JSON.parse("…") assignment form', () => {
	const html =
		`<script>window.__NUXT__=JSON.parse("{\\"data\\":[{\\"id\\":7}],\\"quote\\":\\"a \\\\\\"b\\\\\\" c\\"}")</script>`;
	const out = extractEmbeddedJson(html) as {
		__NUXT__: { data: { id: number }[]; quote: string };
	};
	assertEquals(out.__NUXT__.data[0].id, 7);
	assertEquals(out.__NUXT__.quote, 'a "b" c');
});

Deno.test("extractEmbeddedJson: skips an IIFE payload instead of evaluating it", () => {
	const html =
		`<script>window.__NUXT__=(function(a,b){return {data:[{a:a}],error:b}}(1,null));</script>`;
	assertEquals(extractEmbeddedJson(html), {});
});

Deno.test("extractEmbeddedJson: respects a custom key list", () => {
	const html = `<script>window.__MY_STATE__ = {"a":1};</script>
		<script>window.__NEXT_DATA__ = {"b":2};</script>`;
	assertEquals(extractEmbeddedJson(html, { keys: ["__MY_STATE__"] }), {
		__MY_STATE__: { a: 1 },
	});
});

Deno.test("extractEmbeddedJson: skips oversized scripts", () => {
	const big = `<script>window.__INITIAL_STATE__ = {"pad":"${
		"x".repeat(5000)
	}"};</script>`;
	assertEquals(extractEmbeddedJson(big, { maxScriptSize: 1000 }), {});
	const ok = extractEmbeddedJson(big, { maxScriptSize: 100_000 }) as {
		__INITIAL_STATE__: { pad: string };
	};
	assertEquals(ok.__INITIAL_STATE__.pad.length, 5000);
});

Deno.test("extractEmbeddedJson: first occurrence wins and later ones are ignored", () => {
	const html = `<script>window.__INITIAL_STATE__ = {"n":1};</script>
		<script>window.__INITIAL_STATE__ = {"n":2};</script>`;
	assertEquals(extractEmbeddedJson(html), { __INITIAL_STATE__: { n: 1 } });
});

Deno.test("extractEmbeddedJson: never throws on hostile input", () => {
	for (
		const html of [
			"",
			"<script>",
			"<script>window.__NEXT_DATA__ = {",
			"<script>window.__NEXT_DATA__ = }{</script>",
			`<script id="__NEXT_DATA__" type="application/json">nope</script>`,
			"<<>>&&;",
		]
	) {
		assertEquals(typeof extractEmbeddedJson(html), "object");
	}
});

Deno.test("extractEmbeddedJson: throws only on a wrong argument type", () => {
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractEmbeddedJson(null as any), TypeError);
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractEmbeddedJson({} as any), TypeError);
});
