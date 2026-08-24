/**
 * Document metadata — title, description, canonical, language, dates, images and icons
 * — read out of `<meta>`, `<link>`, a few document elements and, as a late fallback,
 * JSON-LD.
 *
 * This is the deterministic half of the package: no scoring, no judgment calls. Every
 * field is produced by a fixed precedence chain, spelled out on
 * {@linkcode extractMetadata} and implemented literally below, so "why did I get *this*
 * title?" is always answerable by reading one list — or, with a logger injected, by
 * reading the log, since every resolved field is reported together with the source that
 * won it.
 *
 * Two things here are deliberate and easy to undo by accident. Attributes are read
 * through {@linkcode attr}, never `getAttribute`, because real markup ships
 * `<META NAME="Description">` and the parser's own lookup is case-sensitive. And
 * JSON-LD is consulted lazily: a document whose metas answer everything must not pay
 * for parsing its `ld+json` blocks.
 *
 * @module
 */

import {
	attr,
	type DomElement,
	type ParsedDocument,
	parseDocument,
	query,
	queryAll,
	tag,
	text,
} from "./_dom.ts";
import {
	assertHtmlString,
	collapseWs,
	documentBase,
	isSuspiciousUrl,
	normalizeDate,
	resolveUrl,
} from "./_util.ts";
import { flattenJsonLd, jsonLdFromDocument } from "./json-ld.ts";
import type { Logger, Metadata, MetadataOptions } from "./types.ts";

// ---------------------------------------------------------------------------------
// the raw meta table
// ---------------------------------------------------------------------------------

/**
 * Attributes that can name a `<meta>`, in the order they are trusted.
 *
 * `property` first because OpenGraph and the `article:*` vocabulary use it and are the
 * more specific statement; `http-equiv` last because it is a transport header in
 * disguise and only rarely says anything about the document itself.
 */
const META_KEY_ATTRS = ["property", "name", "itemprop", "http-equiv"] as const;

/** The three maps of {@linkcode Metadata}, before any field is derived from them. */
interface MetaTable {
	openGraph: Record<string, string>;
	twitter: Record<string, string>;
	meta: Record<string, string>;
}

/**
 * Walks every `<meta>` in the document — `<head>` or not — and splits it into the
 * `og:`, `twitter:` and everything-else maps.
 *
 * The whole document is scanned rather than just `<head>`, because a `<meta>` that a
 * script injected, or that a broken template emitted after `<body>`, is still the
 * document's own statement about itself and the parser will happily have left it in the
 * body. First occurrence of a key wins: duplicated `og:image` is normal (multiple
 * candidate images), and the first one is the one every consumer of the protocol takes.
 */
function collectMetaTable(doc: ParsedDocument, logger?: Logger): MetaTable {
	const openGraph: Record<string, string> = {};
	const twitter: Record<string, string> = {};
	const meta: Record<string, string> = {};

	const elements = queryAll(doc.root, "meta", logger);
	let skipped = 0;

	for (const el of elements) {
		let key = "";
		for (const name of META_KEY_ATTRS) {
			const raw = attr(el, name);
			if (raw && raw.trim()) {
				key = raw.trim().toLowerCase();
				break;
			}
		}
		// `value` is not the spec's attribute, but enough CMS templates emit it that
		// honouring it costs nothing and rescues the odd document
		const value = (attr(el, "content") ?? attr(el, "value") ?? "").trim();
		if (!key || !value) {
			skipped++;
			continue;
		}

		let target: Record<string, string>;
		let prop: string;
		if (key.startsWith("og:")) {
			target = openGraph;
			prop = key.slice(3);
		} else if (key.startsWith("twitter:")) {
			target = twitter;
			prop = key.slice(8);
		} else {
			target = meta;
			prop = key;
		}
		// a bare `og:` prefix with nothing after it names nothing. `Object.hasOwn`
		// rather than `in`, so that a meta genuinely named `toString` is kept instead
		// of being mistaken for a duplicate of `Object.prototype`'s
		if (!prop || Object.hasOwn(target, prop)) continue;
		target[prop] = value;
	}

	const counts = `${Object.keys(openGraph).length} og, ` +
		`${Object.keys(twitter).length} twitter, ${Object.keys(meta).length} other`;
	logger?.debug(
		`[html-extract] metadata: ${elements.length} meta tag(s) -> ${counts}` +
			(skipped ? `, ${skipped} skipped (no key or no value)` : ""),
	);

	return { openGraph, twitter, meta };
}

