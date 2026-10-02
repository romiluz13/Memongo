/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
// Startup projection repair fence contract. The repair captures ONE
// admission before the first bounded snapshot read, keeps every snapshot
// OUTSIDE the fences, projects each snapshot batch in one withFencedWrite
// carrying the same admission token (recordRun:false, fence session
// propagated), records diagnostics in SEPARATE best-effort fenced writes
// AFTER primary resolution, advances host counters only from resolved
// primaries, propagates a gate conflict with NO diagnostic attempt, and
// records a fenced failed run with the ORIGINAL token before rethrowing a
// non-gate failure.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ClientSession, Db } from "mongodb"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { mocked } from "./test-helpers/manager-test-kit.js"
import {
	type CanonicalEvent,
	getUnprojectedEvents,
	projectChunksFromEvents,
	projectEventChunksBatch,
} from "./mongodb-events.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import {
	captureAdmissionToken,
	ErasureGateConflictError,
	withFencedWrite,
} from "./mongodb-write-fence.js"

vi.mock("./mongodb-events.js", async () => {
	const kit = await import("./test-helpers/manager-test-kit.js")
	return {
		...(await kit.eventsModuleMock()),
		// Granted-path snapshot collaborator. Not part of the shared kit
		// (no expansion); file-local override only.
		getUnprojectedEvents: vi.fn(async () => [] as CanonicalEvent[]),
	}
})

// Fence-specific file-local override (the batch-fence-test pattern): the
// shared kit's writeFenceModuleMock serves legacy suites; this suite needs
// a distinctive admission epoch and an observable default fence session.
vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-write-fence.js")>()
	return {
		...actual,
		// Epoch 7 is distinctive: "the same token on every fence" cannot
		// pass by matching an epoch-0 default.
		captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
			kind: "admission" as const,
			agentId,
			epoch: 7,
		})),
		withFencedWrite: vi.fn(
			async ({
				fn,
			}: {
				fn: (session: import("mongodb").ClientSession) => Promise<unknown>
			}) => fn({} as import("mongodb").ClientSession),
		),
	}
})

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

const ADMISSION_TOKEN = {
	kind: "admission",
	agentId: "agent-1",
	epoch: 7,
} as const

function buildRepairManager(overrides?: Record<string, unknown>) {
	return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		db: {} as Db,
		prefix: "test_",
		agentId: "agent-1",
		chunkCount: 0,
		...overrides,
	}) as MongoDBMemoryManager
}

function runRepair(manager: MongoDBMemoryManager) {
	return (
		manager as unknown as {
			repairEventProjections: () => Promise<{
				eventsProcessed: number
				chunksCreated: number
			}>
		}
	).repairEventProjections()
}

function makeEvent(eventId: string, agentId = "agent-1"): CanonicalEvent {
	return {
		eventId,
		agentId,
		role: "user",
		body: `body of ${eventId}`,
		scope: "agent",
		scopeRef: `agent:${agentId}`,
		timestamp: new Date("2026-09-09T00:00:00.000Z"),
		validAt: new Date("2026-09-09T00:00:00.000Z"),
	}
}

function fullBatch(idPrefix: string): CanonicalEvent[] {
	return Array.from({ length: 500 }, (_, index) =>
		makeEvent(`${idPrefix}-${index}`),
	)
}

