import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseDocument, serialize } from "../src/_dom.ts";
import { extractMainContent, mainContentFromDocument } from "../src/main-content.ts";
import type { MainContentOptions } from "../src/types.ts";

// Main-content extraction is a heuristic, so every assertion here is deliberately FUZZY
// (design §11): the result must CONTAIN a known body phrase and EXCLUDE a known nav or
// footer phrase. Asserting exact output would pin the scoring constants in place and
// turn every tuning change into a test rewrite.

const NAV = `
<nav class="primary-nav">
	<a href="/">Home</a> <a href="/news">Newsroom and bulletins</a>
	<a href="/events">Events calendar</a> <a href="/about">About the institute</a>
	<a href="/contact">Contact the press office</a> <a href="/jobs">Vacancies</a>
	<a href="/donate">Support our work today</a>
</nav>`;

const FOOTER = `
<footer class="site-footer">
	<p>2024 The Institute. All rights reserved worldwide.</p>
	<a href="/terms">Terms of use</a> <a href="/privacy">Privacy notice</a>
</footer>`;

const P1 =
	`The survey ran for eleven weeks across four estuaries, and the counts were taken at
	slack water so that the birds were not being pushed off the mud by the tide. That
	single decision, unglamorous as it is, explains most of the difference between this
	year's figures and the ones published in 2019.`;

const P2 =
	`Numbers of wintering dunlin were up by a fifth, while the redshank count barely moved.
	The team is careful not to read a trend into two seasons, but the direction is at
	least consistent with what the ringing data has been saying since the cold winter.`;

const P3 =
	`What happens next depends almost entirely on whether the saltmarsh restoration at the
	head of the second estuary is funded for another three years. Without it, the newest
	roost sites are unlikely to persist beyond the next big storm surge.`;

Deno.test("semantic: <main> wins over a nav big enough to out-weigh it", () => {
	const html = `<!doctype html><html><body>
		${NAV}
		<main>
			<h1>Estuary bird counts, winter 2024</h1>
			<p>${P1}</p>
			<p>${P2}</p>
		</main>
		${FOOTER}
	</body></html>`;

	const content = extractMainContent(html);
	assert(content, "expected content");
	assertEquals(content.via, "semantic");
	assertStringIncludes(content.text(), "slack water");
	assert(!content.text().includes("Support our work today"), "nav leaked in");
	assert(!content.text().includes("All rights reserved"), "footer leaked in");
	// the winning element is a real one, so its own tag is part of the serialization
	assertStringIncludes(content.html, "<main>");
	assert(content.linkDensity < 0.1, `link density too high: ${content.linkDensity}`);
	assert(content.textLength > 200, `text too short: ${content.textLength}`);
});

Deno.test("semantic: the longest <article> wins on a page of teasers", () => {
	const html = `<!doctype html><html><body>
		<article class="teaser"><h2>Short teaser one</h2><p>A sentence or two only.</p></article>
		<article class="post"><h1>The real post</h1><p>${P1}</p><p>${P2}</p></article>
		<article class="teaser"><h2>Short teaser two</h2><p>Also very short indeed.</p></article>
	</body></html>`;

	const content = extractMainContent(html)!;
	assertEquals(content.via, "semantic");
	assertStringIncludes(content.text(), "The real post");
	assert(!content.text().includes("Short teaser one"), "a teaser leaked in");
});

Deno.test("semantic: an empty <main> shell falls through to scoring", () => {
	const html = `<!doctype html><html><body>
		<main id="app"></main>
		<div id="layout">
			<div class="entry-body"><p>${P1}</p><p>${P2}</p></div>
		</div>
	</body></html>`;

	const content = extractMainContent(html)!;
	assertEquals(content.via, "scored");
	assertStringIncludes(content.text(), "slack water");
});

Deno.test("semantic: minTextLength decides where the fall-through happens", () => {
	const html = `<!doctype html><html><body>
		<main><p>A short but real sentence of main content, about ninety characters long here.</p></main>
		<div class="entry-body"><p>${P1}</p><p>${P2}</p></div>
	</body></html>`;

	// the default (140) is above the <main> text, so scoring takes over
	assertEquals(extractMainContent(html)!.via, "scored");
	// lowered, the semantic markup is trusted again
	const low = extractMainContent(html, { minTextLength: 40 })!;
	assertEquals(low.via, "semantic");
	assertStringIncludes(low.text(), "ninety characters");
});

