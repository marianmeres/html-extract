import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { extract } from "../src/mod.ts";
import { loadFixture } from "./_fixtures.ts";

// Integration over the fixture corpus. Content assertions are deliberately FUZZY
// (design §11): they assert that a known body phrase is present and a known nav/footer
// phrase is absent. Exact-output assertions on a heuristic are a maintenance trap — the
// golden files cover exact output, and they are meant to be re-reviewed when they move.

Deno.test("news article: semantic content wins, chrome is excluded", async () => {
	const { html } = await loadFixture("news-article");
	const doc = extract(html, {
		url: "https://sentinel.example/news/2024/harbour-crane-collapse",
	});

	assertEquals(doc.metadata.title, "Harbour crane collapses at north quay");
	assertEquals(doc.lang, "en-GB");
	assertEquals(doc.metadata.author, "Ruth Ellinger");
	assertEquals(doc.metadata.siteName, "The Daily Sentinel");
	assertEquals(doc.metadata.type, "article");
	assertEquals(
		doc.metadata.canonical,
		"https://sentinel.example/news/2024/harbour-crane-collapse",
	);
	assertEquals(doc.metadata.publishedAt, "2024-03-12T06:41:00.000Z");
	assertEquals(doc.metadata.modifiedAt, "2024-03-12T11:02:00.000Z");
	// og:image is relative in the fixture and must be resolved against the page URL
	assertEquals(doc.metadata.image, "https://sentinel.example/news/img/crane-wide.jpg");
	assertEquals(doc.metadata.favicon, "https://sentinel.example/static/favicon-32.png");
	assertEquals(doc.metadata.openGraph.site_name, "The Daily Sentinel");
	assertEquals(doc.metadata.twitter.card, "summary_large_image");

	assertEquals(doc.jsonLd.length, 1);
	assertEquals((doc.jsonLd[0] as Record<string, string>)["@type"], "NewsArticle");

	const content = doc.content;
	assert(content, "expected content");
	assertStringIncludes(content.text(), "bringing down a section of overhead rail");
	assertStringIncludes(content.text(), "structural failure rather than an operational");
	assert(!content.text().includes("Subscribe now"), "primary nav leaked into content");
	assert(!content.text().includes("All rights reserved"), "footer leaked into content");
	assert(
		!content.text().includes("Dockers vote to strike"),
		"aside leaked into content",
	);
	assert(content.linkDensity < 0.2, `link density too high: ${content.linkDensity}`);
	assertStringIncludes(content.markdown(), "# Harbour crane collapses at north quay");
});

Deno.test("docs page: <base href> wins over the page URL when resolving", async () => {
	const { html } = await loadFixture("docs-page");
	const doc = extract(html, { url: "https://mirror.example/whatever" });

	assertEquals(
		doc.metadata.canonical,
		"https://docs.widgetworks.dev/api/rate-limiting",
	);
	assertEquals(doc.metadata.favicon, "https://docs.widgetworks.dev/favicon.ico");
	assertEquals(doc.metadata.siteName, "Widgetworks Docs");

	const content = doc.content!;
	assertStringIncludes(content.text(), "rolling window");
	assert(!content.text().includes("JavaScript SDK"), "sidebar leaked into content");
	assert(!content.text().includes("Widgetworks Inc."), "footer leaked into content");

	const md = content.markdown();
	// the code block must survive verbatim, including its indentation
	assertStringIncludes(md, "```ts");
	assertStringIncludes(md, "\tconst res = await fetch(url);");
	// and the rectangular table becomes GFM
	assertStringIncludes(md, "| Plan |");
	assertStringIncludes(md, "| Enterprise |");
	// relative doc links resolve against <base href>
	assertStringIncludes(md, "https://docs.widgetworks.dev/api/errors#429");
});

Deno.test("product page: JSON-LD @graph and a broken sibling block", async () => {
	const { html } = await loadFixture("product-jsonld");
	const doc = extract(html, { url: "https://shop.bergwerk.at/p/vertigo-2" });

	// three blocks in the document, one of which is unparseable and must be skipped
	assertEquals(doc.jsonLd.length, 2);
	const graph = (doc.jsonLd[0] as { "@graph": Record<string, unknown>[] })["@graph"];
	assertEquals(graph.length, 2);
	assertEquals(graph[1]["@type"], "Product");
	// the comment-wrapped block is recovered
	assertEquals((doc.jsonLd[1] as Record<string, string>).name, "Bergwerk GmbH");

	// uppercase attribute names must still be read
	assertEquals(
		doc.metadata.description,
		"Klettersteigset mit Bandfalldämpfer, geprüft nach EN 958:2017.",
	);
	assertEquals(doc.lang, "de-AT");
	assertEquals(doc.metadata.image, "https://cdn.bergwerk.at/p/vertigo-2/hero@2x.jpg");

	// the same page carries microdata too — and it is the only place the SKU appears
	assertEquals(doc.microdata.length, 1);
	const product = doc.microdata[0];
	assertEquals(product.type, ["https://schema.org/Product"]);
	assertEquals(product.properties.sku, ["BW-4471"]);
	assertEquals(product.properties.category, ["Klettersteig", "Sicherung"]);
	const offer = product.properties.offers[0] as {
		properties: Record<string, unknown[]>;
	};
	assertEquals(offer.properties.priceCurrency, ["EUR"]);

	const content = doc.content!;
	assertStringIncludes(content.text(), "Bandfalldämpfer arbeitet mit einem doppelt");
	assert(!content.text().includes("Warenkorb (0)"), "nav leaked into content");
	assert(!content.text().includes("Impressum"), "footer leaked into content");
});

