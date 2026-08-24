import { assert, assertEquals, assertThrows } from "@std/assert";
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

/**
 * A script that repeats an assignment whose literal never closes. Every occurrence used
 * to be rescanned to end-of-source, which is quadratic: 872 000 chars — well inside the
 * default `maxScriptSize` — took ~5 s, and doubling the length quadrupled it.
 */
function unbalancedScript(key: string, reps: number, open: string): string {
	return `<script>${(`${key} = ${open}${"x".repeat(200)}\n`).repeat(reps)}</script>`;
}

Deno.test("extractEmbeddedJson: an unclosed literal repeated does not go quadratic", () => {
	for (
		const [label, open] of [
			["unbalanced brace", "{"],
			["unterminated string", `{"a":"`],
		] as const
	) {
		const html = unbalancedScript("__NEXT_DATA__", 4000, open);
		const started = performance.now();
		const out = extractEmbeddedJson(html);
		const elapsed = performance.now() - started;
		assertEquals(out, {}, label);
		// generous by two orders of magnitude — the fixed scanner needs ~20 ms, the
		// quadratic one needed >5 000 ms for this input
		assert(elapsed < 1000, `${label}: took ${elapsed.toFixed(0)}ms`);
	}
});

Deno.test("extractEmbeddedJson: the work stays linear as the script grows", () => {
	const time = (reps: number) => {
		const html = unbalancedScript("__NUXT__", reps, "{");
		const started = performance.now();
		extractEmbeddedJson(html);
		return performance.now() - started;
	};
	time(500); // warm up, so the first parse's JIT cost is not attributed to `small`
	const small = time(500);
	const big = time(4000);
	// 8x the input: linear allows ~8x, the quadratic scanner would need ~64x. The
	// threshold is deliberately loose — this asserts the complexity class, not a budget
	assert(
		big < small * 24 + 50,
		`500 reps ${small.toFixed(0)}ms, 4000 reps ${big.toFixed(0)}ms`,
	);
});

Deno.test("extractEmbeddedJson: the scan budget does not lose a real payload", () => {
	const cases: [string, string][] = [
		[
			"decoy inside a string",
			`var s = "__NUXT__ = {"; window.__NUXT__ = {"ok":true};`,
		],
		[
			"unbalanced decoy first",
			`__NUXT__ = {${"x".repeat(5000)}\n__NUXT__ = {"ok":true}`,
		],
		[
			"many unparseable decoys",
			`__NUXT__ = {a:1};\n`.repeat(2000) + `__NUXT__ = {"ok":true}`,
		],
		["a megabyte of padding", `/*${"x".repeat(1_000_000)}*/\n__NUXT__ = {"ok":true}`],
	];
	for (const [label, body] of cases) {
		assertEquals(extractEmbeddedJson(`<script>${body}</script>`), {
			__NUXT__: { ok: true },
		}, label);
	}
});

Deno.test("extractEmbeddedJson: exhausting the scan budget is warned about", () => {
	const warn: string[] = [];
	const logger = {
		debug: () => {},
		info: () => {},
		log: () => {},
		warn: (...a: unknown[]) => warn.push(a.join(" ")),
		error: () => {},
	};
	extractEmbeddedJson(unbalancedScript("__NEXT_DATA__", 2000, "{"), { logger });
	assert(
		warn.some((l) =>
			l.includes("[html-extract] embedded json: __NEXT_DATA__ scan budget")
		),
		`no budget warning, got: ${JSON.stringify(warn)}`,
	);
});