describe("MongoDBMemoryManager projection repair", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// The kit's bare projectChunksFromEvents resolves undefined, which
		// crashes the unfenced baseline inside act before any fence
		// assertion can bind. A shaped zero default lets the baseline path
		// complete so every case fails at its own fence assertion.
		mocked(projectChunksFromEvents).mockResolvedValue({
			eventsProcessed: 0,
			chunksCreated: 0,
		})
	})

	it("captures exactly one admission before the first snapshot read", async () => {
		const manager = buildRepairManager()
		mocked(getUnprojectedEvents).mockResolvedValueOnce([makeEvent("e-1")])
		mocked(projectEventChunksBatch).mockResolvedValueOnce([
			{ chunkCreated: true },
		])

		await runRepair(manager)

		expect(mocked(captureAdmissionToken)).toHaveBeenCalledTimes(1)
		expect(mocked(captureAdmissionToken)).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
		})
		expect(
			mocked(captureAdmissionToken).mock.invocationCallOrder[0],
		).toBeLessThan(mocked(getUnprojectedEvents).mock.invocationCallOrder[0])
	})

	it("reuses the same admission token on every fence and records each resolved batch in a separate fenced run", async () => {
		const manager = buildRepairManager()
		mocked(getUnprojectedEvents)
			.mockResolvedValueOnce(fullBatch("e-1"))
			.mockResolvedValueOnce([makeEvent("e-2")])
		mocked(projectEventChunksBatch)
			.mockResolvedValueOnce(
				Array.from({ length: 500 }, () => ({ chunkCreated: true })),
			)
			.mockResolvedValueOnce([{ chunkCreated: true }])

		await runRepair(manager)

		// 2 primary fences + 2 separate diagnostic fences — every one
		// carries the one captured admission token.
		expect(mocked(withFencedWrite)).toHaveBeenCalledTimes(4)
		expect(mocked(captureAdmissionToken)).toHaveBeenCalledTimes(1)
		for (const call of mocked(withFencedWrite).mock.calls) {
			expect(call[0].token).toEqual(ADMISSION_TOKEN)
		}
		expect(mocked(recordProjectionRun)).toHaveBeenCalledTimes(2)
		expect(mocked(recordProjectionRun)).toHaveBeenNthCalledWith(1, {
			db: manager.db,
			prefix: "test_",
			run: {
				agentId: "agent-1",
				projectionType: "chunks",
				status: "ok",
				itemsProjected: 500,
				durationMs: expect.any(Number),
			},
			session: expect.anything(),
		})
		expect(mocked(recordProjectionRun)).toHaveBeenNthCalledWith(2, {
			db: manager.db,
			prefix: "test_",
			run: {
				agentId: "agent-1",
				projectionType: "chunks",
				status: "ok",
				itemsProjected: 1,
				durationMs: expect.any(Number),
			},
			session: expect.anything(),
		})
	})

	it("projects each batch inside its fence with recordRun:false and the fence session", async () => {
		const manager = buildRepairManager()
		const events = [makeEvent("e-1"), makeEvent("e-2")]
		mocked(getUnprojectedEvents).mockResolvedValueOnce(events)
		mocked(projectEventChunksBatch).mockResolvedValueOnce([
			{ chunkCreated: true },
			{ chunkCreated: true },
		])
		const fenceSession = {
			sentinel: "fence-session",
		} as unknown as ClientSession
		mocked(withFencedWrite).mockImplementationOnce(async ({ fn }) =>
			fn(fenceSession),
		)

		await runRepair(manager)

		expect(mocked(projectEventChunksBatch)).toHaveBeenCalledTimes(1)
		const primaryCall = mocked(projectEventChunksBatch).mock.calls[0]?.[0]
		expect(primaryCall).toEqual({
			db: manager.db,
			prefix: "test_",
			events,
			recordRun: false,
			session: fenceSession,
		})
		expect(primaryCall?.events).toBe(events)
		expect(primaryCall?.session).toBe(fenceSession)
	})

	it("drains in batches of 500 until a short snapshot and counts only committed chunks", async () => {
		const manager = buildRepairManager()
		const firstBatch = fullBatch("e-1")
		const secondBatch = [makeEvent("e-2-0"), makeEvent("e-2-1")]
		mocked(getUnprojectedEvents)
			.mockResolvedValueOnce(firstBatch)
			.mockResolvedValueOnce(secondBatch)
		mocked(projectEventChunksBatch)
			.mockResolvedValueOnce(
				Array.from({ length: 500 }, (_, index) => ({
					chunkCreated: index < 499,
				})),
			)
			.mockResolvedValueOnce([{ chunkCreated: true }, { chunkCreated: true }])

		const result = await runRepair(manager)

		expect(result).toEqual({ eventsProcessed: 502, chunksCreated: 501 })
		expect(mocked(getUnprojectedEvents)).toHaveBeenCalledTimes(2)
		expect(mocked(getUnprojectedEvents)).toHaveBeenNthCalledWith(1, {
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
			limit: 500,
		})
		expect(mocked(getUnprojectedEvents)).toHaveBeenNthCalledWith(2, {
			db: manager.db,
			prefix: "test_",
			agentId: "agent-1",
			limit: 500,
		})
		expect(mocked(projectEventChunksBatch)).toHaveBeenCalledTimes(2)
		expect(mocked(projectEventChunksBatch).mock.calls[0]?.[0].events).toBe(
			firstBatch,
		)
		expect(mocked(projectEventChunksBatch).mock.calls[1]?.[0].events).toBe(
			secondBatch,
		)
		expect(manager.chunkCount).toBe(501)
	})

	it("re-running after a completed drain is a fenced no-op (idempotence)", async () => {
		const manager = buildRepairManager()
		mocked(getUnprojectedEvents).mockResolvedValueOnce([makeEvent("e-1")])
		mocked(projectEventChunksBatch).mockResolvedValueOnce([
			{ chunkCreated: true },
		])
		await runRepair(manager)
		expect(mocked(withFencedWrite)).toHaveBeenCalledTimes(2)
		expect(mocked(projectEventChunksBatch)).toHaveBeenCalledTimes(1)

		// Nothing unprojected remains: the second pass fences nothing.
		const second = await runRepair(manager)

		expect(second).toEqual({ eventsProcessed: 0, chunksCreated: 0 })
		expect(mocked(withFencedWrite)).toHaveBeenCalledTimes(2)
		expect(mocked(projectEventChunksBatch)).toHaveBeenCalledTimes(1)
		expect(mocked(recordProjectionRun)).toHaveBeenCalledTimes(1)
		// Admission is per repair: the second pass captured its own token.
		expect(mocked(captureAdmissionToken)).toHaveBeenCalledTimes(2)
		expect(manager.chunkCount).toBe(1)
	})

	it("advances host counters only from resolved primary fences", async () => {
		const manager = buildRepairManager()
		mocked(getUnprojectedEvents)
			.mockResolvedValueOnce(fullBatch("e-1"))
			.mockResolvedValueOnce([makeEvent("e-2")])
		mocked(projectEventChunksBatch).mockResolvedValueOnce(
			Array.from({ length: 500 }, (_, index) => ({ chunkCreated: index < 2 })),
		)
		// Two pass-through fences first (batch 1's primary + its separate
		// diagnostic), so the queued rejection lands on batch 2's PRIMARY
		// fence — the mid-drain fence that must not resolve.
		mocked(withFencedWrite)
			.mockImplementationOnce(async ({ fn }) => fn({} as ClientSession))
			.mockImplementationOnce(async ({ fn }) => fn({} as ClientSession))
			.mockRejectedValueOnce(new ErasureGateConflictError("agent-1"))

		await expect(runRepair(manager)).rejects.toThrow(ErasureGateConflictError)

		// The first batch committed 2 chunks; the second batch's fence never
		// resolved — the conflict aborts the drain with the counter
		// reflecting only the acknowledged commit.
		expect(manager.chunkCount).toBe(2)
		expect(mocked(recordProjectionRun)).toHaveBeenCalledTimes(1)
	})

	it("propagates a gate conflict with no diagnostic attempt", async () => {
		const manager = buildRepairManager()
		mocked(getUnprojectedEvents).mockResolvedValueOnce([
			makeEvent("e-1"),
			makeEvent("e-2"),
		])
		mocked(withFencedWrite).mockRejectedValueOnce(
			new ErasureGateConflictError("agent-1"),
		)

		const failure = await runRepair(manager).then(
			() => undefined,
			(err: unknown) => err,
		)

		expect(failure).toBeInstanceOf(ErasureGateConflictError)
		// Exactly one fence: the primary. No failed-run fence, no retry, no
		// sessionless fallback.
		expect(mocked(withFencedWrite)).toHaveBeenCalledTimes(1)
		expect(mocked(projectEventChunksBatch)).not.toHaveBeenCalled()
		expect(mocked(recordProjectionRun)).not.toHaveBeenCalled()
		expect(manager.chunkCount).toBe(0)
	})

	it("records a fenced failed run with the original token on a non-gate failure, then rethrows", async () => {
		const manager = buildRepairManager()
		mocked(getUnprojectedEvents).mockResolvedValueOnce([makeEvent("e-1")])
		mocked(withFencedWrite).mockRejectedValueOnce(
			new Error("injected projection failure"),
		)

		const failure = await runRepair(manager).then(
			() => undefined,
			(err: unknown) => err,
		)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toBe("injected projection failure")
		// The primary fence rejected; the failed-run diagnostic is a
		// SEPARATE fenced write carrying the ORIGINAL admission token.
		expect(mocked(withFencedWrite)).toHaveBeenCalledTimes(2)
		const failedRunFence = mocked(withFencedWrite).mock.calls[1]?.[0]
		expect(failedRunFence?.token).toEqual(ADMISSION_TOKEN)
		expect(mocked(recordProjectionRun)).toHaveBeenCalledTimes(1)
		expect(mocked(recordProjectionRun)).toHaveBeenCalledWith({
			db: manager.db,
			prefix: "test_",
			run: {
				agentId: "agent-1",
				projectionType: "chunks",
				status: "failed",
				itemsProjected: 0,
				durationMs: expect.any(Number),
			},
			session: expect.anything(),
		})
		// The drain aborted on the rethrow — no second snapshot.
		expect(mocked(getUnprojectedEvents)).toHaveBeenCalledTimes(1)
		expect(manager.chunkCount).toBe(0)
	})

	it("keeps tenant scoping: A's repair projects only A's snapshot; B's empty repair fences nothing", async () => {
		const managerA = buildRepairManager()
		const managerB = buildRepairManager({ agentId: "agent-2" })
		const eventsA = [makeEvent("e-a-1"), makeEvent("e-a-2")]
		mocked(getUnprojectedEvents)
			.mockResolvedValueOnce(eventsA)
			.mockResolvedValueOnce([])
		mocked(projectEventChunksBatch).mockResolvedValueOnce([
			{ chunkCreated: true },
			{ chunkCreated: true },
		])

		const resultA = await runRepair(managerA)
		const resultB = await runRepair(managerB)

		expect(resultA).toEqual({ eventsProcessed: 2, chunksCreated: 2 })
		expect(resultB).toEqual({ eventsProcessed: 0, chunksCreated: 0 })
		// A's batch projected exactly A's snapshot rows under A's admission.
		expect(mocked(projectEventChunksBatch)).toHaveBeenCalledTimes(1)
		expect(mocked(projectEventChunksBatch).mock.calls[0]?.[0].events).toBe(
			eventsA,
		)
		expect(mocked(captureAdmissionToken)).toHaveBeenNthCalledWith(1, {
			db: managerA.db,
			prefix: "test_",
			agentId: "agent-1",
		})
		expect(mocked(captureAdmissionToken)).toHaveBeenNthCalledWith(2, {
			db: managerB.db,
			prefix: "test_",
			agentId: "agent-2",
		})
		expect(mocked(getUnprojectedEvents)).toHaveBeenNthCalledWith(1, {
			db: managerA.db,
			prefix: "test_",
			agentId: "agent-1",
			limit: 500,
		})
		expect(mocked(getUnprojectedEvents)).toHaveBeenNthCalledWith(2, {
			db: managerB.db,
			prefix: "test_",
			agentId: "agent-2",
			limit: 500,
		})
		// Only A's primary + A's diagnostic fence exist; B's empty repair
		// never fenced.
		expect(mocked(withFencedWrite)).toHaveBeenCalledTimes(2)
		expect(managerA.chunkCount).toBe(2)
		expect(managerB.chunkCount).toBe(0)
	})
})
