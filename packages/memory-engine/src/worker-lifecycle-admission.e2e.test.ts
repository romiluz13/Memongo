import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import {
	afterAll,
	afterEach,
	beforeAll,
	expect,
	it,
	vi,
	type Mock,
} from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	type AdmissionToken,
} from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E99 requires owned local MongoDB")
const client = new MongoClient(uri)
const name = `memongo_e99_lifecycle_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/lifecycle-${label}.json`,
			JSON.stringify(data),
		)
}
function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
type Managed = {
	host: MongoDBManagerHost
	ops: MongoDBManagerJobsOps
	writes: MongoDBManagerWriteOps
	drain: Mock<(params?: { admission?: AdmissionToken }) => Promise<void>>
	agentId: string
}
const managers: Managed[] = []
function manager(): Managed {
	const agentId = `lifecycle-${randomUUID()}`
	const drain = vi
		.fn<(params?: { admission?: AdmissionToken }) => Promise<void>>()
		.mockResolvedValue()
	const host = {
		db,
		prefix,
		agentId,
		closed: false,
		memoryJobWorkerStopped: true,
		memoryJobWorkerActive: false,
		memoryJobWakeRequested: false,
		memoryJobWorkerGeneration: 0,
		memoryJobWorkerPromise: Promise.resolve(),
		memoryJobWorkerTimer: null,
		memoryJobOperationContexts: new Map(),
		drainMemoryJobQueue: drain,
		isDuplicateKeyError: (error: unknown) =>
			Reflect.get(Object(error), "code") === 11000,
	} as unknown as MongoDBManagerHost
	const ops = new MongoDBManagerJobsOps(host),
		writes = new MongoDBManagerWriteOps(host)
	host.startMemoryJobWorker = (...args) =>
		Reflect.apply(ops.startMemoryJobWorker, ops, args)
	host.wakeMemoryJobWorker = (...args) =>
		Reflect.apply(ops.wakeMemoryJobWorker, ops, args)
	host.stopMemoryJobWorker = () => ops.stopMemoryJobWorker()
	host.scheduleBackgroundExtraction = (...args) =>
		Reflect.apply(ops.scheduleBackgroundExtraction, ops, args)
	const value = { host, ops, writes, drain, agentId }
	managers.push(value)
	return value
}
function start(
	m: ReturnType<typeof manager>,
	admission?: AdmissionToken,
	generation = 0,
) {
	Reflect.apply(m.ops.startMemoryJobWorker, m.ops, [admission, generation])
}
function wake(
	m: ReturnType<typeof manager>,
	admission?: AdmissionToken,
	generation = 0,
	timer?: NodeJS.Timeout,
) {
	Reflect.apply(m.ops.wakeMemoryJobWorker, m.ops, [
		admission,
		generation,
		timer,
	])
}
async function settle(m: ReturnType<typeof manager>) {
	for (;;) {
		const promise = m.host.memoryJobWorkerPromise
		await promise
		if (promise === m.host.memoryJobWorkerPromise) return
	}
}
async function token(m: ReturnType<typeof manager>) {
	return captureAdmissionToken({ db, prefix, agentId: m.agentId })
}
async function erase(m: ReturnType<typeof manager>) {
	expect(
		(await deleteAllForAgent({ db, prefix, agentId: m.agentId })).status,
	).toBe("complete")
}
function gateBarrier(agentId: string) {
	const entered = deferred(),
		release = deferred()
	const original = Collection.prototype.findOne
	let once = true
	const spy = vi
		.spyOn(Collection.prototype, "findOne")
		.mockImplementation(async function (this: Collection, ...args) {
			const value = await Reflect.apply(original, this, args)
			if (
				once &&
				this.collectionName === `${prefix}meta` &&
				String(Reflect.get(args[0], "_id")).endsWith(agentId)
			) {
				once = false
				entered.resolve()
				await release.promise
			}
			return value
		})
	return { entered, release, spy }
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
	await db
		.collection(`${prefix}memory_jobs`)
		.createIndex({ agentId: 1, jobId: 1 }, { unique: true })
})
afterEach(async () => {
	vi.restoreAllMocks()
	for (const m of managers.splice(0)) await m.ops.stopMemoryJobWorker()
})
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
		await client.close()
	}
})
it("rejects a delayed pre-stop generation even when its database epoch is still current", async () => {
	const m = manager(),
		admission = await token(m)
	await m.ops.stopMemoryJobWorker()
	start(m, admission, 0)
	await settle(m)
	expect(m.host.memoryJobWorkerTimer).toBeNull()
	expect(m.drain).not.toHaveBeenCalled()
})
it("rejects stale admission before installing an interval", async () => {
	const m = manager(),
		admission = await token(m)
	await erase(m)
	start(m, admission)
	await settle(m)
	expect(m.host.memoryJobWorkerTimer).toBeNull()
	expect(m.drain).not.toHaveBeenCalled()
})
it("waits for startup validation and prevents interval installation after stop", async () => {
	const m = manager(),
		admission = await token(m),
		barrier = gateBarrier(m.agentId)
	start(m, admission)
	await barrier.entered.promise
	let stopped = false
	const stop = m.ops.stopMemoryJobWorker().then(() => {
		stopped = true
	})
	await Promise.resolve()
	expect(stopped).toBe(false)
	barrier.release.resolve()
	await stop
	expect(m.host.memoryJobWorkerTimer).toBeNull()
	expect(m.drain).not.toHaveBeenCalled()
})
it("preserves an explicit pending wake instead of recapturing admission", async () => {
	const m = manager(),
		admission = await token(m),
		entered = deferred(),
		release = deferred()
	m.drain.mockImplementationOnce(async () => {
		entered.resolve()
		await release.promise
	})
	start(m, admission)
	await entered.promise
	wake(m, admission)
	release.resolve()
	await settle(m)
	expect(m.drain).toHaveBeenCalledTimes(2)
	expect(m.drain.mock.calls[1]?.[0]?.admission).toBe(admission)
})
it("keeps the newer pending epoch when an older wake arrives afterward", async () => {
	const m = manager(),
		old = await token(m),
		entered = deferred(),
		release = deferred()
	m.drain.mockImplementationOnce(async () => {
		entered.resolve()
		await release.promise
	})
	start(m, old)
	await entered.promise
	await erase(m)
	const fresh = await token(m)
	wake(m, fresh)
	wake(m, old)
	release.resolve()
	await settle(m)
	expect(m.drain.mock.calls[1]?.[0]?.admission).toBe(fresh)
})
it("does not let a tokenless pending request displace explicit admission", async () => {
	const m = manager(),
		admission = await token(m),
		entered = deferred(),
		release = deferred()
	m.drain.mockImplementationOnce(async () => {
		entered.resolve()
		await release.promise
	})
	start(m, admission)
	await entered.promise
	wake(m, admission)
	wake(m)
	release.resolve()
	await settle(m)
	expect(m.drain.mock.calls[1]?.[0]?.admission).toBe(admission)
})
it("retires an old interval and lets fresh admission restart exactly one timer", async () => {
	const m = manager(),
		admission = await token(m),
		intervals = vi.spyOn(globalThis, "setInterval")
	start(m, admission)
	await settle(m)
	const oldTimer = m.host.memoryJobWorkerTimer
	expect(oldTimer).not.toBeNull()
	await erase(m)
	wake(m, admission, 0, oldTimer ?? undefined)
	await settle(m)
	expect(m.host.memoryJobWorkerTimer).toBeNull()
	const fresh = await token(m)
	start(m, fresh)
	await settle(m)
	const current = m.host.memoryJobWorkerTimer
	expect(current).not.toBeNull()
	wake(m, admission, 0, oldTimer ?? undefined)
	await settle(m)
	expect(m.host.memoryJobWorkerTimer).toBe(current)
	expect(intervals).toHaveBeenCalledTimes(2)
})
it("serializes concurrent starts into one active drain and one interval", async () => {
	const m = manager(),
		admission = await token(m),
		barrier = gateBarrier(m.agentId)
	const intervals = vi.spyOn(globalThis, "setInterval")
	start(m, admission)
	await barrier.entered.promise
	start(m, admission)
	barrier.release.resolve()
	await settle(m)
	expect(intervals).toHaveBeenCalledTimes(1)
	expect(m.host.memoryJobWorkerTimer?.hasRef()).toBe(false)
})
it("does not re-wake a pending request after stop", async () => {
	const m = manager(),
		admission = await token(m),
		entered = deferred(),
		release = deferred()
	m.drain.mockImplementationOnce(async () => {
		entered.resolve()
		await release.promise
	})
	start(m, admission)
	await entered.promise
	wake(m, admission)
	const stop = m.ops.stopMemoryJobWorker()
	release.resolve()
	await stop
	expect(m.drain).toHaveBeenCalledTimes(1)
	expect(m.host.memoryJobWorkerTimer).toBeNull()
})
it("owns a fresh-generation pending run until stop has awaited the latest promise", async () => {
	const m = manager(),
		admission = await token(m),
		entered = deferred(),
		release = deferred(),
		second = deferred(),
		finish = deferred()
	m.drain.mockImplementationOnce(async () => {
		entered.resolve()
		await release.promise
	})
	m.drain.mockImplementationOnce(async () => {
		second.resolve()
		await finish.promise
	})
	start(m, admission)
	await entered.promise
	let stopped = false
	const stop = m.ops.stopMemoryJobWorker().then(() => {
		stopped = true
	})
	start(m, admission, 1)
	release.resolve()
	await second.promise
	expect(stopped).toBe(false)
	finish.resolve()
	await stop
	expect(m.drain.mock.calls[1]?.[0]?.admission).toBe(admission)
})
it("retries a transient boot validation failure with the same request", async () => {
	const m = manager(),
		intervals = vi.spyOn(globalThis, "setInterval"),
		original = Collection.prototype.findOne
	let once = true
	vi.spyOn(Collection.prototype, "findOne").mockImplementation(async function (
		this: Collection,
		...args
	) {
		if (
			once &&
			this.collectionName === `${prefix}meta` &&
			String(Reflect.get(args[0], "_id")).endsWith(m.agentId)
		) {
			once = false
			throw new Error("transient gate read")
		}
		return Reflect.apply(original, this, args)
	})
	start(m)
	await settle(m)
	expect(m.host.memoryJobWorkerTimer).not.toBeNull()
	expect(m.drain).not.toHaveBeenCalled()
	const callback = intervals.mock.calls[0]?.[0]
	expect(typeof callback).toBe("function")
	if (typeof callback === "function") callback()
	await settle(m)
	expect(m.drain).toHaveBeenCalledTimes(1)
	expect(m.drain.mock.calls[0]?.[0]?.admission?.agentId).toBe(m.agentId)
})
it("captures manual extraction generation before a scoped read delayed across stop", async () => {
	const m = manager(),
		eventId = "owned",
		original = Collection.prototype.findOne
	await db.collection(`${prefix}events`).insertOne({
		agentId: m.agentId,
		eventId,
		body: "owned",
		role: "user",
		timestamp: new Date(),
		validAt: new Date(),
		scope: "agent",
		scopeRef: "owned",
	})
	vi.spyOn(Collection.prototype, "findOne").mockImplementation(async function (
		this: Collection,
		...args
	) {
		const value = await Reflect.apply(original, this, args)
		if (
			this.collectionName === `${prefix}events` &&
			Reflect.get(args[0], "agentId") === m.agentId
		)
			await m.ops.stopMemoryJobWorker()
		return value
	})
	await expect(
		m.writes.extractEvent({ eventId, scope: "agent", scopeRef: "owned" }),
	).resolves.toMatchObject({ scheduled: true })
	await settle(m)
	expect(m.host.memoryJobWorkerTimer).toBeNull()
	expect(m.drain).not.toHaveBeenCalled()
	expect(
		await db.collection(`${prefix}memory_jobs`).findOne({ agentId: m.agentId }),
	).toMatchObject({ status: "pending", admissionEpoch: 0 })
})
