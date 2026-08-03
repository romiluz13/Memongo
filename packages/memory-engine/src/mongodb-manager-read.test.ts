/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { mocked } from "./test-helpers/manager-test-kit.js"

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./benchmark-quality-contracts.js", async (importOriginal) =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkQualityContractsModuleMock(importOriginal),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)

vi.mock("./mongodb-benchmark-harness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkHarnessModuleMock(),
)

vi.mock("./mongodb-retrieval-planner.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).retrievalPlannerModuleMock(),
)

vi.mock("./mongodb-episodes.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
)

vi.mock("./mongodb-graph.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).graphModuleMock(),
)

vi.mock("./mongodb-schema.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).schemaModuleMock(),
)

vi.mock("./mongodb-query-cache.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).queryCacheModuleMock(),
)

vi.mock("./mongodb-query-rewriter.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).queryRewriterModuleMock(),
)

vi.mock("./mongodb-reranker.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).rerankerModuleMock(),
)

vi.mock("./mongodb-lane-coverage.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).laneCoverageModuleMock(),
)

vi.mock("./mongodb-memory-jobs.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).memoryJobsModuleMock(),
)

vi.mock("./mongodb-consolidator.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).consolidatorModuleMock(),
)

vi.mock("./mongodb-derived-memory.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).derivedMemoryModuleMock(),
)

vi.mock("./mongodb-benchmark-readiness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkReadinessModuleMock(),
)

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

describe("MongoDBMemoryManager conversation recall", () => {
	it("forwards the verified native bitemporal prefilter capability", async () => {
		const { recallConversation } = await import(
			"./mongodb-conversation-recall.js"
		)
		mocked(recallConversation).mockResolvedValue({
			results: [],
			metadata: {
				totalMatched: 0,
				filtersApplied: [],
				searchMethod: "standard",
				durationMs: 0,
			},
		})
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				capabilities: {
					vectorSearch: true,
					textSearch: true,
					rankFusion: true,
					storedSource: false,
					vectorIndexMethod: false,
					scoreFusion: false,
				},
				nativeBitemporalVectorPrefilter: true,
			},
		) as MongoDBMemoryManager

		await manager.recallConversation({ query: "deployment" })

		expect(recallConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				nativeBitemporalVectorPrefilter: true,
			}),
		)
	})

	it("activates native bitemporal prefiltering after a deferred index converges", async () => {
		const { recallConversation } = await import(
			"./mongodb-conversation-recall.js"
		)
		const { eventsCollection, isEventsVectorBitemporalPrefilterReady } =
			await import("./mongodb-schema.js")
		mocked(recallConversation).mockResolvedValue({
			results: [],
			metadata: {
				totalMatched: 0,
				filtersApplied: [],
				searchMethod: "standard",
				durationMs: 0,
			},
		})
		mocked(isEventsVectorBitemporalPrefilterReady).mockResolvedValue(true)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
		} as unknown as import("mongodb").Collection)
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				capabilities: {
					vectorSearch: true,
					textSearch: true,
					rankFusion: true,
					storedSource: false,
					vectorIndexMethod: false,
					scoreFusion: false,
				},
				nativeBitemporalVectorPrefilter: false,
				nativeBitemporalPrefilterCheckedAt: 0,
			},
		) as MongoDBMemoryManager

		await manager.recallConversation({ query: "deployment" })

		expect(recallConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				nativeBitemporalVectorPrefilter: true,
			}),
		)
	})
})
