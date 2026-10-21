import { describe, expect, it } from "vitest"
import {
	BENCHMARK_CONFIGURATION_COVERAGE,
	hasCompleteConfigurationCoverage,
} from "./benchmark-run-configuration-schema.js"
import { producedRunConfiguration } from "./benchmark-run-configuration.fixture.js"

// C-1: session turn recall changes what reaches the answerer, so its flag
// and its frozen constants (R, S, T) are part of the run identity.

describe("session turn recall identity", () => {
	it("records the raw flag, the resolved mode and the frozen constants", () => {
		const unset = producedRunConfiguration()
		const settings = unset.configuration.settings
		expect(settings["env.MEMONGO_SESSION_TURN_RECALL"]).toBeNull()
		expect(settings.effectiveSessionTurnRecall).toBe(false)
		expect(settings.sessionTurnRecallSeedResults).toBe(20)
		expect(settings.sessionTurnRecallSeedSessions).toBe(8)
		expect(settings.sessionTurnRecallTurnsPerSession).toBe(3)
		expect(hasCompleteConfigurationCoverage(settings)).toBe(true)

		const enabled = producedRunConfiguration({
			MEMONGO_SESSION_TURN_RECALL: "enabled",
		})
		expect(
			enabled.configuration.settings["env.MEMONGO_SESSION_TURN_RECALL"],
		).toBe("enabled")
		expect(enabled.configuration.settings.effectiveSessionTurnRecall).toBe(true)
		expect(enabled.configurationHash).not.toBe(unset.configurationHash)

		const other = producedRunConfiguration({
			MEMONGO_SESSION_TURN_RECALL: "on",
		})
		expect(other.configuration.settings.effectiveSessionTurnRecall).toBe(false)
		expect(other.configurationHash).not.toBe(unset.configurationHash)
	})

	it("moves coverage past b02-keyed-v5 so an older manifest does not resume", () => {
		expect(BENCHMARK_CONFIGURATION_COVERAGE).toBe("b02-keyed-v6")
	})
})
