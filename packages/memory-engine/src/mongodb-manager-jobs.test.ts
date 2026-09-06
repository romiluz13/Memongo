/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { mocked } from "./test-helpers/manager-test-kit.js"

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
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

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

describe("MongoDBMemoryManager consolidate job tracking", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does not abort consolidation when createMemoryJob fails", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		const { invalidateQueryCache } = await import("./mongodb-query-cache.js")

		mocked(createMemoryJob).mockRejectedValue(new Error("job create failed"))
		mocked(consolidateMemory).mockResolvedValue({
			runId: "run-1",
			eventsProcessed: 3,
			factsPromoted: 2,
			factsPruned: 0,
			conflictsResolved: 0,
			durationMs: 25,
		})

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
			},
		) as MongoDBMemoryManager

		const result = await manager.consolidate({ maxEvents: 10 })

		expect(result.eventsProcessed).toBe(3)
		expect(createMemoryJob).toHaveBeenCalledTimes(1)
		expect(updateMemoryJob).not.toHaveBeenCalled()
		expect(invalidateQueryCache).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
		})
	})
	it("marks the explicit consolidate run's row as tracking a live synchronous run (W05)", async () => {
		const { createMemoryJob } = await import("./mongodb-memory-jobs.js")
		const { consolidateMemory } = await import("./mongodb-consolidator.js")
		mocked(createMemoryJob).mockResolvedValue("job-w05-tracking")
		mocked(consolidateMemory).mockResolvedValue({
			runId: "run-w05",
			eventsProcessed: 3,
			factsPromoted: 2,
			factsPruned: 0,
			conflictsResolved: 0,
			durationMs: 25,
		})
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
			},
		) as MongoDBMemoryManager
		await manager.consolidate({
			maxEvents: 10,
			llmDedup: true,
			scope: "workspace",
			scopeRef: "workspace:ws-9",
		})
		// The row is RUNNING with NO lease — exactly the shape the claim filter
		// used to treat as abandoned work. The tracking marker plus persisted
		// caller options make it nonclaimable-by-the-worker while giving a
		// later legitimate retry (failed with budget left) its original scope.
		expect(createMemoryJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					jobType: "consolidation",
					status: "running",
					tracking: true,
					metadata: {
						maxEvents: 10,
						llmDedup: true,
						scope: "workspace",
						scopeRef: "workspace:ws-9",
					},
				}),
			}),
		)
		// The synchronous run replays the caller's own options.
		expect(consolidateMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				options: {
					maxEvents: 10,
					llmDedup: true,
					scope: "workspace",
					scopeRef: "workspace:ws-9",
				},
			}),
		)
	})

	it("preserves the original consolidation error when failed job update also fails", async () => {
		const { createMemoryJob, updateMemoryJob } = await import(
			"./mongodb-memory-jobs.js"
		)
		const { consolidateMemory } = await import("./mongodb-consolidator.js")

		mocked(createMemoryJob).mockResolvedValue("job-1")
		mocked(consolidateMemory).mockRejectedValue(new Error("boom"))
		mocked(updateMemoryJob).mockRejectedValue(new Error("job update failed"))

		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
			},
		) as MongoDBMemoryManager

		await expect(manager.consolidate({ scope: "workspace" })).rejects.toThrow(
			"boom",
		)
		expect(updateMemoryJob).toHaveBeenCalledTimes(1)
	})
})
