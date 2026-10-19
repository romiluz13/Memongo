// M2 review D3 residue: a consolidation that completes and then fails on the
// query-cache invalidation reports that the run committed.
import { describe, expect, it, vi } from "vitest"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { invalidateQueryCache } from "./mongodb-query-cache.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

vi.mock("./mongodb-consolidator.js", () => ({
	consolidationSearchBudgetLimits: (maxEvents: number) => ({
		maxAggregations: maxEvents + 200,
		maxEmbeds: maxEvents + 200,
	}),
	consolidateMemory: vi.fn(async () => ({
		runId: "run-1",
		agentId: "agent1",
		eventsProcessed: 3,
		factsPromoted: 2,
		factsInferred: 1,
		factsMerged: 0,
		factsPruned: 1,
		conflictsResolved: 0,
		durationMs: 5,
		candidates: [],
	})),
}))

vi.mock("./mongodb-query-cache.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-query-cache.js")>()),
	invalidateQueryCache: vi.fn(),
}))

function host(): MongoDBManagerHost {
	const f = createStatefulMongoFake()
	return {
		db: f.db,
		prefix: "test_",
		agentId: "agent1",
		workspaceDir: "/owned/test",
		isDuplicateKeyError: () => false,
		runIndexHealthRequest: <T>(fn: () => Promise<T>) => fn(),
	} as unknown as MongoDBManagerHost
}

describe("consolidate: a cache failure after the run completed", () => {
	it("rethrows the failure with commitState committed and the run's counts", async () => {
		const cacheFailure = new Error("cache write failed")
		vi.mocked(invalidateQueryCache).mockRejectedValueOnce(cacheFailure)

		const failure = await new MongoDBManagerLifecycleOps(host())
			.consolidate({ maxEvents: 3 })
			.then(
				() => undefined,
				(err: unknown) => err,
			)

		expect(failure).toBe(cacheFailure)
		expect(failure).toMatchObject({
			commitState: "committed",
			commit: {
				operation: "consolidate",
				runId: "run-1",
				eventsProcessed: 3,
				factsPromoted: 2,
				factsInferred: 1,
				factsMerged: 0,
				factsPruned: 1,
			},
		})
	})
})
