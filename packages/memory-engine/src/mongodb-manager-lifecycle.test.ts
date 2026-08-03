/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"

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

// ---------------------------------------------------------------------------
// P2.1 shared Mongo runtime: client ownership + memory-job worker sweep
// ---------------------------------------------------------------------------

describe("P2.1 shared client close ownership", () => {
	function buildCloseableManager(fields: Record<string, unknown>) {
		return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			closed: false,
			client: { close: vi.fn(async () => {}) },
			writeQueue: Promise.resolve(),
			derivationQueue: Promise.resolve(),
			derivationSchedulingQueue: Promise.resolve(),
			memoryJobWorkerStopped: true,
			memoryJobWorkerTimer: null,
			memoryJobWorkerPromise: Promise.resolve(),
			watchTimer: null,
			watcher: null,
			changeStreamWatcher: null,
			syncing: null,
			accessTracker: null,
			...fields,
		}) as MongoDBMemoryManager & {
			client: { close: ReturnType<typeof vi.fn> }
		}
	}

	it("does not close a shared client on manager close, but runs onClosed", async () => {
		const onClosed = vi.fn()
		const manager = buildCloseableManager({
			ownsClient: false,
			onClosed,
		})

		await manager.close()

		expect(manager.client.close).not.toHaveBeenCalled()
		expect(onClosed).toHaveBeenCalledTimes(1)
	})

	it("closes an owned client on manager close (legacy per-manager client)", async () => {
		const manager = buildCloseableManager({ ownsClient: true })

		await manager.close()

		expect(manager.client.close).toHaveBeenCalledTimes(1)
	})

	it("invokes onClosed only once across repeated close calls", async () => {
		const onClosed = vi.fn()
		const manager = buildCloseableManager({ ownsClient: false, onClosed })

		await manager.close()
		await manager.close()

		expect(onClosed).toHaveBeenCalledTimes(1)
	})
})
