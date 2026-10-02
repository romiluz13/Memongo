import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import {
	captureAdmissionToken,
	readErasureGate,
} from "./mongodb-write-fence.js"
import { ensureCollections } from "./mongodb-schema.js"
import { writeEvent } from "./mongodb-events.js"
import {
	checkAutoEpisodeTriggers,
	materializeEpisode,
} from "./mongodb-episodes.js"
import { heuristicEpisodeSummarizer } from "./mongodb-derived-memory.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E127a owned Mongo only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e127a_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/episode-${label}.json`,
			JSON.stringify(data),
		)
}
async function entry() {
	const agentId = `agent-${randomUUID()}`,
		admission = await captureAdmissionToken({ db, prefix, agentId })
	const events = [0, 1].map((i) => ({
		eventId: randomUUID(),
		agentId,
		role: "user" as const,
		body: `Original event ${i}`,
		timestamp: new Date(1770000000000 + i * 1000),
		scope: "agent" as const,
		scopeRef: `agent:${agentId}`,
	}))
	for (const event of events) await writeEvent({ db, prefix, event })
	return { agentId, admission, events }
}
function material(
	e: Awaited<ReturnType<typeof entry>>,
	summarizer = heuristicEpisodeSummarizer,
) {
	const params = {
		db,
		prefix,
		agentId: e.agentId,
		admission: e.admission,
		type: "thread" as const,
		timeRange: { start: e.events[0].timestamp, end: e.events[1].timestamp },
		events: e.events,
		summarizer,
	}
	return materializeEpisode(params)
}
function auto(e: Awaited<ReturnType<typeof entry>>) {
	const params = {
		db,
		prefix,
		agentId: e.agentId,
		admission: e.admission,
		summarizer: heuristicEpisodeSummarizer,
		force: true,
	}
	return checkAutoEpisodeTriggers(params)
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
	return readErasureGate({ db: otherDb, prefix, agentId })
}
async function counts(agentId: string) {
	return {
		episodes: await db
			.collection(`${prefix}episodes`)
			.countDocuments({ agentId }),
		runs: await db
			.collection(`${prefix}projection_runs`)
			.countDocuments({ agentId }),
	}
}
function beforeFence(stage: number, action: () => Promise<unknown>) {
	let explicit = 0,
		hit = false
	const start = client.startSession.bind(client)
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === stage) {
			const txn = session.withTransaction.bind(session)
			session.withTransaction = ((
				fn: Parameters<typeof txn>[0],
				options?: Parameters<typeof txn>[1],
			) =>
				txn(async (s) => {
					if (!hit) {
						hit = true
						await action()
					}
					return fn(s)
				}, options)) as typeof txn
		}
		return session
	})
	return () => hit
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	await client.connect()
	await other.connect()
	await ensureCollections(db, prefix)
})
afterEach(() => {
	vi.restoreAllMocks()
	delete process.env.MEMONGO_EPISODES_MAX_PER_SCOPE
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
it("fresh canonical episode and selected markers keep stable identity", async () => {
	const e = await entry(),
		result = await auto(e)
	expect(result.triggered).toBe(true)
	expect(await counts(e.agentId)).toEqual({ episodes: 1, runs: 1 })
	expect(
		await db.collection(`${prefix}events`).countDocuments({
			agentId: e.agentId,
			consolidatedIntoEpisodeId: result.episode?.episodeId,
		}),
	).toBe(2)
	const again = await material(e)
	expect(again?.episodeId).toBe(result.episode?.episodeId)
	expect(await counts(e.agentId)).toEqual({ episodes: 1, runs: 2 })
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(6)
})
it("selected old summary cannot recreate canonical episode after erasure", async () => {
	const e = await entry()
	let erased: Awaited<ReturnType<typeof erase>> | undefined
	const summarizer = async (
		...args: Parameters<typeof heuristicEpisodeSummarizer>
	) => {
		const result = await heuristicEpisodeSummarizer(...args)
		erased = await erase(e.agentId)
		return result
	}
	await expect(material(e, summarizer)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(await counts(e.agentId)).toEqual({ episodes: 0, runs: 0 })
	expect(erased).toBeDefined()
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it.each([
	"few-events",
	"few-conversational",
	"failed",
])("old %s diagnostic cannot reappear", async (mode) => {
	const e = await entry()
	let erased: Awaited<ReturnType<typeof erase>> | undefined
	if (mode === "failed") {
		await expect(
			material(e, async () => {
				erased = await erase(e.agentId)
				throw new Error("E127a summary failure")
			}),
		).rejects.toThrow("E127a summary failure")
	} else {
		const insert = Collection.prototype.insertOne
		beforeFence(1, async () => {
			erased = await erase(e.agentId)
		})
		vi.spyOn(Collection.prototype, "insertOne").mockImplementation(
			async function (this: Collection, doc, options) {
				if (
					this.collectionName === `${prefix}projection_runs` &&
					!options?.session
				)
					erased = await erase(e.agentId)
				return insert.call(this, doc, options)
			},
		)
		const params = {
			db,
			prefix,
			agentId: e.agentId,
			admission: e.admission,
			type: "thread" as const,
			timeRange: { start: e.events[0].timestamp, end: e.events[1].timestamp },
			events:
				mode === "few-events"
					? [e.events[0]]
					: e.events.map((x) => ({ ...x, role: "system" })),
			summarizer: heuristicEpisodeSummarizer,
		}
		expect(await materializeEpisode(params)).toBeNull()
	}
	expect(await counts(e.agentId)).toEqual({ episodes: 0, runs: 0 })
	expect(erased).toBeDefined()
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it("old successful diagnostic cannot reappear after canonical commit", async () => {
	const e = await entry()
	let erased: Awaited<ReturnType<typeof erase>> | undefined
	beforeFence(3, async () => {
		erased = await erase(e.agentId)
	})
	const insert = Collection.prototype.insertOne
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(
		async function (this: Collection, doc, options) {
			if (
				this.collectionName === `${prefix}projection_runs` &&
				!options?.session
			)
				erased = await erase(e.agentId)
			return insert.call(this, doc, options)
		},
	)
	expect(await material(e)).not.toBeNull()
	expect(await counts(e.agentId)).toEqual({ episodes: 0, runs: 0 })
	expect(erased).toBeDefined()
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it("old cap cannot prune fresh post-erasure episodes", async () => {
	const e = await entry()
	process.env.MEMONGO_EPISODES_MAX_PER_SCOPE = "1"
	let erased: Awaited<ReturnType<typeof erase>> | undefined,
		done = false
	const action = async () => {
		if (done) return
		done = true
		erased = await erase(e.agentId)
		await otherDb.collection(`${prefix}episodes`).insertMany(
			[0, 1].map((i) => ({
				agentId: e.agentId,
				episodeId: `fresh-${i}`,
				type: "thread",
				title: "Fresh title",
				summary: "Fresh summary",
				timeRange: { start: new Date(), end: new Date() },
				sourceEventCount: 2,
				updatedAt: new Date(),
				status: "active",
				scope: "agent",
				scopeRef: `agent:${e.agentId}`,
				createdAt: new Date(i),
			})),
		)
	}
	beforeFence(2, action)
	const count = Collection.prototype.countDocuments
	vi.spyOn(Collection.prototype, "countDocuments").mockImplementation(
		async function (this: Collection, filter, options) {
			if (this.collectionName === `${prefix}episodes` && !options?.session)
				await action()
			return count.call(this, filter, options)
		},
	)
	expect(await material(e)).not.toBeNull()
	expect(done).toBe(true)
	expect(
		await db
			.collection(`${prefix}episodes`)
			.countDocuments({ agentId: e.agentId, episodeId: /^fresh-/ }),
	).toBe(2)
	expect(erased).toBeDefined()
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it.each([
	false,
	true,
])("old marker cannot stamp reimported same-ID event foreign=%s", async (foreign) => {
	const e = await entry()
	let erased: Awaited<ReturnType<typeof erase>> | undefined,
		done = false
	const action = async () => {
		if (done) return
		done = true
		erased = await erase(e.agentId)
		await writeEvent({
			db: otherDb,
			prefix,
			event: {
				...e.events[0],
				agentId: foreign ? `other-${randomUUID()}` : e.agentId,
				body: "Fresh reimport",
			},
		})
	}
	beforeFence(4, action)
	const update = Collection.prototype.updateMany
	vi.spyOn(Collection.prototype, "updateMany").mockImplementation(
		async function (this: Collection, filter, changes, options) {
			if (
				this.collectionName === `${prefix}events` &&
				!Array.isArray(changes) &&
				Reflect.has(changes.$set ?? {}, "consolidatedAt") &&
				!options?.session
			)
				await action()
			return update.call(this, filter, changes, options)
		},
	)
	await expect(auto(e)).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(done).toBe(true)
	const row = await db
		.collection(`${prefix}events`)
		.findOne({ eventId: e.events[0].eventId })
	expect(row?.body).toBe("Fresh reimport")
	expect(row?.consolidatedAt).toBeUndefined()
	expect(erased).toBeDefined()
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it.each([
	["material", "owner"],
	["auto", "owner"],
	["material", "kind"],
	["auto", "kind"],
])("%s rejects wrong-%s carrier before any source read", async (mode, mismatch) => {
	const e = await entry(),
		find = vi.spyOn(Collection.prototype, "find")
	const params = {
		db,
		prefix,
		agentId: e.agentId,
		admission: {
			...e.admission,
			...(mismatch === "owner"
				? { agentId: "foreign" }
				: { kind: "erasure" as unknown as "admission" }),
		},
		type: "thread" as const,
		timeRange: { start: e.events[0].timestamp, end: e.events[1].timestamp },
		summarizer: heuristicEpisodeSummarizer,
		force: true,
	}
	await expect(
		mode === "material"
			? materializeEpisode(params)
			: checkAutoEpisodeTriggers(params),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(find).not.toHaveBeenCalled()
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(0)
})
it("admitted marker excludes a foreign owner without an epoch change", async () => {
	const e = await entry()
	beforeFence(4, async () => {
		await otherDb
			.collection(`${prefix}events`)
			.updateOne(
				{ eventId: e.events[0].eventId },
				{ $set: { agentId: `foreign-${randomUUID()}` } },
			)
	})
	expect((await auto(e)).triggered).toBe(true)
	const row = await db
		.collection(`${prefix}events`)
		.findOne({ eventId: e.events[0].eventId })
	expect(row?.consolidatedAt).toBeUndefined()
	expect(
		await db.collection(`${prefix}events`).countDocuments({
			agentId: e.agentId,
			consolidatedAt: { $exists: true },
		}),
	).toBe(1)
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(4)
})
it("admitted duplicate aborts canonical stage without internal retry", async () => {
	const e = await entry(),
		update = Collection.prototype.updateOne
	let attempts = 0
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
		this: Collection,
		filter,
		changes,
		options,
	) {
		if (this.collectionName === `${prefix}episodes`) {
			attempts++
			return Promise.reject(
				new MongoServerError({ message: "E127a duplicate", code: 11000 }),
			)
		}
		return update.call(this, filter, changes, options)
	})
	await expect(material(e)).rejects.toMatchObject({ code: 11000 })
	expect(attempts).toBe(1)
	expect(await counts(e.agentId)).toEqual({ episodes: 0, runs: 1 })
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(1)
})
it("known-aborted canonical replay does not re-summarize or duplicate", async () => {
	const e = await entry(),
		start = client.startSession.bind(client)
	let explicit = 0,
		attempts = 0
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === 1) {
			const commit = session.commitTransaction.bind(session)
			vi.spyOn(session, "commitTransaction").mockImplementation(
				async (...args) => {
					if (++attempts === 1) {
						await session.abortTransaction()
						throw new MongoServerError({
							message: "E127a retry",
							code: 112,
							errorLabels: ["TransientTransactionError"],
						})
					}
					return commit(...args)
				},
			)
		}
		return session
	})
	const summarizer = vi.fn(heuristicEpisodeSummarizer)
	expect(await material(e, summarizer)).not.toBeNull()
	expect(attempts).toBe(2)
	expect(summarizer).toHaveBeenCalledOnce()
	expect(await counts(e.agentId)).toEqual({ episodes: 1, runs: 1 })
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(3)
})
it.each([
	false,
	true,
])("public write keeps original carrier into episode queue batch=%s", async (batch) => {
	const agentId = `agent-${randomUUID()}`,
		tasks: Array<() => Promise<void>> = []
	const host = {
		db,
		prefix,
		client,
		agentId,
		closed: false,
		config: {
			mongodb: {
				embeddingMode: "manual",
				episodes: { enabled: true, minEventsForEpisode: 2 },
			},
		},
		workspaceDir: "/tmp/e127a-no-files",
		writeQueue: Promise.resolve(),
		writeQueueDepth: 0,
		chunkCount: 0,
		dirty: true,
		memoryJobWorkerStopped: true,
		memoryJobOperationContexts: new Map(),
		shouldRunPostWriteDerivedWork: () => false,
		enqueueDerivedWork: (fn: () => Promise<void>) => tasks.push(fn),
		scheduleQueryCacheInvalidation: () => {},
		startMemoryJobWorker: () => {},
		wakeMemoryJobWorker: () => {},
	}
	const jobs = new MongoDBManagerJobsOps(host as unknown as MongoDBManagerHost)
	Object.assign(host, {
		schedulePostWriteDerivations: async (
			params: Parameters<
				MongoDBManagerJobsOps["schedulePostWriteDerivations"]
			>[0],
		) => {
			host.shouldRunPostWriteDerivedWork = () => true
			try {
				await jobs.schedulePostWriteDerivations(params)
			} finally {
				host.shouldRunPostWriteDerivedWork = () => false
			}
		},
	})
	const writer = new MongoDBManagerWriteOps(
			host as unknown as MongoDBManagerHost,
		),
		input = {
			role: "user" as const,
			body: "Queued source",
			scope: "agent" as const,
		}
	if (batch)
		await writer.writeConversationEventsBatch([
			input,
			{ ...input, body: "Queued second" },
		])
	else {
		await writer.writeConversationEvent(input)
		await writer.writeConversationEvent({ ...input, body: "Queued second" })
	}
	expect(tasks.length).toBeGreaterThan(0)
	const original = await captureAdmissionToken({ db, prefix, agentId }),
		erased = await erase(agentId)
	for (const event of [0, 1].map((i) => ({
		eventId: randomUUID(),
		agentId,
		role: "user" as const,
		body: `Fresh event ${i}`,
		timestamp: new Date(1780000000000 + i * 1000),
		scope: "agent" as const,
		scopeRef: `agent:${agentId}`,
	})))
		await writeEvent({ db: otherDb, prefix, event })
	expect(original.epoch).toBe(0)
	for (const task of tasks) await task()
	expect(await counts(agentId)).toEqual({ episodes: 0, runs: 0 })
	expect(await readErasureGate({ db, prefix, agentId })).toEqual(erased)
})
