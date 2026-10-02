import { configDefaults, defineConfig } from "vitest/config"

import unitConfig from "./vitest.config.js"

// Deliberate live config: the unit config extends the default excludes with
// the package-wide *.e2e.test.ts boundary, and a CLI --exclude can only
// append, so restoring the documented defaults has to happen in a config.
// Timeouts and reporters are spread from the unit config so both files keep
// one source for the shared policy; direct object spread is used rather
// than Vite's mergeConfig, which concatenates arrays and would retain the
// unit exclude.
export default defineConfig({
	...unitConfig,
	test: {
		...unitConfig.test,
		exclude: [...configDefaults.exclude],
	},
})
