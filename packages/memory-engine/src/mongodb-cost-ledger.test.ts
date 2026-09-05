/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock schema-collections before importing module under test
// ---------------------------------------------------------------------------

vi.mock("./mongodb-schema-collections.js", () => ({
	costLedgerCollection: vi.fn(),
}))

import { costLedgerCollection } from "./mongodb-schema-collections.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import {
	costLedgerDay,
	recordLLMSpend,
	recordEmbeddingSpend,
	getDailyCostSums,
	instrumentProviderCostSpend,
} from "./mongodb-cost-ledger.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCollection(): Collection<Document> {
	return {
		updateOne: vi.fn().mockResolvedValue({ upsertedId: null }),
		aggregate: vi
			.fn()
			.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
	} as unknown as Collection<Document>
}

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const DAY = new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// costLedgerDay
// ---------------------------------------------------------------------------

describe("costLedgerDay", () => {
	it("returns UTC YYYY-MM-DD for an explicit date", () => {
		expect(costLedgerDay(new Date("2026-08-14T23:59:59.999Z"))).toBe(
			"2026-08-14",
		)
	})

	it("rolls over at UTC midnight, not local midnight", () => {
		// 2026-08-15T00:00:00.001Z is 08-15 in every timezone's UTC view
		expect(costLedgerDay(new Date("2026-08-15T00:00:00.001Z"))).toBe(
			"2026-08-15",
		)
	})
})

// ---------------------------------------------------------------------------
// recordLLMSpend
// ---------------------------------------------------------------------------

describe("recordLLMSpend", () => {
	let mockCol: Collection<Document>

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(costLedgerCollection).mockReturnValue(mockCol)
	})

	it("upserts a kind=llm doc with both token counters", () => {
		recordLLMSpend({} as Db, PREFIX, AGENT_ID, {
			inputTokens: 120,
			outputTokens: 30,
		})

		expect(costLedgerCollection).toHaveBeenCalledWith({}, PREFIX)
		const [filter, update, options] = vi.mocked(mockCol.updateOne).mock.calls[0]
		expect(filter).toEqual({ agentId: AGENT_ID, day: DAY, kind: "llm" })
		expect((update as Document).$inc).toEqual({
			inputTokens: 120,
			outputTokens: 30,
		})
		expect((update as Document).$set.updatedAt).toBeInstanceOf(Date)
		expect((update as Document).$setOnInsert.createdAt).toBeInstanceOf(Date)
		expect(options).toEqual({ upsert: true })
	})

	it("records input-only when output tokens are missing", () => {
		recordLLMSpend({} as Db, PREFIX, AGENT_ID, { inputTokens: 50 })

		const [filter, update] = vi.mocked(mockCol.updateOne).mock.calls[0]
		expect((filter as Document).kind).toBe("llm")
		expect((update as Document).$inc).toEqual({ inputTokens: 50 })
	})

	it("floors fractional token counts", () => {
		recordLLMSpend({} as Db, PREFIX, AGENT_ID, {
			inputTokens: 10.9,
			outputTokens: 0.9,
		})

		const [, update] = vi.mocked(mockCol.updateOne).mock.calls[0]
		expect((update as Document).$inc).toEqual({
			inputTokens: 10,
			outputTokens: 0,
		})
	})

	it("is a no-op when both counts are missing", () => {
		recordLLMSpend({} as Db, PREFIX, AGENT_ID, {})
		expect(mockCol.updateOne).not.toHaveBeenCalled()
	})

	it("is a no-op for zero, negative, and non-finite counts", () => {
		recordLLMSpend({} as Db, PREFIX, AGENT_ID, {
			inputTokens: 0,
			outputTokens: -5,
		})
		recordLLMSpend({} as Db, PREFIX, AGENT_ID, {
			inputTokens: Number.NaN,
		})
		recordLLMSpend({} as Db, PREFIX, AGENT_ID, {
			inputTokens: Number.POSITIVE_INFINITY,
		})
		expect(mockCol.updateOne).not.toHaveBeenCalled()
	})

	it("never throws when the ledger write rejects", () => {
		vi.mocked(mockCol.updateOne).mockReturnValue(
			Promise.reject(new Error("ledger down")) as never,
		)
		expect(() =>
			recordLLMSpend({} as Db, PREFIX, AGENT_ID, { inputTokens: 1 }),
		).not.toThrow()
	})
})

