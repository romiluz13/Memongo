import { defineConfig } from "vitest/config"

// A remote Atlas cluster is far slower than the local atlas-local container for
// exactly the work the e2e hooks do. Measured against a live cluster: a single
// autoEmbed vector index took ~50s to reach READY, versus near-instant locally,
// and each suite builds up to 14 Search indexes on top of ~90 standard ones.
//
// Budgets tuned for the container therefore fail wholesale against Atlas — and
// they fail in the worst way, because a blown *hook* budget SKIPS the file's
// tests rather than failing them. A run against Atlas reported 190 skipped
// tests, which reads as "green with some gaps" instead of "two of the largest
// suites never executed."
//
// So scale the budgets to the target rather than hardcoding one number for
// both. mongodb+srv:// is the reliable signal: it is the only scheme Atlas
// hands out, and the local container is always a plain mongodb:// host.
const testUri =
	process.env.MONGODB_TEST_URI?.trim() ||
	process.env.MEMONGO_TEST_MONGODB_URI?.trim() ||
	""
const isRemoteCluster = testUri.startsWith("mongodb+srv://")

export default defineConfig({
	test: {
		// The e2e suites all share one MongoDB deployment, and their beforeAll
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
		// These are give-up budgets, not expected runtimes — a genuinely hung
		// hook or test still fails, just later.
		hookTimeout: isRemoteCluster ? 900_000 : 240_000,
		testTimeout: isRemoteCluster ? 600_000 : 120_000,
	},
})
