/**
 * Main-content extraction — the fuzzy part of this package, and the only part that
 * guesses.
 *
 * Three strategies are tried in order and the winner is recorded in
 * {@linkcode MainContent.via}, because a caller who cannot see *how* the answer was
 * reached cannot tell a confident hit from a lucky one:
 *
 * 1. `selector` — the user said where the content is, so nothing else runs.
 * 2. `semantic` — the document said where the content is (`<main>`, `[role=main]`,
 *    `<article>`), guarded by a minimum text length so an empty `<main>` shell cannot
 *    "successfully" extract nothing.
 * 3. `scored` — nobody said, so a readability-style score decides.
 *
 * All of it happens on a **deep clone** of the body. {@linkcode "./extract.ts".extract}
 * runs every extractor against one parse, and this is the only extractor that rewrites a
 * tree; mutating the shared one would silently corrupt whatever runs after it.
 *
 * @module
 */

import {
	attr,
	childNodes,
	children,
	classId,
	cloneElement,
	type DomElement,
	dropAll,
	isComment,
	isElement,
	isText,
	type ParsedDocument,
	parseDocument,
	query,
	queryAll,
	remove,
	serialize,
	serializeChildren,
	tag,
	text,
	walkElements,
} from "./_dom.ts";
import {
	assertHtmlString,
	BOILERPLATE_TAGS,
	collapseWs,
	documentBase,
	linkDensity,
	NEGATIVE_HINTS,
	NON_CONTENT_TAGS,
	POSITIVE_HINTS,
	textLength,
} from "./_util.ts";
import { cleanNode } from "./clean.ts";
import { renderMarkdown } from "./to-markdown.ts";
import { renderText } from "./to-text.ts";
import type {
	MainContent,
	MainContentOptions,
	MainContentVia,
	MarkdownOptions,
	TextOptions,
} from "./types.ts";

// ---------------------------------------------------------------------------------
// tuning constants — every magic number in this module lives here, named
// ---------------------------------------------------------------------------------

/** Default {@linkcode MainContentOptions.minTextLength}. */
const DEFAULT_MIN_TEXT_LENGTH = 140;

/**
 * One step of the semantic fast path.
 *
 * A `find` function rather than a selector string, because one of the three cannot be
 * expressed as a selector at all — see {@linkcode withRoleMain}.
 */
interface SemanticSource {
	/** What to call this step in the log. */
	label: string;
	/** Every element in `root` that qualifies, in document order. */
	find: (root: DomElement, logger: MainContentOptions["logger"]) => DomElement[];
}

/**
 * Elements with `role="main"`, found by walking rather than by selector.
 *
 * The selector engine matches attribute *names* case-sensitively — the exact quirk
 * {@linkcode "./_dom.ts".attr} exists to paper over — so `querySelectorAll("[role=main]")`
 * silently misses `<div ROLE="main">` and the whole page falls through to scoring. That
 * is not a hypothetical shape: this package's own product fixture is written with
 * uppercase attribute names, and a document that shouts one attribute shouts them all.
 * An attribute-presence selector (`[role]`) would be matched the same way, so the only
 * safe reading is a walk plus `attr()`.
 *
 * The *value* is compared case-insensitively too. ARIA role tokens are case-sensitive
 * per spec, so this is a deliberate deviation: `role="MAIN"` has never meant anything
 * other than the main landmark, and rejecting it would reintroduce the same
 * shouting-document failure one level down.
 */
function withRoleMain(root: DomElement): DomElement[] {
	const out: DomElement[] = [];
	walkElements(root, (el) => {
		if (attr(el, "role")?.trim().toLowerCase() === "main") out.push(el);
	});
	return out;
}

/** Semantic containers, in the order they are trusted. */
const SEMANTIC_SOURCES: readonly SemanticSource[] = [
	{ label: "main", find: (root, logger) => queryAll(root, "main", logger) },
	{ label: "[role=main]", find: withRoleMain },
	{ label: "article", find: (root, logger) => queryAll(root, "article", logger) },
];

/** Elements whose text is worth points for their ancestors. */
const SCORING_SELECTOR = "p, td, pre, blockquote, li";

