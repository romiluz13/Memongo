import { describe, expect, it } from "vitest"
import {
	BENCHMARK_CONFIGURATION_COVERAGE,
	hasCompleteConfigurationCoverage,
} from "./benchmark-run-configuration-schema.js"
import { producedRunConfiguration } from "./benchmark-run-configuration.fixture.js"

// D: custom-v3 changes what reaches the answerer, so the protocol value,
// the frozen reader budget and its tokenizer are part of the run identity.

describe("reader budget identity", () => {
	it("records custom-v3 as covered, distinct from custom-v2", () => {
		const v2 = producedRunConfiguration({
			MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v2",
		})
		const v3 = producedRunConfiguration({
			MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v3",
		})
		const settings = v3.configuration.settings
		expect(settings["env.MEMONGO_BENCHMARK_QA_PROTOCOL"]).toBe("custom-v3")
		expect(hasCompleteConfigurationCoverage(settings)).toBe(true)
		expect(v3.configurationHash).not.toBe(v2.configurationHash)
	})

	it("records the frozen budget and the tokenizer that estimates it", () => {
		const settings = producedRunConfiguration().configuration.settings
		expect(settings.readerBudgetEstimatedTokens).toBe(16_000)
		expect(settings.readerBudgetTokenizer).toBe("js-tiktoken@1.0.21/o200k_base")
		expect(hasCompleteConfigurationCoverage(settings)).toBe(true)
		const { readerBudgetTokenizer: _, ...withoutTokenizer } = settings
		expect(hasCompleteConfigurationCoverage(withoutTokenizer)).toBe(false)
	})

	it("moves coverage past b02-keyed-v6 so an older manifest does not resume", () => {
		expect(BENCHMARK_CONFIGURATION_COVERAGE).not.toBe("b02-keyed-v6")
	})
})
