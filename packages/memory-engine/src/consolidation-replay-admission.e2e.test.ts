import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"
import type { ClaimedMemoryJob } from "./types.js"

const barrier = vi.hoisted(() => ({
	agentId: "",
	reached: () => {},
	resume: Promise.resolve(),
	code: "",
}))
vi.mock("./mongodb-consolidator.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-consolidator.js")>()
	return {
		...actual,
		consolidateMemory: async (
			params: Parameters<typeof actual.consolidateMemory>[0],
		) => {
			if (params.agentId === barrier.agentId) {
				barrier.reached()
				await barrier.resume
			}
			try {
				return await actual.consolidateMemory(params)
			} catch (error) {
				barrier.code =
					error instanceof Error && "code" in error ? String(error.code) : ""
				throw error
			}
		},
	}
})
vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => true,
}))

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E39 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e39_replay_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
beforeAll(async () => {
	writeFileSync(
		`${process.env.E22_FETCH_EVIDENCE_DIR}/replay-fixture-worker.json`,
		JSON.stringify({ fixturePid: process.pid }),
	)
	await client.connect()
	await ensureCollections(db, prefix)
	await db.collection(`${prefix}consolidation_runs`).createIndex(
		{ gateKey: 1 },
		{
			unique: true,
			partialFilterExpression: { gateKey: { $type: "string" } },
		},
	)
})
afterAll(async () => {
	try {
		await db.dropDatabase()
		expect(
			(
				await client
					.db("admin")
					.admin()
					.listDatabases({ nameOnly: true, filter: { name } })
			).databases,
		).toEqual([])
	} finally {
		await client.close()
	}
})
describe("consolidation replay original admission on the owned database", () => {
	it("completes a fresh replay with its stored admission epoch", async () => {
		const agentId = `agent-${randomUUID()}`
		const admission = await captureAdmissionToken({ db, prefix, agentId })
		const job: ClaimedMemoryJob = {
			jobId: `job-${randomUUID()}`,
			agentId,
			jobType: "consolidation",
			status: "running",
			createdAt: new Date(),
			startedAt: new Date(),
			attempts: 1,
			admissionEpoch: admission.epoch,
			leaseOwner: "fresh-worker",
			leaseToken: "fresh-token",
			heartbeatAt: new Date(),
			leaseExpiresAt: new Date(Date.now() + 60000),
			metadata: { maxEvents: 1 },
		}
		await db.collection(`${prefix}memory_jobs`).insertOne(job)
		const ops = new MongoDBManagerJobsOps({
			db,
			prefix,
			agentId,
			workspaceDir: "/owned/e39",
		} as unknown as MongoDBManagerHost) as unknown as {
			runClaimedConsolidationJob(
				job: ClaimedMemoryJob,
				epoch: number,
			): Promise<void>
		}
		await ops.runClaimedConsolidationJob(job, admission.epoch)
		const finished = await db
			.collection(`${prefix}memory_jobs`)
			.findOne({ jobId: job.jobId })
		const leases = await db
			.collection(`${prefix}consolidation_runs`)
			.find({ agentId })
			.toArray()
		expect(finished).toMatchObject({
			status: "completed",
			admissionEpoch: admission.epoch,
		})
		expect(leases).toHaveLength(1)
		expect(leases[0]).toMatchObject({ status: "completed" })
		expect(await readErasureGate({ db, prefix, agentId })).toMatchObject({
			epoch: 0,
			state: "open",
			serial: 1,
		})
	})
	it("does not recapture a fresh admission for pre-erasure replay options", async () => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		const job: ClaimedMemoryJob = {
			jobId: `job-${randomUUID()}`,
			agentId,
			jobType: "consolidation",
			status: "running",
			createdAt: new Date(),
			startedAt: new Date(),
			attempts: 1,
			admissionEpoch: 0,
			leaseOwner: "owned-worker",
			leaseToken: "owned-token",
			heartbeatAt: new Date(),
			leaseExpiresAt: new Date(Date.now() + 60000),
			metadata: { scope: "session", scopeRef: "session:old", maxEvents: 1 },
		}
		await db.collection(`${prefix}memory_jobs`).insertOne(job)
		const host = {
			db,
			prefix,
			agentId,
			workspaceDir: "/owned/e39",
			memoryJobWorkerId: "owned-worker",
		} as unknown as MongoDBManagerHost
		const ops = new MongoDBManagerJobsOps(host) as unknown as {
			runClaimedConsolidationJob(
				job: ClaimedMemoryJob,
				epoch: number,
			): Promise<void>
		}
		let release = () => {}
		const reached = new Promise<void>((resolve) => {
			barrier.reached = resolve
		})
		barrier.resume = new Promise<void>((resolve) => {
			release = resolve
		})
		barrier.agentId = agentId
		barrier.code = ""
		const replay = ops.runClaimedConsolidationJob(job, 0)
		try {
			await Promise.race([
				reached,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() => reject(new Error("replay barrier not reached")),
						10000,
					)
					timer.unref()
				}),
			])
			expect((await deleteAllForAgent({ db, prefix, agentId })).status).toBe(
				"complete",
			)
			const afterErase = await readErasureGate({ db, prefix, agentId })
			expect(afterErase).toMatchObject({ epoch: 1, state: "open" })
			release()
			await replay
			const leases = await db
				.collection(`${prefix}consolidation_runs`)
				.find({ agentId })
				.toArray()
			const jobs = await db
				.collection(`${prefix}memory_jobs`)
				.find({ agentId })
				.toArray()
			const gate = await readErasureGate({ db, prefix, agentId })
			writeFileSync(
				`${process.env.E22_FETCH_EVIDENCE_DIR}/replay-race-readback.json`,
				JSON.stringify({ code: barrier.code, leases, jobs, afterErase, gate }),
			)
			expect(barrier.code).toBe("ERASURE_GATE_CONFLICT")
			expect(leases).toEqual([])
			expect(jobs).toEqual([])
			expect(gate).toEqual(afterErase)
		} finally {
			release()
			await replay
			barrier.agentId = ""
		}
	})
})