/**
 * Shortest text a block must carry before it scores at all.
 *
 * Below this it is a label, a caption or a menu entry, and counting those is how a
 * sidebar of ten one-word links out-scores three real paragraphs.
 */
const MIN_SCORING_TEXT = 25;

/** Points a block's own class/id hints are worth, positive and negative alike. */
const HINT_WEIGHT = 25;

/**
 * Divider applied to a text block's points at each generation above it: index 0 is the
 * parent, index 1 the grandparent, and the last index is as far as points travel.
 *
 * Stopping at the grandparent — which is what this did — loses whole articles on
 * page-builder markup. A Gutenberg group block or an Elementor widget wraps every
 * paragraph in two `<div>`s of its own, which puts the real container three generations
 * up, where it scored *nothing*: not one point, and (because class/id hints are only
 * consulted for elements that scored) not its `entry-content` bonus either. The winner
 * was then whichever innermost wrapper held the longest single paragraph, and the
 * sibling-append step could not recover the rest because that wrapper is an only child.
 * The failure was silent and total — one paragraph out of six, reported as a confident
 * `scored` result.
 *
 * The decay is readability's (`level < 2 ? level + 1 : level * 3`) and it is what keeps
 * full propagation from simply handing `<body>` the win: a container N paragraphs deep
 * accumulates roughly N·points/6 while each leaf wrapper keeps only its own, so the
 * container wins on *count* while the divider keeps the ever-larger ancestors above it
 * from coasting on the same points. Five generations is the reach; beyond that a
 * document is nesting for layout reasons no score can interpret.
 */
const ANCESTOR_SCORE_DIVIDERS: readonly number[] = [1, 2, 6, 9, 12];

/** Longest text run that still earns length points, in 100-character steps. */
const MAX_LENGTH_POINTS = 3;

/**
 * A scored winner whose text is at least this fraction link text is rejected.
 *
 * This is the guard that makes a sitemap or a link farm return `null` instead of its
 * biggest `<div>`: the `(1 - linkDensity)` multiplier alone only *shrinks* such a
 * block's score, and on a page where every candidate is navigation the least-bad one
 * still wins. It applies to `scored` only — when the user or the document named the
 * content, a link list is a legitimate answer.
 */
const MAX_WINNER_LINK_DENSITY = 0.5;

/** A sibling is appended when it scores at least this much… */
const SIBLING_SCORE_FLOOR = 10;
/** …or at least this fraction of the winner's score, whichever is larger. */
const SIBLING_SCORE_RATIO = 0.2;
/** A `<p>` sibling is appended on text length alone once it is this long. */
const SIBLING_P_MIN_TEXT = 80;
/** …and only while this much of it is not link text. */
const SIBLING_P_MAX_LINK_DENSITY = 0.25;

/**
 * Base score per tag name, before class/id hints and the link-density multiplier.
 *
 * Positive for the containers prose actually lives in, negative for the ones that only
 * ever *hold* prose written elsewhere — a `<ul>` full of paragraphs is a list of
 * teasers, not an article, and a heading is never a container at all.
 */
const TAG_WEIGHTS: Readonly<Record<string, number>> = {
	div: 5,
	article: 5,
	section: 5,
	main: 5,
	pre: 3,
	td: 3,
	blockquote: 3,
	ol: -3,
	ul: -3,
	dl: -3,
	dd: -3,
	dt: -3,
	li: -3,
	form: -3,
	address: -3,
	th: -5,
	h1: -5,
	h2: -5,
	h3: -5,
	h4: -5,
	h5: -5,
	h6: -5,
};

// ---------------------------------------------------------------------------------
// scoring primitives
// ---------------------------------------------------------------------------------

/**
 * Commas in a string — the cheapest available proxy for "somebody wrote sentences
 * here".
 *
 * Ideographic and fullwidth commas count too. Restricting this to `,` would score every
 * CJK document as if it contained no prose at all, which is exactly the kind of quiet,
 * whole-language failure that never shows up in an English test corpus.
 */
function commaCount(value: string): number {
	return (value.match(/[,，、]/g) ?? []).length;
}