// ---------------------------------------------------------------------------
// recordEmbeddingSpend
// ---------------------------------------------------------------------------

describe("recordEmbeddingSpend", () => {
	let mockCol: Collection<Document>

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(costLedgerCollection).mockReturnValue(mockCol)
	})

	it("upserts embedUnits for each embedding channel kind", () => {
		for (const kind of [
			"search",
			"cache-probe",
			"consolidation",
			"indexing",
		] as const) {
			vi.clearAllMocks()
			recordEmbeddingSpend({} as Db, PREFIX, AGENT_ID, kind, 3)
			const [filter, update, options] = vi.mocked(mockCol.updateOne).mock
				.calls[0]
			expect(filter).toEqual({ agentId: AGENT_ID, day: DAY, kind })
			expect((update as Document).$inc).toEqual({ embedUnits: 3 })
			expect(options).toEqual({ upsert: true })
		}
	})

	it("is a no-op for zero, negative, and non-finite units", () => {
		recordEmbeddingSpend({} as Db, PREFIX, AGENT_ID, "search", 0)
		recordEmbeddingSpend({} as Db, PREFIX, AGENT_ID, "indexing", -1)
		recordEmbeddingSpend({} as Db, PREFIX, AGENT_ID, "search", Number.NaN)
		recordEmbeddingSpend(
			{} as Db,
			PREFIX,
			AGENT_ID,
			"search",
			Number.POSITIVE_INFINITY,
		)
		expect(mockCol.updateOne).not.toHaveBeenCalled()
	})

	it("floors fractional units", () => {
		recordEmbeddingSpend({} as Db, PREFIX, AGENT_ID, "consolidation", 2.7)
		const [, update] = vi.mocked(mockCol.updateOne).mock.calls[0]
		expect((update as Document).$inc).toEqual({ embedUnits: 2 })
	})

	it("never throws when the ledger write rejects", () => {
		vi.mocked(mockCol.updateOne).mockReturnValue(
			Promise.reject(new Error("ledger down")) as never,
		)
		expect(() =>
			recordEmbeddingSpend({} as Db, PREFIX, AGENT_ID, "search", 1),
		).not.toThrow()
	})
})

// ---------------------------------------------------------------------------
// getDailyCostSums
// ---------------------------------------------------------------------------

