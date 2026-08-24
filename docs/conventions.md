# Conventions

## File organisation

- `src/mod.ts` is the only public surface. A file that is not re-exported from it is
  internal, whatever it exports.
- `_`-prefixed files (`_dom.ts`, `_util.ts`) are infrastructure and are never re-exported.
- One extractor per file, named after what it extracts.
- Tests mirror sources: `src/x.ts` ↔ `tests/x.test.ts`.

## Naming

- Public: `extractThing` for structured data, `toThing` for renderings, bare verbs
  (`clean`, `pick`) for transforms.
- Internal counterpart: `thingFromDocument`.
- Node-level renderer: `renderThing`.
- Options interface: `ThingOptions extends BaseOptions`.

## The parser

✅ Do:

```ts
import { attr, query, queryAll, serialize } from "./_dom.ts";
const cls = attr(el, "class"); // case-insensitive, parser-quirk aware
```

❌ Don't:

```ts
import { parseHTML } from "linkedom"; // only _dom.ts may do this
const cls = el.getAttribute("class"); // case-sensitive; misses <DIV CLASS=…>
const html = el.innerHTML; // does not re-escape & in attribute values
```

## Error handling

✅ Do — assert the argument type, then degrade on everything else:

```ts
export function extractThing(html: string, options?: ThingOptions): Thing[] {
	assertHtmlString(html, "extractThing");
	const doc = parseDocument(html, options);
	return doc ? thingFromDocument(doc, options) : [];
}
```

❌ Don't — throw on content, or swallow a programmer error:

```ts
if (!html.includes("<html")) throw new Error("not a document"); // never
export function extractThing(html: unknown) {
	try {
		/* … */
	} catch {
		return [];
	} // hides real bugs, including TypeErrors
}
```

Catch only where an operation genuinely can fail: `JSON.parse`, `new URL`, and
user-supplied selectors. The `_dom.ts` helpers already never throw.

## Traversal

✅ Do — iterate with an explicit stack, or cap the depth and degrade:

```ts
walkElements(root, (el, depth) => {
	if (depth > MAX_DEPTH) return false; // skip the subtree
});
```

❌ Don't — recurse over children unbounded. A 20 000-deep document is a real input, and
a `RangeError` breaks the never-throws contract.

## Logging

✅ Do:

```ts
options?.logger?.debug(`[html-extract] json-ld: ${blocks.length} block(s)`);
```

❌ Don't:

```ts
console.warn("skipping block"); // a library must be silent by default
logger.debug(...); // logger is optional — always optional-chain
```

`debug` for routine facts (what was found, which strategy won, what was skipped);
`warn` only for genuinely surprising input (truncation, an invalid selector the caller
passed). Every message is prefixed `[html-extract]`. A caller who injects a logger must
be able to work out _why_ the output looks the way it does without a debugger.

## Types

- Explicit return type on every export — JSR's "no slow types" rule, gated by
  `deno publish --dry-run`.
- Never widen a public result to `any`. `unknown[]` for JSON-LD is deliberate: the shape
  is genuinely unknown and pretending otherwise would be a lie in the type system.
- Options are always a single optional object, never positional booleans.

## Documentation

- Every export gets JSDoc that explains **why**, not just what: the trade-off, the
  failure mode it defends against, the input that made it necessary.
- Public functions get an `@example`. Examples are type-checked by
  `deno task doc:lint`, so declare what they use (`declare const html: string;`).
- Documented defaults live in `src/types.ts` and are repeated in `API.md`. When one
  changes, both change.

## Testing

✅ Do — assert fuzzily against the heuristic:

```ts
assertStringIncludes(content.text(), "a phrase from the article body");
assert(!content.text().includes("Subscribe now"), "nav leaked into content");
```

❌ Don't — pin exact output of a heuristic in a unit test. Golden files exist for exact
output, and they are meant to be re-read when they move.

- Inline HTML strings for unit tests; `tests/fixtures/` for anything corpus-wide.
- Every public function needs a never-throws case and a wrong-argument-type case.
- `deno task test:golden` regenerates goldens. Review the diff before committing it —
  regenerating to make a failure go away is how a regression ships.
