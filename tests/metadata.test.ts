import { assert, assertEquals, assertThrows } from "@std/assert";
import { extractMetadata, metadataFromDocument } from "../src/metadata.ts";
import { parseDocument } from "../src/_dom.ts";
import type { Logger } from "../src/types.ts";

/** A logger that keeps every line, so tests can assert on *why* a value was picked. */
function recorder(): { lines: string[]; logger: Logger } {
	const lines: string[] = [];
	const push = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(" "));
	};
	return { lines, logger: { debug: push, log: push, warn: push, error: push } };
}

const FULL_HEAD = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>Title element</title>
	<meta name="description" content="The   real
	description">
	<meta property="og:title" content="OG title">
	<meta property="og:description" content="OG description">
	<meta property="og:image" content="/img/hero.png">
	<meta property="og:image:width" content="1200">
	<meta property="og:site_name" content="Example Site">
	<meta property="og:type" content="article">
	<meta property="og:url" content="https://example.com/og-url">
	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:title" content="TW title">
	<meta name="twitter:creator" content="@someone">
	<meta property="article:published_time" content="2024-03-01T10:00:00Z">
	<meta property="article:modified_time" content="2024-03-02T11:30:00Z">
	<meta name="author" content="Jane Doe">
	<link rel="canonical" href="/posts/1">
	<link rel="shortcut icon" href="/fav.png">