/** Tag weight plus class/id hints — a candidate's score before any block contributes. */
function baseScore(el: DomElement): number {
	let score = TAG_WEIGHTS[tag(el)] ?? 0;
	const hint = classId(el);
	if (POSITIVE_HINTS.test(hint)) score += HINT_WEIGHT;
	if (NEGATIVE_HINTS.test(hint)) score -= HINT_WEIGHT;
	return score;
}

/** Points one text block is worth to its ancestors. */
function blockPoints(value: string): number {
	return 1 + commaCount(value) +
		Math.min(Math.floor(value.length / 100), MAX_LENGTH_POINTS);
}

// ---------------------------------------------------------------------------------
// the working clone
// ---------------------------------------------------------------------------------

/**
 * Deep-clones the body and strips what is never content from the copy.
 *
 * Returns `null` when the parser refuses to clone — the caller then gives up rather
 * than falling back to mutating the shared tree, because a corrupted document would
 * make *every other* extractor wrong instead of just this one.
 */
function workingClone(
	doc: ParsedDocument,
	logger: MainContentOptions["logger"],
): DomElement | null {
	const clone = cloneElement(doc.body);
	if (!clone) {
		logger?.warn(
			"[html-extract] main content: could not clone the document body, giving up",
		);
		return null;
	}

	const dropped = dropAll(clone, [...NON_CONTENT_TAGS], logger);

	let comments = 0;
	walkElements(clone, (el) => {
		for (const node of childNodes(el)) {
			if (isComment(node)) {
				remove(node);
				comments++;
			}
		}
	});

	logger?.debug(
		`[html-extract] main content: working clone ready, dropped ${dropped} ` +
			`non-content element(s) and ${comments} comment(s)`,
	);
	return clone;
}

// ---------------------------------------------------------------------------------
// strategy 1 — the selector override
// ---------------------------------------------------------------------------------

/**
 * The user's own answer, taken at face value.
 *
 * No scoring and no minimum length: the whole point of the override is to win on pages
 * where the heuristic is wrong, and second-guessing it would put the heuristic back in
 * charge. A non-matching or invalid selector is not an error — it falls through to the
 * other strategies, because a stale per-site rule should degrade, not break.
 */
function bySelector(
	root: DomElement,
	selector: string,
	minTextLength: number,
	logger: MainContentOptions["logger"],
): DomElement | null {
	const found = query(root, selector, logger);
	if (!found) {
		logger?.debug(
			`[html-extract] main content: selector ${
				JSON.stringify(selector)
			} matched nothing, falling through`,
		);
		return null;
	}
	const len = textLength(found);
	if (len < minTextLength) {
		logger?.debug(
			`[html-extract] main content: selector ${JSON.stringify(selector)} matched ` +
				`<${tag(found)}> with only ${len} chars of text — honouring it anyway`,
		);
	}
	return found;
}

// ---------------------------------------------------------------------------------
// strategy 2 — the semantic fast path
// ---------------------------------------------------------------------------------

/**
 * The document's own answer: `<main>`, then `[role=main]`, then `<article>`.
 *
 * When a page marks up its content honestly that markup beats any score, so the only
 * judgment here is the length gate — an unhydrated SPA ships an empty `<main>` shell,
 * and without the gate that shell would "successfully" extract nothing at all.
 *
 * Several matches are resolved by text length rather than document order. That is what
 * picks the post out of an index page of `<article>` teasers, and it costs nothing in
 * the ordinary case where there is exactly one match.
 */
