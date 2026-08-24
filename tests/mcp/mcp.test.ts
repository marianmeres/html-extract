/**
 * Tests for `mcp.ts`.
 *
 * Gated out of `deno task test` (see the `--ignore` in `deno.json`) and run by
 * `deno task test:mcp` instead: `mcp.ts` imports `npm:zod` and the MCP server types,
 * and the default suite stays hermetic and dependency-free.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { tools } from "../../mcp.ts";

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

function call(name: string, args: Record<string, unknown>): Promise<string> {
	const tool = byName[name];
	assert(tool, `no such tool: ${name}`);
	return tool.handler(args);
}

const FIXTURES = fromFileUrl(new URL("../fixtures", import.meta.url));
const fixture = (name: string) => `${FIXTURES}/${name}/input.html`;

// ---------------------------------------------------------------------------
// definitions
// ---------------------------------------------------------------------------

Deno.test("tool definitions are well-formed", () => {
	assert(tools.length > 0);
	for (const t of tools) {
		assert(/^[a-z0-9-]+$/.test(t.name), `bad tool name: ${t.name}`);
		assert(t.description.length > 40, `thin description: ${t.name}`);
		assert(Object.keys(t.params).length > 0, `no params: ${t.name}`);
		for (const [param, schema] of Object.entries(t.params)) {
			assert(
				(schema as { description?: string }).description,
				`${t.name}.${param} has no .describe()`,
			);
		}
	}
	assertEquals(new Set(tools.map((t) => t.name)).size, tools.length);
});

Deno.test("every document-taking tool accepts html or path, and rejects neither/both", async () => {
	for (const name of ["extract-preview", "diagnose-content", "convert-html"]) {
		await assertRejects(() => call(name, {}), Error, "one of `html` or `path`");
		await assertRejects(
			() => call(name, { html: "<p>x</p>", path: fixture("nav-only") }),
			Error,
			"not both",
		);
	}
	await assertRejects(
		() => call("extract-preview", { path: "/no/such/file.html" }),
		Error,
		"could not read",
	);
});

// ---------------------------------------------------------------------------
// extract-preview
// ---------------------------------------------------------------------------

Deno.test("extract-preview: reports what the library actually found", async () => {
	const out = await call("extract-preview", {
		path: fixture("news-article"),
		url: "https://sentinel.example/news/2024/harbour-crane-collapse",
	});
	assertStringIncludes(out, "Harbour crane collapses at north quay");
	assertStringIncludes(out, "The Daily Sentinel");
	assertStringIncludes(out, "2024-03-12T06:41:00.000Z");
	assertStringIncludes(out, "json-ld       : 1 block(s) — @type: NewsArticle");
	assertStringIncludes(out, "via         : semantic");
	// the markdown preview is on by default
	assertStringIncludes(out, "# Harbour crane collapses at north quay");
});

Deno.test("extract-preview: trace shows the library's own decisions", async () => {
	const quiet = await call("extract-preview", { path: fixture("news-article") });
	assert(!quiet.includes("## decision trace"));
	assertStringIncludes(quiet, "log line(s) captured");

	const loud = await call("extract-preview", {
		path: fixture("news-article"),
		trace: true,
	});
	assertStringIncludes(loud, "## decision trace");
	assertStringIncludes(loud, "[html-extract] metadata: title from og:title");
	assertStringIncludes(loud, "[html-extract] main content: via=semantic");
});

Deno.test("extract-preview: preview: 0 omits the markdown, and null content is explained", async () => {
	const out = await call("extract-preview", {
		path: fixture("news-article"),
		preview: 0,
	});
	assert(!out.includes("markdown preview"));

	const navOnly = await call("extract-preview", { path: fixture("nav-only") });
	assertStringIncludes(navOnly, "null — no main content could be identified");
	assertStringIncludes(navOnly, "diagnose-content");
});

Deno.test("extract-preview: surfaces embedded json and microdata", async () => {
	const next = await call("extract-preview", { path: fixture("nextjs-app") });
	assertStringIncludes(next, "__NEXT_DATA__");
	assertStringIncludes(next, "__INITIAL_STATE__");

	const product = await call("extract-preview", { path: fixture("product-jsonld") });
	assertStringIncludes(product, "microdata     : 1 item(s)");
	assertStringIncludes(product, "https://schema.org/Product");
});

Deno.test("extract-preview: contentSelector is honoured", async () => {
	const out = await call("extract-preview", {
		path: fixture("news-article"),
		contentSelector: "aside.related",
	});
	assertStringIncludes(out, "via         : selector");
});

Deno.test("extract-preview: malformed input degrades instead of throwing", async () => {
	for (const name of ["broken-soup", "broken-truncated"]) {
		const out = await call("extract-preview", { path: fixture(name) });
		assertStringIncludes(out, "# extract()");
	}
	assertStringIncludes(await call("extract-preview", { html: "" }), "# extract()");
});

// ---------------------------------------------------------------------------
// diagnose-content
// ---------------------------------------------------------------------------

Deno.test("diagnose-content: explains a null result and suggests nothing to invent", async () => {
	const out = await call("diagnose-content", { path: fixture("nav-only") });
	assertStringIncludes(out, "returned null");
	assertStringIncludes(out, "## decision trace");
	// the trace has to carry the real reason, not a paraphrase
	assertStringIncludes(out, "link text");
});

Deno.test("diagnose-content: ranks the containers a page actually has", async () => {
	const out = await call("diagnose-content", {
		path: fixture("docs-page"),
		url: "https://docs.widgetworks.dev/api/rate-limiting",
	});
	assertStringIncludes(out, "via         : semantic");
	assertStringIncludes(out, "## candidate selectors present in this document");
	assertStringIncludes(out, "main");
	assertStringIncludes(out, "The automatic pick looks right");
});

Deno.test("diagnose-content: extra selectors are probed", async () => {
	const out = await call("diagnose-content", {
		path: fixture("product-jsonld"),
		selectors: ".pdp__description, .pdp",
	});
	assertStringIncludes(out, ".pdp__description");
});

Deno.test("diagnose-content: never throws on hostile input", async () => {
	for (const html of ["", "<<>>&&;", "<div>".repeat(500)]) {
		assertStringIncludes(
			await call("diagnose-content", { html }),
			"# diagnose-content",
		);
	}
});

// ---------------------------------------------------------------------------
// convert-html
// ---------------------------------------------------------------------------

Deno.test("convert-html: markdown and text, whole document or main content only", async () => {
	const md = await call("convert-html", { path: fixture("docs-page") });
	assertStringIncludes(md, "# Rate limiting");
	assertStringIncludes(md, "```ts"); // code fence and language survive
	assertStringIncludes(md, "| Plan |"); // rectangular table becomes GFM
	assertStringIncludes(md, "JavaScript SDK"); // whole document: the sidebar is in

	const main = await call("convert-html", {
		path: fixture("docs-page"),
		mainContentOnly: true,
	});
	assertStringIncludes(main, "main content only, via semantic");
	assert(!main.includes("JavaScript SDK"), "sidebar leaked into main-content output");

	const txt = await call("convert-html", {
		path: fixture("docs-page"),
		format: "text",
	});
	assertStringIncludes(txt, "Rate limiting");
	assert(!txt.includes("```"), "text output must not contain fences");
});

Deno.test("convert-html: options reach the renderer", async () => {
	const html = `<p><a href="/a">A</a> <img src="/i.png" alt="I"> a * b</p>`;
	const base = await call("convert-html", { html, url: "https://e.com/p/" });
	assertStringIncludes(base, "[A](https://e.com/a)");
	assertStringIncludes(base, "![I](https://e.com/i.png)");
	assertStringIncludes(base, "a \\* b");

	const bare = await call("convert-html", {
		html,
		links: false,
		images: false,
		escape: false,
	});
	assert(!bare.includes("]("), "links: false still emitted a link");
	assert(!bare.includes("!["), "images: false still emitted an image");
	assertStringIncludes(bare, "a * b");

	const starred = await call("convert-html", {
		html: "<ul><li>x</li></ul>",
		bullet: "*",
	});
	assertStringIncludes(starred, "* x");
});

Deno.test("convert-html: maxChars truncates and says so", async () => {
	const out = await call("convert-html", { path: fixture("docs-page"), maxChars: 50 });
	assertStringIncludes(out, "more chars]");
	assert(out.length < 200);
});

Deno.test("convert-html: mainContentOnly on a page with no content explains itself", async () => {
	const out = await call("convert-html", {
		path: fixture("nav-only"),
		mainContentOnly: true,
	});
	assertStringIncludes(out, "No main content could be identified");
	assertStringIncludes(out, "diagnose-content");
});

// ---------------------------------------------------------------------------
// pick-fields
// ---------------------------------------------------------------------------

Deno.test("pick-fields: text, attr and all, plus the misses", async () => {
	const out = await call("pick-fields", {
		path: fixture("product-jsonld"),
		selectors: JSON.stringify({
			title: "h1",
			price: { selector: ".price", attr: "data-value" },
			tags: { selector: ".tag", all: true },
			nope: ".no-such-thing",
		}),
	});
	assertStringIncludes(out, '"title": "Klettersteigset Vertigo 2"');
	assertStringIncludes(out, '"price": "89.90"');
	assertStringIncludes(out, '"EN 958:2017"');
	assertStringIncludes(out, "Missing (selector matched nothing");
	assertStringIncludes(out, "nope");
});

Deno.test("pick-fields: an invalid selector is reported, not thrown", async () => {
	const out = await call("pick-fields", {
		html: "<p>x</p>",
		selectors: JSON.stringify({ bad: "<<>>" }),
	});
	assertStringIncludes(out, "invalid selector");
	assertStringIncludes(out, "Missing");
});

Deno.test("pick-fields: a bad selector map is a clear error", async () => {
	await assertRejects(
		() => call("pick-fields", { html: "<p>x</p>", selectors: "not json" }),
		Error,
		"must be a JSON object",
	);
	await assertRejects(
		() => call("pick-fields", { html: "<p>x</p>", selectors: "[1,2]" }),
		Error,
		"must be a JSON object",
	);
});

// ---------------------------------------------------------------------------
// metadata-precedence — the drift pin
// ---------------------------------------------------------------------------

const METADATA_FIELDS = [
	"title",
	"description",
	"canonical",
	"lang",
	"siteName",
	"author",
	"publishedAt",
	"modifiedAt",
	"image",
	"favicon",
	"type",
];

Deno.test("metadata-precedence: covers every field and never stops early", async () => {
	const out = await call("metadata-precedence", {});
	for (const field of METADATA_FIELDS) {
		assertStringIncludes(out, `## ${field}`);
	}
	// The chains are derived by elimination against the real implementation. A
	// "stopped" note means src/metadata.ts grew, renamed or reordered a source that the
	// probe table in mcp.ts does not know about — which is exactly the drift this pin
	// exists to catch. Update CANDIDATES in mcp.ts, do not weaken this assertion.
	assert(
		!out.includes("stopped"),
		`metadata-precedence could not derive a full chain:\n${out}`,
	);
});

Deno.test("metadata-precedence: the derived order matches the documented one", async () => {
	const out = await call("metadata-precedence", { field: "title" });
	const steps = out
		.split("\n")
		.map((l) => l.match(/^\s*\d+\.\s*(.+)$/)?.[1])
		.filter(Boolean);
	assertEquals(steps, [
		"meta[name=title]",
		"og:title",
		"twitter:title",
		"json-ld headline/name",
		"<title>",
		"<h1>",
	]);
});

Deno.test("metadata-precedence: a single field, and an unknown one", async () => {
	const one = await call("metadata-precedence", { field: "favicon" });
	assertStringIncludes(one, "## favicon");
	assertStringIncludes(one, "/favicon.ico guess");
	assert(!one.includes("## title"));

	const bogus = await call("metadata-precedence", { field: "nonsense" });
	assertStringIncludes(bogus, "unknown field");
});

Deno.test("metadata-precedence: the tool and API.md agree on the favicon chain", async () => {
	// `rel` matching is token-based, so `rel="shortcut icon"` is NOT a separate step —
	// a divergence this tool found in the docs, and one worth keeping pinned
	const out = await call("metadata-precedence", { field: "favicon" });
	const steps = out
		.split("\n")
		.map((l) => l.match(/^\s*\d+\.\s*(.+)$/)?.[1])
		.filter(Boolean);
	assertEquals(steps, [
		"<link rel=icon>",
		"<link rel=apple-touch-icon>",
		"<link rel=mask-icon>",
		"/favicon.ico guess",
	]);

	const api = await Deno.readTextFile(
		fromFileUrl(new URL("../../API.md", import.meta.url)),
	);
	assertStringIncludes(api, "`link[rel~=icon]`");
});

// ---------------------------------------------------------------------------
// the tools must not lie about the package
// ---------------------------------------------------------------------------

Deno.test("mcp-include.txt exists and describes the package", async () => {
	const text = await Deno.readTextFile(
		fromFileUrl(new URL("../../mcp-include.txt", import.meta.url)),
	);
	assert(text.trim().length > 80, "mcp-include.txt is too thin to be useful");
	assertStringIncludes(text, "metadata");
	// the sanitizer disclaimer travels with every description of clean()
	assertStringIncludes(text, "NOT an XSS sanitizer");
});
