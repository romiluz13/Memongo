/**
 * Consolidation reasoning proof (issue #31).
 *
 * Runs the REAL deduce/induce primitives against a live LLM and asserts they
 * produce genuine new inferred facts — the honest gate that the reasoning brain
 * is not a silent no-op (it returns [] on truncation, so a too-small token
 * budget would pass a mock but fail here). Skipped unless a provider is set.
 *
 * Run (from packages/memory-engine):
 *   MEMONGO_ENRICHMENT_API_KEY=... MEMONGO_ENRICHMENT_BASE_URL=... \
 *   MEMONGO_ENRICHMENT_MODEL=... MEMONGO_ENRICHMENT_AUTH_STYLE=api-key \
 *   MEMONGO_ENRICHMENT_PROVIDER=openai-compatible \
 *   vitest run src/mongodb-consolidation-reasoning.e2e.test.ts --testTimeout=240000
 */
import { describe, expect, it } from "vitest"
import {
	deduceFactsFromMemories,
	induceFactsFromMemories,
} from "./mongodb-consolidation-reasoning.js"
import { resolveEnrichmentProvider } from "./mongodb-llm-enrichment.js"

const provider = (() => {
	try {
		return resolveEnrichmentProvider(process.env)
	} catch {
		return null
	}
})()
const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""

describe.skipIf(!provider)("consolidation reasoning (live LLM)", () => {
	it("deduces a strictly-entailed new fact", async () => {
		if (!provider) return
		const result = await deduceFactsFromMemories({
			provider,
			model,
			facts: [
				"The user lives in London.",
				"The user commutes to the office by bike every weekday.",
				"The office is in central London.",
			],
		})
		console.log("deduced ->", JSON.stringify(result.map((r) => r.value)))
		expect(result.length).toBeGreaterThan(0)
		expect(result.every((r) => r.kind === "deduction" && r.value)).toBe(true)
	}, 240000)

	it("induces a generalization across a repeated pattern", async () => {
		if (!provider) return
		const result = await induceFactsFromMemories({
			provider,
			model,
			facts: [
				"The user wrote the API service in TypeScript.",
				"The user wrote the web app in TypeScript.",
				"The user wrote the CLI in TypeScript.",
			],
		})
		console.log("induced ->", JSON.stringify(result.map((r) => r.value)))
		expect(result.length).toBeGreaterThan(0)
		expect(result.every((r) => r.kind === "induction" && r.value)).toBe(true)
	}, 240000)
})
