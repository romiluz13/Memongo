import { configDefaults, defineConfig } from "vitest/config"

// The e2e QA case drives a live answer+judge round trip, so it needs a
// give-up budget an order of magnitude above Vitest's 5s default — the unit
// corpus is fully mocked and finishes in milliseconds regardless.
//
// CI (GitHub Actions sets CI=true) additionally emits JUnit XML to
// test-results/junit.xml, which scripts/ci/verify-tests-ran.mjs parses to
// fail the build when a green run turns out to contain no executed tests
// (the corpus unit tests here, the live-LLM QA suite in the nightly).
// Locally (CI unset) the default reporter stays the only one.
export default defineConfig({
	test: {
		// Unit-only default selection: the live-LLM e2e suite is excluded at
		// the config layer (config.exclude replaces the documented defaults,
		// re-stated via configDefaults) and selected explicitly via
		// vitest.e2e.config.ts.
		exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
		testTimeout: 240_000,
		reporters: process.env.CI
			? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
			: "default",
	},
})
