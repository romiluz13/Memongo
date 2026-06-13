import { describe, expect, it } from "vitest"
import {
	fixtureForCapability,
	memoryCapabilityFixtures,
	renderMemoryCapabilityFixturesMarkdown,
	type MemoryCapabilityId,
} from "./memory-capability-fixtures.js"

const requiredCapabilities: MemoryCapabilityId[] = [
	"multi-session-current-state",
	"retrieval-coverage",
	"temporal-reasoning",
	"assistant-recall",
	"count-current-state",
	"answer-context-packing",
	"preference-memory",
	"judge-contract",
]

describe("memory capability fixtures", () => {
	it("covers every benchmark-blocking memory capability", () => {
		for (const capabilityId of requiredCapabilities) {
			const fixture = fixtureForCapability(capabilityId)
			expect(fixture?.minimumScenario.length).toBeGreaterThan(40)
			expect(fixture?.mongoCapabilities.length).toBeGreaterThan(0)
			expect(fixture?.acceptance.length).toBeGreaterThan(1)
			expect(fixture?.stopCondition).toContain("Stop")
		}
	})

	it("keeps fixtures generic rather than benchmark-question specific", () => {
		const serialized = JSON.stringify(memoryCapabilityFixtures)
		expect(serialized).not.toMatch(/\b[a-f0-9]{8}\b/i)
		expect(serialized).not.toContain("gold answer")
		expect(serialized).toContain("no question-id")
	})

	it("renders markdown for artifact publication", () => {
		const markdown = renderMemoryCapabilityFixturesMarkdown()
		expect(markdown).toContain("# Memory Capability Fixtures")
		expect(markdown).toContain("Multi-session current-state")
		expect(markdown).toContain("MongoDB capabilities")
	})
})