Deno.test("selector: the override wins over everything, short or not", () => {
	const html = `<!doctype html><html><body>
		${NAV}
		<main><h1>The heuristic answer</h1><p>${P1}</p><p>${P2}</p></main>
		<div id="editors-note"><p>A brief note from the editor.</p></div>
	</body></html>`;

	const content = extractMainContent(html, { selector: "#editors-note" })!;
	assertEquals(content.via, "selector");
	assertStringIncludes(content.text(), "brief note from the editor");
	assert(!content.text().includes("slack water"), "the heuristic answer leaked in");
	// no minimum length is applied on this path — the caller asked for it explicitly
	assert(
		content.textLength < 140,
		`expected a short result, got ${content.textLength}`,
	);
});

Deno.test("selector: a non-matching or invalid selector falls through, never throws", () => {
	const html = `<!doctype html><html><body>
		<main><h1>Estuary bird counts</h1><p>${P1}</p><p>${P2}</p></main>
	</body></html>`;

	assertEquals(extractMainContent(html, { selector: "#nope" })!.via, "semantic");
	assertEquals(extractMainContent(html, { selector: ">>>((" })!.via, "semantic");
	assertEquals(extractMainContent(html, { selector: "" })!.via, "semantic");
});

Deno.test("scored: a div-soup article is recovered, with its lead paragraph", () => {
	const html = `<!doctype html><html><body>
		${NAV}
		<div id="layout">
			<p class="lead">The counts were taken at slack water across four separate estuaries
				over eleven weeks, which is the detail that matters most here.</p>
			<div class="entry-body">
				<p>${P2}</p>
				<p>${P3}</p>
			</div>
			<div class="promo-box">
				<p>Subscribe to our newsletter and never miss another bulletin from us.</p>
				<a href="/subscribe">Sign up now</a>
			</div>
		</div>
		${FOOTER}
	</body></html>`;

	const content = extractMainContent(html)!;
	assertEquals(content.via, "scored");
	// the scored container is assembled by this package, so the wrapper the winner
	// happened to share with its siblings is not part of the output
	assert(!content.html.includes(`id="layout"`), "the assembled wrapper leaked out");

	const text = content.text();
	assertStringIncludes(text, "wintering dunlin");
	assertStringIncludes(text, "saltmarsh restoration");
	// the sibling <p> rule is what recovers a lead paragraph outside the body div
	assertStringIncludes(text, "slack water across four separate estuaries");
	assert(!text.includes("Support our work today"), "nav leaked in");
	assert(!text.includes("All rights reserved"), "footer leaked in");
	assert(!text.includes("Subscribe to our newsletter"), "promo box leaked in");
});

Deno.test("scored: a nav-only page is legitimately null", () => {
	const html = `<!doctype html><html><body>
		<header><a href="/">Northfield Parish Council</a></header>
		<div class="wrap">
			<h1>Sitemap</h1>
			<ul class="sitemap">
				<li><a href="/council">The council and its members</a></li>
				<li><a href="/council/minutes">Minutes of every meeting</a></li>
				<li><a href="/planning">Planning applications and appeals</a></li>
				<li><a href="/allotments">Allotments and the waiting list</a></li>
				<li><a href="/burial-ground">The burial ground and its records</a></li>
				<li><a href="/village-hall">Village hall bookings and hire rates</a></li>
			</ul>
		</div>
		${FOOTER}
	</body></html>`;

	assertEquals(extractMainContent(html), null);
});

Deno.test("scored: a page with nothing in it at all is null", () => {
	assertEquals(extractMainContent("<html><body><div></div></body></html>"), null);
	assertEquals(extractMainContent("<p>too short</p>"), null);
});

Deno.test("markdown() and text() are lazy and memoized", () => {
	const html = `<!doctype html><html><body>
		<main><h1>Estuary bird counts</h1><p>${P1}</p><p>${P2}</p></main>
	</body></html>`;

	// the render option objects are only read when a renderer actually runs, so a getter
	// on them counts renders exactly
	let markdownReads = 0;
	let textReads = 0;
	const options: MainContentOptions = {
		get markdown() {
			markdownReads++;
			return {};
		},
		get text() {
			textReads++;
			return {};
		},
	};

	const content = extractMainContent(html, options)!;
	assertEquals(markdownReads, 0, "markdown was rendered without being asked for");
	assertEquals(textReads, 0, "text was rendered without being asked for");
	assert(content.textLength > 0);
	assertEquals(content.linkDensity, 0);

	const md = content.markdown();
	assertEquals(markdownReads, 1);
	assertEquals(textReads, 0, "asking for markdown must not render text");
	assertEquals(content.markdown(), md);
	assertEquals(content.markdown(), md);
	assertEquals(markdownReads, 1, "markdown was re-rendered on a second call");

	const txt = content.text();
	assertEquals(textReads, 1);
	assertEquals(content.text(), txt);
	assertEquals(textReads, 1, "text was re-rendered on a second call");

	assertStringIncludes(md, "# Estuary bird counts");
	assertStringIncludes(txt, "slack water");
});