</head>
<body><h1>H1 title</h1><p>body</p></body>
</html>`;

Deno.test("metadata: a full realistic head", () => {
	const md = extractMetadata(FULL_HEAD, { url: "https://example.com/section/" });

	assertEquals(md.title, "OG title");
	assertEquals(md.description, "The real description");
	assertEquals(md.canonical, "https://example.com/posts/1");
	assertEquals(md.lang, "en");
	assertEquals(md.siteName, "Example Site");
	assertEquals(md.author, "Jane Doe");
	assertEquals(md.publishedAt, "2024-03-01T10:00:00.000Z");
	assertEquals(md.modifiedAt, "2024-03-02T11:30:00.000Z");
	assertEquals(md.image, "https://example.com/img/hero.png");
	assertEquals(md.favicon, "https://example.com/fav.png");
	assertEquals(md.type, "article");
});

Deno.test("metadata: og/twitter maps are split and prefix-stripped", () => {
	const md = extractMetadata(FULL_HEAD);

	assertEquals(md.openGraph.title, "OG title");
	assertEquals(md.openGraph["image:width"], "1200");
	assertEquals(md.openGraph.site_name, "Example Site");
	assertEquals(md.twitter.card, "summary_large_image");
	assertEquals(md.twitter.creator, "@someone");

	// no prefixed keys survive in the og/twitter maps...
	assert(!Object.keys(md.openGraph).some((k) => k.startsWith("og:")));
	assert(!Object.keys(md.twitter).some((k) => k.startsWith("twitter:")));
	// ...and og/twitter are not repeated in the generic map
	assert(
		!Object.keys(md.meta).some((k) =>
			k.startsWith("og:") || k.startsWith("twitter:")
		),
	);

	// `article:*` is a plain property meta, so it belongs to the generic map
	assertEquals(md.meta["article:published_time"], "2024-03-01T10:00:00Z");
	assertEquals(md.meta.author, "Jane Doe");
	// `<meta charset>` names nothing and is dropped
	assert(!("charset" in md.meta));
});

Deno.test("metadata: precedence", () => {
	const html = `<html><head>
		<title>Title element</title>
		<meta name="title" content="Explicit title">
		<meta property="og:title" content="OG title">
		<meta name="twitter:title" content="TW title">
		<meta name="description" content="Explicit description">
		<meta property="og:description" content="OG description">
		<meta name="twitter:description" content="TW description">
	</head><body><h1>H1</h1></body></html>`;
	const md = extractMetadata(html);
	assertEquals(md.title, "Explicit title");
	assertEquals(md.description, "Explicit description");
});

Deno.test("metadata: og beats twitter, twitter beats nothing", () => {
	const og = extractMetadata(
		`<html><head><meta property="og:description" content="OG"><meta name="twitter:description" content="TW"></head></html>`,
	);
	assertEquals(og.description, "OG");

	const tw = extractMetadata(
		`<html><head><meta name="twitter:description" content="TW"></head></html>`,
	);
	assertEquals(tw.description, "TW");
});

Deno.test("metadata: an empty content does not shadow a later source", () => {
	const md = extractMetadata(
		`<html><head><meta name="description" content=""><meta property="og:description" content="Real"></head></html>`,
	);
	assertEquals(md.description, "Real");
	assert(!("description" in md.meta));
});

Deno.test("metadata: uppercase attribute names", () => {
	const md = extractMetadata(
		`<HTML LANG="de"><HEAD>
			<META NAME="Description" CONTENT="Shouty description">
			<META PROPERTY="OG:TITLE" CONTENT="Shouty title">
			<LINK REL="CANONICAL" HREF="https://example.com/x">
		</HEAD></HTML>`,
	);
	assertEquals(md.description, "Shouty description");
	assertEquals(md.title, "Shouty title");
	assertEquals(md.openGraph.title, "Shouty title");
	assertEquals(md.canonical, "https://example.com/x");
	assertEquals(md.lang, "de");
});

Deno.test("metadata: first occurrence of a key wins", () => {
	const md = extractMetadata(
		`<html><head>
			<meta property="og:image" content="https://example.com/first.png">
			<meta property="og:image" content="https://example.com/second.png">
			<meta name="author" content="First">
			<meta name="author" content="Second">
		</head></html>`,
	);
	assertEquals(md.image, "https://example.com/first.png");
	assertEquals(md.openGraph.image, "https://example.com/first.png");
	assertEquals(md.author, "First");
});

Deno.test("metadata: a `value` attribute stands in for a missing `content`", () => {
	const md = extractMetadata(
		`<html><head><meta name="author" value="Jane"></head></html>`,
	);
	assertEquals(md.author, "Jane");
});

Deno.test("metadata: urls stay relative without a url option", () => {
	const md = extractMetadata(
		`<html><head><link rel="canonical" href="/posts/1"><meta property="og:image" content="img/hero.png"></head></html>`,
	);
	assertEquals(md.canonical, "/posts/1");
	assertEquals(md.image, "img/hero.png");
	assertEquals(md.favicon, undefined);
});

Deno.test("metadata: urls resolve against options.url", () => {
	const md = extractMetadata(
		`<html><head><link rel="canonical" href="/posts/1"><meta property="og:image" content="img/hero.png"></head></html>`,
		{ url: "https://example.com/deep/page.html" },
	);
	assertEquals(md.canonical, "https://example.com/posts/1");
	assertEquals(md.image, "https://example.com/deep/img/hero.png");
});

Deno.test("metadata: a document's own <base href> wins over options.url", () => {
	const md = extractMetadata(
		`<html><head><base href="https://cdn.example.com/assets/">
			<link rel="canonical" href="page.html">
			<meta property="og:image" content="hero.png">
		</head></html>`,
		{ url: "https://example.com/deep/page.html" },
	);
	assertEquals(md.canonical, "https://cdn.example.com/assets/page.html");
	assertEquals(md.image, "https://cdn.example.com/assets/hero.png");
});

Deno.test("metadata: favicon chain", () => {
	const shortcut = extractMetadata(
		`<html><head><link rel="shortcut icon" href="/s.ico"></head></html>`,
		{ url: "https://example.com/" },
	);
	assertEquals(shortcut.favicon, "https://example.com/s.ico");

	// rel=icon wins over apple-touch-icon regardless of document order
	const both = extractMetadata(
		`<html><head><link rel="apple-touch-icon" href="/apple.png"><link rel="icon" href="/i.png"></head></html>`,
	);
	assertEquals(both.favicon, "/i.png");

	const apple = extractMetadata(
		`<html><head><link rel="apple-touch-icon" href="/apple.png"></head></html>`,
	);
	assertEquals(apple.favicon, "/apple.png");

	const mask = extractMetadata(
		`<html><head><link rel="mask-icon" href="/m.svg"></head></html>`,
	);
	assertEquals(mask.favicon, "/m.svg");

	// the /favicon.ico guess only happens when we know where the document lives
	const guessed = extractMetadata("<html><head></head></html>", {
		url: "https://example.com/a/b/c",
	});
	assertEquals(guessed.favicon, "https://example.com/favicon.ico");
	assertEquals(extractMetadata("<html><head></head></html>").favicon, undefined);
});

Deno.test("metadata: title falls back to <title> then <h1>", () => {
	const t = extractMetadata(
		`<html><head><title>  Doc   title </title></head><body><h1>H1</h1></body></html>`,
	);
	assertEquals(t.title, "Doc title");

	const h1 = extractMetadata(`<div><h1>Just an h1</h1><h1>second</h1></div>`);
	assertEquals(h1.title, "Just an h1");
});

Deno.test("metadata: lang chain", () => {
	assertEquals(extractMetadata(`<html lang="cs"></html>`).lang, "cs");
	assertEquals(
		extractMetadata(
			`<html><head><meta http-equiv="content-language" content="sk"></head></html>`,
		).lang,
		"sk",
	);
	assertEquals(
		extractMetadata(
			`<html><head><meta property="og:locale" content="en_GB"></head></html>`,
		).lang,
		"en_GB",
	);
});

Deno.test("metadata: dates — ISO when parseable, raw when not", () => {
	const iso = extractMetadata(
		`<html><head><meta name="date" content="2024-03-01"></head></html>`,
	);
	assertEquals(iso.publishedAt, "2024-03-01T00:00:00.000Z");

	// kept verbatim rather than dropped: "Q3 2024" is still information
	const raw = extractMetadata(
		`<html><head><meta name="pubdate" content="Q3 2024"></head></html>`,
	);
	assertEquals(raw.publishedAt, "Q3 2024");

	const notEvenClose = extractMetadata(
		`<html><head><meta name="publish-date" content="whenever"></head></html>`,
	);
	assertEquals(notEvenClose.publishedAt, "whenever");

	const modified = extractMetadata(
		`<html><head><meta property="og:updated_time" content="2024-05-06T07:08:09Z"></head></html>`,
	);
	assertEquals(modified.modifiedAt, "2024-05-06T07:08:09.000Z");

	const itemprop = extractMetadata(
		`<html><head><meta itemprop="datePublished" content="2020-01-02"><meta itemprop="dateModified" content="2020-02-03"></head></html>`,
	);
	assertEquals(itemprop.publishedAt, "2020-01-02T00:00:00.000Z");
	assertEquals(itemprop.modifiedAt, "2020-02-03T00:00:00.000Z");
});

Deno.test("metadata: <time datetime> is the last resort for publishedAt", () => {
	const md = extractMetadata(
		`<article><time>no datetime</time><time datetime="2024-04-05">April 5</time></article>`,
	);
	assertEquals(md.publishedAt, "2024-04-05T00:00:00.000Z");
});

Deno.test("metadata: json-ld fills the gaps", () => {
	const block = JSON.stringify({
		"@context": "https://schema.org",
		"@type": "NewsArticle",
		headline: "JSON-LD headline",
		description: ["Array description", "second"],
		url: "/from-json-ld",
		image: { "@type": "ImageObject", name: "a caption", url: "/ld.png" },
		author: { "@type": "Person", name: "LD Author" },
		publisher: { "@type": "Organization", name: "LD Publisher" },
		datePublished: "2021-06-07T08:09:10Z",
		dateModified: "2021-06-08T08:09:10Z",
	});
	const md = extractMetadata(
		`<html><head><script type="application/ld+json">${block}</script></head><body></body></html>`,
		{ url: "https://example.com/" },
	);

	assertEquals(md.title, "JSON-LD headline");
	assertEquals(md.description, "Array description");
	assertEquals(md.canonical, "https://example.com/from-json-ld");
	assertEquals(md.image, "https://example.com/ld.png");
	assertEquals(md.author, "LD Author");
	assertEquals(md.siteName, "LD Publisher");
	assertEquals(md.publishedAt, "2021-06-07T08:09:10.000Z");
	assertEquals(md.modifiedAt, "2021-06-08T08:09:10.000Z");
});

Deno.test("metadata: json-ld content nodes beat site-furniture nodes", () => {
	const org = JSON.stringify({ "@type": "Organization", name: "Publisher Inc" });
	const post = JSON.stringify({
		"@graph": [{ "@type": ["Thing", "BlogPosting"], name: "Real post" }],
	});
	const html = `<html><head>
		<script type="application/ld+json">${org}</script>
		<script type="application/ld+json">${post}</script>
	</head></html>`;
	assertEquals(extractMetadata(html).title, "Real post");
});

// The regression the "content nodes beat furniture" test above does *not* catch: with
// only furniture present there is nothing to beat, and a chain that merely re-orders
// still falls through to it. On the CMS baseline of the web that is the normal case.
Deno.test("metadata: furniture-only json-ld never answers a generic key", () => {
	const org = JSON.stringify({
		"@context": "https://schema.org",
		"@type": "Organization",
		name: "ACME Corp",
		url: "https://acme.com/",
		description: "We make things",
		image: "https://acme.com/logo.png",
		publisher: { name: "ACME Holding" },
	});
	const html = `<html><head><title>How to bake bread — ACME Blog</title>
		<script type="application/ld+json">${org}</script>
		</head><body><h1>How to bake bread</h1></body></html>`;
	const md = extractMetadata(html, { url: "https://acme.com/posts/bread" });

	assertEquals(md.title, "How to bake bread — ACME Blog");
	// the damaging one: a crawler deduping on `canonical` must not collapse every page
	// of the site onto its homepage
	assertEquals(md.canonical, undefined);
	assertEquals(md.description, undefined);
	assertEquals(md.siteName, undefined);
	assertEquals(md.image, undefined);
});

Deno.test("metadata: the Yoast-shaped @graph is furniture too", () => {
	const graph = JSON.stringify({
		"@context": "https://schema.org",
		"@graph": [
			{ "@type": "WebSite", name: "ACME Blog", url: "https://acme.com/" },
			{ "@type": "BreadcrumbList", itemListElement: [] },
		],
	});
	const html = `<html><head><title>How to bake bread — ACME Blog</title>
		<script type="application/ld+json">${graph}</script>
		</head><body><h1>How to bake bread</h1></body></html>`;
	const md = extractMetadata(html, { url: "https://acme.com/posts/bread" });

	assertEquals(md.title, "How to bake bread — ACME Blog");
	assertEquals(md.canonical, undefined);
});

Deno.test("metadata: a node with no @type counts as furniture", () => {
	const html = `<html><head><title>Real title</title>
		<script type="application/ld+json">{"name":"Guessed","url":"/guessed"}</script>
		</head></html>`;
	const md = extractMetadata(html, { url: "https://example.com/page" });
	assertEquals(md.title, "Real title");
	assertEquals(md.canonical, undefined);
});

// The other half of the rule: keys only a creative work carries stay unrestricted, so a
// loosely-typed block still contributes what it unambiguously means.
Deno.test("metadata: unambiguous json-ld keys are read from any node", () => {
	const node = JSON.stringify({
		"@type": "Organization",
		name: "ACME Corp",
		headline: "The actual headline",
		author: { name: "Jane Doe" },
		datePublished: "2021-06-07T08:09:10Z",
		dateModified: "2021-06-08T08:09:10Z",
	});
	const html =
		`<html><head><title>T</title><script type="application/ld+json">${node}</script></head></html>`;
	const md = extractMetadata(html);

	assertEquals(md.title, "The actual headline");
	assertEquals(md.author, "Jane Doe");
	assertEquals(md.publishedAt, "2021-06-07T08:09:10.000Z");
	assertEquals(md.modifiedAt, "2021-06-08T08:09:10.000Z");
});

// The shape of tests/fixtures/product-jsonld: furniture first, content second, in one
// @graph. A Product *is* the page, so its generic keys must still win.
Deno.test("metadata: a content node later in the graph still answers", () => {
	const graph = JSON.stringify({
		"@graph": [
			{ "@type": "BreadcrumbList", itemListElement: [] },
			{ "@type": "WebSite", name: "Bergwerk", url: "https://shop.example/" },
			{
				"@type": "Product",
				name: "Klettersteigset Vertigo 2",
				url: "/p/vertigo-2",
				description: "Mit Bandfalldämpfer.",
			},
		],
	});
	const md = extractMetadata(
		`<html><head><title>Vertigo 2 | Bergwerk</title>
		<script type="application/ld+json">${graph}</script></head></html>`,
		{ url: "https://shop.example/p/vertigo-2" },
	);

	assertEquals(md.title, "Klettersteigset Vertigo 2");
	assertEquals(md.canonical, "https://shop.example/p/vertigo-2");
	assertEquals(md.description, "Mit Bandfalldämpfer.");
});

// `FAQPage`, `QAPage`, `CollectionPage`, … are all schema.org `WebPage`s: they describe
// this document, so the generic keys may be read off them.
Deno.test("metadata: every …Page type counts as content", () => {
	for (const type of ["WebPage", "FAQPage", "CollectionPage", "ProfilePage"]) {
		const node = JSON.stringify({ "@type": type, name: `${type} name` });
		const md = extractMetadata(
			`<html><head><title>T</title><script type="application/ld+json">${node}</script></head></html>`,
		);
		assertEquals(md.title, `${type} name`, `${type} should be content`);
	}
	// …but the site itself is not the page
	const site = JSON.stringify({ "@type": "WebSite", name: "WebSite name" });
	assertEquals(
		extractMetadata(
			`<html><head><title>T</title><script type="application/ld+json">${site}</script></head></html>`,
		).title,
		"T",
	);
});

Deno.test("metadata: the log names the source that won over furniture", () => {
	const org = JSON.stringify({ "@type": "Organization", name: "ACME Corp" });
	const { lines, logger } = recorder();
	extractMetadata(
		`<html><head><title>Real title</title><script type="application/ld+json">${org}</script></head></html>`,
		{ logger },
	);
	assert(lines.some((l) => l === "[html-extract] metadata: title from <title>"));
	assert(lines.some((l) => l.includes("node(s), 0 content-typed")));
});

Deno.test("metadata: odd json-ld shapes never throw", () => {
	const html = `<html><head>
		<script type="application/ld+json">[null, 42, "bare string", {"@type": "Article", "headline": 2024, "author": ["Solo"], "image": ["/a.png"]}]</script>
		<script type="application/ld+json">{ not json at all }</script>
	</head></html>`;
	const md = extractMetadata(html);
	assertEquals(md.title, "2024");
	assertEquals(md.author, "Solo");
	assertEquals(md.image, "/a.png");
});

Deno.test("metadata: json-ld is not parsed when the metas answer everything", () => {
	const complete = `<html lang="en"><head>
		<meta name="title" content="T"><meta name="description" content="D">
		<link rel="canonical" href="https://example.com/c">
		<meta property="og:site_name" content="S"><meta name="author" content="A">
		<meta property="article:published_time" content="2024-01-01">
		<meta property="article:modified_time" content="2024-01-02">
		<meta property="og:image" content="https://example.com/i.png">
		<link rel="icon" href="/f.ico">
		<script type="application/ld+json">{"@type":"Article","headline":"never read"}</script>
	</head></html>`;

	const eager = recorder();
	extractMetadata(complete, { logger: eager.logger });
	assert(
		!eager.lines.some((l) => l.includes("consulting json-ld")),
		`json-ld was consulted for a complete document:\n${eager.lines.join("\n")}`,
	);

	const lazy = recorder();
	// drop the description meta -> that one chain must reach json-ld
	extractMetadata(complete.replace(`<meta name="description" content="D">`, ""), {
		logger: lazy.logger,
	});
	assert(lazy.lines.some((l) => l.includes("consulting json-ld")));
});

Deno.test("metadata: the logger reports which source won", () => {
	const { lines, logger } = recorder();
	extractMetadata(FULL_HEAD, { logger, url: "https://example.com/" });
	assert(lines.some((l) => l === "[html-extract] metadata: title from og:title"));
	assert(lines.some((l) => l.includes("description from meta[name=description]")));
	assert(lines.some((l) => l.includes("meta tag(s) ->")));
});

Deno.test("metadata: empty input yields empty maps and nothing else", () => {
	const md = extractMetadata("");
	assertEquals(md, { openGraph: {}, twitter: {}, meta: {} });
	assertEquals(Object.keys(md).sort(), ["meta", "openGraph", "twitter"]);
});

Deno.test("metadata: absent fields are absent, not empty strings", () => {
	const md = extractMetadata(
		`<html><head><meta name="description" content="  "></head></html>`,
	);
	assertEquals(Object.keys(md).sort(), ["meta", "openGraph", "twitter"]);
	assertEquals(md.description, undefined);
});

Deno.test("metadata: malformed markup still yields what it can", () => {
	const md = extractMetadata(
		`<html><head><meta name=description content=unquoted><title>Broken<body><p>text<div><h1>Head`,
	);
	assertEquals(md.description, "unquoted");
	assert(md.title);
});

Deno.test("metadata: a document with no head at all", () => {
	const md = extractMetadata(
		`<p>lead</p><h1>The heading</h1><meta name="author" content="Body Meta">`,
	);
	assertEquals(md.title, "The heading");
	assertEquals(md.author, "Body Meta");
});

Deno.test("metadata: never throws on hostile input", () => {
	const inputs = [
		"",
		" ",
		"<",
		"<<<>>>",
		"  binary ￿   noise",
		"<meta",
		"<meta>",
		"<meta name>",
		'<meta name="" content="">',
		'<meta property="og:" content="x">',
		'<meta property="twitter:" content="x">',
		`<html><head><base href="::::"><link rel=canonical href="::: "></head></html>`,
		'<html><head><link rel="icon"></head></html>',
		"<div>".repeat(2000) + "hi" + "</div>".repeat(2000),
		"<html><head><script type='application/ld+json'>[[[[[</script></head></html>",
		'<meta name="date" content="not a date at all">',
		"</p></div></html>",
		"%PDF-1.4 \n%âãÏÓ",
	];
	for (const input of inputs) {
		const md = extractMetadata(input, { url: "https://example.com/" });
		assertEquals(typeof md.openGraph, "object");
		assertEquals(typeof md.twitter, "object");
		assertEquals(typeof md.meta, "object");
	}
});

Deno.test("metadata: a javascript: url is kept but warned about", () => {
	const { lines, logger } = recorder();
	const md = extractMetadata(
		`<html><head><link rel="canonical" href="javascript:alert(1)"></head></html>`,
		{ logger },
	);
	assertEquals(md.canonical, "javascript:alert(1)");
	assert(lines.some((l) => l.includes("is a script URL")));
});

Deno.test("metadata: a wrong argument type is a programmer error and throws", () => {
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractMetadata(null as any), TypeError);
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractMetadata(undefined as any), TypeError);
	// deno-lint-ignore no-explicit-any
	assertThrows(() => extractMetadata(123 as any), TypeError);
});

Deno.test("metadata: metadataFromDocument works on an already-parsed document", () => {
	const doc = parseDocument(FULL_HEAD);
	assert(doc);
	const md = metadataFromDocument(doc, { url: "https://example.com/section/" });
	assertEquals(md.title, "OG title");
	assertEquals(md.canonical, "https://example.com/posts/1");
	// same result as the public entry point
	assertEquals(md, extractMetadata(FULL_HEAD, { url: "https://example.com/section/" }));
});
