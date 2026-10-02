import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { MongoDBManagerSyncOps } from "./mongodb-manager-sync.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import {
	getPendingExtractionEvents,
	writeEvent,
	writeEventsBatch,
} from "./mongodb-events.js"
import { ensureCollections } from "./mongodb-schema.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import {
	captureAdmissionToken,
	readErasureGate,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E140 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri)
const name = `memongo_e140_periodic_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/periodic-${label}.json`,
			JSON.stringify(data),
		)
}
type RepairParams = { admission?: AdmissionToken; singleBatch?: boolean }
function entry() {
	const agentId = `agent-${randomUUID()}`
	const host = {
		db,
		prefix,
		client,
		agentId,
		chunkCount: 0,
		closed: false,
		dirty: true,
		config: {
			mongodb: {
				embeddingMode: "manual",
				episodes: { enabled: false, minEventsForEpisode: 6 },
			},
		},
		workspaceDir: "/tmp/memongo-e140-no-files",
		writeQueue: Promise.resolve(),
		writeQueueDepth: 0,
		memoryJobWorkerStopped: true,
		memoryJobOperationContexts: new Map(),
		shouldRunPostWriteDerivedWork: () => true,
		schedulePostWriteDerivations: async () => {},
		scheduleQueryCacheInvalidation: () => {},
		startMemoryJobWorker: () => {},
		wakeMemoryJobWorker: () => {},
		pruneIdempotencyFingerprints: async () => ({ pruned: 0 }),
	} as unknown as MongoDBManagerHost
	const sync = new MongoDBManagerSyncOps(host),
		jobs = new MongoDBManagerJobsOps(host)
	const repair = sync.repairEventProjections.bind(sync) as (
		params?: RepairParams,
	) => ReturnType<typeof sync.repairEventProjections>
	host.repairEventProjections = repair
	host.repairExtractionOutbox = sync.repairExtractionOutbox.bind(sync)
	return {
		agentId,
		host,
		sync,
		jobs,
		repair,
		writes: new MongoDBManagerWriteOps(host),
	}
}
async function seed(e: ReturnType<typeof entry>, count = 1) {
	const receipts = await writeEventsBatch({
		db,
		prefix,
		events: Array.from({ length: count }, () => ({
			eventId: randomUUID(),
			agentId: e.agentId,
			role: "user",
			body: "Remember this source",
			scope: "agent",
			scopeRef: `agent:${e.agentId}`,
			timestamp: new Date(),
		})),
	})
	expect(receipts.every((r) => r.ok)).toBe(true)
}
async function rows(e: ReturnType<typeof entry>) {
	return {
		chunks: await db
			.collection(`${prefix}chunks`)
			.find({ agentId: e.agentId })
			.toArray(),
		events: await db
			.collection(`${prefix}events`)
			.find({ agentId: e.agentId })
			.toArray(),
		runs: await db
			.collection(`${prefix}projection_runs`)
			.find({ agentId: e.agentId, projectionType: "chunks" })
			.toArray(),
	}
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	vi.stubEnv("MEMONGO_AUTO_CONSOLIDATION_MS", "0")
	await client.connect()
	await other.connect()
	await ensureCollections(db, prefix)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
	try {
		await db.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name } })
		expect(listed.databases).toEqual([])
		evidence("cleanup", { name, databases: listed.databases })
	} finally {
		vi.unstubAllEnvs()
		await other.close()
		await client.close()
	}
})
it("manual worker tick repairs failed durable projection after real job release cleared its outbox marker", async () => {
	const e = entry(),
		original = Collection.prototype.updateOne
	let hit = false
	const fault = vi
		.spyOn(Collection.prototype, "updateOne")
		.mockImplementation(async function (
			this: Collection,
			filter,
			update,
			options,
		) {
			if (!hit && this.collectionName === `${prefix}chunks`) {
				hit = true
				throw new Error("owned inline projection failure")
			}
			return Reflect.apply(original, this, [filter, update, options])
		})
	const receipt = await e.writes.writeConversationEvent({
		role: "user",
		body: "Remember the durable event",
		scope: "agent",
	})
	fault.mockRestore()
	expect(hit).toBe(true)
	expect(receipt.eventId).toBeTypeOf("string")
	const before = await rows(e)
	expect(before.chunks).toEqual([])
	expect(before.events).toHaveLength(1)
	expect(before.events[0]).not.toHaveProperty("projectedAt")
	expect(before.events[0]).not.toHaveProperty("extractionJobPendingAt")
	expect(
		await getPendingExtractionEvents({ db, prefix, agentId: e.agentId }),
	).toEqual([])
	expect(
		await db.collection(`${prefix}memory_jobs`).findOne({ agentId: e.agentId }),
	).toMatchObject({ status: "pending" })
	expect(before.runs).toEqual([
		expect.objectContaining({ status: "failed", itemsProjected: 0 }),
	])
	await e.jobs.drainMemoryJobQueue({
		admission: await captureAdmissionToken({ db, prefix, agentId: e.agentId }),
	})
	const after = await rows(e)
	expect(after.chunks).toHaveLength(1)
	expect(after.events[0].projectedAt).toBeInstanceOf(Date)
	expect(e.host.chunkCount).toBe(1)
	evidence("durable-recovery", {
		eventId: receipt.eventId,
		before,
		after,
		chunkCount: e.host.chunkCount,
		jobExecutionNative: false,
		timerExecuted: false,
	})
})
it("manual worker ticks process one 500-event batch then the remaining event", async () => {
	const e = entry()
	await seed(e, 501)
	const admission = await captureAdmissionToken({
		db,
		prefix,
		agentId: e.agentId,
	})
	await e.jobs.drainMemoryJobQueue({ admission })
	const first = await rows(e)
	expect(first.chunks).toHaveLength(500)
	expect(first.events.filter((event) => event.projectedAt)).toHaveLength(500)
	expect(e.host.chunkCount).toBe(500)
	await e.jobs.drainMemoryJobQueue({ admission })
	expect((await rows(e)).chunks).toHaveLength(501)
	expect(e.host.chunkCount).toBe(501)
	evidence("bounded-ticks", {
		firstCount: first.chunks.length,
		finalCount: e.host.chunkCount,
	})
})
it("argument-free startup repair still drains all 501 events", async () => {
	const e = entry()
	await seed(e, 501)
	expect(await e.repair()).toEqual({ eventsProcessed: 501, chunksCreated: 501 })
	expect((await rows(e)).chunks).toHaveLength(501)
})
it.each([
	"bulk",
	"marker",
])("worker %s failure rolls back the batch and a later tick heals it", async (stage) => {
	const e = entry()
	await seed(e)
	const admission = await captureAdmissionToken({
			db,
			prefix,
			agentId: e.agentId,
		}),
		bulk = Collection.prototype.bulkWrite,
		mark = Collection.prototype.updateMany
	let hit = false
	const fault =
		stage === "bulk"
			? vi
					.spyOn(Collection.prototype, "bulkWrite")
					.mockImplementation(async function (this: Collection, ops, options) {
						const result = await Reflect.apply(bulk, this, [ops, options])
						if (this.collectionName === `${prefix}chunks`) {
							hit = true
							throw new Error("owned bulk failure")
						}
						return result
					})
			: vi
					.spyOn(Collection.prototype, "updateMany")
					.mockImplementation(async function (
						this: Collection,
						filter,
						update,
						options,
					) {
						const result = await Reflect.apply(mark, this, [
							filter,
							update,
							options,
						])
						if (this.collectionName === `${prefix}events`) {
							hit = true
							throw new Error("owned marker failure")
						}
						return result
					})
	await e.jobs.drainMemoryJobQueue({ admission })
	fault.mockRestore()
	expect(hit).toBe(true)
	const failed = await rows(e)
	expect(failed.chunks).toEqual([])
	expect(failed.events[0]).not.toHaveProperty("projectedAt")
	expect(e.host.chunkCount).toBe(0)
	expect(failed.runs).toEqual([
		expect.objectContaining({ status: "failed", itemsProjected: 0 }),
	])
	await e.jobs.drainMemoryJobQueue({ admission })
	expect((await rows(e)).chunks).toHaveLength(1)
	expect(e.host.chunkCount).toBe(1)
	evidence(`rollback-${stage}`, { failed, healed: await rows(e) })
})
it("queued worker epoch refuses after outbox pause and same-ID fresh reimport without an event read", async () => {
	const e = entry()
	await seed(e)
	const admission = await captureAdmissionToken({
			db,
			prefix,
			agentId: e.agentId,
		}),
		prior = (await rows(e)).events[0]
	e.host.repairExtractionOutbox = async () => {
		expect(
			(
				await deleteAllForAgent({
					db: other.db(name),
					prefix,
					agentId: e.agentId,
				})
			).status,
		).toBe("complete")
		await captureAdmissionToken({
			db: other.db(name),
			prefix,
			agentId: e.agentId,
		})
		await writeEvent({
			db: other.db(name),
			prefix,
			event: {
				eventId: prior.eventId,
				agentId: e.agentId,
				role: "user",
				body: "Fresh reimport",
				scope: "agent",
				scopeRef: `agent:${e.agentId}`,
				timestamp: new Date(),
			},
		})
		return {
			eventsProcessed: 0,
			jobsCreated: 0,
			jobsReleased: 0,
			eventsFailed: 0,
		}
	}
	const find = Collection.prototype.find
	let reads = 0
	const spy = vi
		.spyOn(Collection.prototype, "find")
		.mockImplementation(function (this: Collection, filter, options) {
			if (
				this.dbName === name &&
				this.collectionName === `${prefix}events` &&
				Reflect.has(filter ?? {}, "projectedAt")
			)
				reads++
			return Reflect.apply(find, this, [filter, options])
		})
	await expect(e.jobs.drainMemoryJobQueue({ admission })).rejects.toMatchObject(
		{ code: "ERASURE_GATE_CONFLICT" },
	)
	spy.mockRestore()
	expect(reads).toBe(0)
	expect(e.host.chunkCount).toBe(0)
	const actual = await rows(e)
	expect(actual.chunks).toEqual([])
	expect(actual.runs).toEqual([])
	expect(actual.events[0]).toMatchObject({ body: "Fresh reimport" })
	expect(actual.events[0]).not.toHaveProperty("projectedAt")
	evidence("stale-tick", {
		reads,
		actual,
		gate: await readErasureGate({ db, prefix, agentId: e.agentId }),
	})
})

it.each([
	"kind",
	"owner",
])("supplied %s refuses before snapshot even with no unprojected events", async (mode) => {
	const e = entry(),
		admission = await captureAdmissionToken({ db, prefix, agentId: e.agentId })
	const supplied =
		mode === "kind"
			? { ...admission, kind: "erasure", runId: "wrong" }
			: { ...admission, agentId: "foreign" }
	const find = Collection.prototype.find
	let reads = 0
	const spy = vi
		.spyOn(Collection.prototype, "find")
		.mockImplementation(function (this: Collection, filter, options) {
			if (this.dbName === name && this.collectionName === `${prefix}events`)
				reads++
			return Reflect.apply(find, this, [filter, options])
		})
	await expect(
		e.repair({ admission: supplied as AdmissionToken, singleBatch: true }),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	spy.mockRestore()
	expect(reads).toBe(0)
	expect(e.host.chunkCount).toBe(0)
})