// ---------------------------------------------------------------------------------
// document readers
// ---------------------------------------------------------------------------------

/**
 * The `rel` tokens of a `<link>`, lowercased.
 *
 * Token-based on purpose: `rel="shortcut icon"` declares *both* `shortcut` and `icon`,
 * so a substring test would also match `rel="icon-foo"` while a whole-string comparison
 * would miss the single most common favicon spelling on the web.
 */
function relTokens(el: DomElement): string[] {
	return (attr(el, "rel") ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
}

/** `href` of the first `<link>` carrying `rel` as one of its tokens. */
function linkHref(links: DomElement[], rel: string): string | undefined {
	for (const el of links) {
		if (!relTokens(el).includes(rel)) continue;
		const href = attr(el, "href");
		if (href && href.trim()) return href.trim();
	}
	return undefined;
}

/**
 * The document element, for reading `lang` off it.
 *
 * `parseDocument` normalizes fragments into a full document, so `doc.root` is `<html>`
 * in practice — the fallback query is there for the parser that one day disagrees.
 */
function htmlElement(doc: ParsedDocument, logger?: Logger): DomElement {
	if (tag(doc.root) === "html") return doc.root;
	return query(doc.root, "html", logger) ?? doc.root;
}

/**
 * Text of the document's `<title>`.
 *
 * `head title` is tried first because an inline `<svg><title>` is a tooltip, not the
 * document's title, and in a fragment without a `<head>` it would otherwise be the
 * first `title` element in document order.
 */
function titleElementText(doc: ParsedDocument, logger?: Logger): string {
	const el = query(doc.root, "head title", logger) ?? query(doc.root, "title", logger);
	return text(el);
}

/**
 * `datetime` of the first `<time>` that has one.
 *
 * The weakest publication-date signal there is — it may well be a comment timestamp or
 * an event date — which is why it sits at the very end of the `publishedAt` chain and
 * only ever runs when every meta and JSON-LD source came up empty.
 */
function firstTimeDatetime(doc: ParsedDocument, logger?: Logger): string | undefined {
	for (const el of queryAll(doc.root, "time", logger)) {
		const value = attr(el, "datetime");
		if (value && value.trim()) return value.trim();
	}
	return undefined;
}

// ---------------------------------------------------------------------------------
// json-ld readers
// ---------------------------------------------------------------------------------

/**
 * `@type` values that mark a JSON-LD node as *the page's content* rather than site
 * furniture (`Organization`, `BreadcrumbList`, `WebSite`, `SearchAction`, …).
 *
 * The `\w*article` shape is intentional: `NewsArticle`, `TechArticle` and
 * `ScholarlyArticle` are the same kind of thing as `Article`, and a list of literal
 * names would have to grow forever to keep up with schema.org.
 */
const JSON_LD_CONTENT_TYPE = /^(?:\w*article|blogposting|webpage|product|recipe|event)$/;

/** How deep a value read out of JSON-LD may nest before we stop looking. */
const JSON_LD_MAX_DEPTH = 3;

/** `true` when a node's `@type` (string or array) looks like page content. */
function looksLikeContent(node: Record<string, unknown>): boolean {
	const raw = node["@type"];
	const list = Array.isArray(raw) ? raw : [raw];
	return list.some(
		(v) => typeof v === "string" && JSON_LD_CONTENT_TYPE.test(v.trim().toLowerCase()),
	);
}

/**
 * Content-ish nodes first, everything else after, both in document order.
 *
 * Taking the first node blindly is the common bug: a page's first JSON-LD block is
 * routinely an `Organization` or a `BreadcrumbList`, and reading `name` off it would
 * title every article on the site after the publisher.
 */
function orderJsonLdNodes(
	nodes: Record<string, unknown>[],
): Record<string, unknown>[] {
	const content: Record<string, unknown>[] = [];
	const rest: Record<string, unknown>[] = [];
	for (const node of nodes) (looksLikeContent(node) ? content : rest).push(node);
	return [...content, ...rest];
}

/**
 * Reads a human-readable string out of an arbitrary JSON-LD value.
 *
 * Everything about this is defensive because JSON-LD in the wild is untyped data
 * written by templates: `headline` can be a string, an array of strings, a number, or
 * an `{"@value": …}` language wrapper, and `author` is as often an object as a string.
 * Anything else yields `undefined` rather than `"[object Object]"`.
 */
function jsonLdText(value: unknown, depth = 0): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (depth >= JSON_LD_MAX_DEPTH) return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = jsonLdText(item, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	if (value && typeof value === "object") {
		const node = value as Record<string, unknown>;
		return jsonLdText(node.name, depth + 1) ??
			jsonLdText(node["@value"], depth + 1) ??
			jsonLdText(node.url, depth + 1);
	}
	return undefined;
}

/**
 * Reads a URL out of an arbitrary JSON-LD value.
 *
 * Same shapes as {@linkcode jsonLdText}, but an object resolves through `url` /
 * `contentUrl` / `@id` instead of `name` — an `ImageObject`'s `name` is its caption,
 * and returning that as the page image would be silently wrong.
 */
function jsonLdUrl(value: unknown, depth = 0): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (depth >= JSON_LD_MAX_DEPTH) return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = jsonLdUrl(item, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	if (value && typeof value === "object") {
		const node = value as Record<string, unknown>;
		return jsonLdUrl(node.url, depth + 1) ??
			jsonLdUrl(node.contentUrl, depth + 1) ??
			jsonLdUrl(node["@id"], depth + 1);
	}
	return undefined;
}

/** First value any of `keys` yields, node by node, in {@linkcode orderJsonLdNodes} order. */
function readJsonLd(
	nodes: Record<string, unknown>[],
	keys: string[],
	read: (value: unknown) => string | undefined,
): string | undefined {
	for (const node of nodes) {
		for (const key of keys) {
			const found = read(node[key]);
			if (found) return found;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------------
// chains
// ---------------------------------------------------------------------------------

/** One step of a precedence chain: a label for the log, and how to read it. */
type ChainStep = [source: string, read: () => string | undefined];

/**
 * First step of the chain that yields a non-blank value, logging which one won.
 *
 * The steps are thunks so that an expensive late fallback — JSON-LD — is never
 * evaluated for a field an early `<meta>` already answered.
 */
function firstOf(
	field: string,
	chain: ChainStep[],
	logger?: Logger,
): string | undefined {
	for (const [source, read] of chain) {
		const value = read();
		if (typeof value === "string" && value.trim()) {
			logger?.debug(`[html-extract] metadata: ${field} from ${source}`);
			return value;
		}
	}
	return undefined;
}

/** Whitespace-collapsed text value, or `undefined` — never `""`. */
function asText(value: string | undefined): string | undefined {
	const collapsed = typeof value === "string" ? collapseWs(value) : "";
	return collapsed || undefined;
}

/**
 * Trims and resolves a URL-ish value against the document base.
 *
 * Whitespace is *not* collapsed the way it is for text: a URL with an interior space is
 * broken markup and mangling it further only hides that. Without a base the value stays
 * relative — dropping it would be strictly worse than returning what the document said.
 */
function asUrl(
	value: string | undefined,
	base: string | undefined,
	field: string,
	logger?: Logger,
): string | undefined {
	const resolved = resolveUrl(value, base);
	if (resolved && isSuspiciousUrl(resolved)) {
		logger?.warn(
			`[html-extract] metadata: ${field} is a script URL, keeping as-is: ${resolved}`,
		);
	}
	return resolved;
}

/** Fields of {@linkcode Metadata} that are plain optional strings. */
type MetadataField = Exclude<keyof Metadata, "openGraph" | "twitter" | "meta">;

/**
 * Extracts metadata from an already-parsed document.
 *
 * Internal counterpart of {@linkcode extractMetadata}, used by
 * {@linkcode "./extract.ts".extract} so the document is only parsed once — every
 * precedence chain, including the JSON-LD fallback, then runs against that single tree.
 */
export function metadataFromDocument(
	doc: ParsedDocument,
	options?: MetadataOptions,
): Metadata {
	const logger = options?.logger;
	const { openGraph, twitter, meta } = collectMetaTable(doc, logger);
	const base = documentBase(doc.root, options?.url);

	// `<link>`s are only collected if a chain actually reaches one
	let linkCache: DomElement[] | undefined;
	const links = (): DomElement[] => (linkCache ??= queryAll(doc.root, "link", logger));

	// JSON-LD is the last fallback before the document's own elements, so it is parsed,
	// flattened and ordered at most once, and only if some chain gets that far
	let nodeCache: Record<string, unknown>[] | undefined;
	const nodes = (): Record<string, unknown>[] => {
		if (!nodeCache) {
			nodeCache = orderJsonLdNodes(flattenJsonLd(jsonLdFromDocument(doc, options)));
			logger?.debug(
				`[html-extract] metadata: consulting json-ld (${nodeCache.length} node(s))`,
			);
		}
		return nodeCache;
	};
	const ldText = (...keys: string[]) => readJsonLd(nodes(), keys, jsonLdText);
	const ldUrl = (...keys: string[]) => readJsonLd(nodes(), keys, jsonLdUrl);

	const pick = (field: string, chain: ChainStep[]) => firstOf(field, chain, logger);

	const title = asText(pick("title", [
		["meta[name=title]", () => meta.title],
		["og:title", () => openGraph.title],
		["twitter:title", () => twitter.title],
		["json-ld headline/name", () => ldText("headline", "name")],
		["<title>", () => titleElementText(doc, logger)],
		["<h1>", () => text(query(doc.root, "h1", logger))],
	]));

	const description = asText(pick("description", [
		["meta[name=description]", () => meta.description],
		["og:description", () => openGraph.description],
		["twitter:description", () => twitter.description],
		["json-ld description", () => ldText("description")],
	]));

	const canonical = asUrl(
		pick("canonical", [
			["<link rel=canonical>", () => linkHref(links(), "canonical")],
			["og:url", () => openGraph.url],
			["json-ld url", () => ldUrl("url")],
		]),
		base,
		"canonical",
		logger,
	);

	const lang = asText(pick("lang", [
		["<html lang>", () => attr(htmlElement(doc, logger), "lang")],
		["meta[http-equiv=content-language]", () => meta["content-language"]],
		["og:locale", () => openGraph.locale],
	]));

	const siteName = asText(pick("siteName", [
		["og:site_name", () => openGraph.site_name],
		["meta[name=application-name]", () => meta["application-name"]],
		["json-ld publisher", () => ldText("publisher")],
	]));

	const author = asText(pick("author", [
		["meta[name=author]", () => meta.author],
		["article:author", () => meta["article:author"]],
		["json-ld author", () => ldText("author")],
		["twitter:creator", () => twitter.creator],
	]));

	const publishedAt = normalizeDate(asText(pick("publishedAt", [
		["article:published_time", () => meta["article:published_time"]],
		["meta[name=date]", () => meta.date],
		["meta[name=pubdate]", () => meta.pubdate],
		["meta[name=publish-date]", () => meta["publish-date"]],
		["meta[itemprop=datePublished]", () => meta.datepublished],
		["json-ld datePublished", () => ldText("datePublished")],
		["<time datetime>", () => firstTimeDatetime(doc, logger)],
	])));

	const modifiedAt = normalizeDate(asText(pick("modifiedAt", [
		["article:modified_time", () => meta["article:modified_time"]],
		["og:updated_time", () => openGraph.updated_time],
		["meta[name=last-modified]", () => meta["last-modified"]],
		["meta[itemprop=dateModified]", () => meta.datemodified],
		["json-ld dateModified", () => ldText("dateModified")],
	])));

	const image = asUrl(
		pick("image", [
			["og:image", () => openGraph.image],
			["og:image:url", () => openGraph["image:url"]],
			["twitter:image", () => twitter.image],
			["twitter:image:src", () => twitter["image:src"]],
			["<link rel=image_src>", () => linkHref(links(), "image_src")],
			["json-ld image", () => ldUrl("image")],
		]),
		base,
		"image",
		logger,
	);

	const favicon = asUrl(
		pick("favicon", [
			// `rel="shortcut icon"` is caught here too — see `relTokens`
			["<link rel=icon>", () => linkHref(links(), "icon")],
			["<link rel=apple-touch-icon>", () => linkHref(links(), "apple-touch-icon")],
			["<link rel=mask-icon>", () => linkHref(links(), "mask-icon")],
			// only guessed when a document URL was given: without one it would resolve
			// to the bare string "/favicon.ico", which is worse than admitting we do
			// not know
			["/favicon.ico guess", () => (options?.url ? "/favicon.ico" : undefined)],
		]),
		base,
		"favicon",
		logger,
	);

	const ogType = asText(pick("type", [["og:type", () => openGraph.type]]));

	const fields: Partial<Metadata> = {};
	const missing: string[] = [];
	const set = (key: MetadataField, value: string | undefined) => {
		// an absent field is `undefined`, not `""` and not a present key holding
		// `undefined` — callers test `if (md.title)`, and `JSON.stringify` of a result
		// should not be littered with nulls
		if (value) fields[key] = value;
		else missing.push(key);
	};

	set("title", title);
	set("description", description);
	set("canonical", canonical);
	set("lang", lang);
	set("siteName", siteName);
	set("author", author);
	set("publishedAt", publishedAt);
	set("modifiedAt", modifiedAt);
	set("image", image);
	set("favicon", favicon);
	set("type", ogType);

	if (missing.length) {
		logger?.debug(`[html-extract] metadata: not found: ${missing.join(", ")}`);
	}

	return { ...fields, openGraph, twitter, meta };
}

/**
 * Extracts normalized document metadata: the `<meta>` table split into OpenGraph,
 * Twitter and everything-else maps, plus the derived fields every consumer actually
 * wants.
 *
 * Each field is resolved by a fixed chain, first hit wins, blank values never count:
 *
 * - **title** — `meta[name=title]`, `og:title`, `twitter:title`, JSON-LD
 *   `headline`/`name`, `<title>`, first `<h1>`
 * - **description** — `meta[name=description]`, `og:description`,
 *   `twitter:description`, JSON-LD `description`
 * - **canonical** — `<link rel=canonical>`, `og:url`, JSON-LD `url`
 * - **lang** — `<html lang>`, `meta[http-equiv=content-language]`, `og:locale`
 * - **siteName** — `og:site_name`, `meta[name=application-name]`, JSON-LD
 *   `publisher.name`
 * - **author** — `meta[name=author]`, `article:author`, JSON-LD `author.name`,
 *   `twitter:creator`
 * - **publishedAt** — `article:published_time`, `meta[name=date]`,
 *   `meta[name=pubdate]`, `meta[name=publish-date]`, `meta[itemprop=datePublished]`,
 *   JSON-LD `datePublished`, first `<time datetime>`
 * - **modifiedAt** — `article:modified_time`, `og:updated_time`,
 *   `meta[name=last-modified]`, `meta[itemprop=dateModified]`, JSON-LD `dateModified`
 * - **image** — `og:image`, `og:image:url`, `twitter:image`, `twitter:image:src`,
 *   `<link rel=image_src>`, JSON-LD `image`
 * - **favicon** — `<link rel=icon>` (which also covers `rel="shortcut icon"`),
 *   `rel=apple-touch-icon`, `rel=mask-icon`, and `/favicon.ico` **only** when
 *   {@linkcode MetadataOptions.url} was given
 * - **type** — `og:type`
 *
 * Text values are trimmed and whitespace-collapsed. Dates go through
 * {@linkcode "./_util.ts".normalizeDate} — ISO 8601 when parseable, **the raw string
 * when not**, because `"March 2024"` is still information. `canonical`, `image` and
 * `favicon` are resolved against the document's own `<base href>` if it has one and
 * {@linkcode MetadataOptions.url} otherwise, exactly like a browser; with neither, a
 * relative URL is returned relative rather than dropped.
 *
 * Never throws on bad input: a document that is empty, truncated or not really HTML
 * yields a `Metadata` with three empty maps and no fields set. The only exception is a
 * non-string `html`, which is a programmer error.
 *
 * @example
 * ```ts
 * declare const html: string;
 * declare const url: string;
 * const md = extractMetadata(html, { url: "https://example.com/posts/1" });
 * md.title;              // "…"
 * md.publishedAt;        // "2024-03-01T00:00:00.000Z"
 * md.openGraph["image:width"];   // og:* keys, without the prefix
 * ```
 */
export function extractMetadata(html: string, options?: MetadataOptions): Metadata {
	assertHtmlString(html, "extractMetadata");
	const doc = parseDocument(html, options);
	if (!doc) {
		options?.logger?.debug("[html-extract] metadata: no document, returning empty");
		return { openGraph: {}, twitter: {}, meta: {} };
	}
	return metadataFromDocument(doc, options);
}
