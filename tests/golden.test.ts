import { extract, toMarkdown, toText } from "../src/mod.ts";
import { assertGolden, loadFixtures } from "./_fixtures.ts";

// Golden-file tests over the fixture corpus (design §11). Whitespace rules regress
// invisibly in hand-written assertions and jump straight out of a diff, so the markdown
// and text renderings of every fixture are checked byte-for-byte.
//
// Regenerate after a deliberate change:  deno task test:golden

const BASE_URL: Record<string, string> = {
	"news-article": "https://sentinel.example/news/2024/harbour-crane-collapse",
	"docs-page": "https://docs.widgetworks.dev/api/rate-limiting",
	"product-jsonld": "https://shop.bergwerk.at/p/vertigo-2",
	"nextjs-app": "https://flourish.example/journal/sourdough-starter-day-14",
	"nav-only": "https://northfield-pc.example/sitemap",
	"tables-and-code": "https://bench.example/report",
	"broken-truncated": "https://mairie.example/seances/4-avril",
	"broken-soup": "https://geocities.example/~me/index.html",
	"fragment-email": "https://mail.example/message/88213",
	"pathological": "https://notes.example/logs/tide-gauge",
	"rendering-corners": "https://notes.example/logs/rig",
};

for (const fixture of await loadFixtures()) {
	const url = BASE_URL[fixture.name];

	Deno.test(`golden: ${fixture.name} markdown`, async () => {
		const doc = extract(fixture.html, { url });
		// the main content when there is one, the whole document otherwise — a fixture
		// with no identifiable content still has a rendering worth regression-testing
		const md = doc.content
			? doc.content.markdown()
			: toMarkdown(fixture.html, { url });
		await assertGolden(fixture, "expected.md", md);
	});

	Deno.test(`golden: ${fixture.name} text`, async () => {
		const doc = extract(fixture.html, { url });
		const txt = doc.content ? doc.content.text() : toText(fixture.html);
		await assertGolden(fixture, "expected.txt", txt);
	});

	Deno.test(`golden: ${fixture.name} structured data`, async () => {
		const doc = extract(fixture.html, { url });
		const summary = {
			title: doc.title,
			lang: doc.lang,
			metadata: doc.metadata,
			jsonLd: doc.jsonLd,
			embeddedJsonKeys: Object.keys(doc.embeddedJson).sort(),
			microdata: doc.microdata,
			content: doc.content
				? {
					via: doc.content.via,
					textLength: doc.content.textLength,
					linkDensity: Number(doc.content.linkDensity.toFixed(2)),
				}
				: null,
		};
		await assertGolden(
			fixture,
			"expected.json",
			`${JSON.stringify(summary, null, "\t")}\n`,
		);
	});
}
