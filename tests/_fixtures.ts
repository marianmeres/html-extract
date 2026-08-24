import { fromFileUrl, join } from "@std/path";

/** One fixture case: a directory under `tests/fixtures/` holding an `input.html`. */
export interface Fixture {
	/** Directory name, e.g. `"news-article"`. */
	name: string;
	/** Absolute path of the case directory. */
	dir: string;
	/** The raw document. */
	html: string;
}

/** Absolute path of `tests/fixtures`. */
export const FIXTURES_DIR: string = fromFileUrl(new URL("./fixtures", import.meta.url));

/**
 * Loads the fixture corpus: real-world-shaped messy HTML, one directory per case.
 *
 * The corpus is deliberately awkward — a news article, a docs page, a product page whose
 * JSON-LD includes a deliberately broken block, a Next.js payload, a nav-only page, a
 * table/code torture test, an email fragment with no `<html>` at all, and two genuinely
 * broken documents. Every one of them is a shape that has, at some point, made a naive
 * extractor produce nonsense.
 *
 * Two of them exist because an adversarial review found defects this corpus could not
 * reach, which is the more useful lesson: a corpus of *realistic* pages only ever tests
 * the paths realistic pages take. `pathological` carries the awkward-but-legal markup —
 * uppercase `LANG=`/`ROLE=`, an `itemprop` named `toString`, a `<base target>` shadowing
 * the real `<base href>`, JSON-LD that is only site furniture, a date no parser should
 * guess at, an article four wrapper divs above its paragraphs. `rendering-corners`
 * carries the markdown constructs that were silently lost or emitted broken — a list
 * nested directly in a list, `<dl>`, `<ol start>`, a line of tildes, adjacent emphasis
 * runs, a ragged table, `<textarea>` (RCDATA) beside `<xmp>` (RAWTEXT).
 */
export async function loadFixtures(): Promise<Fixture[]> {
	const out: Fixture[] = [];
	for await (const entry of Deno.readDir(FIXTURES_DIR)) {
		if (!entry.isDirectory) continue;
		const dir = join(FIXTURES_DIR, entry.name);
		try {
			out.push({
				name: entry.name,
				dir,
				html: await Deno.readTextFile(join(dir, "input.html")),
			});
		} catch {
			// a case directory without an input.html is not a fixture
		}
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** Loads a single fixture by directory name. */
export async function loadFixture(name: string): Promise<Fixture> {
	const dir = join(FIXTURES_DIR, name);
	return { name, dir, html: await Deno.readTextFile(join(dir, "input.html")) };
}

/**
 * Compares a rendering against its golden file, or writes the golden file when
 * `UPDATE_GOLDEN=1`.
 *
 * Golden files are the point of the markdown/text suites: whitespace rules are exactly
 * the kind of thing that regresses invisibly in a unit assertion but jumps out of a diff.
 */
export async function assertGolden(
	fixture: Fixture,
	file: string,
	actual: string,
): Promise<void> {
	const path = join(fixture.dir, file);
	const update = Deno.env.get("UPDATE_GOLDEN") === "1";
	if (update) {
		await Deno.writeTextFile(path, actual);
		return;
	}
	let expected: string;
	try {
		expected = await Deno.readTextFile(path);
	} catch {
		throw new Error(
			`missing golden file ${path} — run \`deno task test:golden\` to create it`,
		);
	}
	if (expected !== actual) {
		const { assertEquals } = await import("@std/assert");
		assertEquals(
			actual,
			expected,
			`golden mismatch for ${fixture.name}/${file} — review the diff, then run ` +
				`\`deno task test:golden\` if the new output is correct`,
		);
	}
}
