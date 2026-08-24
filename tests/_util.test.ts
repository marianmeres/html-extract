import { assert, assertEquals, assertThrows } from "@std/assert";
import { type DomElement, parseDocument, query } from "../src/_dom.ts";
import {
	assertHtmlString,
	collapseBlankLines,
	collapseWs,
	documentBase,
	isSuspiciousUrl,
	linkDensity,
	normalizeDate,
	resolveUrl,
	textLength,
} from "../src/_util.ts";
import { extractMetadata } from "../src/metadata.ts";

/** `documentBase` needs a real root; every test here parses a full document. */
function root(html: string): DomElement {
	const doc = parseDocument(html);
	assert(doc, "fixture failed to parse");
	return doc.root;
}

// ---------------------------------------------------------------------------------
// assertHtmlString
// ---------------------------------------------------------------------------------

Deno.test("assertHtmlString: throws a TypeError naming the caller and the type", () => {
	for (const bad of [undefined, null, 42, [], {}, new Date()]) {
		assertThrows(
			() => assertHtmlString(bad, "extractThing"),
			TypeError,
			"extractThing(html) expects a string",
		);
	}
	assertHtmlString("", "extractThing"); // an empty string is input, not a type error
});

// ---------------------------------------------------------------------------------
// urls
// ---------------------------------------------------------------------------------

Deno.test("resolveUrl: resolves, degrades, never throws", () => {
	assertEquals(resolveUrl("/a", "https://ex.com/x/y"), "https://ex.com/a");
	assertEquals(resolveUrl(" a ", "https://ex.com/x/y"), "https://ex.com/x/a");
	assertEquals(resolveUrl("/a"), "/a"); // no base: stays relative rather than dropped
	assertEquals(resolveUrl("/a", "not a url"), "/a");
	assertEquals(resolveUrl(""), undefined);
	assertEquals(resolveUrl(undefined), undefined);
	assertEquals(resolveUrl(null), undefined);
});

// regression, finding 2: a leading `<base target>` hid the real `<base href>`
Deno.test("documentBase: the first <base> *with* an href wins, not the first <base>", () => {
	const html = `<html><head><base target="_blank">` +
		`<base href="https://cdn.example/root/">` +
		`<link rel="canonical" href="c"></head><body></body></html>`;

	assertEquals(
		documentBase(root(html), "https://ex.com/a/b"),
		"https://cdn.example/root/",
	);

	// and the whole point of it: relative metadata resolves against the declared base
	assertEquals(
		extractMetadata(html, { url: "https://ex.com/a/b" }).canonical,
		"https://cdn.example/root/c",
	);
});

Deno.test("documentBase: an empty or blank href never masks the next <base>", () => {
	const empty = `<html><head><base href="">` +
		`<base href="https://cdn.example/root/"></head><body></body></html>`;
	assertEquals(
		documentBase(root(empty), "https://ex.com/a/b"),
		"https://cdn.example/root/",
	);

	const blank = `<html><head><base href="   ">` +
		`<base href="https://cdn.example/root/"></head><body></body></html>`;
	assertEquals(
		documentBase(root(blank), "https://ex.com/a/b"),
		"https://cdn.example/root/",
	);
});

Deno.test("documentBase: the first declared base still shadows later ones", () => {
	// the first <base href> is *the* base, even when a second one follows (browser rule)
	const html = `<html><head><base href="https://one.example/x/">` +
		`<base href="https://two.example/y/"></head><body></body></html>`;
	assertEquals(
		documentBase(root(html), "https://ex.com/a/b"),
		"https://one.example/x/",
	);
});

Deno.test("documentBase: falls back to url, and to undefined without either", () => {
	const none = `<html><head></head><body></body></html>`;
	assertEquals(documentBase(root(none), "https://ex.com/a/b"), "https://ex.com/a/b");
	assertEquals(documentBase(root(none)), undefined);

	// a relative <base href> is resolved against url
	const rel = `<html><head><base href="/api/"></head><body></body></html>`;
	assertEquals(documentBase(root(rel), "https://ex.com/a/b"), "https://ex.com/api/");
	// and is unusable without one, so url (here: nothing) wins
	assertEquals(documentBase(root(rel)), undefined);

	assertEquals(documentBase(null, "https://ex.com/"), "https://ex.com/");
	assertEquals(documentBase(undefined), undefined);
});

