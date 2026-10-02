import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import {
	beforeAll,
	afterAll,
	afterEach,
	beforeEach,
	expect,
	it,
	vi,
} from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { ensureCollections } from "./mongodb-schema.js"
import { QueryCacheInvalidationCoalescer } from "./mongodb-query-cache-invalidation.js"
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
	throw new Error("E130 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e130_cache_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
const pending: Promise<unknown>[] = [],
	timers: ReturnType<typeof setTimeout>[] = []
const callbacks: Array<{ identity: string; fire: () => void }> = []
const nativeDeleteMany = Collection.prototype.deleteMany
let configureSession:
	| ((session: import("mongodb").ClientSession) => void)
	| undefined
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/cache-cleanup-${label}.json`,
			JSON.stringify(data),
		)
}
function entry() {
	const agentId = `agent-${randomUUID()}`,
		host = {
			db,
			prefix,
			client,
			agentId,
			closed: false,
			config: {
				mongodb: {
					embeddingMode: "manual",
					episodes: { enabled: false, minEventsForEpisode: 6 },
				},
			},
			workspaceDir: "/tmp/memongo-e130-no-files",
			writeQueue: Promise.resolve(),
			writeQueueDepth: 0,
			chunkCount: 0,
			dirty: true,
			memoryJobWorkerStopped: true,
			memoryJobOperationContexts: new Map(),
			shouldRunPostWriteDerivedWork: () => false,
			schedulePostWriteDerivations: async () => {},
			scheduleQueryCacheInvalidation: () => {},
			startMemoryJobWorker: () => {},
			wakeMemoryJobWorker: () => {},
			queryCacheInvalidationCoalescer: new QueryCacheInvalidationCoalescer(),
		}
	const ops = new MongoDBManagerWriteOps(host as unknown as MongoDBManagerHost)
	return { agentId, ops, coalescer: host.queryCacheInvalidationCoalescer }
}
async function token(e: ReturnType<typeof entry>) {
	return captureAdmissionToken({ db, prefix, agentId: e.agentId })
}
function schedule(
	e: ReturnType<typeof entry>,
	admission?: AdmissionToken,
	scopeRef = `agent:${e.agentId}`,
) {
	e.ops.scheduleQueryCacheInvalidation({
		agentId: e.agentId,
		scope: "agent",
		scopeRef,
		...(admission ? { admission } : {}),
	} as Parameters<typeof e.ops.scheduleQueryCacheInvalidation>[0])
}
async function row(agentId: string, scopeRef = `agent:${agentId}`) {
	const now = new Date()
	await db.collection(`${prefix}query_cache`).insertOne({
		queryHash: randomUUID(),
		queryNorm: "Fresh legacy content",
		agentId,
		scope: "agent",
		scopeRef,
		results: [],
		pathUsed: "text",
		sourceScope: "agent",
		createdAt: now,
		expiresAt: new Date(now.getTime() + 3_600_000),
		hitCount: 0,
		lastHitAt: now,
	})
}
async function count(agentId: string, scopeRef = `agent:${agentId}`) {
	return db
		.collection(`${prefix}query_cache`)
		.countDocuments({ agentId, scopeRef })
}
async function gate(agentId: string) {
	return readErasureGate({ db, prefix, agentId })
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
	return gate(agentId)
}
async function settle() {
	let cursor = 0
	for (let round = 0; round < 4; round++) {
		const last = pending.length
		await Promise.allSettled(pending.slice(cursor, last))
		cursor = last
		await Promise.resolve()
		if (cursor === pending.length) return
	}
	throw new Error("E130 completion barrier exceeded")
}
function fire(index: number) {
	const callback = callbacks[index]
	expect(callback).toBeDefined()
	callback.fire()
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	await client.connect()
	await other.connect()
	await ensureCollections(db, prefix)
})
beforeEach(() => {
	const prototype = QueryCacheInvalidationCoalescer.prototype as unknown as {
		arm: (identity: string) => ReturnType<typeof setTimeout>
		onWindowElapsed: (identity: string) => void
	}
	vi.spyOn(prototype, "arm").mockImplementation(function (
		this: typeof prototype,
		identity,
	) {
		callbacks.push({ identity, fire: () => this.onWindowElapsed(identity) })
		const timer = setTimeout(() => {}, 60_000)
		timer.unref()
		timers.push(timer)
		return timer
	})
	const start = client.startSession.bind(client)
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args),
			transaction = session.withTransaction.bind(session),
			end = session.endSession.bind(session)
		session.withTransaction = ((fn, options) => {
			const result = transaction(fn, options)
			pending.push(result)
			void result.catch(() => {})
			return result
		}) as typeof transaction
		vi.spyOn(session, "endSession").mockImplementation((...endArgs) => {
			const result = end(...endArgs)
			pending.push(result)
			void result.catch(() => {})
			return result
		})
		configureSession?.(session)
		return session
	})
	const remove = nativeDeleteMany
	vi.spyOn(Collection.prototype, "deleteMany").mockImplementation(function (
		this: Collection,
		filter,
		options,
	) {
		const result = remove.call(this, filter, options)
		if (this.collectionName === `${prefix}query_cache`) {
			pending.push(result)
			void result.catch(() => {})
		}
		return result
	})
})
afterEach(async () => {
	await settle()
	for (const timer of timers) clearTimeout(timer)
	timers.length = 0
	callbacks.length = 0
	pending.length = 0
	configureSession = undefined
	vi.restoreAllMocks()
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
		vi.unstubAllEnvs()
		await other.close()
		await client.close()
	}
})
it("fresh leading cleanup deletes only its namespace and commits one serial", async () => {
	const e = entry(),
		admission = await token(e),
		before = await gate(e.agentId)
	await row(e.agentId)
	await row(e.agentId, "other-scope")
	await row("foreign-agent")
	schedule(e, admission)
	await settle()
	expect(await count(e.agentId)).toBe(0)
	expect(await count(e.agentId, "other-scope")).toBe(1)
	expect(await count("foreign-agent")).toBe(1)
	expect((await gate(e.agentId))?.serial).toBe((before?.serial ?? 0) + 1)
})
it("same-epoch burst runs one leading and one trailing", async () => {
	const e = entry(),
		admission = await token(e),
		before = await gate(e.agentId)
	await row(e.agentId)
	schedule(e, admission)
	await settle()
	await row(e.agentId)
	schedule(e, admission)
	schedule(e, admission)
	expect(callbacks).toHaveLength(1)
	fire(0)
	await settle()
	expect(await count(e.agentId)).toBe(0)
	expect((await gate(e.agentId))?.serial).toBe((before?.serial ?? 0) + 2)
	fire(1)
	expect(e.coalescer.pendingCount()).toBe(0)
})
it("a quiet window creates no second cleanup", async () => {
	const e = entry(),
		admission = await token(e)
	schedule(e, admission)
	await settle()
	const before = await gate(e.agentId)
	fire(0)
	await settle()
	expect(await gate(e.agentId)).toEqual(before)
	expect(e.coalescer.pendingCount()).toBe(0)
})
it("old trailing cleanup cannot delete fresh post-erasure legacy content", async () => {
	const e = entry(),
		admission = await token(e)
	schedule(e, admission)
	await settle()
	schedule(e, admission)
	const erased = await erase(e.agentId)
	await row(e.agentId)
	fire(0)
	await settle()
	expect(await count(e.agentId)).toBe(1)
	expect(await gate(e.agentId)).toEqual(erased)
	fire(1)
	expect(e.coalescer.pendingCount()).toBe(0)
})
it("new epoch gets an independent leading while old trailing remains harmless", async () => {
	const e = entry(),
		old = await token(e)
	schedule(e, old)
	await settle()
	schedule(e, old)
	await erase(e.agentId)
	const fresh = await token(e),
		before = await gate(e.agentId)
	await row(e.agentId)
	schedule(e, fresh)
	await settle()
	expect(callbacks).toHaveLength(2)
	expect(callbacks[0].identity).not.toBe(callbacks[1].identity)
	expect(await count(e.agentId)).toBe(0)
	expect((await gate(e.agentId))?.serial).toBe((before?.serial ?? 0) + 1)
	await row(e.agentId)
	const after = await gate(e.agentId)
	fire(0)
	await settle()
	expect(await count(e.agentId)).toBe(1)
	expect(await gate(e.agentId)).toEqual(after)
})
it("delete failure rolls back gate and rows and warns once", async () => {
	const e = entry(),
		admission = await token(e),
		before = await gate(e.agentId)
	await row(e.agentId)
	const remove = nativeDeleteMany,
		warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(Collection.prototype, "deleteMany").mockImplementation(
		async function (this: Collection, filter, options) {
			const result = await remove.call(this, filter, options)
			if (this.collectionName === `${prefix}query_cache`)
				throw new Error("E130 failure with private text")
			return result
		},
	)
	expect(() => schedule(e, admission)).not.toThrow()
	await settle()
	expect(await count(e.agentId)).toBe(1)
	expect(await gate(e.agentId)).toEqual(before)
	expect(warn).toHaveBeenCalledTimes(1)
	expect(JSON.stringify(warn.mock.calls)).not.toContain("private text")
})
it("known-aborted commit retries cleanup once without double serial", async () => {
	const e = entry(),
		admission = await token(e),
		before = await gate(e.agentId)
	await row(e.agentId)
	let attempts = 0
	configureSession = (session) => {
		const commit = session.commitTransaction.bind(session)
		vi.spyOn(session, "commitTransaction").mockImplementation(
			async (...commitArgs) => {
				if (++attempts === 1) {
					await session.abortTransaction()
					throw new MongoServerError({
						message: "E130 retry",
						code: 112,
						errorLabels: ["TransientTransactionError"],
					})
				}
				return commit(...commitArgs)
			},
		)
	}
	schedule(e, admission)
	await settle()
	expect(attempts).toBe(2)
	expect(await count(e.agentId)).toBe(0)
	expect((await gate(e.agentId))?.serial).toBe((before?.serial ?? 0) + 1)
})
it.each([
	"wrong-kind",
	"wrong-owner",
	"wrong-namespace",
])("%s warns and returns before scheduling", async (mode) => {
	const e = entry(),
		original = await token(e),
		before = await gate(e.agentId)
	await row(e.agentId)
	const admission =
		mode === "wrong-kind"
			? { ...original, kind: "erasure", runId: "wrong" }
			: mode === "wrong-owner"
				? { ...original, agentId: "foreign-agent" }
				: original
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	expect(() =>
		e.ops.scheduleQueryCacheInvalidation({
			agentId: mode === "wrong-namespace" ? "foreign-agent" : e.agentId,
			scope: "agent",
			scopeRef: `agent:${e.agentId}`,
			admission,
		} as Parameters<typeof e.ops.scheduleQueryCacheInvalidation>[0]),
	).not.toThrow()
	await settle()
	expect(callbacks).toHaveLength(0)
	expect(await count(e.agentId)).toBe(1)
	expect(await gate(e.agentId)).toEqual(before)
	expect(warn).toHaveBeenCalledTimes(1)
})
it("malformed epoch schedules no database work and warns once", async () => {
	const e = entry(),
		original = await token(e),
		before = await gate(e.agentId)
	await row(e.agentId)
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {}),
		sessions = vi.mocked(client.startSession).mock.calls.length
	schedule(e, { ...original, epoch: Number.NaN })
	await settle()
	expect(vi.mocked(client.startSession).mock.calls).toHaveLength(sessions)
	expect(await count(e.agentId)).toBe(1)
	expect(await gate(e.agentId)).toEqual(before)
	expect(warn).toHaveBeenCalledTimes(1)
})
it("direct legacy cleanup keeps its pipe key and creates no gate", async () => {
	const e = entry()
	await row(e.agentId)
	schedule(e)
	await settle()
	expect(await count(e.agentId)).toBe(0)
	expect(await gate(e.agentId)).toBeNull()
	expect(callbacks[0].identity).toBe(`${e.agentId}|agent|agent:${e.agentId}`)
})
it.each([
	false,
	true,
])("native public writer forwards original admission batch=%s", async (batch) => {
	const e = entry(),
		seen: Array<{ admission?: AdmissionToken }> = []
	const host = Reflect.get(e.ops, "host") as MongoDBManagerHost
	host.scheduleQueryCacheInvalidation = (params) => {
		seen.push(params)
	}
	if (batch) {
		const receipts = await e.ops.writeConversationEventsBatch([
			{ role: "user", body: "First", scope: "agent" },
			{ role: "user", body: "Second", scope: "agent" },
		])
		expect(receipts.every((r) => r.ok)).toBe(true)
	} else
		expect(
			(
				await e.ops.writeConversationEvent({
					role: "user",
					body: "Single",
					scope: "agent",
				})
			).eventId,
		).toBeTypeOf("string")
	await settle()
	expect(seen).toHaveLength(batch ? 2 : 1)
	expect(seen[0].admission).toEqual({
		kind: "admission",
		agentId: e.agentId,
		epoch: 0,
	})
	if (batch) expect(seen[1].admission).toBe(seen[0].admission)
})
it("public batch in one scope coalesces actual cleanup into leading and trailing", async () => {
	const e = entry(),
		host = Reflect.get(e.ops, "host") as MongoDBManagerHost
	host.scheduleQueryCacheInvalidation = (params) =>
		e.ops.scheduleQueryCacheInvalidation(params)
	await row(e.agentId)
	const receipts = await e.ops.writeConversationEventsBatch([
		{ role: "user", body: "First coalesced", scope: "agent" },
		{ role: "user", body: "Second coalesced", scope: "agent" },
	])
	expect(receipts.every((receipt) => receipt.ok)).toBe(true)
	await settle()
	expect(callbacks).toHaveLength(1)
	expect(await count(e.agentId)).toBe(0)
	expect((await gate(e.agentId))?.serial).toBe(6)
	await row(e.agentId)
	fire(0)
	await settle()
	expect(await count(e.agentId)).toBe(0)
	expect((await gate(e.agentId))?.serial).toBe(7)
})
