import { describe, expect, it, vi } from "vitest"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { extractValidityFromText } from "./mongodb-temporal-extraction.js"

const REFERENCE = new Date("2024-03-15T00:00:00.000Z")

function providerReturning(content: string): {
	provider: EnrichmentProvider
	calls: Array<{ messages: Array<{ role: string; content: string }> }>
} {
	const calls: Array<{ messages: Array<{ role: string; content: string }> }> =
		[]
	const provider: EnrichmentProvider = {
		name: "mock",
		chatCompletion: vi.fn(async (params) => {
			calls.push({ messages: params.messages })
			return { content }
		}),
	}
	return { provider, calls }
}

describe("extractValidityFromText", () => {
	it("returns an extracted validFrom when the text states an explicit start date", async () => {
		const { provider } = providerReturning(
			JSON.stringify({ validFrom: "2021-01-01", validTo: null }),
		)
		const result = await extractValidityFromText({
			provider,
			model: "m",
			text: "The user has worked at Acme since 2021.",
			referenceTime: REFERENCE,
		})
		expect(result.source).toBe("extracted")
		expect(result.validFrom?.toISOString()).toBe("2021-01-01T00:00:00.000Z")
		expect(result.validTo).toBeUndefined()
	})

	it("extracts a closed validity window (validFrom and validTo)", async () => {
		const { provider } = providerReturning(
			JSON.stringify({ validFrom: "2022-06-01", validTo: "2023-09-30" }),
		)
		const result = await extractValidityFromText({
			provider,
			model: "m",
			text: "The user lived in Berlin from mid-2022 until September 2023.",
			referenceTime: REFERENCE,
		})
		expect(result.source).toBe("extracted")
		expect(result.validFrom?.toISOString()).toBe("2022-06-01T00:00:00.000Z")
		expect(result.validTo?.toISOString()).toBe("2023-09-30T00:00:00.000Z")
	})

	it("falls back EXPLICITLY to the reference time (never null/undefined) when no date is present", async () => {
		const { provider } = providerReturning(
			JSON.stringify({ validFrom: null, validTo: null }),
		)
		const result = await extractValidityFromText({
			provider,
			model: "m",
			text: "The user likes coffee.",
			referenceTime: REFERENCE,
		})
		expect(result.source).toBe("reference")
		expect(result.validFrom?.toISOString()).toBe(REFERENCE.toISOString())
		expect(result.validTo).toBeUndefined()
	})

	it("degrades to the reference-time fallback (not the write clock) when the LLM call throws", async () => {
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn(async () => {
				throw new Error("network down")
			}),
		}
		const result = await extractValidityFromText({
			provider,
			model: "m",
			text: "The user has a dog.",
			referenceTime: REFERENCE,
		})
		expect(result.source).toBe("reference")
		expect(result.validFrom?.toISOString()).toBe(REFERENCE.toISOString())
	})

	it("degrades to the reference-time fallback when the response is not valid JSON", async () => {
		const { provider } = providerReturning("not json at all")
		const result = await extractValidityFromText({
			provider,
			model: "m",
			text: "The user has a cat.",
			referenceTime: REFERENCE,
		})
		expect(result.source).toBe("reference")
		expect(result.validFrom?.toISOString()).toBe(REFERENCE.toISOString())
	})

	it("drops an invalid/unparseable extracted date and falls back to reference time", async () => {
		const { provider } = providerReturning(
			JSON.stringify({ validFrom: "sometime last year", validTo: null }),
		)
		const result = await extractValidityFromText({
			provider,
			model: "m",
			text: "The user moved recently.",
			referenceTime: REFERENCE,
		})
		expect(result.source).toBe("reference")
		expect(result.validFrom?.toISOString()).toBe(REFERENCE.toISOString())
	})

	it("ignores a validTo that precedes validFrom (impossible window)", async () => {
		const { provider } = providerReturning(
			JSON.stringify({ validFrom: "2023-01-01", validTo: "2022-01-01" }),
		)
		const result = await extractValidityFromText({
			provider,
			model: "m",
			text: "garbled window",
			referenceTime: REFERENCE,
		})
		expect(result.source).toBe("extracted")
		expect(result.validFrom?.toISOString()).toBe("2023-01-01T00:00:00.000Z")
		expect(result.validTo).toBeUndefined()
	})

	it("passes the reference date to the model so it can resolve relative expressions", async () => {
		const { provider, calls } = providerReturning(
			JSON.stringify({ validFrom: null, validTo: null }),
		)
		await extractValidityFromText({
			provider,
			model: "m",
			text: "since last spring",
			referenceTime: REFERENCE,
		})
		const userMsg = calls[0]?.messages.find((m) => m.role === "user")?.content
		expect(userMsg).toContain("2024-03-15")
	})
})
