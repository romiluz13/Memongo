import type { Db } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { EnrichmentConfigError } from "./mongodb-llm-enrichment.js"
import {
	getSearchBudgetSnapshot,
	openSearchBudget,
} from "./mongodb-search-budget.js"
import { SearchLaneError } from "./search-outcomes.js"

const seams = vi.hoisted(() => ({
	provider: vi.fn((): unknown => null),
}))

vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => false,
	resolveEnrichmentProvider: seams.provider,
}))

function fixture(aggregate: () => Promise<unknown[]>) {
	const events = {
		find: vi.fn(),
		aggregate: vi.fn(() => ({ toArray: aggregate })),
	}
	const runs = {
		findOneAndUpdate: vi.fn(async () => ({ status: "running" })),
		updateOne: vi.fn(async () => ({ matchedCount: 1 })),
	}
	const gate = { agentId: "agent-1", epoch: 0, state: "open", serial: 0 }
	const meta = {
		findOneAndUpdate: vi.fn(async () => ({ ...gate })),
		findOne: vi.fn(async () => ({ ...gate })),
		updateOne: vi.fn(async () => {
			gate.serial += 1
			return { matchedCount: 1, modifiedCount: 1 }
		}),
	}
	const collection = vi.fn((name: string) => {
		if (name === "test_meta") return meta
		if (name === "test_events") return events
		if (name === "test_consolidation_runs") return runs
		throw new Error(`Unexpected collection: ${name}`)
	})
	const session = {
		inTransaction: () => false,
		withTransaction: async (fn: () => Promise<unknown>) => fn(),
		endSession: async () => {},
	}
	const db = {
		collection,
		client: { startSession: () => session },
	} as unknown as Db
	return { db, events, runs }
}

const from = new Date("2026-03-01T00:00:00Z")
const to = new Date("2026-03-31T00:00:00Z")

beforeEach(() => {
	vi.clearAllMocks()
	seams.provider.mockReturnValue(null)
})

describe("consolidator entity filter selects its batch through Atlas Search", () => {
	it("emits one $search with the batch window in compound.filter and the entity query as must", async () => {
		const f = fixture(async () => [])
		await consolidateMemory({
			db: f.db,
			prefix: "test_",
			agentId: "agent-1",
			options: {
				entitySet: ["Acme", "Berlin"],
				scope: "agent",
				scopeRef: "agent:agent-1",
				timeRange: { from, to },
				maxEvents: 7,
			},
		})

		expect(f.events.find).not.toHaveBeenCalled()
		expect(f.events.aggregate).toHaveBeenCalledOnce()
		const pipeline = (
			f.events.aggregate.mock.calls[0] as unknown as [unknown[]]
		)[0]
		expect(pipeline).toEqual([
			{
				$search: {
					index: "test_events_text",
					compound: {
						filter: [
							{ equals: { path: "agentId", value: "agent-1" } },
							{ equals: { path: "scope", value: "agent" } },
							{ equals: { path: "scopeRef", value: "agent:agent-1" } },
							{ range: { path: "timestamp", gte: from, lte: to } },
						],
						must: [{ text: { query: ["Acme", "Berlin"], path: "body" } }],
					},
				},
			},
			{
				$match: {
					agentId: "agent-1",
					dreamerProcessedAt: { $exists: false },
					scope: "agent",
					scopeRef: "agent:agent-1",
					timestamp: { $gte: from, $lte: to },
				},
			},
			{ $sort: { timestamp: -1 } },
			{ $limit: 7 },
		])
	})

	it("keeps the window to agentId alone when no scope or time range is given", async () => {
		const f = fixture(async () => [])
		await consolidateMemory({
			db: f.db,
			prefix: "test_",
			agentId: "agent-1",
			options: { entitySet: ["Acme"] },
		})
		const pipeline = (
			f.events.aggregate.mock.calls[0] as unknown as [
				Array<{ $search: { compound: { filter: unknown[] } } }>,
			]
		)[0]
		expect(pipeline[0].$search.compound.filter).toEqual([
			{ equals: { path: "agentId", value: "agent-1" } },
		])
	})

	it("uses the newest-unprocessed find, not Search, without an entity set", async () => {
		const cursor = {
			sort: vi.fn(),
			limit: vi.fn(),
			toArray: vi.fn(async () => []),
		}
		cursor.sort.mockReturnValue(cursor)
		cursor.limit.mockReturnValue(cursor)
		const f = fixture(async () => [])
		f.events.find.mockReturnValue(cursor)
		await consolidateMemory({
			db: f.db,
			prefix: "test_",
			agentId: "agent-1",
			options: { maxEvents: 3 },
		})
		expect(f.events.aggregate).not.toHaveBeenCalled()
		expect(f.events.find).toHaveBeenCalledOnce()
	})

	it("fails the run with a typed Search error, never an empty batch, when the $search stage fails", async () => {
		const failure = new Error("mongot unavailable")
		const f = fixture(async () => {
			throw failure
		})
		const outcome = consolidateMemory({
			db: f.db,
			prefix: "test_",
			agentId: "agent-1",
			options: { entitySet: ["Acme"] },
		})
		await expect(outcome).rejects.toBeInstanceOf(SearchLaneError)
		await expect(outcome).rejects.toMatchObject({ stage: "atlas-search" })
		const terminal = f.runs.updateOne.mock.calls
			.map((call) => (call as unknown as [unknown, { $set?: unknown }])[1].$set)
			.filter(Boolean)
		expect(terminal).toEqual([
			expect.objectContaining({
				status: "failed",
				error: expect.stringContaining("atlas-search"),
			}),
		])
		expect(terminal).not.toContainEqual(
			expect.objectContaining({ status: "completed" }),
		)
	})
})

