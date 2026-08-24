/**
 * MCP tools exposed by `@marianmeres/html-extract`.
 *
 * Discovered and namespaced by the central `@marianmeres/mcp-server`. Every tool here
 * runs the real library against a document the caller supplies — none of them fetches
 * anything, and the only side effect any of them has is reading a local file when
 * `path` is used instead of `html`.
 *
 * The theme is *explaining* extraction rather than performing it: this package's
 * hardest question is "why did I get this?", and every tool answers a version of it by
 * capturing the library's own `debug` trail instead of paraphrasing what the code is
 * believed to do.
 *
 * @module
 */

import { z } from "npm:zod";
import type { McpToolDefinition } from "jsr:@marianmeres/mcp-server/types";
import { parseDocument, queryAll, text as nodeText } from "./src/_dom.ts";
import { collapseWs, linkDensity, textLength } from "./src/_util.ts";
import {
	extract,
	extractMainContent,
	extractMetadata,
	pick,
	toMarkdown,
	toText,
} from "./src/mod.ts";
import type { Logger, MicrodataItem } from "./src/types.ts";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * A `Logger` that keeps every line instead of writing it.
 *
 * This is what makes the tools trustworthy: they report the library's own decisions,
 * verbatim, rather than a second implementation of the precedence rules that could
 * quietly drift away from the first.
 */
function recorder(): { logger: Logger; lines: string[] } {
	const lines: string[] = [];
	const push = (level: string) => (...args: unknown[]) => {
		lines.push(`${level} ${args.map((a) => String(a)).join(" ")}`);
	};
	return {
		lines,
		logger: {
			debug: push("debug"),
			log: push("log "),
			warn: push("warn"),
			error: push("error"),
		},
	};
}

/** Reads the document from an inline string or a local file. Exactly one is required. */
async function loadHtml(args: Record<string, unknown>): Promise<string> {
	const html = typeof args.html === "string" ? args.html : undefined;
	const path = typeof args.path === "string" ? args.path : undefined;
	if (html && path) {
		throw new Error("pass either `html` or `path`, not both");
	}
	if (path) {
		try {
			return await Deno.readTextFile(path);
		} catch (e) {
			throw new Error(
				`could not read ${path}: ${e instanceof Error ? e.message : e}`,
			);
		}
	}
	if (html === undefined) throw new Error("one of `html` or `path` is required");
	return html;
}

/** Cuts a string to `max`, appending a note about what was dropped. */
function truncate(value: string, max: number): string {
	if (max <= 0 || value.length <= max) return value;
	return `${value.slice(0, max)}\n… [${value.length - max} more chars]`;
}