Deno.test("toJSON() materializes both renderings and survives JSON.stringify", () => {
	const html = `<!doctype html><html><body>
		<main><h1>Estuary bird counts</h1><p>${P1}</p>
		<p>See the <a href="/methods">methods note</a> for the full protocol details.</p></main>
	</body></html>`;

	const content = extractMainContent(html, { url: "https://institute.example/birds" })!;
	const json = content.toJSON();
	assertStringIncludes(json.markdown, "# Estuary bird counts");
	assertStringIncludes(json.text, "slack water");
	assertStringIncludes(json.html, "<main>");
	assertEquals(json.textLength, content.textLength);
	assertEquals(json.linkDensity, content.linkDensity);
	assertEquals(json.via, "semantic");
	// url is forwarded, so links resolve in the markdown
	assertStringIncludes(json.markdown, "https://institute.example/methods");

	// the whole point: methods do not survive a JSONB round trip, values do
	const round = JSON.parse(JSON.stringify(content)) as typeof json;
	assertEquals(round, json);
	assertEquals(typeof round.markdown, "string");
	assertEquals(typeof round.text, "string");
});

Deno.test("<base href> beats options.url when resolving markdown links", () => {
	const html =
		`<!doctype html><html><head><base href="https://docs.example/api/"></head>
	<body><main><h1>Rate limiting</h1><p>${P1}</p>
	<p>See the <a href="errors">error reference</a> for the rest of it.</p></main></body></html>`;

	const md = extractMainContent(html, { url: "https://mirror.example/x" })!.markdown();
	assertStringIncludes(md, "https://docs.example/api/errors");
});

Deno.test("the caller's document is never mutated", () => {
	const html = `<!doctype html><html><body>
		${NAV}
		<main><h1>Estuary bird counts</h1><p>${P1}</p><p>${P2}</p></main>
		${FOOTER}
		<script type="application/ld+json">{"@type":"Article"}</script>
	</body></html>`;

	const doc = parseDocument(html)!;
	const before = serialize(doc.body);
	const content = mainContentFromDocument(doc, { selector: "main" })!;
	assertEquals(content.via, "selector");
	assertEquals(serialize(doc.body), before, "extraction rewrote the shared tree");

	// and again through the scoring path, which strips far more
	const doc2 = parseDocument(html)!;
	const before2 = serialize(doc2.body);
	assertEquals(mainContentFromDocument(doc2, { selector: "#nope" })!.via, "semantic");
	assertEquals(serialize(doc2.body), before2, "scoring rewrote the shared tree");

	// and what the other extractors depend on is still there afterwards
	const doc3 = parseDocument(html)!;
	mainContentFromDocument(doc3, { minTextLength: 100_000 });
	assert(
		doc3.root.querySelector("script"),
		"the <script> was removed from the original",
	);
	assert(doc3.body.querySelector("nav.primary-nav"), "the <nav> was removed");
	assert(doc3.body.querySelector("footer"), "the <footer> was removed");
});

Deno.test("never throws: empty, broken, hostile and pathological input", () => {
	const inputs = [
		"",
		" ",
		"<",
		"<<<>>>",
		"<html",
		"<div><p>unclosed",
		"<!doctype html><html><body><main>",
		"  binary noise �  ",
		"<p>a</p>".repeat(5000),
		"<div>".repeat(4000) + "text" + "</div>".repeat(4000),
		`<a href="javascript:alert(1)">x</a>`,
		"<table><tr><td>only a cell</td></tr>",
	];
	for (const input of inputs) {
		const content = extractMainContent(input, { url: "https://example.com/" });
		// null is fine; anything else must still be coherent
		if (content) {
			assertEquals(typeof content.html, "string");
			assertEquals(typeof content.markdown(), "string");
			assertEquals(typeof content.text(), "string");
			assert(content.textLength >= 0);
			assert(content.linkDensity >= 0 && content.linkDensity <= 1);
		}
	}

	// an unparseable selector over odd input is still not an error
	assertEquals(extractMainContent("<div>x</div>", { selector: "[[[" }), null);
});

