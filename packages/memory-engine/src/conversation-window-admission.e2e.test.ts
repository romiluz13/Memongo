import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { projectConversationWindows } from "./mongodb-conversation-windows.js"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { writeEventsBatch } from "./mongodb-events.js"
import { ensureCollections } from "./mongodb-schema.js"
import {
	captureAdmissionToken,
	ErasureGateConflictError,
} from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E247 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri)
const name = `memongo_e247_windows_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/window-admission-${label}.json`,
			JSON.stringify(data),
		)
}
function entry() {
	const agentId = randomUUID(),
		sessionId = randomUUID()
	return {
		db,
		prefix,
		agentId,
		sessionId,
		scope: "agent" as const,
		scopeRef: `agent:${agentId}`,
	}
}
async function seed(
	params: ReturnType<typeof entry>,
	count: number,
	body: string,
) {
	const rows = await writeEventsBatch({
		db,
		prefix,
		events: Array.from({ length: count }, (_, i) => ({
			agentId: params.agentId,
			sessionId: params.sessionId,
			scope: params.scope,
			scopeRef: params.scopeRef,
			eventId: randomUUID(),
			role: "user" as const,
			body: `${body} ${i}`,
			timestamp: new Date(Date.now() + i),
		})),
	})
	expect(rows.every((row) => row.ok)).toBe(true)
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
}
beforeAll(async () => {
	evidence("worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
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
it("rejects old selected text after complete erasure and projects fresh follow-up", async () => {
	const params = entry()
	await seed(params, 5, "erased secret")
	const original = Collection.prototype.find
	let hit = false
	const spy = vi
		.spyOn(Collection.prototype, "find")
		.mockImplementation(function (this: Collection, ...args) {
			const cursor = original.apply(this, args)
			if (
				!hit &&
				this.dbName === name &&
				this.collectionName === `${prefix}events`
			) {
				hit = true
				const toArray = cursor.toArray.bind(cursor)
				cursor.toArray = async () => {
					const selected = await toArray()
					await erase(params.agentId)
					return selected
				}
			}
			return cursor
		})
	await expect(projectConversationWindows(params)).rejects.toBeInstanceOf(
		ErasureGateConflictError,
	)
	expect(hit).toBe(true)
	spy.mockRestore()
	expect(
		await db
			.collection(`${prefix}chunks`)
			.countDocuments({ agentId: params.agentId }),
	).toBe(0)
	await seed(params, 5, "fresh text")
	expect(await projectConversationWindows(params)).toEqual({
		windowsCreated: 1,
	})
	const row = await db
		.collection(`${prefix}chunks`)
		.findOne({ agentId: params.agentId })
	expect(row?.text).toContain("fresh text")
	expect(row?.text).not.toContain("erased secret")
	evidence("selection-race", { hit, fresh: row?.text })
})
it("deletes the first committed window and rejects the second after erasure", async () => {
	const params = entry()
	await seed(params, 12, "old window")
	const start = client.startSession.bind(client)
	let explicit = 0,
		hit = false
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === 2) {
			const txn = session.withTransaction.bind(session)
			session.withTransaction = (async (fn, options) => {
				if (!hit) {
					hit = true
					expect(
						await otherDb
							.collection(`${prefix}chunks`)
							.countDocuments({ agentId: params.agentId }),
					).toBe(1)
					await erase(params.agentId)
				}
				return txn(fn, options)
			}) as typeof txn
		}
		return session
	})
	await expect(projectConversationWindows(params)).rejects.toBeInstanceOf(
		ErasureGateConflictError,
	)
	expect(hit).toBe(true)
	expect(
		await db
			.collection(`${prefix}chunks`)
			.countDocuments({ agentId: params.agentId }),
	).toBe(0)
	evidence("between-windows", { hit, explicit, remaining: 0 })
})
it("rejects a supplied admission from before erasure before selecting events", async () => {
	const params = entry(),
		admission = await captureAdmissionToken(params)
	await erase(params.agentId)
	await seed(params, 5, "fresh rows")
	const original = Collection.prototype.find
	let selections = 0
	vi.spyOn(Collection.prototype, "find").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (this.dbName === name && this.collectionName === `${prefix}events`)
			selections++
		return original.apply(this, args)
	})
	await expect(
		projectConversationWindows({ ...params, admission }),
	).rejects.toBeInstanceOf(ErasureGateConflictError)
	expect(selections).toBe(0)
	evidence("stale-before-read", { selections })
})
