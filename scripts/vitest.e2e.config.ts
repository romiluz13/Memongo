import { configDefaults, defineConfig } from "vitest/config"

import unitConfig from "./vitest.config.js"

// Deliberate live config: restores the documented default excludes so the
// e2e suite is selectable (a CLI --exclude can only append). Timeout and
// reporters are spread from the unit config; direct object spread is used
// rather than Vite's mergeConfig, which concatenates arrays and would
// retain the unit exclude.
export default defineConfig({
	...unitConfig,
	test: {
		...unitConfig.test,
		exclude: [...configDefaults.exclude],
	},
})
