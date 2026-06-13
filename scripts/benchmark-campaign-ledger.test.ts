import { describe, expect, it } from "vitest"
import {
	benchmarkCampaignLedger,
	renderBenchmarkCampaignLedgerMarkdown,
} from "./benchmark-campaign-ledger.js"

describe("benchmark campaign ledger", () => {
	it("tracks the required competitor order", () => {
		expect(benchmarkCampaignLedger.map((row) => row.competitor)).toEqual([
			"Mem0",
			"Mem0",
			"Mem0",
			"Supermemory / MemoryBench",
			"Zep",
			"Mastra",
			"Hindsight",
			"OpenViking / OpenClaw Eval",
			"MemPalace",
			"Letta",
		])
	})

	it("requires artifacts and stop conditions for every row", () => {
		for (const row of benchmarkCampaignLedger) {
			expect(row.requiredArtifacts.length).toBeGreaterThan(0)
			expect(row.stopConditions.length).toBeGreaterThan(0)
			expect(row.nextGate.length).toBeGreaterThan(40)
		}
	})

	it("keeps non-proved ecosystem rows out of win status", () => {
		const unprovedRows = benchmarkCampaignLedger.filter(
			(row) => row.competitor !== "MemPalace",
		)
		expect(
			unprovedRows.some((row) => row.memongoStatus === "memongo-win"),
		).toBe(false)
	})

	it("renders markdown for publication review", () => {
		const markdown = renderBenchmarkCampaignLedgerMarkdown()
		expect(markdown).toContain("# Benchmark Campaign Ledger")
		expect(markdown).toContain("Mem0")
		expect(markdown).toContain("question-id")
		expect(markdown).toContain("Letta")
	})
})
