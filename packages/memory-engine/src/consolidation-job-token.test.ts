import type { ClientSession } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import {
	beginErasure,
	captureAdmissionToken,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"
import type { ClaimedMemoryJob } from "./types.js"

vi.mock("./mongodb-consolidator.js", () => ({
	consolidateMemory: vi.fn(async () => ({
		runId: "result",
		eventsProcessed: 0,
		factsPromoted: 0,
		factsPruned: 0,
		conflictsResolved: 0,
		durationMs: 0,
		candidates: [],
	})),
}))
beforeEach(() => vi.mocked(consolidateMemory).mockClear())
function fixture() {
	const f = createStatefulMongoFake()
	const host = {
		db: f.db,
		prefix: "test_",
		agentId: "agent1",
		workspaceDir: "/owned/test",
		isDuplicateKeyError: (error: unknown) =>
			error instanceof Error && "code" in error && error.code === 11000,
	} as unknown as MongoDBManagerHost
	return { f, host }
}
describe("new consolidation jobs preserve admission and legacy boundaries", () => {
	it.each([
		undefined,
		null,
		0,
		5,
		-1,
		1.5,
		"5",
	])("forwards present epochs without recapturing; legacy %j is unchanged", async (epoch) => {
		const { f, host } = fixture()
		await captureAdmissionToken({
			db: f.db,
			prefix: "test_",
			agentId: "agent1",
		})
		const job = {
			jobId: "job",
			agentId: "agent1",
			jobType: "consolidation",
			status: "running",
			createdAt: new Date(),
			attempts: 1,
			leaseOwner: "worker",
			leaseToken: "lease",
			heartbeatAt: new Date(),
			leaseExpiresAt: new Date(Date.now() + 60000),
			...(epoch === undefined ? {} : { admissionEpoch: epoch }),
		} as ClaimedMemoryJob
		await f.collection("memory_jobs").insertOne(job)
		const ops = new MongoDBManagerJobsOps(host) as unknown as {
			runClaimedConsolidationJob(
				job: ClaimedMemoryJob,
				epoch: number,
			): Promise<void>
		}
		await ops.runClaimedConsolidationJob(job, 0)
		const call = vi.mocked(consolidateMemory).mock.calls[0]?.[0]
		expect(call).toBeDefined()
		if (epoch == null) expect(call).not.toHaveProperty("admission")
		else
			expect(call?.admission).toEqual({
				kind: "admission",
				agentId: "agent1",
				epoch,
			})
	})
	it("captures before tracking and forwards the same epoch", async () => {
		const { f, host } = fixture()
		await new MongoDBManagerLifecycleOps(host).consolidate({ maxEvents: 1 })
		expect(f.all("memory_jobs")[0]).toMatchObject({
			admissionEpoch: 0,
			status: "completed",
			tracking: true,
		})
		expect(vi.mocked(consolidateMemory).mock.calls[0]?.[0].admission).toEqual({
			kind: "admission",
			agentId: "agent1",
			epoch: 0,
		})
	})
	it("rejects erasing admission before tracking or run", async () => {
		const { f, host } = fixture()
		await beginErasure({ db: f.db, prefix: "test_", agentId: "agent1" })
		await expect(
			new MongoDBManagerLifecycleOps(host).consolidate(),
		).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
		expect(f.all("memory_jobs")).toEqual([])
		expect(consolidateMemory).not.toHaveBeenCalled()
	})
	it.each([
		"tracking",
		"automatic",
	])("keeps %s job dates and identity stable across callback attempts", async (kind) => {
		const { f, host } = fixture()
		const admission = await captureAdmissionToken({
			db: f.db,
			prefix: "test_",
			agentId: "agent1",
		})
		const attempts: unknown[] = []
		const insert = vi
			.spyOn(f.collection("memory_jobs"), "insertOne")
			.mockImplementation(async (doc) => {
				attempts.push(structuredClone(doc))
				return { acknowledged: true, insertedId: "job" }
			})
		vi.spyOn(f.db.client, "startSession").mockImplementation(
			() =>
				({
					inTransaction: () => false,
					withTransaction: async (fn: () => Promise<unknown>) => {
						const result = await fn()

						await fn()

						return result
					},
					endSession: async () => {},
				}) as unknown as ClientSession,
		)
		if (kind === "tracking")
			await new MongoDBManagerLifecycleOps(host).consolidate({ maxEvents: 1 })
		else
			await (
				new MongoDBManagerJobsOps(host) as unknown as {
					stageAutoConsolidationJob(admission: AdmissionToken): Promise<void>
				}
			).stageAutoConsolidationJob(admission)
		expect(insert.mock.calls).toHaveLength(2)
		expect(insert.mock.calls[0]?.[0]).toEqual(insert.mock.calls[1]?.[0])
		expect(insert.mock.calls[0]?.[0]).toMatchObject({
			createdAt: expect.any(Date),
			admissionEpoch: 0,
		})
		expect(attempts).toHaveLength(2)
	})
})