/** One-line preview of a chunk of text. */
function snippet(value: string, max = 120): string {
	const flat = collapseWs(value);
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** `key: value` lines, aligned, skipping absent values. */
function fields(rows: Array<[string, unknown]>): string {
	const present = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
	if (!present.length) return "  (none)";
	const width = Math.max(...present.map(([k]) => k.length));
	return present
		.map(([k, v]) => `  ${k.padEnd(width)} : ${String(v)}`)
		.join("\n");
}

/** `@type` values found in a JSON-LD block, including inside a `@graph`. */
function jsonLdTypes(block: unknown): string[] {
	const out: string[] = [];
	const visit = (value: unknown, depth: number) => {
		if (!value || typeof value !== "object" || depth > 3) return;
		if (Array.isArray(value)) {
			for (const v of value) visit(v, depth + 1);
			return;
		}
		const node = value as Record<string, unknown>;
		const t = node["@type"];
		if (typeof t === "string") out.push(t);
		else if (Array.isArray(t)) out.push(...t.filter((x) => typeof x === "string"));
		if (node["@graph"]) visit(node["@graph"], depth + 1);
	};
	visit(block, 0);
	return out;
}

/** Short label for a microdata item. */
function microdataLabel(item: MicrodataItem): string {
	const type = item.type?.[0] ?? "(untyped)";
	const props = Object.keys(item.properties);
	return `${type} — ${props.length} prop(s): ${props.slice(0, 8).join(", ")}${
		props.length > 8 ? ", …" : ""
	}`;
}

// ---------------------------------------------------------------------------
// extract-preview
// ---------------------------------------------------------------------------

async function extractPreview(args: Record<string, unknown>): Promise<string> {
	const html = await loadHtml(args);
	const url = typeof args.url === "string" ? args.url : undefined;
	const trace = args.trace === true;
	const previewChars = typeof args.preview === "number" ? args.preview : 800;
	const { logger, lines } = recorder();

	const doc = extract(html, {
		url,
		logger,
		contentSelector: typeof args.contentSelector === "string"
			? args.contentSelector
			: undefined,
	});

	const m = doc.metadata;
	const out: string[] = [
		`# extract() — ${url ?? "no url given (relative links stay relative)"}`,
		`input: ${html.length} chars`,
		"",
		"## metadata",
		fields([
			["title", m.title],
			["description", m.description],
			["canonical", m.canonical],
			["lang", m.lang],
			["siteName", m.siteName],
			["author", m.author],
			["publishedAt", m.publishedAt],
			["modifiedAt", m.modifiedAt],
			["image", m.image],
			["favicon", m.favicon],
			["type", m.type],
		]),
	];

	const missing = ([
		["title", m.title],
		["description", m.description],
		["canonical", m.canonical],
		["lang", m.lang],
		["siteName", m.siteName],
		["author", m.author],
		["publishedAt", m.publishedAt],
		["modifiedAt", m.modifiedAt],
		["image", m.image],
		["favicon", m.favicon],
		["type", m.type],
	] as Array<[string, unknown]>).filter(([, v]) => v === undefined).map(([k]) => k);
	if (missing.length) out.push(`  not found: ${missing.join(", ")}`);

	out.push(
		"",
		fields([
			[
				"openGraph",
				`${Object.keys(m.openGraph).length} key(s)${
					Object.keys(m.openGraph).length
						? `: ${Object.keys(m.openGraph).join(", ")}`
						: ""
				}`,
			],
			[
				"twitter",
				`${Object.keys(m.twitter).length} key(s)${
					Object.keys(m.twitter).length
						? `: ${Object.keys(m.twitter).join(", ")}`
						: ""
				}`,
			],
			[
				"meta",
				`${Object.keys(m.meta).length} key(s)${
					Object.keys(m.meta).length
						? `: ${Object.keys(m.meta).join(", ")}`
						: ""
				}`,
			],
		]),
		"",
		"## structured data",
	);

	out.push(
		`  json-ld       : ${doc.jsonLd.length} block(s)${
			doc.jsonLd.length
				? ` — @type: ${
					doc.jsonLd.flatMap(jsonLdTypes).join(", ") || "(none declared)"
				}`
				: ""
		}`,
	);
	const blobs = Object.entries(doc.embeddedJson);
	out.push(
		`  embedded json : ${blobs.length} blob(s)${
			blobs.length
				? ` — ${
					blobs
						.map(([k, v]) =>
							`${k} (${
								v && typeof v === "object"
									? Object.keys(v as object).slice(0, 6).join(", ")
									: typeof v
							})`
						)
						.join("; ")
				}`
				: ""
		}`,
	);
	out.push(`  microdata     : ${doc.microdata.length} item(s)`);
	for (const item of doc.microdata.slice(0, 5)) {
		out.push(`      ${microdataLabel(item)}`);
	}

	out.push("", "## content");
	if (!doc.content) {
		out.push(
			"  null — no main content could be identified.",
			"  That is a legitimate outcome (a nav-only page, an unhydrated SPA shell).",
			"  Use the `diagnose-content` tool to see what the candidates looked like.",
		);
	} else {
		out.push(
			fields([
				["via", doc.content.via],
				["textLength", doc.content.textLength],
				["linkDensity", doc.content.linkDensity.toFixed(3)],
				["html", `${doc.content.html.length} chars`],
			]),
		);
		if (previewChars > 0) {
			out.push(
				"",
				"  markdown preview:",
				"",
				truncate(doc.content.markdown(), previewChars),
			);
		}
	}

	if (trace) {
		out.push("", "## decision trace", ...lines.map((l) => `  ${l}`));
	} else {
		out.push(
			"",
			`(${lines.length} log line(s) captured — pass trace: true to see which source ` +
				"won each field and which content strategy fired)",
		);
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
// diagnose-content
// ---------------------------------------------------------------------------

/** Selectors worth probing when the heuristic disappoints. Ordinary CMS vocabulary. */
const PROBE_SELECTORS: readonly string[] = [
	"main",
	"article",
	"[role=main]",
	"[itemprop=articleBody]",
	"#main",
	"#content",
	"#main-content",
	"#article",
	"#post",
	".main",
	".content",
	".main-content",
	".article",
	".article-body",
	".article-content",
	".post",
	".post-body",
	".post-content",
	".entry",
	".entry-content",
	".story",
	".story-body",
	".markdown-body",
	".prose",
];

interface Probe {
	selector: string;
	matches: number;
	textLength: number;
	linkDensity: number;
	score: number;
	preview: string;
}

async function diagnoseContent(args: Record<string, unknown>): Promise<string> {
	const html = await loadHtml(args);
	const url = typeof args.url === "string" ? args.url : undefined;
	const minTextLength = typeof args.minTextLength === "number"
		? args.minTextLength
		: undefined;
	const extra = typeof args.selectors === "string"
		? args.selectors.split(",").map((s) => s.trim()).filter(Boolean)
		: [];

	const { logger, lines } = recorder();
	const content = extractMainContent(html, { url, minTextLength, logger });

	const doc = parseDocument(html);
	const bodyText = doc ? textLength(doc.body) : 0;

	const probes: Probe[] = [];
	if (doc) {
		for (const selector of [...PROBE_SELECTORS, ...extra]) {
			const matches = queryAll(doc.body, selector);
			if (!matches.length) continue;
			// the largest match is the one a caller would mean by this selector
			let best = matches[0];
			let bestLen = textLength(best);
			for (const el of matches.slice(1)) {
				const len = textLength(el);
				if (len > bestLen) {
					best = el;
					bestLen = len;
				}
			}
			const density = linkDensity(best);
			probes.push({
				selector,
				matches: matches.length,
				textLength: bestLen,
				linkDensity: density,
				score: bestLen * (1 - density),
				preview: snippet(nodeText(best)),
			});
		}
	}
	probes.sort((a, b) => b.score - a.score);

	const out: string[] = [
		`# diagnose-content — ${url ?? "no url given"}`,
		`input: ${html.length} chars, body text: ${bodyText} chars`,
		"",
		"## what extractMainContent() actually did",
	];

	if (!content) {
		out.push(
			"  returned null — nothing cleared the bar.",
			"  Expected for a nav-only page or an unhydrated SPA shell; otherwise the",
			"  heuristic missed, and a contentSelector is the fix.",
		);
	} else {
		const coverage = bodyText ? (content.textLength / bodyText) * 100 : 0;
		out.push(
			fields([
				["via", content.via],
				[
					"textLength",
					`${content.textLength} (${coverage.toFixed(0)}% of body text)`,
				],
				["linkDensity", content.linkDensity.toFixed(3)],
				["preview", snippet(content.text())],
			]),
		);
		if (coverage < 25) {
			out.push(
				"  ⚠ under a quarter of the page's text — the pick may be a fragment of the",
				"    real article. Compare it with the candidates below.",
			);
		}
		if (content.linkDensity > 0.4) {
			out.push(
				"  ⚠ high link density — this looks more like navigation than prose.",
			);
		}
	}

	out.push("", "## candidate selectors present in this document");
	if (!probes.length) {
		out.push(
			"  none of the usual content selectors matched. The page is probably div soup;",
			"  scoring is the only route, or pass your own selectors to this tool.",
		);
	} else {
		out.push(
			"  ranked by textLength × (1 − linkDensity) — the same signal the scorer trusts",
			"",
		);
		for (const p of probes.slice(0, 10)) {
			out.push(
				`  ${p.selector}`,
				`      ${p.matches} match(es), ${p.textLength} chars, link density ${
					p.linkDensity.toFixed(3)
				}`,
				`      ${p.preview}`,
			);
		}
	}

	const top = probes[0];
	out.push("", "## recommendation");
	if (!top) {
		out.push("  Nothing to suggest — no common content container is present.");
	} else if (!content) {
		out.push(
			`  Try:  extract(html, { url, contentSelector: ${
				JSON.stringify(top.selector)
			} })`,
			`  (${top.textLength} chars, link density ${top.linkDensity.toFixed(3)})`,
		);
	} else if (top.score > content.textLength * (1 - content.linkDensity) * 1.3) {
		out.push(
			`  The automatic pick (via ${content.via}, ${content.textLength} chars) scores`,
			`  well below ${top.selector} (${top.textLength} chars). Consider:`,
			`      extract(html, { url, contentSelector: ${
				JSON.stringify(top.selector)
			} })`,
		);
	} else {
		out.push(
			`  The automatic pick looks right (via ${content.via}). No override needed.`,
		);
	}

	out.push("", "## decision trace", ...lines.map((l) => `  ${l}`));
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// convert-html
// ---------------------------------------------------------------------------

async function convertHtml(args: Record<string, unknown>): Promise<string> {
	const html = await loadHtml(args);
	const url = typeof args.url === "string" ? args.url : undefined;
	const format = args.format === "text" ? "text" : "markdown";
	const maxChars = typeof args.maxChars === "number" ? args.maxChars : 20_000;
	const mainOnly = args.mainContentOnly === true;

	if (mainOnly) {
		const content = extractMainContent(html, {
			url,
			markdown: {
				url,
				links: args.links as boolean | undefined,
				images: args.images as boolean | undefined,
				escape: args.escape as boolean | undefined,
				bullet: args.bullet as "-" | "*" | "+" | undefined,
			},
		});
		if (!content) {
			return "No main content could be identified, so there is nothing to convert.\n" +
				"Run `diagnose-content` to see the candidates, or set mainContentOnly: false " +
				"to convert the whole document.";
		}
		const body = format === "text" ? content.text() : content.markdown();
		return `(main content only, via ${content.via}, ${content.textLength} chars of text)\n\n${
			truncate(body, maxChars)
		}`;
	}

	const body = format === "text" ? toText(html) : toMarkdown(html, {
		url,
		links: args.links as boolean | undefined,
		images: args.images as boolean | undefined,
		escape: args.escape as boolean | undefined,
		bullet: args.bullet as "-" | "*" | "+" | undefined,
	});
	return truncate(body, maxChars);
}

// ---------------------------------------------------------------------------
// pick-fields
// ---------------------------------------------------------------------------

async function pickFields(args: Record<string, unknown>): Promise<string> {
	const html = await loadHtml(args);
	const raw = typeof args.selectors === "string" ? args.selectors : "";
	let map: Record<string, unknown>;
	try {
		map = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`\`selectors\` must be a JSON object, e.g. {"title":"h1","price":{"selector":".price","attr":"data-value"}} — ${
				e instanceof Error ? e.message : e
			}`,
		);
	}
	if (!map || typeof map !== "object" || Array.isArray(map)) {
		throw new Error(
			"`selectors` must be a JSON object mapping field name to selector",
		);
	}

	const { logger, lines } = recorder();
	const result = pick(html, map as Parameters<typeof pick>[1], {
		logger,
		maxAll: typeof args.maxAll === "number" ? args.maxAll : undefined,
		trim: typeof args.trim === "boolean" ? args.trim : undefined,
	}) as Record<string, unknown>;

	const empty = Object.keys(map).filter((k) => !(k in result));
	return [
		`# pick() — ${Object.keys(map).length} field(s)`,
		"",
		JSON.stringify(result, null, 2),
		"",
		empty.length
			? `Missing (selector matched nothing, or the attribute is absent): ${
				empty.join(", ")
			}`
			: "Every field matched.",
		"",
		"## trace",
		...lines.map((l) => `  ${l}`),
	].join("\n");
}

// ---------------------------------------------------------------------------
// metadata-precedence
// ---------------------------------------------------------------------------

/**
 * One markup source a metadata chain can read, plus the label
 * `src/metadata.ts` logs when that source wins.
 *
 * The labels are how {@linkcode metadataPrecedence} maps a trace line back to a
 * candidate; the *order* is never encoded here — it is derived by elimination, so it
 * cannot drift away from the implementation.
 */
interface Candidate {
	/** The exact source label `firstOf()` logs. */
	label: string;
	/** Markup to place in `<head>`. */
	head?: string;
	/** Markup to place in `<body>`. */
	body?: string;
	/** Attribute to put on `<html>`. */
	htmlAttr?: string;
}

const PROBE_URL = "https://probe.example/a/b";

const CANDIDATES: Record<string, Candidate[]> = {
	title: [
		{ label: "meta[name=title]", head: `<meta name="title" content="v-meta-title">` },
		{ label: "og:title", head: `<meta property="og:title" content="v-og-title">` },
		{
			label: "twitter:title",
			head: `<meta name="twitter:title" content="v-tw-title">`,
		},
		{
			label: "json-ld headline/name",
			head:
				`<script type="application/ld+json">{"@type":"Article","headline":"v-ld"}</script>`,
		},
		{ label: "<title>", head: `<title>v-title</title>` },
		{ label: "<h1>", body: `<h1>v-h1</h1>` },
	],
	description: [
		{
			label: "meta[name=description]",
			head: `<meta name="description" content="v-meta-desc">`,
		},
		{
			label: "og:description",
			head: `<meta property="og:description" content="v-og">`,
		},
		{
			label: "twitter:description",
			head: `<meta name="twitter:description" content="v-tw">`,
		},
		{
			label: "json-ld description",
			head:
				`<script type="application/ld+json">{"@type":"Article","description":"v-ld"}</script>`,
		},
	],
	canonical: [
		{
			label: "<link rel=canonical>",
			head: `<link rel="canonical" href="/v-canonical">`,
		},
		{ label: "og:url", head: `<meta property="og:url" content="/v-og-url">` },
		{
			label: "json-ld url",
			head:
				`<script type="application/ld+json">{"@type":"Article","url":"/v-ld"}</script>`,
		},
	],
	lang: [
		{ label: "<html lang>", htmlAttr: `lang="en-GB"` },
		{
			label: "meta[http-equiv=content-language]",
			head: `<meta http-equiv="content-language" content="fr-CA">`,
		},
		{ label: "og:locale", head: `<meta property="og:locale" content="de_AT">` },
	],
	siteName: [
		{
			label: "og:site_name",
			head: `<meta property="og:site_name" content="v-og-site">`,
		},
		{
			label: "meta[name=application-name]",
			head: `<meta name="application-name" content="v-app">`,
		},
		{
			label: "json-ld publisher",
			head:
				`<script type="application/ld+json">{"@type":"Article","publisher":{"name":"v-ld"}}</script>`,
		},
	],
	author: [
		{
			label: "meta[name=author]",
			head: `<meta name="author" content="v-meta-author">`,
		},
		{
			label: "article:author",
			head: `<meta property="article:author" content="v-article">`,
		},
		{
			label: "json-ld author",
			head:
				`<script type="application/ld+json">{"@type":"Article","author":{"name":"v-ld"}}</script>`,
		},
		{
			label: "twitter:creator",
			head: `<meta name="twitter:creator" content="@v-tw">`,
		},
	],
	publishedAt: [
		{
			label: "article:published_time",
			head:
				`<meta property="article:published_time" content="2024-01-01T00:00:00Z">`,
		},
		{ label: "meta[name=date]", head: `<meta name="date" content="2024-02-02">` },
		{
			label: "meta[name=pubdate]",
			head: `<meta name="pubdate" content="2024-03-03">`,
		},
		{
			label: "meta[name=publish-date]",
			head: `<meta name="publish-date" content="2024-04-04">`,
		},
		{
			label: "meta[itemprop=datePublished]",
			head: `<meta itemprop="datePublished" content="2024-05-05">`,
		},
		{
			label: "json-ld datePublished",
			head:
				`<script type="application/ld+json">{"@type":"Article","datePublished":"2024-06-06"}</script>`,
		},
		{ label: "<time datetime>", body: `<time datetime="2024-07-07">then</time>` },
	],
	modifiedAt: [
		{
			label: "article:modified_time",
			head:
				`<meta property="article:modified_time" content="2024-01-01T00:00:00Z">`,
		},
		{
			label: "og:updated_time",
			head: `<meta property="og:updated_time" content="2024-02-02T00:00:00Z">`,
		},
		{
			label: "meta[name=last-modified]",
			head: `<meta name="last-modified" content="2024-03-03">`,
		},
		{
			label: "meta[itemprop=dateModified]",
			head: `<meta itemprop="dateModified" content="2024-04-04">`,
		},
		{
			label: "json-ld dateModified",
			head:
				`<script type="application/ld+json">{"@type":"Article","dateModified":"2024-05-05"}</script>`,
		},
	],
	image: [
		{
			label: "og:image",
			head: `<meta property="og:image" content="/v-og-image.png">`,
		},
		{
			label: "og:image:url",
			head: `<meta property="og:image:url" content="/v-og-url.png">`,
		},
		{
			label: "twitter:image",
			head: `<meta name="twitter:image" content="/v-tw.png">`,
		},
		{
			label: "twitter:image:src",
			head: `<meta name="twitter:image:src" content="/v-tw-src.png">`,
		},
		{
			label: "<link rel=image_src>",
			head: `<link rel="image_src" href="/v-link.png">`,
		},
		{
			label: "json-ld image",
			head:
				`<script type="application/ld+json">{"@type":"Article","image":"/v-ld.png"}</script>`,
		},
	],
	favicon: [
		// `rel="shortcut icon"` is deliberately NOT a separate step — the rel test is
		// token-based, so the `icon` step catches it and document order decides
		{ label: "<link rel=icon>", head: `<link rel="icon" href="/v-icon.png">` },
		{
			label: "<link rel=apple-touch-icon>",
			head: `<link rel="apple-touch-icon" href="/v-apple.png">`,
		},
		{
			label: "<link rel=mask-icon>",
			head: `<link rel="mask-icon" href="/v-mask.svg">`,
		},
		{ label: "/favicon.ico guess" },
	],
	type: [
		{ label: "og:type", head: `<meta property="og:type" content="article">` },
	],
};

/** Assembles a probe document out of the candidates still in play. */
function probeDocument(candidates: Candidate[]): string {
	const attrs = candidates.map((c) => c.htmlAttr).filter(Boolean).join(" ");
	const head = candidates.map((c) => c.head).filter(Boolean).join("\n");
	const body = candidates.map((c) => c.body).filter(Boolean).join("\n");
	return `<!doctype html><html ${attrs}><head>\n${head}\n</head><body>\n${body}\n</body></html>`;
}

/**
 * Derives one field's precedence chain by elimination: build a document containing every
 * candidate, see which source the library reports, drop it, repeat.
 *
 * The order therefore comes out of `src/metadata.ts` itself rather than out of a table
 * here, which is the only way this tool can be relied on after someone reorders a chain.
 */
function deriveChain(field: string): { order: string[]; note?: string } {
	let remaining = [...(CANDIDATES[field] ?? [])];
	const order: string[] = [];

	while (remaining.length) {
		const { logger, lines } = recorder();
		extractMetadata(probeDocument(remaining), { url: PROBE_URL, logger });
		const line = lines.find((l) => l.includes(`metadata: ${field} from `));
		if (!line) {
			return {
				order,
				note: `stopped early: none of the remaining sources (${
					remaining.map((c) => c.label).join(", ")
				}) produced a value`,
			};
		}
		const source = line.slice(
			line.indexOf(`${field} from `) + `${field} from `.length,
		).trim();
		order.push(source);
		const next = remaining.filter((c) => c.label !== source);
		if (next.length === remaining.length) {
			return {
				order,
				note:
					`stopped: the implementation reported a source this tool does not know ` +
					`(${source}) — the probe table in mcp.ts needs updating`,
			};
		}
		remaining = next;
	}
	return { order };
}

// deno-lint-ignore require-await
async function metadataPrecedence(args: Record<string, unknown>): Promise<string> {
	const only = typeof args.field === "string" ? args.field : undefined;
	const names = only ? [only] : Object.keys(CANDIDATES);

	const out: string[] = [
		"# metadata precedence",
		"",
		"Derived by running the library against synthetic documents and eliminating the",
		"winner one step at a time — the order below comes from src/metadata.ts itself.",
		"",
	];

	for (const field of names) {
		if (!CANDIDATES[field]) {
			out.push(
				`## ${field}`,
				`  unknown field — known: ${Object.keys(CANDIDATES).join(", ")}`,
				"",
			);
			continue;
		}
		const { order, note } = deriveChain(field);
		out.push(`## ${field}`);
		out.push(...order.map((source, i) => `  ${i + 1}. ${source}`));
		if (note) out.push(`  (${note})`);
		out.push("");
	}

	out.push(
		'`rel` is matched by token, so <link rel="shortcut icon"> is caught by the `icon`',
		"step and document order decides between them.",
		'Values are trimmed and whitespace-collapsed; an absent field is `undefined`, never "".',
		"Dates are normalized to ISO 8601 when parseable and kept raw when not.",
		"canonical / image / favicon are resolved against the document's <base href> if it",
		"has one, otherwise against options.url. The /favicon.ico fallback only applies when",
		"options.url was given.",
	);
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// tool definitions
// ---------------------------------------------------------------------------

/** Params every document-taking tool shares. */
const documentParams = {
	html: z.string().optional().describe(
		"The HTML document or fragment, inline. Use this or `path`, not both",
	),
	path: z.string().optional().describe(
		"Path to a local HTML file to read instead of passing it inline. Better for " +
			"anything large",
	),
};

export const tools: McpToolDefinition[] = [
	{
		name: "extract-preview",
		description:
			"Run @marianmeres/html-extract's `extract()` over an HTML document and report " +
			"everything it found: normalized metadata (title, description, canonical, lang, " +
			"author, published/modified dates, image, favicon, OpenGraph and Twitter maps), " +
			"JSON-LD blocks with their @types, framework state blobs (__NEXT_DATA__, " +
			"__NUXT__, Apollo, Redux), microdata items, and the extracted main content with " +
			"its strategy, text length, link density and a markdown preview. Pass trace: " +
			"true to see the library's own decision log — which source won each metadata " +
			"field and which content strategy fired. Use this to find out what a page " +
			"actually yields before writing extraction code against it.",
		params: {
			...documentParams,
			url: z.string().optional().describe(
				"Absolute URL of the document. Resolves relative links/images and enables " +
					"the /favicon.ico fallback. Optional — everything works without it",
			),
			contentSelector: z.string().optional().describe(
				"Per-site override: if this CSS selector matches, its subtree IS the main " +
					"content and the scoring heuristic is skipped",
			),
			trace: z.boolean().optional().describe(
				"Include the captured [html-extract] debug log. Default false",
			),
			preview: z.number().int().min(0).optional().describe(
				"Characters of the content's markdown to include. 0 omits it. Default 800",
			),
		},
		handler: extractPreview,
	},

	{
		name: "diagnose-content",
		description:
			"Troubleshoot @marianmeres/html-extract's main-content extraction on a page it " +
			"gets wrong (or returns null for). Reports what `extractMainContent()` actually " +
			"did and why, then probes the document for the usual content containers (main, " +
			"article, [role=main], .post-content, .entry-content, .markdown-body, …), ranks " +
			"them by text length × (1 − link density), and recommends a `contentSelector` " +
			"when the automatic pick is clearly beaten. Use this before tuning anything: " +
			"main-content extraction is a heuristic, and the documented fix for a page it " +
			"misjudges is an explicit selector, not a code change.",
		params: {
			...documentParams,
			url: z.string().optional().describe("Absolute URL of the document. Optional"),
			minTextLength: z.number().int().min(0).optional().describe(
				"Minimum text length a candidate must have to be accepted. Default 140 — " +
					"lower it for short pages, raise it to reject SPA shells harder",
			),
			selectors: z.string().optional().describe(
				"Extra CSS selectors to probe, comma separated, on top of the built-in list",
			),
		},
		handler: diagnoseContent,
	},

	{
		name: "convert-html",
		description:
			"Convert an HTML document to GitHub-flavoured markdown or block-aware plain " +
			"text using @marianmeres/html-extract, optionally after stripping boilerplate " +
			"down to the main content. Renders from the parsed tree, so <pre>/<code> " +
			"whitespace survives exactly, tables become GFM only when rectangular (ragged " +
			"or colspan tables degrade to HTML passthrough), nested list indentation is " +
			'correct, and <div>a</div><div>b</div> yields "a\\nb" rather than "ab". Use ' +
			"for turning a saved page, an email body or a docs fragment into clean text.",
		params: {
			...documentParams,
			format: z.enum(["markdown", "text"]).optional().describe(
				'Output format. Default "markdown"',
			),
			mainContentOnly: z.boolean().optional().describe(
				"Extract the main content first and convert only that, dropping nav, " +
					"header, footer and sidebars. Default false (converts the whole document)",
			),
			url: z.string().optional().describe(
				"Absolute URL used to resolve relative href/src values",
			),
			links: z.boolean().optional().describe(
				"Emit [text](url) for links. Default true; false emits the text only",
			),
			images: z.boolean().optional().describe(
				"Emit ![alt](src) for images. Default true; false drops them",
			),
			escape: z.boolean().optional().describe(
				"Escape markdown-significant characters in text. Default true",
			),
			bullet: z.enum(["-", "*", "+"]).optional().describe(
				'Unordered list marker. Default "-"',
			),
			maxChars: z.number().int().min(0).optional().describe(
				"Truncate the output at this many characters. Default 20000",
			),
		},
		handler: convertHtml,
	},

	{
		name: "pick-fields",
		description:
			"Run @marianmeres/html-extract's `pick()` — a thin CSS-selector field picker — " +
			"against an HTML document, to check a selector map before committing it to " +
			"code. Text content by default, `attr` for an attribute, `all` for an array of " +
			"every match; a selector that matches nothing (or is invalid) yields undefined " +
			"rather than an error, and the result says which fields came back empty. " +
			"Deliberately thin: no nesting, no transforms, no conditionals.",
		params: {
			...documentParams,
			selectors: z.string().describe(
				"JSON object mapping field name to a selector or a spec, e.g. " +
					'{"title":"h1","price":{"selector":".price","attr":"data-value"},' +
					'"tags":{"selector":".tag","all":true}}',
			),
			maxAll: z.number().int().min(1).optional().describe(
				"Cap on the number of values returned for an `all` spec. Default 1000",
			),
			trim: z.boolean().optional().describe(
				"Default trim for specs that do not set it. Default true",
			),
		},
		handler: pickFields,
	},

	{
		name: "metadata-precedence",
		description:
			"Show the precedence chain @marianmeres/html-extract uses for each metadata " +
			"field — which <meta>, OpenGraph, Twitter, JSON-LD or document element wins, in " +
			"order — for title, description, canonical, lang, siteName, author, " +
			"publishedAt, modifiedAt, image, favicon and type. The order is derived by " +
			"running the library against synthetic probe documents and eliminating the " +
			"winner step by step, so it reflects the implementation rather than a copy of " +
			'it. Use it to answer "which meta tag do I need for X to be picked up?" or ' +
			'"why did the title come from OpenGraph instead of <title>?".',
		params: {
			field: z.string().optional().describe(
				"A single field to explain: title, description, canonical, lang, siteName, " +
					"author, publishedAt, modifiedAt, image, favicon, type. Omit for all",
			),
		},
		handler: metadataPrecedence,
	},
];