describe("getDailyCostSums", () => {
	let mockCol: Collection<Document>

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(costLedgerCollection).mockReturnValue(mockCol)
	})

	it("matches the tenant and a trailing-day window, sums ascending by day", async () => {
		const toArrayFn = vi.fn().mockResolvedValue([
			{
				_id: "2026-08-13",
				inputTokens: 100,
				outputTokens: 40,
				embedUnits: 5,
			},
			{
				_id: "2026-08-14",
				inputTokens: 200,
				outputTokens: 80,
				embedUnits: 7,
			},
		])
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: toArrayFn,
		} as never)

		const sums = await getDailyCostSums({} as Db, PREFIX, AGENT_ID, 30)

		// Pipeline shape: match -> group with $ifNull sums -> ascending sort
		const [pipeline] = vi.mocked(mockCol.aggregate).mock.calls[0]
		const stages = pipeline as Document[]
		expect(stages).toHaveLength(3)
		const match = stages[0].$match as Document
		expect(match.agentId).toBe(AGENT_ID)
		const startDay = match.day as { $gte: string }
		expect(startDay.$gte).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		// 30-day inclusive window starts 29 days before today
		const expectedStart = costLedgerDay(new Date(Date.now() - 29 * 86_400_000))
		expect(startDay.$gte).toBe(expectedStart)
		const group = stages[1].$group as Document
		expect(group._id).toBe("$day")
		expect((group.inputTokens as Document).$sum.$ifNull).toEqual([
			"$inputTokens",
			0,
		])
		expect((stages[2].$sort as Document)._id).toBe(1)

		expect(sums).toEqual([
			{
				day: "2026-08-13",
				inputTokens: 100,
				outputTokens: 40,
				embedUnits: 5,
			},
			{
				day: "2026-08-14",
				inputTokens: 200,
				outputTokens: 80,
				embedUnits: 7,
			},
		])
	})

	it("clamps the window to at least one day", async () => {
		await getDailyCostSums({} as Db, PREFIX, AGENT_ID, 0)

		const [pipeline] = vi.mocked(mockCol.aggregate).mock.calls[0]
		const match = (pipeline as Document[])[0].$match as Document
		const startDay = match.day as { $gte: string }
		expect(startDay.$gte).toBe(costLedgerDay(new Date()))
	})

	it("returns [] when no documents match", async () => {
		const sums = await getDailyCostSums({} as Db, PREFIX, AGENT_ID, 30)
		expect(sums).toEqual([])
	})

	it("returns [] on aggregation failure (best-effort contract)", async () => {
		vi.mocked(mockCol.aggregate).mockReturnValue({
			toArray: vi.fn().mockRejectedValue(new Error("aggregate failed")),
		} as never)

		const sums = await getDailyCostSums({} as Db, PREFIX, AGENT_ID, 30)
		expect(sums).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// instrumentProviderCostSpend
// ---------------------------------------------------------------------------

describe("instrumentProviderCostSpend", () => {
	let mockCol: Collection<Document>

	beforeEach(() => {
		vi.clearAllMocks()
		mockCol = createMockCollection()
		vi.mocked(costLedgerCollection).mockReturnValue(mockCol)
	})

	const REQUEST = {
		model: "test-model",
		messages: [{ role: "user", content: "hello" }],
	}

	function createInnerProvider(
		chatCompletion: EnrichmentProvider["chatCompletion"],
	): EnrichmentProvider {
		return { name: "inner", chatCompletion }
	}

	it("forwards the request and returns the provider response untouched", async () => {
		const chatCompletion = vi.fn(async () => ({
			content: "ok",
			usage: { inputTokens: 10, outputTokens: 5 },
		}))
		const wrapped = instrumentProviderCostSpend({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			provider: createInnerProvider(chatCompletion),
		})

		const response = await wrapped.chatCompletion(REQUEST)

		expect(chatCompletion).toHaveBeenCalledWith(REQUEST)
		expect(response).toEqual({
			content: "ok",
			usage: { inputTokens: 10, outputTokens: 5 },
		})
	})

	it("records llm spend from the response usage block", async () => {
		const wrapped = instrumentProviderCostSpend({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			provider: createInnerProvider(
				vi.fn(async () => ({
					content: "ok",
					usage: { inputTokens: 10, outputTokens: 5 },
				})),
			),
		})

		await wrapped.chatCompletion(REQUEST)

		expect(mockCol.updateOne).toHaveBeenCalledOnce()
		const [filter, update] = vi.mocked(mockCol.updateOne).mock.calls[0]
		expect((filter as Document).kind).toBe("llm")
		expect((update as Document).$inc).toEqual({
			inputTokens: 10,
			outputTokens: 5,
		})
	})

	it("writes no ledger doc when the response carries no usage", async () => {
		const wrapped = instrumentProviderCostSpend({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			provider: createInnerProvider(vi.fn(async () => ({ content: "ok" }))),
		})

		await wrapped.chatCompletion(REQUEST)

		expect(mockCol.updateOne).not.toHaveBeenCalled()
	})

	it("propagates provider failures without recording spend", async () => {
		const wrapped = instrumentProviderCostSpend({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			provider: createInnerProvider(
				vi.fn(async () => {
					throw new Error("provider down")
				}),
			),
		})

		await expect(wrapped.chatCompletion(REQUEST)).rejects.toThrow(
			"provider down",
		)
		expect(mockCol.updateOne).not.toHaveBeenCalled()
	})

	it("preserves the provider name on the wrapper", async () => {
		const wrapped = instrumentProviderCostSpend({
			db: {} as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			provider: createInnerProvider(vi.fn(async () => ({ content: "ok" }))),
		})

		expect(wrapped.name).toBe("inner")
	})
})
