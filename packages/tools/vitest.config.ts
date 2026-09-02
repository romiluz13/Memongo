import { defineConfig } from "vitest/config"

// CI (GitHub Actions sets CI=true) additionally emits JUnit XML to
// test-results/junit.xml, which scripts/ci/verify-tests-ran.mjs parses to
// fail the build when a green run turns out to contain no executed tests.
// Locally (CI unset) the default reporter stays the only one.
export default defineConfig({
	test: {
		reporters: process.env.CI
			? ["default", ["junit", { outputFile: "test-results/junit.xml" }]]
			: "default",
	},
})
