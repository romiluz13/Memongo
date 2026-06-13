import { describe, expect, it } from "vitest"
import {
	renderMemoryCapabilityFixtureGatesMarkdown,
	runMemoryCapabilityFixtureGates,
} from "./memory-capability-fixture-gates.js"

describe("memory capability fixture gates", () => {
	it("runs the generic product gates without question-id fixtures", () => {
		const report = runMemoryCapabilityFixtureGates("2026-06-10T00:00:00.000Z")

		expect(report.total).toBeGreaterThanOrEqual(4)
		expect(report.ok).toBe(true)
		expect(report.results.map((result) => result.capabilityId)).toContain(
			"count-current-state",
		)
		expect(JSON.stringify(report)).not.toMatch(/\b[a-f0-9]{8}\b/i)
	})

	it("renders markdown gate output", () => {
		const report = runMemoryCapabilityFixtureGates("2026-06-10T00:00:00.000Z")
		const markdown = renderMemoryCapabilityFixtureGatesMarkdown(report)

		expect(markdown).toContain("# Memory Capability Fixture Gate Results")
		expect(markdown).toContain("Count source-backed current-state")
		expect(markdown).toContain("pass")
	})
})
