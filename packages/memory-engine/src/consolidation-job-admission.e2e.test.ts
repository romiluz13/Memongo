import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import {
	Collection,
	type Document,
	type Filter,
	type FindOneAndUpdateOptions,
	MongoClient,
} from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	type AdmissionToken,
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"

const fenceError = vi.hoisted(() => ({ code: "" }))
vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-write-fence.js")>()
	return {
		...actual,
		withFencedWrite: async (
			params: Parameters<typeof actual.withFencedWrite>[0],
		) => {
			try {
				return await actual.withFencedWrite(params)
			} catch (error) {
				fenceError.code =
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
const name = `memongo_e39_jobs_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
beforeAll(async () => {
	writeFileSync(
		`${process.env.E22_FETCH_EVIDENCE_DIR}/jobs-fixture-worker.json`,
		JSON.stringify({ fixturePid: process.pid }),
	)
	await client.connect()
	await ensureCollections(db, prefix)
	await db
		.collection(`${prefix}memory_jobs`)
		.createIndex({ jobId: 1 }, { unique: true })
})
afterAll(async () => {
	vi.restoreAllMocks()
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
function host(agentId: string) {
	return {
		db,
		prefix,
		agentId,
		workspaceDir: "/owned/e39",
		isDuplicateKeyError: (error: unknown) =>
			error instanceof Error && "code" in error && error.code === 11000,
	} as unknown as MongoDBManagerHost
}
async function stage(agentId: string) {
	const admission = await captureAdmissionToken({ db, prefix, agentId })
	return (
		new MongoDBManagerJobsOps(host(agentId)) as unknown as {
			stageAutoConsolidationJob(admission: AdmissionToken): Promise<void>
		}
	).stageAutoConsolidationJob(admission)
}
describe("consolidation job admission on the owned database", () => {
	it.each([
		"tracking",
		"automatic",
	] as const)("does not recreate a %s row after erasure", async (kind) => {
		const agentId = `agent-${randomUUID()}`
		await captureAdmissionToken({ db, prefix, agentId })
		let release = () => {}
		let reached = () => {}
		const paused = new Promise<void>((resolve) => {
			reached = resolve
		})
		const resume = new Promise<void>((resolve) => {
			release = resolve
		})
		const original = Collection.prototype.findOneAndUpdate
		let intercepted = false
		const spy = vi
			.spyOn(Collection.prototype, "findOneAndUpdate")
			.mockImplementation(async function (
				this: Collection<Document>,
				...args: [
					Filter<Document>,
					Document | Document[],
					FindOneAndUpdateOptions?,
				]
			) {
				const result = await Reflect.apply(original, this, args)
				if (
					!intercepted &&
					this.collectionName === `${prefix}meta` &&
					(args[0] as Document)._id === `tenant-erasure-epoch:${agentId}` &&
					!Array.isArray(args[1]) &&
					args[1].$setOnInsert &&
					!args[2]?.session
				) {
					intercepted = true
					reached()
					await resume
				}
				return result
			})
		fenceError.code = ""
		const run = (
			kind === "tracking"
				? new MongoDBManagerLifecycleOps(host(agentId)).consolidate({
						maxEvents: 1,
					})
				: stage(agentId)
		).then(
			() => ({ code: "" }),
			(error: Error & { code?: string }) => ({
				code: error.code ?? error.name,
			}),
		)
		try {
			await Promise.race([
				paused,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() => reject(new Error("job insertion barrier not reached")),
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
			const result = await run
			const jobs = await db
				.collection(`${prefix}memory_jobs`)
				.find({ agentId })
				.toArray()
			const leases = await db
				.collection(`${prefix}consolidation_runs`)
				.find({ agentId })
				.toArray()
			const gate = await readErasureGate({ db, prefix, agentId })
			writeFileSync(
				`${process.env.E22_FETCH_EVIDENCE_DIR}/${kind}-race-readback.json`,
				JSON.stringify({ result, jobs, leases, gate, afterErase }),
			)
			expect(fenceError.code).toBe("ERASURE_GATE_CONFLICT")
			if (kind === "tracking") expect(result.code).toBe("ERASURE_GATE_CONFLICT")
			expect(jobs).toEqual([])
			expect(leases).toEqual([])
			expect(gate).toEqual(afterErase)
		} finally {
			release()
			await run
			spy.mockRestore()
		}
	})
	it("keeps an ordinary tracking and automatic staging control", async () => {
		const directAgent = `agent-${randomUUID()}`
		await new MongoDBManagerLifecycleOps(host(directAgent)).consolidate({
			maxEvents: 1,
		})
		expect(
			await db
				.collection(`${prefix}memory_jobs`)
				.findOne({ agentId: directAgent }),
		).toMatchObject({ status: "completed", tracking: true, admissionEpoch: 0 })
		expect(
			await readErasureGate({ db, prefix, agentId: directAgent }),
		).toMatchObject({
			epoch: 0,
			state: "open",
			serial: 2,
		})
		const autoAgent = `agent-${randomUUID()}`
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now())
		try {
			await stage(autoAgent)
			const job = await db
				.collection(`${prefix}memory_jobs`)
				.findOne({ agentId: autoAgent })
			expect(job).toMatchObject({ status: "pending", admissionEpoch: 0 })
			const gate = await readErasureGate({ db, prefix, agentId: autoAgent })
			expect(gate).toMatchObject({ epoch: 0, state: "open", serial: 1 })
			await stage(autoAgent)
			expect(
				await db
					.collection(`${prefix}memory_jobs`)
					.find({ agentId: autoAgent })
					.toArray(),
			).toEqual([job])
			expect(await readErasureGate({ db, prefix, agentId: autoAgent })).toEqual(
				gate,
			)
			writeFileSync(
				`${process.env.E22_FETCH_EVIDENCE_DIR}/jobs-fresh-readback.json`,
				JSON.stringify({
					job,
					gate,
					directGate: await readErasureGate({
						db,
						prefix,
						agentId: directAgent,
					}),
				}),
			)
		} finally {
			clock.mockRestore()
		}
	})
})
