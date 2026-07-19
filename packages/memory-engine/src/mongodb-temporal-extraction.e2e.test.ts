/**
 * Valid-time extraction proof (issue #32).
 *
 * Runs the REAL LLM temporal extractor over labeled cases and asserts it
 * recovers explicit dates and falls back to the reference time when none are
 * present. Skipped unless a live enrichment provider is configured, so it never
 * fabricates a passing result from a mock.
 *
 * Run (from packages/memory-engine):
 *   MEMONGO_ENRICHMENT_API_KEY=... MEMONGO_ENRICHMENT_BASE_URL=... \
 *   MEMONGO_ENRICHMENT_MODEL=... MEMONGO_ENRICHMENT_AUTH_STYLE=api-key \
 *   MEMONGO_ENRICHMENT_PROVIDER=openai-compatible \
 *   vitest run src/mongodb-temporal-extraction.e2e.test.ts --testTimeout=180000
 */

import { describe, expect, it } from "vitest"
import { resolveEnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { extractValidityFromText } from "./mongodb-temporal-extraction.js"

const provider = (() => {
	try {
		return resolveEnrichmentProvider(process.env)
	} catch {
		return null
	}
})()
const model = process.env.MEMONGO_ENRICHMENT_MODEL?.trim() ?? ""
const REFERENCE = new Date("2024-03-15T00:00:00.000Z")

describe.skipIf(!provider)("valid-time extraction (live LLM)", () => {
	it("extracts an explicit start date from 'since 2021'", async () => {
		if (!provider) return
		const result = await extractValidityFromText({
			provider,
			model,
			text: "The user has worked at Acme since 2021.",
			referenceTime: REFERENCE,
		})
		console.log("since-2021 ->", JSON.stringify(result))
		expect(result.source).toBe("extracted")
		expect(result.validFrom.getUTCFullYear()).toBe(2021)
	})

	it("extracts a closed window with a real validTo", async () => {
		if (!provider) return
		const result = await extractValidityFromText({
			provider,
			model,
			text: "The user lived in Berlin from mid-2022 until September 2023.",
			referenceTime: REFERENCE,
		})
		console.log("closed-window ->", JSON.stringify(result))
		expect(result.source).toBe("extracted")
		expect(result.validFrom.getUTCFullYear()).toBe(2022)
		expect(result.validTo).toBeDefined()
		expect(result.validTo?.getUTCFullYear()).toBe(2023)
	})

	it("falls back to the reference time (not the write clock) when no date is present", async () => {
		if (!provider) return
		const result = await extractValidityFromText({
			provider,
			model,
			text: "The user likes coffee.",
			referenceTime: REFERENCE,
		})
		console.log("no-date ->", JSON.stringify(result))
		expect(result.source).toBe("reference")
		expect(result.validFrom.toISOString()).toBe(REFERENCE.toISOString())
		expect(result.validTo).toBeUndefined()
	})
})
