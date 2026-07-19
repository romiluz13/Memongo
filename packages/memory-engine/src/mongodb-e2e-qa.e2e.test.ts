/**
 * End-to-end QA proof (issue #24 / Wave 4).
 *
 * Runs the REAL answer+judge producer against a live LLM over hand-built QA
 * cases and asserts (a) correct answers grounded in context are judged correct
 * (accuracy high), and (b) the decoy probe shows the live judge is not lenient
 * (low judgeFalsePositiveRate). Skipped unless a provider is configured.
 *
 * Run (from packages/memory-engine):
 *   MEMONGO_ENRICHMENT_API_KEY=... MEMONGO_ENRICHMENT_BASE_URL=... \
 *   MEMONGO_ENRICHMENT_MODEL=... MEMONGO_ENRICHMENT_AUTH_STYLE=api-key \
 *   MEMONGO_ENRICHMENT_PROVIDER=openai-compatible \
 *   vitest run src/mongodb-e2e-qa.e2e.test.ts --testTimeout=240000
 */
import { describe, expect, it } from "vitest"
import { runE2eQa } from "./mongodb-e2e-qa.js"
import { resolveEnrichmentProvider } from "./mongodb-llm-enrichment.js"

const provider = (() => {
	try {
		return resolveEnrichmentProvider(process.env)
	} catch {
		return null
	}
})()
const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""

describe.skipIf(!provider)("e2e QA answer+judge (live LLM)", () => {
	it("answers grounded questions correctly and the judge rejects decoys", async () => {
		if (!provider) return
		const envelope = await runE2eQa({
			provider,
			model,
			cases: [
				{
					caseId: "1",
					question: "Which city does the user live in?",
					goldAnswer: "Berlin",
					contextPassages: [
						"The user moved to Berlin in 2019 and still lives there.",
						"The user enjoys cycling on weekends.",
					],
				},
				{
					caseId: "2",
					question: "What database does the user rely on?",
					goldAnswer: "MongoDB",
					contextPassages: [
						"The user runs their production workloads on MongoDB Atlas.",
					],
				},
				{
					caseId: "3",
					question: "What language does the user write their services in?",
					goldAnswer: "TypeScript",
					contextPassages: [
						"Every backend service the user maintains is written in TypeScript.",
					],
				},
			],
		})
		console.log("e2eQa envelope ->", JSON.stringify(envelope))
		expect(envelope.judge).toBe(model)
		expect(envelope.judgeVersion).toBe("v1")
		// Grounded answers should be recovered and judged correct.
		expect(envelope.accuracy).toBeGreaterThanOrEqual(0.66)
		// A trustworthy judge rejects the known-wrong decoys.
		expect(envelope.judgeFalsePositiveRate).toBeLessThanOrEqual(0.34)
	}, 240000)
})
