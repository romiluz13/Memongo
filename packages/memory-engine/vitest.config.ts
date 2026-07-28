import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		// The e2e suites all share one MongoDB container, and their beforeAll
		// hooks do real work against it — ensureCollections, ~90 standard
		// indexes, up to 14 search indexes. Vitest's 10s default is a budget for
		// an unloaded machine, and every file added to the tier-A gate makes it
		// tighter for the others.
		//
		// This was not a theoretical limit: a hook that blows the budget fails
		// the suite and SKIPS its tests, so the gate quietly reported fewer
		// checks than it claimed to run rather than reporting a failure. Set it
		// once here so a new e2e file cannot re-break the existing ones.
		//
		// This is a give-up budget, not an expected runtime — a genuinely hung
		// hook still fails, just later.
		hookTimeout: 240_000,
	},
})
