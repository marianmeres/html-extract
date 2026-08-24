import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	dependencies: versionizeDeps(
		[
			// the HTML parser — the package's one and only runtime dependency
			"linkedom",
			// clog is used for its `Logger` type only (type-only import, erased at
			// runtime), but the emitted .d.ts references it, so consumers' tsc must be
			// able to resolve it
			"@marianmeres/clog",
		],
		denoJson,
	),
});