describe("consolidation runs on one search ledger", () => {
	it("charges the entity search to the run ledger and records its snapshot on the run row", async () => {
		const f = fixture(async () => [])
		await consolidateMemory({
			db: f.db,
			prefix: "test_",
			agentId: "agent-1",
			options: { entitySet: ["Acme"], maxEvents: 5 },
		})
		const update = (
			f.runs.updateOne.mock.calls[0] as unknown as [
				unknown,
				{ $set: { status: string; searchBudget: Record<string, unknown> } },
			]
		)[1].$set
		expect(update.status).toBe("completed")
		expect(update.searchBudget).toMatchObject({
			accounting: "engine-query-work",
			aggregations: 1,
			embeds: 0,
			maxAggregations: 205,
			maxEmbeds: 205,
		})
	})

	it("joins an enclosing job ledger instead of opening a second one", async () => {
		const f = fixture(async () => [])
		const jobLedger = openSearchBudget({ maxAggregations: 50, maxEmbeds: 50 })
		let inside: unknown
		await jobLedger.run(async () => {
			await consolidateMemory({
				db: f.db,
				prefix: "test_",
				agentId: "agent-1",
				options: { entitySet: ["Acme"] },
			})
			inside = getSearchBudgetSnapshot()
		})
		const update = (
			f.runs.updateOne.mock.calls[0] as unknown as [
				unknown,
				{
					$set: {
						searchBudget: { aggregations: number; maxAggregations: number }
					}
				},
			]
		)[1].$set
		expect(update.searchBudget.maxAggregations).toBe(50)
		expect(update.searchBudget.aggregations).toBe(1)
		expect(jobLedger.snapshot()).toEqual(inside)
		expect(jobLedger.snapshot().aggregations).toBe(1)
	})

	it("denies entity-search work past the ledger limit with a typed budget error", async () => {
		const f = fixture(async () => [])
		const jobLedger = openSearchBudget({ maxAggregations: 0, maxEmbeds: 0 })
		await expect(
			jobLedger.run(() =>
				consolidateMemory({
					db: f.db,
					prefix: "test_",
					agentId: "agent-1",
					options: { entitySet: ["Acme"] },
				}),
			),
		).rejects.toMatchObject({ stage: "atlas-search" })
		expect(f.events.aggregate).not.toHaveBeenCalled()
	})
})

describe("consolidator provider resolution", () => {
	it("throws the typed config error before any run is claimed when a configured provider cannot be resolved", async () => {
		seams.provider.mockImplementation(() => {
			throw new EnrichmentConfigError("MEMONGO_ENRICHMENT_MODEL is missing")
		})
		const f = fixture(async () => [])
		await expect(
			consolidateMemory({
				db: f.db,
				prefix: "test_",
				agentId: "agent-1",
				options: { entitySet: ["Acme"] },
			}),
		).rejects.toBeInstanceOf(EnrichmentConfigError)
		expect(f.runs.findOneAndUpdate).not.toHaveBeenCalled()
		expect(f.runs.updateOne).not.toHaveBeenCalled()
		expect(f.events.aggregate).not.toHaveBeenCalled()
	})
})
