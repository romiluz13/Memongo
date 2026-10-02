import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ClientSession, Db } from "mongodb"
import { MongoDBManagerSyncOps } from "./mongodb-manager-sync.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import {
	getUnprojectedEvents,
	projectEventChunksBatch,
} from "./mongodb-events.js"
import {
	claimMemoryJob,
	deadLetterExpiredMemoryJobs,
} from "./mongodb-memory-jobs.js"
import { recordProjectionRun } from "./mongodb-ops.js"
import {
	captureAdmissionToken,
	readErasureGate,
	ErasureGateConflictError,
	type AdmissionToken,
} from "./mongodb-write-fence.js"

vi.mock("./mongodb-events.js", async (original) => ({
	...(await original<typeof import("./mongodb-events.js")>()),
	getUnprojectedEvents: vi.fn(async () => []),
	projectEventChunksBatch: vi.fn(async () => []),
}))
vi.mock("./mongodb-write-fence.js", async (original) => ({
	...(await original<typeof import("./mongodb-write-fence.js")>()),
	captureAdmissionToken: vi.fn(async () => token),
	readErasureGate: vi.fn(async () => ({
		_id: "gate-test",
		agentId: token.agentId,
		epoch: token.epoch,
		state: "open",
		serial: 0,
	})),
	withFencedWrite: vi.fn(
		async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) =>
			fn({} as ClientSession),
	),
}))
vi.mock("./mongodb-ops.js", async (original) => ({
	...(await original<typeof import("./mongodb-ops.js")>()),
	recordProjectionRun: vi.fn(async () => {}),
}))
vi.mock("./mongodb-memory-jobs.js", async (original) => ({
	...(await original<typeof import("./mongodb-memory-jobs.js")>()),
	deadLetterExpiredMemoryJobs: vi.fn(async () => 0),
	claimMemoryJob: vi.fn(async () => null),
}))
const token: AdmissionToken = {
	kind: "admission",
	agentId: "agent-1",
	epoch: 7,
}
type RepairParams = { admission?: AdmissionToken; singleBatch?: boolean }
function entry() {
	const host = {
		db: {
			collection: () => ({ countDocuments: async () => 0 }),
		} as unknown as Db,
		prefix: "test_",
		agentId: token.agentId,
		chunkCount: 0,
		memoryJobWorkerStopped: true,
		repairExtractionOutbox: vi.fn(async () => ({
			eventsProcessed: 0,
			jobsCreated: 0,
			jobsReleased: 0,
			eventsFailed: 0,
		})),
		pruneIdempotencyFingerprints: vi.fn(async () => ({ pruned: 0 })),
	} as unknown as MongoDBManagerHost
	const sync = new MongoDBManagerSyncOps(host)
	const repair = sync.repairEventProjections.bind(sync) as (
		params?: RepairParams,
	) => ReturnType<typeof sync.repairEventProjections>
	host.repairEventProjections = repair
	return { host, sync, repair, jobs: new MongoDBManagerJobsOps(host) }
}
function events(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		eventId: `event-${index}`,
		agentId: token.agentId,
		role: "user" as const,
		body: "Remember this",
		scope: "agent" as const,
		scopeRef: "agent:agent-1",
		timestamp: new Date(0),
	}))
}
beforeEach(() => {
	vi.resetAllMocks()
	vi.mocked(captureAdmissionToken).mockResolvedValue(token)
	vi.mocked(getUnprojectedEvents).mockResolvedValue([])
	vi.mocked(projectEventChunksBatch).mockResolvedValue([])
	vi.mocked(claimMemoryJob).mockResolvedValue(null)
	vi.mocked(deadLetterExpiredMemoryJobs).mockResolvedValue(0)
	vi.mocked(readErasureGate).mockResolvedValue({
		_id: "gate-test",
		agentId: token.agentId,
		epoch: 7,
		state: "open",
		serial: 0,
	})
	vi.stubEnv("MEMONGO_AUTO_CONSOLIDATION_MS", "0")
})
afterEach(() => vi.unstubAllEnvs())
it("worker mode reuses admission and projects exactly one full batch", async () => {
	const e = entry()
	vi.mocked(getUnprojectedEvents)
		.mockResolvedValueOnce(events(500))
		.mockResolvedValueOnce(events(1))
	vi.mocked(projectEventChunksBatch).mockImplementation(async ({ events }) =>
		events.map(() => ({ chunkCreated: true })),
	)
	expect(await e.repair({ admission: token, singleBatch: true })).toEqual({
		eventsProcessed: 500,
		chunksCreated: 500,
	})
	expect(captureAdmissionToken).not.toHaveBeenCalled()
	expect(getUnprojectedEvents).toHaveBeenCalledTimes(1)
	expect(e.host.chunkCount).toBe(500)
})
it("startup keeps the existing full-drain behavior", async () => {
	const e = entry()
	vi.mocked(getUnprojectedEvents)
		.mockResolvedValueOnce(events(500))
		.mockResolvedValueOnce(events(1))
	vi.mocked(projectEventChunksBatch)
		.mockResolvedValueOnce(
			Array.from({ length: 500 }, () => ({ chunkCreated: true })),
		)
		.mockResolvedValueOnce([{ chunkCreated: true }])
	expect(await e.repair()).toEqual({ eventsProcessed: 501, chunksCreated: 501 })
	expect(captureAdmissionToken).toHaveBeenCalledTimes(1)
	expect(getUnprojectedEvents).toHaveBeenCalledTimes(2)
})
it.each([
	"kind",
	"owner",
	"stale",
	"missing",
])("supplied %s admission refuses before event reads", async (mode) => {
	const e = entry()
	const supplied =
		mode === "kind"
			? { ...token, kind: "erasure" }
			: mode === "owner"
				? { ...token, agentId: "foreign" }
				: token
	if (mode === "stale")
		vi.mocked(readErasureGate).mockResolvedValueOnce({
			_id: "gate-test",
			agentId: token.agentId,
			epoch: 8,
			state: "open",
			serial: 0,
		})
	if (mode === "missing") vi.mocked(readErasureGate).mockResolvedValueOnce(null)
	await expect(
		e.repair({ admission: supplied as AdmissionToken, singleBatch: true }),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(getUnprojectedEvents).not.toHaveBeenCalled()
	expect(captureAdmissionToken).not.toHaveBeenCalled()
	expect(e.host.chunkCount).toBe(0)
})
it("drain passes its original admission after outbox and continues on ordinary failure", async () => {
	const e = entry(),
		repair = vi.fn(async () => {
			throw new Error("owned repair failure")
		})
	e.host.repairEventProjections = repair
	e.host.memoryJobWorkerStopped = false
	await e.jobs.drainMemoryJobQueue({ admission: token })
	expect(repair).toHaveBeenCalledWith({ admission: token, singleBatch: true })
	expect(
		vi.mocked(e.host.repairExtractionOutbox).mock.invocationCallOrder[0],
	).toBeLessThan(repair.mock.invocationCallOrder[0])
	expect(e.host.pruneIdempotencyFingerprints).toHaveBeenCalledWith({
		admission: token,
	})
	expect(deadLetterExpiredMemoryJobs).toHaveBeenCalledTimes(1)
	expect(claimMemoryJob).toHaveBeenCalledWith(
		expect.objectContaining({
			jobType: "extraction",
			admissionEpoch: token.epoch,
		}),
	)
})
it("drain stops on repair gate conflict before later sweeps", async () => {
	const e = entry(),
		repair = vi.fn(async () => {
			throw new ErasureGateConflictError(token.agentId)
		})
	e.host.repairEventProjections = repair
	await expect(
		e.jobs.drainMemoryJobQueue({ admission: token }),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(e.host.pruneIdempotencyFingerprints).not.toHaveBeenCalled()
	expect(deadLetterExpiredMemoryJobs).not.toHaveBeenCalled()
	expect(recordProjectionRun).not.toHaveBeenCalled()
})
