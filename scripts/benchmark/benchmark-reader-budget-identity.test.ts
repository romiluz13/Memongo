import { describe, expect, it } from "vitest"
import {
	BENCHMARK_CONFIGURATION_COVERAGE,
	hasCompleteConfigurationCoverage,
} from "./benchmark-run-configuration-schema.js"
import { benchmarkArmConfiguration } from "./benchmark-arms.js"
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

// custom-v4 widens the protocol value lists and adds no key, so the
// coverage marker stays; resume already refuses a changed executable.
describe("reader contract identity", () => {
	it("records a custom-v4 run manifest as covered, distinct from custom-v3", () => {
		const v3 = producedRunConfiguration({
			MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v3",
		})
		const v4 = producedRunConfiguration({
			MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v4",
		})
		const settings = v4.configuration.settings
		expect(settings["env.MEMONGO_BENCHMARK_QA_PROTOCOL"]).toBe("custom-v4")
		expect(hasCompleteConfigurationCoverage(settings)).toBe(true)
		expect(v4.configurationHash).not.toBe(v3.configurationHash)
	})

	it("records custom-v4 arm manifests as covered", () => {
		const run = producedRunConfiguration().configuration
		for (const sessionTurnRecall of [false, true]) {
			const arm = benchmarkArmConfiguration(run, {
				name: sessionTurnRecall ? "v4r" : "v4",
				protocol: "custom-v4",
				sessionTurnRecall,
			})
			expect(arm.configuration.settings.benchmarkArmQaProtocol).toBe(
				"custom-v4",
			)
			expect(hasCompleteConfigurationCoverage(arm.configuration.settings)).toBe(
				true,
			)
		}
	})

	// Hashes computed at 2ab6bdc4af, before custom-v4 existed.
	it("leaves custom-v3 manifests and their hashes unchanged", () => {
		const v3 = producedRunConfiguration({
			MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v3",
		})
		expect(v3.configurationHash).toBe(
			"df22a40620cb7d9db2a388b263dfe07c60fc669761d467b5ca76140c832b335a",
		)
		const run = producedRunConfiguration().configuration
		const arm = (name: string, sessionTurnRecall: boolean) =>
			benchmarkArmConfiguration(run, {
				name,
				protocol: "custom-v3",
				sessionTurnRecall,
			}).configurationHash
		expect(arm("v3", false)).toBe(
			"81319f18a79b52353cbf99047c1ecde619c8cf96233e10df800a44989ca75e62",
		)
		expect(arm("v3r", true)).toBe(
			"d96542efd0e90603250031edfec1ae7aabf59e71963f1b6e12e745a0d3a37294",
		)
		expect(BENCHMARK_CONFIGURATION_COVERAGE).toBe("b02-keyed-v9")
	})
})
