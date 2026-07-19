/**
 * Fact-extraction recall proof (issue #30, slice 3).
 *
 * Runs the REAL LLM extractor against the deterministic regex baseline over the
 * labeled fixture and asserts the LLM recovers at least as many ground-truth
 * facts as regex. This is the honest gate for the "LLM extraction beats regex"
 * claim — it is skipped unless a live enrichment provider is configured, so it
 * never fabricates a passing number from a mock.
 *
 * Run (from packages/memory-engine):
 *   MEMONGO_ENRICHMENT_API_KEY=... \
 *   MEMONGO_ENRICHMENT_BASE_URL=... \
 *   MEMONGO_ENRICHMENT_MODEL=... \
 *   vitest run src/fact-extraction-eval.e2e.test.ts --reporter=verbose
 */

import { describe, expect, it } from "vitest"
import {
	FACT_EXTRACTION_FIXTURE,
	evaluateFactExtractor,
} from "./fact-extraction-eval.js"
import {
	extractLlmStructuredCandidates,
	extractStructuredCandidatesFromEvent,
} from "./mongodb-derived-memory.js"
import { resolveEnrichmentProvider } from "./mongodb-llm-enrichment.js"

const provider = (() => {
	try {
		return resolveEnrichmentProvider(process.env)
	} catch {
		return null
	}
})()
const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""

describe.skipIf(!provider)("fact-extraction recall: LLM vs regex", () => {
	it("LLM recall is at least the regex baseline over the labeled fixture", async () => {
		const regexReport = await evaluateFactExtractor({
			cases: FACT_EXTRACTION_FIXTURE,
			extract: (event) =>
				extractStructuredCandidatesFromEvent(event).map((c) => c.value),
		})

		const llmReport = await evaluateFactExtractor({
			cases: FACT_EXTRACTION_FIXTURE,
			extract: async (event) => {
				if (!provider) return []
				const candidates = await extractLlmStructuredCandidates({
					event,
					provider,
					model,
				})
				return candidates.map((c) => c.value)
			},
		})

		// Surface both numbers so a failing run shows the actual gap.
		console.log(
			`fact-recall — regex: ${regexReport.recall.toFixed(3)}, llm: ${llmReport.recall.toFixed(3)}`,
		)

		// Hard floor: the LLM must never do worse than the deterministic baseline.
		expect(llmReport.recall).toBeGreaterThanOrEqual(regexReport.recall)

		// Real value-add: on the "implicit-*" cases (facts stated with no trigger
		// word), the regex extractor structurally recovers nothing, so any recall
		// there is headroom only the LLM can close. This is the honest proof that
		// the brain adds recall regex cannot — not just a non-regression.
		const implicit = (report: typeof regexReport) =>
			report.perCase
				.filter((c) => c.name.startsWith("implicit-"))
				.reduce((sum, c) => sum + c.matched, 0)

		expect(implicit(regexReport)).toBe(0)
		expect(implicit(llmReport)).toBeGreaterThan(0)
	})
})