Deno.test("a wrong argument TYPE is a programmer error and does throw", () => {
	// deno-lint-ignore no-explicit-any
	const bad = extractMainContent as any;
	assertThrows(() => bad(undefined), TypeError, "extractMainContent");
	assertThrows(() => bad(null), TypeError);
	assertThrows(() => bad(123), TypeError);
	assertThrows(() => bad(["<p>x</p>"]), TypeError);
});

Deno.test("a logger explains the outcome without changing it", () => {
	const html = `<!doctype html><html><body>
		${NAV}
		<div id="layout"><div class="entry-body"><p>${P1}</p><p>${P2}</p></div></div>
	</body></html>`;

	const lines: string[] = [];
	const logger = {
		debug: (...a: unknown[]) => lines.push(`debug ${a.join(" ")}`),
		log: (...a: unknown[]) => lines.push(`log ${a.join(" ")}`),
		warn: (...a: unknown[]) => lines.push(`warn ${a.join(" ")}`),
		error: (...a: unknown[]) => lines.push(`error ${a.join(" ")}`),
	};

	const quiet = extractMainContent(html);
	const loud = extractMainContent(html, { logger });
	assertEquals(loud!.html, quiet!.html);
	assertEquals(loud!.via, quiet!.via);

	assert(lines.length > 0, "a logger was injected but nothing was logged");
	assert(
		lines.every((l) => l.includes("[html-extract]")),
		"every log line must be namespaced",
	);
	assert(
		lines.some((l) => l.includes("via=scored")),
		"the winning strategy must be logged",
	);
	assert(
		lines.some((l) => l.includes("candidate(s)")),
		"the number of scored candidates must be logged",
	);

	// and a null outcome says so, at debug
	lines.length = 0;
	extractMainContent(`<html><body><nav><a href="/">x</a></nav></body></html>`, {
		logger,
	});
	assert(
		lines.some((l) => l.startsWith("debug") && l.includes("none found")),
		"a null result must be explained at debug",
	);
});

Deno.test("scored: an article survives the wrapper divs a page builder puts around it", () => {
	// Gutenberg group blocks and Elementor widgets wrap EVERY paragraph in two <div>s of
	// their own, which puts the real container three or more generations above the text.
	// Points used to stop at the grandparent, so the container scored nothing at all —
	// not even its `entry-content` hint, which is only consulted for elements that scored
	// — and the winner was the innermost wrapper around a single paragraph.
	const paragraphs = [P1, P2, P3, P1, P2, P3];

	for (const depth of [0, 1, 2, 3, 4]) {
		const blocks = paragraphs
			.map((p) => {
				let block = `<p>${p}</p>`;
				for (let i = 0; i < depth; i++) {
					block = `<div class="wp-block-group__inner-container">${block}</div>`;
				}
				return block;
			})
			.join("\n");
		const html = `<!doctype html><html><body>
			<div class="entry-content">${blocks}</div>
		</body></html>`;

		const content = extractMainContent(html);
		assert(content, `depth ${depth}: expected content`);
		assertEquals(content.via, "scored", `depth ${depth}`);
		const text = content.text();
		assertStringIncludes(text, "slack water");
		assertStringIncludes(text, "wintering dunlin");
		assertStringIncludes(text, "saltmarsh restoration");
		// the whole article, not the one paragraph that happened to sit in the
		// best-scoring leaf wrapper
		assert(
			content.textLength > 1200,
			`depth ${depth}: only ${content.textLength} chars came back`,
		);
	}
});

