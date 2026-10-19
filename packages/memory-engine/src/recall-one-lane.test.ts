import {
	type Collection,
	type Db,
	type Document,
	MongoServerError,
} from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock("@memongo/lib", async (importOriginal) => ({
	...(await importOriginal<typeof import("@memongo/lib")>()),
	createSubsystemLogger: () => ({
		warn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}))
vi.mock("./mongodb-schema.js", () => ({ eventsCollection: vi.fn() }))
vi.mock("./mongodb-telemetry.js", () => ({ emitTelemetry: vi.fn() }))

import { recallConversation } from "./mongodb-conversation-recall.js"
import { eventsCollection } from "./mongodb-schema.js"
import { openSearchBudget } from "./mongodb-search-budget.js"
import {
	resetSearchAdmissionForTests,
	tryConsumeSearchAdmission,
} from "./mongodb-search-admission.js"
import { SearchBudgetDeniedError, SearchLaneError } from "./search-outcomes.js"

const TENANT = { scope: "agent", scopeRef: "agent:a1" } as const

const event = {
	eventId: "event-1",
	agentId: "a1",
	role: "user",
	body: "the deploy failed on Tuesday",
	timestamp: new Date("2026-01-01T00:00:00Z"),
}

function fakeEvents(aggregateResult: () => Promise<Document[]>) {
	const find = vi.fn((_filter: Document) => ({
		sort: vi.fn(() => ({
			limit: vi.fn(() => ({ toArray: vi.fn(async () => [event]) })),
		})),
	}))
	const aggregate = vi.fn((_pipeline: Document[]) => ({
		toArray: vi.fn(aggregateResult),
	}))
	vi.mocked(eventsCollection).mockReturnValue({
		find,
		aggregate,
	} as unknown as Collection)
	return { find, aggregate }
}

function recall(
	request: Partial<Parameters<typeof recallConversation>[0]["request"]> = {},
) {
	return recallConversation({
		db: {} as Db,
		prefix: "test_",
		request: { agentId: "a1", ...TENANT, query: "deploy failed", ...request },
	})
}

describe("recall is one hybrid lane", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resetSearchAdmissionForTests(Date.now())
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("runs one $rankFusion aggregate with no capabilities passed", async () => {
		const { find, aggregate } = fakeEvents(async () => [event])
		const response = await recall()
		expect(aggregate).toHaveBeenCalledTimes(1)
		expect(aggregate.mock.calls[0]?.[0][0]).toHaveProperty("$rankFusion")
		expect(find).not.toHaveBeenCalled()
		expect(response.metadata.searchMethod).toBe("hybrid")
		expect(response.results.map((r) => r.citation.eventId)).toEqual(["event-1"])
	})

	it("returns a healthy zero as final: no semantic tier, no substring scan", async () => {
		const { find, aggregate } = fakeEvents(async () => [])
		const response = await recall()
		expect(response.results).toEqual([])
		expect(response.metadata.searchMethod).toBe("hybrid")
		expect(aggregate).toHaveBeenCalledTimes(1)
		expect(find).not.toHaveBeenCalled()
	})

	it("types a fusion failure instead of falling back to semantic or regex", async () => {
		const driverError = new MongoServerError({ errmsg: "boom", code: 2 })
		const { find, aggregate } = fakeEvents(async () => {
			throw driverError
		})
		const failure = await recall({}).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			lane: "recall",
			stage: "rank-fusion",
			reason: "query-error",
		})
		expect((failure as Error).cause).toBe(driverError)
		expect(aggregate).toHaveBeenCalledTimes(1)
		expect(find).not.toHaveBeenCalled()
		expect(JSON.stringify(warn.mock.calls)).not.toContain("falling back")
	})

	it("types an admission denial and runs no read at all", async () => {
		vi.stubEnv("MEMONGO_SEARCH_ADMISSION_RPM", "1")
		vi.stubEnv("MEMONGO_SEARCH_ADMISSION_BURST", "1")
		resetSearchAdmissionForTests(Date.now())
		expect(tryConsumeSearchAdmission().ok).toBe(true)
		const { find, aggregate } = fakeEvents(async () => [event])
		const failure = await recall().catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(SearchBudgetDeniedError)
		expect(failure).toMatchObject({
			lane: "recall",
			stage: "request",
			reason: "budget-embeds",
		})
		expect((failure as SearchBudgetDeniedError).retryAfterMs).toBeGreaterThan(0)
		expect(aggregate).not.toHaveBeenCalled()
		expect(find).not.toHaveBeenCalled()
	})

	it("lists a no-query recall chronologically with no content filter", async () => {
		const { find, aggregate } = fakeEvents(async () => [])
		const response = await recall({ query: undefined })
		expect(aggregate).not.toHaveBeenCalled()
		expect(find).toHaveBeenCalledTimes(1)
		const filter = find.mock.calls[0]?.[0] as Document
		expect(JSON.stringify(filter)).not.toContain("$regex")
		expect(filter).not.toHaveProperty("body")
		expect(response.metadata.searchMethod).toBe("standard")
		expect(response.results[0]?.matchType).toBe("filter")
	})

	it.each([
		"Mars/Olympus",
		`private-timezone-marker-${"x".repeat(1_000)}`,
	])("rejects an invalid timezone without echoing it (case %#)", async (timezone) => {
		const { find, aggregate } = fakeEvents(async () => [])
		const failure = await recall({
			timezone,
			startTime: "2026-04-08",
		}).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toBe("invalid timezone")
		expect(find).not.toHaveBeenCalled()
		expect(aggregate).not.toHaveBeenCalled()
	})

	it("charges the fused aggregate and its embed to the request ledger", async () => {
		fakeEvents(async () => [event])
		const ledger = openSearchBudget({ maxAggregations: 12, maxEmbeds: 5 })
		await ledger.run(() => recall())
		expect(ledger.snapshot()).toMatchObject({ aggregations: 1, embeds: 1 })
	})

	it("types a ledger denial of the fused aggregate and runs nothing", async () => {
		const { find, aggregate } = fakeEvents(async () => [event])
		const ledger = openSearchBudget({ maxAggregations: 12, maxEmbeds: 0 })
		const failure = await ledger
			.run(() => recall())
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(SearchBudgetDeniedError)
		expect(failure).toMatchObject({ reason: "budget-embeds" })
		expect((failure as SearchBudgetDeniedError).retryAfterMs).toBeUndefined()
		expect(aggregate).not.toHaveBeenCalled()
		expect(find).not.toHaveBeenCalled()
	})
})