Deno.test("next.js page: __NEXT_DATA__ is the best data on the page", async () => {
	const { html } = await loadFixture("nextjs-app");
	const doc = extract(html);

	const next = doc.embeddedJson.__NEXT_DATA__ as {
		props: { pageProps: { post: { author: { name: string }; tags: string[] } } };
		buildId: string;
	};
	assertEquals(next.buildId, "kQ7f2nBv9");
	assertEquals(next.props.pageProps.post.author.name, "Mira Halloran");
	assertEquals(next.props.pageProps.post.tags, ["bread", "fermentation"]);
	assertEquals(doc.embeddedJson.__INITIAL_STATE__, { theme: "light", locale: "en-GB" });
	// the Nuxt IIFE is not JSON and must be skipped rather than evaluated
	assertEquals("__NUXT__" in doc.embeddedJson, false);

	const content = doc.content!;
	assertStringIncludes(content.text(), "doubles in about five hours");
	assert(!content.text().includes("RSS"), "footer leaked into content");
});

Deno.test("nav-only page: content is legitimately null", async () => {
	const { html } = await loadFixture("nav-only");
	const doc = extract(html, { url: "https://northfield-pc.example/sitemap" });

	assertEquals(doc.metadata.title, "Sitemap — Northfield Parish Council");
	assertEquals(doc.content, null);
});

Deno.test("fragment input: an email body with no <html> works the same", async () => {
	const { html } = await loadFixture("fragment-email");
	const doc = extract(html, { url: "https://mail.example/message/88213" });

	assertEquals(doc.metadata.title, undefined);
	const content = doc.content!;
	assertStringIncludes(content.text(), "Your order #88213 has shipped");
	assertStringIncludes(content.markdown(), "**#88213**");
	assertStringIncludes(
		content.markdown(),
		"https://track.example.com/88213?ref=email&src=shipping",
	);
});

Deno.test("broken documents still yield what they carry", async () => {
	const truncated = await loadFixture("broken-truncated");
	const doc = extract(truncated.html, { url: "https://mairie.example/x" });
	assertEquals(doc.metadata.title, "Compte rendu de la séance du 4 avril");
	assertStringIncludes(doc.metadata.description!, "Séance ordinaire");
	// the JSON-LD block is cut mid-string and must be skipped, not thrown on
	assertEquals(doc.jsonLd.length, 0);

	const soup = await loadFixture("broken-soup");
	const soupDoc = extract(soup.html);
	assertEquals(soupDoc.metadata.title, "Untitled Document");
	// the fixture's `</title` is missing its `>`, so a browser-shaped parser swallows the
	// meta that follows it — the *second* description is the first one that survives.
	// Documenting the degradation is the point; guessing at a "nicer" answer is not.
	assertStringIncludes(soupDoc.metadata.description!, "a second, later description");
	assert(soupDoc.content === null || soupDoc.content.textLength >= 0);
});

Deno.test("pathological page: the corners an ordinary corpus never reaches", async () => {
	const { html } = await loadFixture("pathological");
	const doc = extract(html, { url: "https://notes.example/logs/tide-gauge" });

	// `LANG=` and `ROLE=` in the source casing — the selector engine is case-sensitive on
	// attribute names, so the semantic path has to read them through attr()
	assertEquals(doc.lang, "en-AU");
	assertEquals(doc.content?.via, "semantic");
	// …and [role=main] sits four wrapper divs above its paragraphs
	assertStringIncludes(doc.content!.text(), "float arm now fouls its guide");
	assert(!doc.content!.text().includes("Coastal Watch Trust"), "footer leaked in");
	assert(!doc.content!.text().includes("Index"), "nav leaked in");

	// the page's only JSON-LD is site furniture; its `name`/`url` must not win
	assertEquals(doc.metadata.title, "Field notes: the tide gauge & the gull");
	assertEquals(doc.metadata.canonical, undefined);

	// a date shape nobody can read stays raw; one with an explicit zone normalizes
	assertEquals(doc.metadata.publishedAt, "March 2024");
	assertEquals(doc.metadata.modifiedAt, "2024-03-12T06:41:00.000Z");

	// the first <base> carries only `target`; the second is the one with the href
	assertStringIncludes(
		doc.content!.markdown(),
		"https://notes.example/archive/2024/series?flag=corrected",
	);

	// an itemprop named after an Object.prototype member used to throw and cost the
	// caller the entire page
	assertEquals(Object.entries(doc.microdata[0].properties), [
		["name", ["Tide gauge NP-1"]],
		["toString", ["© 2026 Coastal Watch Trust"]],
		["constructor", ["brass and stainless"]],
	]);
});

