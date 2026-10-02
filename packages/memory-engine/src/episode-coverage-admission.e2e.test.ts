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
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E127b owned Mongo only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e127b_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/episode-coverage-${label}.json`,
			JSON.stringify(data),
		)
}
async function entry(admitted = true, eventCount = 2) {
	const agentId = `agent-${randomUUID()}`,
		admission = admitted
			? await captureAdmissionToken({ db, prefix, agentId })
			: undefined
	const events = [0, 1].slice(0, eventCount).map((i) => ({
		eventId: randomUUID(),
		agentId,
		role: "user" as const,
		body: `Original event ${i}`,
		timestamp: new Date(1770000000000 + i * 1000),
		scope: "agent" as const,
		scopeRef: `agent:${agentId}`,
	}))
	for (const event of events) await writeEvent({ db, prefix, event })
	const tasks: Array<() => Promise<void>> = [],
		host = {
			db,
			prefix,
			client,
			agentId,
			config: {
				mongodb: { episodes: { enabled: true, minEventsForEpisode: 2 } },
			},
			shouldRunPostWriteDerivedWork: () => true,
			enqueueDerivedWork: (fn: () => Promise<void>) => tasks.push(fn),
		}
	const jobs = new MongoDBManagerJobsOps(host as unknown as MongoDBManagerHost)
	await jobs.schedulePostWriteDerivations({ ...events[0], admission })
	expect(tasks).toHaveLength(1)
	return { agentId, admission, events, run: tasks[0] }
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
	return readErasureGate({ db: otherDb, prefix, agentId })
}
async function coverage(agentId: string) {
	return db.collection(`${prefix}lane_coverage`).findOne({ agentId })
}
function stageFive(action: () => Promise<unknown>) {
	let explicit = 0,
		hit = false
	const start = client.startSession.bind(client)
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === 5) {
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
	vi.stubEnv("MEMONGO_EPISODES_MAX_PER_SCOPE", "100")
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
it("fresh queue adds one coverage fence after four episode stages", async () => {
	const e = await entry()
	await e.run()
	expect((await coverage(e.agentId))?.lanes.episodic.count).toBe(1)
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(5)
	expect(
		await db.collection(`${prefix}events`).countDocuments({
			agentId: e.agentId,
			consolidatedAt: { $exists: true },
		}),
	).toBe(2)
})
it("old post-marker coverage cannot recreate a row after erasure", async () => {
	const e = await entry()
	let erased: Awaited<ReturnType<typeof erase>> | undefined,
		hit = false
	const action = async () => {
		if (hit) return
		hit = true
		erased = await erase(e.agentId)
	}
	stageFive(action)
	const update = Collection.prototype.updateOne
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
		async function (this: Collection, filter, changes, options) {
			if (this.collectionName === `${prefix}lane_coverage` && !options?.session)
				await action()
			return update.call(this, filter, changes, options)
		},
	)
	await e.run()
	expect(hit).toBe(true)
	expect(erased).toBeDefined()
	expect(await coverage(e.agentId)).toBeNull()
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		erased,
	)
})
it("coverage failure leaves the earlier episode and markers durable", async () => {
	const e = await entry(),
		update = Collection.prototype.updateOne
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
		this: Collection,
		filter,
		changes,
		options,
	) {
		if (this.collectionName === `${prefix}lane_coverage`)
			return Promise.reject(new Error("E127b coverage failure"))
		return update.call(this, filter, changes, options)
	})
	await e.run()
	expect(await coverage(e.agentId)).toBeNull()
	expect(
		await db
			.collection(`${prefix}episodes`)
			.countDocuments({ agentId: e.agentId }),
	).toBe(1)
	expect(
		await db.collection(`${prefix}events`).countDocuments({
			agentId: e.agentId,
			consolidatedAt: { $exists: true },
		}),
	).toBe(2)
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(4)
})
it.each([
	false,
	true,
])("known-aborted coverage retry erasure=%s", async (erasedReplay) => {
	const e = await entry(),
		start = client.startSession.bind(client)
	let explicit = 0,
		attempts = 0,
		erased: Awaited<ReturnType<typeof erase>> | undefined
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === 5) {
			const commit = session.commitTransaction.bind(session)
			vi.spyOn(session, "commitTransaction").mockImplementation(
				async (...args) => {
					if (++attempts === 1) {
						await session.abortTransaction()
						if (erasedReplay) erased = await erase(e.agentId)
						throw new MongoServerError({
							message: "E127b retry",
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
	await e.run()
	if (erasedReplay) {
		expect(erased).toBeDefined()
		expect(attempts).toBe(1)
		expect(await coverage(e.agentId)).toBeNull()
		expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
			erased,
		)
	} else {
		expect(attempts).toBe(2)
		expect((await coverage(e.agentId))?.lanes.episodic.count).toBe(1)
		expect(
			(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
		).toBe(5)
	}
})
it("legacy queue does not create an erasure gate", async () => {
	const e = await entry(false)
	await e.run()
	expect((await coverage(e.agentId))?.lanes.episodic.count).toBe(1)
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toBeNull()
})
it("non-triggered queue adds no coverage row or serial", async () => {
	const e = await entry(true, 1)
	await e.run()
	expect(await coverage(e.agentId)).toBeNull()
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(0)
})
