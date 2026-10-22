import { describe, expect, it } from "vitest"
import { hashOperationRunConfiguration } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import { benchmarkArmConfiguration } from "./benchmark-arms.js"
import {
	BENCHMARK_CONFIGURATION_COVERAGE,
	hasCompleteConfigurationCoverage,
} from "./benchmark-run-configuration-schema.js"
import { producedRunConfiguration } from "./benchmark-run-configuration.fixture.js"

// The custom QA answer and judge caps decide what a thinking model can
// return, so a run at another cap must not share an identity.

function atCaps(answer: number, judge: number) {
	const { configuration } = producedRunConfiguration()
	return {
		...configuration,
		settings: {
			...configuration.settings,
			customQaAnswerMaxTokens: answer,
			customQaJudgeMaxTokens: judge,
		},
	}
}

describe("custom QA answer cap identity", () => {
	it("records both caps as covered settings", () => {
		const settings = producedRunConfiguration().configuration.settings
		expect(settings.customQaAnswerMaxTokens).toBe(8192)
		expect(settings.customQaJudgeMaxTokens).toBe(8192)
		expect(hasCompleteConfigurationCoverage(settings)).toBe(true)
		const { customQaJudgeMaxTokens: _, ...withoutJudgeCap } = settings
		expect(hasCompleteConfigurationCoverage(withoutJudgeCap)).toBe(false)
		expect(
			hasCompleteConfigurationCoverage({
				...settings,
				customQaAnswerMaxTokens: "8192",
			}),
		).toBe(false)
	})

	it("gives a run at 512 and a run at 8192 different hashes", () => {
		const capped = hashOperationRunConfiguration(atCaps(512, 512))
		const raised = hashOperationRunConfiguration(atCaps(8192, 8192))
		expect(raised).toBe(producedRunConfiguration().configurationHash)
		expect(capped).not.toBe(raised)
		expect(hashOperationRunConfiguration(atCaps(8192, 512))).not.toBe(raised)
	})

	it.each([
		"custom-v1",
		"custom-v2",
		"custom-v3",
	] as const)("gives the %s arm different identities at 512 and 8192", (protocol) => {
		const arm = { name: "a", protocol, sessionTurnRecall: false }
		expect(
			benchmarkArmConfiguration(atCaps(512, 512), arm).configurationHash,
		).not.toBe(
			benchmarkArmConfiguration(atCaps(8192, 8192), arm).configurationHash,
		)
	})

	it("moves coverage past b02-keyed-v8 so an older manifest does not resume", () => {
		expect(BENCHMARK_CONFIGURATION_COVERAGE).toBe("b02-keyed-v9")
	})
})