Deno.test("rendering corners: markdown constructs that used to be lost or broken", async () => {
	const { html } = await loadFixture("rendering-corners");
	const md = extract(html, { url: "https://notes.example/logs/rig" }).content!
		.markdown();

	// a nested list that is a direct child of a list, not of an <li>
	assertStringIncludes(md, "- Float arm, stainless, 300 mm\n  - guide bushing");
	// <ol start> and <li value>
	assertStringIncludes(md, "3. Lift the float arm clear.");
	assertStringIncludes(md, "7. Replace the guide bushing.");
	assertStringIncludes(md, "8. Re-level against the datum plate.");
	// a definition list has to render as something, not as a run-on paragraph
	assertStringIncludes(md, "**Datum**");
	// a line of tildes must not open a code fence
	assertStringIncludes(md, "\\~\\~\\~");
	// adjacent same-delimiter emphasis runs must not fuse into literal asterisks
	assertStringIncludes(md, "*a*<!-- -->*b*");
	// the ragged/colspan table degrades to HTML, with its <script> stripped
	assertStringIncludes(md, "<table>");
	assert(!md.includes("ignored()"), "a script survived the table passthrough");
	// RCDATA is decoded, RAWTEXT is not
	assertStringIncludes(md, "Reads high & sticks");
	assertStringIncludes(md, "raw &amp; literal");
});

Deno.test("extract: switches turn the parts off without changing the shape", async () => {
	const { html } = await loadFixture("news-article");

	const metaOnly = extract(html, { content: false });
	assertEquals(metaOnly.content, null);
	assertEquals(metaOnly.metadata.title, "Harbour crane collapses at north quay");

	const bare = extract(html, {
		metadata: false,
		jsonLd: false,
		embeddedJson: false,
		microdata: false,
		content: false,
	});
	assertEquals(bare.metadata, { openGraph: {}, twitter: {}, meta: {} });
	assertEquals(bare.jsonLd, []);
	assertEquals(bare.embeddedJson, {});
	assertEquals(bare.microdata, []);
	assertEquals(bare.content, null);
	assertEquals(bare.title, undefined);
});

Deno.test("extract: contentSelector overrides the heuristic", async () => {
	const { html } = await loadFixture("news-article");
	const doc = extract(html, { contentSelector: "aside.related" });
	assertEquals(doc.content?.via, "selector");
	assertStringIncludes(doc.content!.text(), "Dockers vote to strike");
});

Deno.test("extract: one odd itemprop does not cost the whole page", () => {
	// the properties map used to be a plain object, so an `itemprop` named after an
	// Object.prototype member threw and the caller lost the entire result — metadata,
	// json-ld and content included, not merely the microdata
	const html = `<!doctype html><html><head><title>T</title></head><body><main>
		<p>${"Body copy long enough to clear the content threshold. ".repeat(4)}</p>
		<footer><span itemscope><span itemprop="toString">© 2026</span></span></footer>
	</main></body></html>`;
	const doc = extract(html);
	assertEquals(doc.metadata.title, "T");
	assert(doc.content, "content was lost");
	// read as a dictionary: TypeScript resolves `.toString` on a Record to Object's
	// method, which is exactly why the JSDoc points at Object.entries/Object.hasOwn
	assertEquals(Object.entries(doc.microdata[0].properties), [["toString", ["© 2026"]]]);
});

Deno.test("extract: an empty document is a degraded result, not an error", () => {
	const doc = extract("");
	assertEquals(doc.content, null);
	assertEquals(doc.jsonLd, []);
	assertEquals(doc.embeddedJson, {});
	assertEquals(doc.microdata, []);
	assertEquals(doc.metadata, { openGraph: {}, twitter: {}, meta: {} });
});

Deno.test("extract: JSON.stringify materializes the lazy renderings", async () => {
	const { html } = await loadFixture("news-article");
	const doc = extract(html);
	const round = JSON.parse(JSON.stringify(doc)) as {
		content: { markdown: string; text: string; via: string };
	};
	assertStringIncludes(round.content.markdown, "# Harbour crane collapses");
	assertStringIncludes(round.content.text, "bringing down a section");
	assertEquals(round.content.via, "semantic");
});

Deno.test("extract: a logger sees the work without changing the result", async () => {
	const { html } = await loadFixture("news-article");
	const lines: string[] = [];
	const logger = {
		debug: (...a: unknown[]) => lines.push(`debug ${a.join(" ")}`),
		log: (...a: unknown[]) => lines.push(`log ${a.join(" ")}`),
		warn: (...a: unknown[]) => lines.push(`warn ${a.join(" ")}`),
		error: (...a: unknown[]) => lines.push(`error ${a.join(" ")}`),
	};
	const quiet = extract(html);
	const loud = extract(html, { logger });
	assertEquals(loud.metadata, quiet.metadata);
	assert(lines.length > 0, "a logger was injected but nothing was logged");
	assert(
		lines.every((l) => l.includes("[html-extract]")),
		"every log line must be namespaced",
	);
});