function bySemantics(
	root: DomElement,
	minTextLength: number,
	logger: MainContentOptions["logger"],
): DomElement | null {
	for (const source of SEMANTIC_SOURCES) {
		let best: DomElement | null = null;
		let bestLen = 0;
		let seen = 0;
		for (const el of source.find(root, logger)) {
			seen++;
			const len = textLength(el);
			if (len < minTextLength) continue;
			if (!best || len > bestLen) {
				best = el;
				bestLen = len;
			}
		}
		if (best) {
			logger?.debug(
				`[html-extract] main content: semantic ${source.label} won ` +
					`(${seen} match(es), ${bestLen} chars of text)`,
			);
			return best;
		}
		if (seen) {
			logger?.debug(
				`[html-extract] main content: ${seen} ${source.label} match(es) all shorter ` +
					`than minTextLength ${minTextLength} — likely an empty shell`,
			);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------------
// subtree metrics — text length and link text length for every element, in one pass
// ---------------------------------------------------------------------------------

/**
 * A run of text, measured the way {@linkcode "./_util.ts".collapseWs} would.
 *
 * `lead`/`trail` are what make the measurement *composable*: collapsed lengths do not
 * simply add up, because two neighbouring runs separated by whitespace gain a space
 * between them and two that are not do not. Carrying those two bits lets a parent's
 * length be assembled from its children's instead of re-read from its own subtree.
 */
interface TextRun {
	/** `collapseWs(raw).length`. */
	len: number;
	/** The raw text begins with whitespace. */
	lead: boolean;
	/** The raw text ends with whitespace. */
	trail: boolean;
}

/** A {@linkcode TextRun} plus the part of it that sits inside `<a>`. */
interface TextMetrics extends TextRun {
	/**
	 * Sum of `len` over every descendant `<a>` — the link-density numerator, summed per
	 * anchor exactly as {@linkcode "./_util.ts".linkDensity} does.
	 */
	anchors: number;
}

/** The measurement of nothing at all. Never mutated; {@linkcode joinRuns} is pure. */
const EMPTY_RUN: TextRun = { len: 0, lead: false, trail: false };

/** Measures one text node's contribution. */
function textRun(raw: string): TextRun {
	if (!raw) return EMPTY_RUN;
	// a single-character test, not `/^\s/` and `/\s$/`: an unanchored end-of-string
	// match rescans, and text nodes in a soup document are not always small
	return {
		len: collapseWs(raw).length,
		lead: /\s/.test(raw[0]),
		trail: /\s/.test(raw[raw.length - 1]),
	};
}

/**
 * Concatenates two measured runs, yielding exactly what measuring their concatenation
 * would have.
 *
 * A run whose `len` is 0 is either empty or all whitespace; either way it contributes no
 * characters, but a whitespace-only run still separates its neighbours, so its `lead`
 * and `trail` have to survive it.
 */
function joinRuns(a: TextRun, b: TextRun): TextRun {
	if (!a.len && !b.len) {
		return { len: 0, lead: a.lead || b.lead, trail: a.trail || b.trail };
	}
	if (!a.len) return { len: b.len, lead: a.lead || b.lead, trail: b.trail };
	if (!b.len) return { len: a.len, lead: a.lead, trail: a.trail || b.trail };
	return {
		len: a.len + b.len + (a.trail || b.lead ? 1 : 0),
		lead: a.lead,
		trail: b.trail,
	};
}

/**
 * Measures every element in `root`'s subtree once, bottom-up.
 *
 * This exists because the obvious spelling is quadratic. Calling
 * {@linkcode "./_util.ts".linkDensity} per candidate walks that candidate's whole
 * subtree twice (`textContent`, then every descendant `<a>`), and candidates *nest* — on
 * a document whose `</div>`s were lost, every block is an ancestor of every later one,
 * so the per-candidate walks add up to O(depth × document). Measured: 4 000 nested
 * blocks (707 KB) took 19.6 s, quadrupling on every doubling, against 36 ms for
 * `toText()` on the same input. Broken markup is a first-class input for this package,
 * so that is not a hostile-input footnote — it is a crawler stalling on a real page.
 *
 * The pass is a pre-order walk collected into an array and then read backwards: in
 * pre-order every parent precedes its descendants, so backwards guarantees children are
 * finished before their parent without a second stack. Iterative throughout, for the
 * usual reason — a recursive post-order over a 20 000-deep document is a `RangeError`,
 * and this package does not throw on markup.
 *
 * The numbers are *identical* to `textLength()`/`linkDensity()`, not an approximation;
 * that is what {@linkcode TextRun}'s `lead`/`trail` bits buy.
 */
function measureSubtrees(root: DomElement): Map<DomElement, TextMetrics> {
	const out = new Map<DomElement, TextMetrics>();

	const order: DomElement[] = [];
	walkElements(root, (el) => {
		order.push(el);
	});

	for (let i = order.length - 1; i >= 0; i--) {
		const el = order[i];
		let run = EMPTY_RUN;
		let anchors = 0;
		for (const node of childNodes(el)) {
			if (isElement(node)) {
				const child = out.get(node);
				if (!child) continue;
				run = joinRuns(run, child);
				anchors += child.anchors + (tag(node) === "a" ? child.len : 0);
			} else if (isText(node)) {
				run = joinRuns(run, textRun(text(node)));
			}
		}
		out.set(el, { ...run, anchors });
	}
	return out;
}

/** Text length of an element, off the measured map. See {@linkcode measureSubtrees}. */
function measuredLength(metrics: Map<DomElement, TextMetrics>, el: DomElement): number {
	return metrics.get(el)?.len ?? 0;
}

/** Link density of an element, off the measured map. See {@linkcode measureSubtrees}. */
function measuredDensity(
	metrics: Map<DomElement, TextMetrics>,
	el: DomElement,
): number {
	const m = metrics.get(el);
	if (!m || !m.len) return 0;
	return Math.min(1, m.anchors / m.len);
}

// ---------------------------------------------------------------------------------
// strategy 3 — scoring
// ---------------------------------------------------------------------------------

/** A scored candidate plus the pieces of it the caller still needs. */
interface ScoredWinner {
	/** The top candidate. */
	winner: DomElement;
	/** Siblings judged to be a continuation of it, in document order. */
	siblings: DomElement[];
	/** The winner's final, link-density-adjusted score. */
	score: number;
	/** How many elements were scored at all. */
	candidates: number;
}

/**
 * Readability-style scoring: text blocks pay their ancestors, then link density taxes
 * the result.
 *
 * Every `p`/`td`/`pre`/`blockquote`/`li` with real text pays each of its first five
 * ancestors, at a divider that grows with the distance
 * ({@linkcode ANCESTOR_SCORE_DIVIDERS}) — a real container wins on how *many* blocks
 * paid it, while the decay stops the ever-larger ancestors above it, `<body>` included,
 * from coasting on the same points. The final `(1 - linkDensity)` multiplier is where a
 * nav-heavy block loses, and it is the strongest single signal in the whole heuristic: a
 * `<div class="content">` whose text is all link text is a menu somebody named badly.
 *
 * The climb stops at the first ancestor {@linkcode NEGATIVE_HINTS} calls chrome, that
 * ancestor included. That one line is what keeps the longer reach honest: without it a
 * comment thread's paragraphs go on paying the page shell that contains them, and on the
 * single most common CMS shape there is — a WordPress `<div id="page">` (a `page` hint,
 * so `+25`) wrapping both a Gutenberg article and a comment thread — the shell out-scores
 * the article and the whole thread comes back as "main content". Boilerplate still scores
 * as a candidate in its own right, so a page that really is a comment thread can still
 * win; it just no longer inflates its ancestors. It is the softer form of readability's
 * rule, which deletes unlikely candidates outright before scoring.
 *
 * Both lengths come off one bottom-up {@linkcode measureSubtrees} pass rather than from
 * per-candidate subtree walks; see there for the document shape that made that
 * necessary.
 */
function byScoring(
	root: DomElement,
	logger: MainContentOptions["logger"],
): ScoredWinner | null {
	dropAll(
		root,
		[...BOILERPLATE_TAGS, '[aria-hidden="true"]', "[hidden]"],
		logger,
	);

	// after the drops, so nothing that was removed is still counted
	const metrics = measureSubtrees(root);

	const raw = new Map<DomElement, number>();
	const award = (el: DomElement | null, points: number) => {
		if (!el) return;
		raw.set(el, (raw.get(el) ?? baseScore(el)) + points);
	};

	let blocks = 0;
	for (const el of queryAll(root, SCORING_SELECTOR, logger)) {
		const value = collapseWs(text(el));
		if (value.length < MIN_SCORING_TEXT) continue;
		blocks++;
		const points = blockPoints(value);
		// `root` is a detached clone, so `parentElement` runs out on its own at the top
		let ancestor = el.parentElement;
		for (let up = 0; ancestor && up < ANCESTOR_SCORE_DIVIDERS.length; up++) {
			award(ancestor, points / ANCESTOR_SCORE_DIVIDERS[up]);
			if (NEGATIVE_HINTS.test(classId(ancestor))) break;
			ancestor = ancestor.parentElement;
		}
	}

	if (!raw.size) {
		logger?.debug(
			`[html-extract] main content: scoring found no candidates ` +
				`(${blocks} qualifying text block(s))`,
		);
		return null;
	}

	// link density is applied once, at the end, so that it taxes the accumulated score
	// rather than each contribution — a block does not become navigation by having many
	// paragraphs in it
	const final = new Map<DomElement, number>();
	let winner: DomElement | null = null;
	let score = -Infinity;
	for (const [el, value] of raw) {
		const adjusted = value * (1 - measuredDensity(metrics, el));
		final.set(el, adjusted);
		if (adjusted > score) {
			winner = el;
			score = adjusted;
		}
	}
	if (!winner) return null;

	logger?.debug(
		`[html-extract] main content: scored ${raw.size} candidate(s) from ${blocks} ` +
			`text block(s), top is <${tag(winner)}${
				classId(winner).trim() ? ` ${classId(winner).trim()}` : ""
			}> at ${score.toFixed(2)}`,
	);

	const siblings = acceptSiblings(winner, score, final, metrics, logger);
	return { winner, siblings, score, candidates: raw.size };
}

/**
 * Siblings that are a continuation of the winner rather than a neighbour of it.
 *
 * Two ways in, because CMS output splits an article two different ways: a sibling that
 * scored respectably in its own right, and a bare `<p>` that never scored because its
 * parent got the points. Without the second rule the lead paragraph of a
 * `<div><p>lead</p><div class="body">…</div></div>` layout is silently lost, which is
 * the sort of failure nobody notices until the text reads oddly.
 */
function acceptSiblings(
	winner: DomElement,
	topScore: number,
	final: Map<DomElement, number>,
	metrics: Map<DomElement, TextMetrics>,
	logger: MainContentOptions["logger"],
): DomElement[] {
	const parent = winner.parentElement;
	if (!parent) return [];

	const threshold = Math.max(SIBLING_SCORE_FLOOR, topScore * SIBLING_SCORE_RATIO);
	const accepted: DomElement[] = [];
	for (const sibling of children(parent)) {
		if (sibling === winner) continue;
		if ((final.get(sibling) ?? 0) >= threshold) {
			accepted.push(sibling);
			continue;
		}
		if (
			tag(sibling) === "p" &&
			measuredLength(metrics, sibling) > SIBLING_P_MIN_TEXT &&
			measuredDensity(metrics, sibling) < SIBLING_P_MAX_LINK_DENSITY
		) {
			accepted.push(sibling);
		}
	}

	if (accepted.length) {
		logger?.debug(
			`[html-extract] main content: appended ${accepted.length} sibling(s) ` +
				`scoring at least ${threshold.toFixed(2)}`,
		);
	}
	return accepted;
}

/**
 * Reassembles the winner and its accepted siblings into one fresh, single-rooted tree.
 *
 * Serialize-and-reparse rather than node surgery: the parser exposes no way to mint a
 * container element (that would be a parser detail leaking out of `_dom.ts`), and
 * re-parsing has the useful side effect of handing back a tree with no leftover
 * ancestry — so what gets rendered is exactly what gets serialized into
 * {@linkcode MainContent.html}, with no wrapper silently in between.
 *
 * Returns `null` only when the assembled HTML is unparseable, which in practice means
 * it was empty.
 */
function assemble(
	winner: DomElement,
	siblings: DomElement[],
	options: MainContentOptions | undefined,
): DomElement | null {
	const parent = winner.parentElement;
	let html: string;
	if (parent) {
		const keep = new Set<DomElement>(siblings);
		html = children(parent)
			.filter((el) => el === winner || keep.has(el))
			.map((el) => serialize(el))
			.join("\n");
	} else {
		// the winner is the clone root itself — its own tag is `<body>`/`<html>` and has
		// no business in the output
		html = serializeChildren(winner);
	}

	const doc = parseDocument(html, {
		logger: options?.logger,
		maxSize: options?.maxSize,
	});
	return doc?.body ?? null;
}

// ---------------------------------------------------------------------------------
// the result
// ---------------------------------------------------------------------------------

/**
 * Wraps a winning subtree in the public {@linkcode MainContent} shape.
 *
 * `markdown()` and `text()` are lazy *and* memoized, down to the option objects they
 * render with: nothing is read out of {@linkcode MainContentOptions.markdown} or
 * {@linkcode MainContentOptions.text} until the first call. A caller who only wanted
 * `textLength` must not pay for markdown conversion of a 2 MB document, and a caller
 * who asks twice must not pay twice.
 *
 * `base` is the document's effective base URL, not `options.url` — the node handed to
 * the renderer has been detached from its document and can no longer be asked about
 * `<base href>`, so the resolution has to be decided here, while the document is still
 * in reach.
 *
 * `toJSON()` breaks that rule on purpose — see {@linkcode MainContent.toJSON}.
 *
 * `length` and `density` default to measuring `node`, and the scored path passes its own
 * instead: it already had to measure the assembled winner to apply the minimum-length
 * and link-density gates, and both are full subtree traversals of the result.
 */
function buildResult(
	node: DomElement,
	html: string,
	via: MainContentVia,
	options: MainContentOptions | undefined,
	base: string | undefined,
	length: number = textLength(node),
	density: number = linkDensity(node),
): MainContent {
	const logger = options?.logger;

	let markdownCache: string | undefined;
	let textCache: string | undefined;

	const markdown = (): string => {
		if (markdownCache === undefined) {
			const own = options?.markdown;
			const opts: MarkdownOptions = {
				logger,
				maxSize: options?.maxSize,
				...own,
				url: own?.url ?? base,
			};
			markdownCache = renderMarkdown(node, opts);
			logger?.debug(
				`[html-extract] main content: rendered ${markdownCache.length} chars of markdown`,
			);
		}
		return markdownCache;
	};

	const asText = (): string => {
		if (textCache === undefined) {
			const own = options?.text;
			const opts: TextOptions = { logger, maxSize: options?.maxSize, ...own };
			textCache = renderText(node, opts);
			logger?.debug(
				`[html-extract] main content: rendered ${textCache.length} chars of text`,
			);
		}
		return textCache;
	};

	return {
		html,
		markdown,
		text: asText,
		textLength: length,
		linkDensity: density,
		via,
		toJSON: () => ({
			html,
			markdown: markdown(),
			text: asText(),
			textLength: length,
			linkDensity: density,
			via,
		}),
	};
}

// ---------------------------------------------------------------------------------
// public surface
// ---------------------------------------------------------------------------------

/**
 * Extracts the main content of an already-parsed document.
 *
 * Internal counterpart of {@linkcode extractMainContent}, used by
 * {@linkcode "./extract.ts".extract} so the document is only parsed once. Everything
 * happens on a deep clone, so the shared tree the other extractors read is left exactly
 * as it was found.
 */
export function mainContentFromDocument(
	doc: ParsedDocument,
	options?: MainContentOptions,
): MainContent | null {
	const logger = options?.logger;
	if (!doc) return null;

	const minTextLength = typeof options?.minTextLength === "number" &&
			options.minTextLength >= 0
		? options.minTextLength
		: DEFAULT_MIN_TEXT_LENGTH;

	// resolved while the document is still whole: winners are handed to the renderers
	// detached, and a `<base href>` beats `options.url` exactly as it does in a browser
	const base = documentBase(doc.root, options?.url);

	const work = workingClone(doc, logger);
	if (!work) return null;

	// 1 — the user's answer
	const selector = options?.selector;
	if (selector) {
		const found = bySelector(work, selector, minTextLength, logger);
		if (found) {
			cleanNode(found, { logger });
			logger?.debug("[html-extract] main content: via=selector");
			return buildResult(found, serialize(found), "selector", options, base);
		}
	}

	// 2 — the document's answer
	const semantic = bySemantics(work, minTextLength, logger);
	if (semantic) {
		cleanNode(semantic, { logger });
		logger?.debug("[html-extract] main content: via=semantic");
		return buildResult(semantic, serialize(semantic), "semantic", options, base);
	}

	// 3 — our answer
	const scored = byScoring(work, logger);
	if (!scored) {
		logger?.debug("[html-extract] main content: none found (nothing scored)");
		return null;
	}

	const node = assemble(scored.winner, scored.siblings, options);
	if (!node) {
		logger?.debug("[html-extract] main content: none found (winner assembled empty)");
		return null;
	}
	cleanNode(node, { logger });

	const length = textLength(node);
	if (length < minTextLength) {
		logger?.debug(
			`[html-extract] main content: none found (winner has ${length} chars, ` +
				`minTextLength is ${minTextLength})`,
		);
		return null;
	}

	const density = linkDensity(node);
	if (density >= MAX_WINNER_LINK_DENSITY) {
		logger?.debug(
			`[html-extract] main content: none found (winner is ` +
				`${
					(density * 100).toFixed(0)
				}% link text — this is navigation, not content)`,
		);
		return null;
	}

	logger?.debug(
		`[html-extract] main content: via=scored (${scored.candidates} candidate(s), ` +
			`top score ${scored.score.toFixed(2)}, ${length} chars, link density ` +
			`${density.toFixed(2)})`,
	);
	return buildResult(
		node,
		serializeChildren(node),
		"scored",
		options,
		base,
		length,
		density,
	);
}

/**
 * Extracts the main content of an HTML document — the article, minus the chrome.
 *
 * Three strategies run in order and {@linkcode MainContent.via} says which one answered,
 * because "we found content" and "we found content *and here is why we believe it*" are
 * different claims:
 *
 * 1. **`selector`** — {@linkcode MainContentOptions.selector} matched. No scoring, no
 *    length check: you said where it was. This is the escape hatch, and it should be
 *    the first thing you reach for when a page comes out wrong.
 * 2. **`semantic`** — the document's own `<main>`, `[role=main]` or `<article>`, as long
 *    as it carries at least {@linkcode MainContentOptions.minTextLength} characters.
 *    That gate is doing real work: an unhydrated SPA ships an empty `<main>` shell, and
 *    without it such a page would extract to nothing and call it a success.
 * 3. **`scored`** — readability-style scoring over the remaining blocks, with link
 *    density as the deciding signal.
 *
 * **This is a heuristic and it will sometimes be wrong.** That is not a bug to be
 * reported so much as the reason `selector` exists. It never throws — malformed markup,
 * a truncated document or binary noise all degrade — and `null` is a legitimate answer,
 * not a failure: a sitemap, a link farm or a nav-only page genuinely has no main
 * content, and saying so is more useful than returning its largest `<div>`.
 *
 * What comes back: `html` is the extracted subtree serialized and structurally cleaned
 * (see {@linkcode "./clean.ts".clean} — **not** sanitized), and it **includes the winning
 * element's own tag**, with its `class`, `id` and `style` intact, on all three paths.
 * `selector` and `semantic` serialize the matched element. `scored` serializes the
 * winning element plus any siblings judged to continue it, joined — the only thing
 * stripped there is the synthetic container this package re-parses them into. So do not
 * assume `html` is a bare run of children you can wrap yourself; wrapping it produces a
 * doubled container. The one exception is a winner that *is* the document body, which
 * has no tag worth emitting and yields its children directly.
 * {@linkcode MainContent.markdown} and {@linkcode MainContent.text} are lazy and
 * memoized; `JSON.stringify()` materializes them through
 * {@linkcode MainContent.toJSON}, so persisting a result is not silently lossy.
 *
 * @example
 * ```ts
 * declare const html: string;
 * const content = extractMainContent(html, { url: "https://example.com/post/1" });
 * if (content) {
 *   content.via;          // "semantic"
 *   content.textLength;   // 4213
 *   content.markdown();   // converted on this line, not before
 * }
 * ```
 *
 * @example
 * ```ts
 * declare const html: string;
 * // the escape hatch, for a site the heuristic reads wrong
 * extractMainContent(html, { selector: "#recipe-body" })?.via; // "selector"
 * ```
 */
export function extractMainContent(
	html: string,
	options?: MainContentOptions,
): MainContent | null {
	assertHtmlString(html, "extractMainContent");
	const doc = parseDocument(html, options);
	if (!doc) {
		options?.logger?.debug(
			"[html-extract] main content: nothing to extract (unparseable or empty input)",
		);
		return null;
	}
	return mainContentFromDocument(doc, options);
}
