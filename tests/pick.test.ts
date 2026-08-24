import { assert, assertEquals } from "@std/assert";
import { pick } from "../src/pick.ts";

const PAGE = `<!doctype html>
<html lang="en">
<head>
	<title>  Widget   page  </title>
	<meta name="sku" content=" ABC-1 ">
</head>
<body>
	<h1 class="title">
		Big   Widget
	</h1>
	<span class="price" data-value="19.90">19,90 €</span>
	<ul>
		<li class="tag">new</li>
		<li class="tag">sale</li>
		<li class="tag">  spaced  </li>
	</ul>
	<a class="link" href="/a">A</a>
	<a class="link">no href</a>
	<div class="empty-attr" data-x=""></div>
</body>
</html>`;

Deno.test("pick: text content by default, whitespace-collapsed", () => {
	const out = pick(PAGE, { title: "h1" });
	assertEquals(out.title, "Big Widget");
});

Deno.test("pick: a bare string is shorthand for { selector }", () => {
	assertEquals(pick(PAGE, { t: "h1" }), pick(PAGE, { t: { selector: "h1" } }));
});

Deno.test("pick: selectors also reach into <head>", () => {
	const out = pick(PAGE, {
		title: "title",
		sku: { selector: "meta[name=sku]", attr: "content" },
	});
	assertEquals(out.title, "Widget page");
	assertEquals(out.sku, "ABC-1");
});

Deno.test("pick: attr reads an attribute and is only trimmed, never collapsed", () => {
	const html = `<div data-json='{"a":  1,  "b": 2}'>x</div>`;
	const out = pick(html, { j: { selector: "div", attr: "data-json" } });
	assertEquals(out.j, `{"a":  1,  "b": 2}`);
});

Deno.test("pick: attribute lookup is case-insensitive", () => {
	const out = pick(`<IMG SRC="a.png">`, { s: { selector: "img", attr: "SrC" } });
	assertEquals(out.s, "a.png");
});

Deno.test("pick: a present but empty attribute is an empty string, not undefined", () => {
	const out = pick(PAGE, { x: { selector: ".empty-attr", attr: "data-x" } });
	assertEquals(out.x, "");
});

Deno.test("pick: all returns every match", () => {
	const out = pick(PAGE, { tags: { selector: ".tag", all: true } });
	assertEquals(out.tags, ["new", "sale", "spaced"]);
});

Deno.test("pick: all with no matches is an empty array, not undefined", () => {
	const out = pick(PAGE, { nope: { selector: ".nothing-here", all: true } });
	assertEquals(out.nope, []);
});

Deno.test("pick: all + attr skips matches without the attribute", () => {
	const out = pick(PAGE, {
		hrefs: { selector: "a.link", attr: "href", all: true },
	});
	assertEquals(out.hrefs, ["/a"]);
});

Deno.test("pick: trim false keeps the raw text", () => {
	const out = pick(`<p>  a\n  b  </p>`, { p: { selector: "p", trim: false } });
	assertEquals(out.p, "  a\n  b  ");
});

Deno.test("pick: options.trim false is the default, spec-level trim overrides it", () => {
	const html = `<p>  a  </p><b>  c  </b>`;
	const out = pick(html, {
		loose: "p",
		tight: { selector: "b", trim: true },
	}, { trim: false });
	assertEquals(out.loose, "  a  ");
	assertEquals(out.tight, "c");
});

Deno.test("pick: trim false on an attribute keeps its whitespace", () => {
	const out = pick(`<div data-x="  v  ">y</div>`, {
		x: { selector: "div", attr: "data-x", trim: false },
	});
	assertEquals(out.x, "  v  ");
});

Deno.test("pick: a missing selector yields undefined", () => {
	const out = pick(PAGE, { missing: ".not-there" });
	assertEquals(out.missing, undefined);
});

Deno.test("pick: a matched element without the attribute yields undefined", () => {
	const out = pick(PAGE, { alt: { selector: "h1", attr: "alt" } });
	assertEquals(out.alt, undefined);
});