// ---------------------------------------------------------------------------------
// whitespace
// ---------------------------------------------------------------------------------

Deno.test("collapseWs / collapseBlankLines", () => {
	assertEquals(collapseWs("  a \n\t b  "), "a b");
	assertEquals(collapseWs(""), "");
	assertEquals(collapseBlankLines("a\n\n\n\n b\n"), "a\n\n b");
	assertEquals(collapseBlankLines("a   \nb"), "a\nb");
});

// ---------------------------------------------------------------------------------
// normalizeDate — regression, finding 1
// ---------------------------------------------------------------------------------

Deno.test("normalizeDate: ISO input normalizes (the shapes the corpus contains)", () => {
	assertEquals(normalizeDate("2024-03-12T06:41:00+00:00"), "2024-03-12T06:41:00.000Z");
	assertEquals(normalizeDate("2024-01-08"), "2024-01-08T00:00:00.000Z");
	assertEquals(normalizeDate("2024-04-05"), "2024-04-05T00:00:00.000Z");
	assertEquals(normalizeDate("2024-03"), "2024-03-01T00:00:00.000Z");
	assertEquals(normalizeDate("2024-03-12T06:41"), "2024-03-12T06:41:00.000Z");
	assertEquals(normalizeDate("2024-03-12T06:41:00.123Z"), "2024-03-12T06:41:00.123Z");
	assertEquals(normalizeDate("2024-03-12T06:41:00.5Z"), "2024-03-12T06:41:00.500Z");
	assertEquals(normalizeDate("2024-03-12T08:41:00+02:00"), "2024-03-12T06:41:00.000Z");
	assertEquals(normalizeDate("2024-03-12T08:41:00+0200"), "2024-03-12T06:41:00.000Z");
	assertEquals(normalizeDate("2024-03-12T08:41:00-02"), "2024-03-12T10:41:00.000Z");
	// a space separator instead of `T` is common CMS output
	assertEquals(normalizeDate("2024-03-12 06:41:00"), "2024-03-12T06:41:00.000Z");
	assertEquals(normalizeDate("  2024-03-12T06:41:00Z  "), "2024-03-12T06:41:00.000Z");
});

// this is the bug: these all went to `Date.parse`, which reads them in the HOST
// timezone, so "March 2024" came back as 2024-02-29T23:00:00.000Z in +01:00
Deno.test("normalizeDate: non-ISO human dates are kept RAW, on every machine", () => {
	const raws = [
		"March 2024",
		"March 5, 2024",
		"5 March 2024",
		"2024/03/05",
		"03/05/2024", // ambiguous by design: never silently resolved to one of the two
		"12.3.2024",
		"2024",
		"5",
		"Mon Mar 12 2024",
		"not a date at all",
	];
	for (const raw of raws) assertEquals(normalizeDate(raw), raw, `${raw} must stay raw`);
});

Deno.test("normalizeDate: a zoneless ISO time is read as UTC, not as host-local", () => {
	// the fixed guess. Under `Date.parse` this asserted the host offset instead, so the
	// same document produced a different publishedAt per machine.
	assertEquals(normalizeDate("2024-03-12T06:41:00"), "2024-03-12T06:41:00.000Z");
	assertEquals(normalizeDate("2024-06-12T06:41:00"), "2024-06-12T06:41:00.000Z"); // DST
	assertEquals(normalizeDate("2024-03-12"), "2024-03-12T00:00:00.000Z");

	// the same statement, made without naming a timezone: the calendar day the library
	// reports can never depend on where it runs
	assertEquals(
		new Date(normalizeDate("2024-03-12") as string).getUTCDate(),
		12,
		"a date-only value slid onto another day",
	);
});

