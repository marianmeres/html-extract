# Tasks

## Add a new extractor

### Steps

1. Add its types to `src/types.ts`: `ThingOptions extends BaseOptions`, and the result
   shape. Document every default in the JSDoc — `API.md` mirrors this file.
2. Create `src/thing.ts` with **both** entry points (see
   [architecture.md](./architecture.md#the-two-function-pattern)).
3. Re-export the public one from `src/mod.ts`, and its types from the `export type` block.
4. If it belongs in `extract()`: add the flag to `ExtractOptions`, the field to
   `ExtractedDocument` (always present — an empty array/object when switched off), call
   it in `src/extract.ts` **before** `mainContentFromDocument`, and add it to the empty
   result returned when the parse fails.
5. Add `tests/thing.test.ts`, and add the function to both call lists in
   `tests/robustness.test.ts`.
6. Update `API.md`, the `README.md` granular-functions block, and `AGENTS.md`'s file
   layout.

### Template

```ts
export function thingFromDocument(doc: ParsedDocument, options?: ThingOptions): Thing[] {
	const logger = options?.logger;
	// … read doc.root / doc.body, never mutate them …
	logger?.debug(`[html-extract] thing: ${out.length} found`);
	return out;
}

export function extractThing(html: string, options?: ThingOptions): Thing[] {
	assertHtmlString(html, "extractThing");
	const doc = parseDocument(html, options);
	return doc ? thingFromDocument(doc, options) : [];
}
```

### Checklist

- [ ] Never throws except `assertHtmlString`
- [ ] Does not mutate the shared tree (clone if you must rewrite)
- [ ] Explicit return type, JSDoc with `@example`
- [ ] `deno task test && deno lint && deno fmt && deno task doc:lint`
- [ ] `deno publish --dry-run --allow-dirty`

## Add a fixture

### Steps

1. `tests/fixtures/<case>/input.html` — real-world-shaped mess, not tidy HTML. The
   corpus earns its keep by being awkward.
2. Add its base URL to `BASE_URL` in `tests/golden.test.ts` if resolution matters.
3. `deno task test:golden` to create `expected.md`, `expected.txt`, `expected.json`.
4. **Read the three generated files.** They are the review; generating them is not.
5. Add a fuzzy assertion to `tests/extract.test.ts` if the case proves something
   specific.

`tests/fixtures` is excluded from `deno fmt` — the formatter rewrites HTML, and it will
happily repair a deliberately broken document.

## Regenerate goldens after an intentional change

```bash
deno task test:golden
git diff tests/fixtures     # read every hunk
```

A golden diff you cannot explain is a regression, not a golden that needs updating.

## Tune the content heuristic

The knobs are the module constants at the top of `src/main-content.ts` (scoring weights,
`MIN_SCORING_TEXT`, the sibling thresholds) and `POSITIVE_HINTS`/`NEGATIVE_HINTS` in
`src/_util.ts`.

### Steps

1. Add a fixture that reproduces the bad extraction **first**.
2. Change one constant. Run `deno task test` — the fuzzy assertions in
   `tests/extract.test.ts` are your regression net.
3. `deno task test:golden` and read the diff across _all_ fixtures: heuristic tuning
   trades one page's correctness for another's, and the corpus is where you see it.
4. If the fix only works for one site, it is not a fix — that is what `contentSelector`
   is for.

## Swap the HTML parser

### Steps

1. Reimplement `src/_dom.ts` against the new parser. Its exports are the entire contract:
   `parseDocument`, the node predicates, `attr`/`attrs`/`classId`, `children`/
   `childNodes`, `query`/`queryAll`, `remove`/`unwrap`/`cloneElement`, `walkElements`,
   `dropAll`, `serialize`/`serializeChildren`.
2. Update the module JSDoc's quirks list — the next person needs to know what the new
   parser gets wrong.
3. Update `deno.json` `imports` and `scripts/build-npm.ts` `versionizeDeps`.
4. `deno task test`. `tests/_dom.test.ts` covers every quirk the current adapter
   normalizes; if it still passes, the swap is behaviour-preserving.

### Checklist

- [ ] No file outside `_dom.ts` mentions the parser
- [ ] `tests/_dom.test.ts` passes unchanged
- [ ] `deno task npm:build` and a Node smoke test of `.npm-dist/dist/mod.js`
- [ ] Golden diffs reviewed

## Release

```bash
deno task test && deno lint && deno fmt --check && deno task doc:lint
deno publish --dry-run
deno task npm:build          # tsc is stricter than deno check
deno task rp                 # patch release: version bump, JSR + npm publish
```