Deno.test("pick: an invalid selector yields undefined instead of throwing", () => {
	const out = pick(PAGE, {
		bad: "<<>>",
		worse: { selector: "div:has-not(", all: true },
		blank: "   ",
	});
	assertEquals(out.bad, undefined);
	assertEquals(out.worse, []);
	assertEquals(out.blank, undefined);
});

Deno.test("pick: an unusable spec yields undefined instead of throwing", () => {
	// deno-lint-ignore no-explicit-any
	const out = pick(PAGE, { a: 42 as any, b: null as any, c: {} as any, d: "h1" });
	assertEquals(out.a, undefined);
	assertEquals(out.b, undefined);
	assertEquals(out.c, undefined);
	assertEquals(out.d, "Big Widget");
});

Deno.test("pick: maxAll caps the result and drops the tail", () => {
	const html = `<ul>${"<li>x</li>".repeat(50)}</ul>`;
	const out = pick(html, { items: { selector: "li", all: true } }, { maxAll: 7 });
	assertEquals((out.items as string[]).length, 7);
});

Deno.test("pick: maxAll 0 yields an empty array, Infinity disables the cap", () => {
	const html = `<ul>${"<li>x</li>".repeat(20)}</ul>`;
	assertEquals(
		pick(html, { i: { selector: "li", all: true } }, { maxAll: 0 }).i,
		[],
	);
	assertEquals(
		(pick(html, { i: { selector: "li", all: true } }, { maxAll: Infinity })
			.i as string[]).length,
		20,
	);
});

Deno.test("pick: the default cap is 1000", () => {
	const html = `<ul>${"<li>x</li>".repeat(1200)}</ul>`;
	const out = pick(html, { i: { selector: "li", all: true } });
	assertEquals((out.i as string[]).length, 1000);
});

Deno.test("pick: non-object selectors is a programmer error and throws TypeError", () => {
	for (const bad of [null, undefined, 42, "h1", ["h1"], true]) {
		let threw = false;
		try {
			// deno-lint-ignore no-explicit-any
			pick(PAGE, bad as any);
		} catch (e) {
			threw = e instanceof TypeError;
		}
		assert(threw, `pick(html, ${JSON.stringify(bad)}) should throw a TypeError`);
	}
});

Deno.test("pick: a wrong html type is a programmer error and throws TypeError", () => {
	let threw = false;
	try {
		// deno-lint-ignore no-explicit-any
		pick(null as any, { a: "p" });
	} catch (e) {
		threw = e instanceof TypeError;
	}
	assert(threw, "pick(null, …) should throw a TypeError");
});

Deno.test("pick: empty html yields no values, but all specs still get their array", () => {
	const out = pick("", { a: "h1", b: { selector: "p", all: true } });
	assertEquals(out.a, undefined);
	assertEquals(out.b, []);
});

Deno.test("pick: malformed html degrades instead of throwing", () => {
	const hostile = [
		"",
		" ",
		"<",
		"<<<>>>",
		"<div".repeat(500),
		"<p>unclosed <span>still",
		`<!--`,
		"�\uD800 lone surrogate",
	];
	for (const html of hostile) {
		const out = pick(html, {
			a: "p",
			b: { selector: "*", all: true },
			c: { selector: "a", attr: "href", all: true },
		});
		assert(typeof out === "object" && out !== null);
		assert(Array.isArray(out.b), `expected an array for ${JSON.stringify(html)}`);
	}
});

Deno.test("pick: an empty selectors map yields an empty object", () => {
	assertEquals(pick(PAGE, {}), {});
});

Deno.test("pick: the logger explains what happened", () => {
	const debug: string[] = [];
	const warn: string[] = [];
	const logger = {
		debug: (...a: unknown[]) => debug.push(a.join(" ")),
		info: () => {},
		log: () => {},
		warn: (...a: unknown[]) => warn.push(a.join(" ")),
		error: () => {},
	};
	pick(PAGE, {
		// deno-lint-ignore no-explicit-any
		broken: 1 as any,
		missing: ".nope",
		tags: { selector: ".tag", all: true },
	}, { logger, maxAll: 1 });
	assert(debug.some((l) => l.includes("[html-extract] pick: missing")));
	assert(debug.some((l) => l.includes("capped at maxAll 1")));
	assert(warn.some((l) => l.includes("no usable selector")));
});