Deno.test("normalizeDate: RFC 2822 / HTTP-date, but only with an explicit zone", () => {
	assertEquals(
		normalizeDate("Tue, 12 Mar 2024 06:41:00 GMT"),
		"2024-03-12T06:41:00.000Z",
	);
	assertEquals(
		normalizeDate("Tue, 12 Mar 2024 08:41:00 +0200"),
		"2024-03-12T06:41:00.000Z",
	);
	assertEquals(normalizeDate("12 March 2024 06:41 UTC"), "2024-03-12T06:41:00.000Z");
	// no zone: unknowable, so kept raw rather than guessed at
	assertEquals(normalizeDate("Tue, 12 Mar 2024 06:41:00"), "Tue, 12 Mar 2024 06:41:00");
	assertEquals(
		normalizeDate("Tue, 12 Foo 2024 06:41:00 GMT"),
		"Tue, 12 Foo 2024 06:41:00 GMT",
	);
});

Deno.test("normalizeDate: impossible calendar dates stay raw, never roll over", () => {
	assertEquals(normalizeDate("2024-02-31"), "2024-02-31"); // would become 2 March
	assertEquals(normalizeDate("2023-02-29"), "2023-02-29");
	assertEquals(normalizeDate("2024-13-01"), "2024-13-01");
	assertEquals(normalizeDate("2024-00-10"), "2024-00-10");
	assertEquals(normalizeDate("2024-03-12T25:00:00Z"), "2024-03-12T25:00:00Z");
	assertEquals(normalizeDate("2024-02-29"), "2024-02-29T00:00:00.000Z"); // a real leap day
});

Deno.test("normalizeDate: empty in, undefined out; nothing else is ever dropped", () => {
	assertEquals(normalizeDate(""), undefined);
	assertEquals(normalizeDate("   "), undefined);
	assertEquals(normalizeDate(undefined), undefined);
	// a two-digit-looking year is not folded into the 20th century by `Date.UTC`
	assertEquals(normalizeDate("0024-03-12"), "0024-03-12T00:00:00.000Z");
});

Deno.test("normalizeDate: never throws, whatever the string", () => {
	const raws = [
		"9999-12-31T23:59:59Z",
		"0000-01-01",
		"    ",
		"1".repeat(5000),
		"2024-" + "0".repeat(4000),
		"Tue, ".repeat(500) + "12 Mar 2024 06:41:00 GMT",
	];
	for (const raw of raws) {
		const out = normalizeDate(raw);
		assert(out === undefined || typeof out === "string", "normalizeDate misbehaved");
	}
});

Deno.test("normalizeDate: pathological input stays linear (no runaway backtracking)", () => {
	// a hang is worse than a throw; both shape regexes must be linear in input length
	const started = Date.now();
	for (const n of [1_000, 10_000, 40_000]) {
		normalizeDate("2024-03-12T06:41:00." + "0".repeat(n) + "!");
		normalizeDate("Mon, " + " ".repeat(n) + "12 Mar 2024 06:41:00 GM");
		normalizeDate("2024-".repeat(n));
	}
	assert(Date.now() - started < 2_000, "normalizeDate is backtracking");
});

// ---------------------------------------------------------------------------------
// scoring helpers
// ---------------------------------------------------------------------------------

Deno.test("linkDensity / textLength", () => {
	const doc = parseDocument(
		`<html><body><div id="nav"><a href="/a">aaaa</a><a href="/b">bbbb</a></div>` +
			`<div id="p">aaaa <a href="/c">bb</a></div></body></html>`,
	);
	assert(doc);
	const nav = query(doc.root, "#nav");
	const para = query(doc.root, "#p");

	assertEquals(linkDensity(nav), 1);
	assertEquals(linkDensity(para), 2 / 7);
	assertEquals(textLength(para), 7);

	// degrades instead of throwing
	assertEquals(linkDensity(null), 0);
	assertEquals(linkDensity(undefined), 0);
	assertEquals(textLength(null), 0);
});

Deno.test("isSuspiciousUrl: sees through whitespace and control characters", () => {
	assert(isSuspiciousUrl("javascript:alert(1)"));
	assert(isSuspiciousUrl("JaVaScRiPt:alert(1)"));
	assert(isSuspiciousUrl("java\tscript:alert(1)"));
	assert(isSuspiciousUrl(" java script :alert(1)"));
	assert(isSuspiciousUrl("vbscript:x"));
	assert(!isSuspiciousUrl("data:image/png;base64,AAAA")); // deliberately allowed
	assert(!isSuspiciousUrl("https://ex.com/javascript:x"));
	assert(!isSuspiciousUrl(undefined));
	assert(!isSuspiciousUrl(""));
});