Deno.test("scored: a comment thread does not pay the shell that contains it", () => {
	// The other half of the longer ancestor reach. `<div id="page">` is the standard
	// WordPress theme wrapper and `page` is a POSITIVE hint, so the shell starts 25 points
	// ahead; let the thread's paragraphs go on paying it and the shell out-scores the
	// article, taking every comment with it. Propagation stops at the first ancestor the
	// class/id vocabulary calls chrome.
	const comments = Array.from(
		{ length: 12 },
		(_, i) =>
			`<div class="comment"><p>Commenter ${i} is quite sure the tide tables were read
			the wrong way round, and says so at considerable length below.</p></div>`,
	).join("");

	const body = [P1, P2, P3]
		.map((p) =>
			`<div class="wp-block-group"><div class="wp-block-group__inner-container">` +
			`<p>${p}</p></div></div>`
		)
		.join("");

	const html = `<!doctype html><html><body>
		<div id="page"><div id="wrap">
			<div class="entry-content">${body}</div>
			<div id="comments">${comments}</div>
		</div></div>
	</body></html>`;

	const content = extractMainContent(html);
	assert(content, "expected content");
	const text = content.text();
	assertStringIncludes(text, "slack water");
	assertStringIncludes(text, "saltmarsh restoration");
	assert(!text.includes("Commenter 0"), "the comment thread leaked in");
	assert(!text.includes("Commenter 11"), "the comment thread leaked in");
});

Deno.test("scored: nested candidates do not make scoring quadratic", () => {
	// A document whose </div>s were lost nests every block inside every earlier one, so
	// every candidate is an ancestor of every later one. Measuring link density per
	// candidate walked that candidate's whole subtree twice, which made the phase
	// O(depth x document): 4000 blocks took 19.6 s and quadrupled on every doubling,
	// against 36 ms for toText() on the same input. One bottom-up pass makes it linear.
	// Broken markup is a first-class input here, so this is a real page, not a fuzz case.
	const parts: string[] = [];
	for (let i = 0; i < 4000; i++) {
		parts.push(`<div class="mod"><div class="inner"><p>${P1}</p>`);
	}
	const html = `<!doctype html><html><body>${parts.join("")}</body></html>`;

	const started = performance.now();
	const content = extractMainContent(html);
	const elapsed = performance.now() - started;

	assert(content, "expected content");
	assertStringIncludes(content.text(), "slack water");
	// deliberately generous: this is a complexity guard, not a benchmark. It runs in
	// ~0.3 s now and took ~20 s before, so a slow machine has an order of magnitude of
	// room and a reintroduced quadratic still fails.
	assert(
		elapsed < 6000,
		`scoring took ${
			elapsed.toFixed(0)
		} ms on 4000 nested blocks — it is quadratic again`,
	);
});

Deno.test("semantic: [role=main] is found however the attribute is spelled", () => {
	// The selector engine matches attribute NAMES case-sensitively, so `[role=main]` used
	// to miss <div ROLE="main"> and the page fell all the way through to scoring, which
	// picked the comment thread. This is the quirk _dom.ts's attr() exists for.
	const thread = Array.from(
		{ length: 12 },
		(_, i) =>
			`<div class="post"><p>Commenter ${i} wrote a long reply about the tides, the
			weather, and the birds that were not there.</p></div>`,
	).join("");

	for (const spelling of ['role="main"', 'ROLE="main"', 'Role="Main"']) {
		const html = `<!doctype html><html><body>
			<div ${spelling}><h1>Estuary bird counts</h1><p>${P1}</p><p>${P2}</p></div>
			<div class="thread">${thread}</div>
		</body></html>`;

		const content = extractMainContent(html);
		assert(content, `${spelling}: expected content`);
		assertEquals(content.via, "semantic", spelling);
		assertStringIncludes(content.text(), "slack water");
		assert(!content.text().includes("Commenter 0"), `${spelling}: the thread won`);
	}
});

Deno.test("html carries the winning element's own tag on the scored path too", () => {
	// The docs used to claim the opposite. `assemble()` serializes the winner itself (plus
	// any accepted siblings) and only the synthetic re-parse container is stripped, so a
	// caller who wraps `html` in a container of their own gets a doubled wrapper.
	const html = `<!doctype html><html><body>
		<div id="layout">
			<div class="entry-body"><p>${P1}</p><p>${P2}</p><p>${P3}</p></div>
		</div>
	</body></html>`;

	const content = extractMainContent(html)!;
	assertEquals(content.via, "scored");
	assertStringIncludes(content.html, `<div class="entry-body">`);
	// …but the parent it was lifted out of is not part of the output
	assert(!content.html.includes(`id="layout"`), "the assembled wrapper leaked out");

	// the one documented exception: a winner that IS the body has no tag worth emitting
	const bare = `<!doctype html><html><body>
		<p>${P1}</p><p>${P2}</p><p>${P3}</p>
	</body></html>`;
	const flat = extractMainContent(bare)!;
	assertEquals(flat.via, "scored");
	assert(!flat.html.includes("<body"), "the body tag leaked into html");
	assertStringIncludes(flat.html, "<p>");
});
