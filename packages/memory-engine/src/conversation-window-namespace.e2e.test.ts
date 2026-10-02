import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { projectConversationWindows } from "./mongodb-conversation-windows.js"
import { writeEventsBatch } from "./mongodb-events.js"
import { ensureCollections } from "./mongodb-schema.js"
import type { MemoryScope } from "@memongo/lib/types/memory"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E141 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e141_windows_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const chunks = db.collection(`${prefix}chunks`)
type Partition = { agentId: string; scope: MemoryScope; scopeRef: string }
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/windows-${label}.json`,
			JSON.stringify(data),
		)
}
async function seed(
	partition: Partition,
	sessionId: string,
	body: string,
	expiresAt?: Date,
) {
	const result = await writeEventsBatch({
		db,
		prefix,
		events: Array.from({ length: 5 }, (_, i) => ({
			...partition,
			eventId: randomUUID(),
			sessionId,
			role: "user" as const,
			body: `${body} ${i}`,
			timestamp: new Date(Date.now() + i),
			...(expiresAt ? { expiresAt } : {}),
		})),
	})
	expect(result.every((row) => row.ok)).toBe(true)
}
async function project(partition: Partition, sessionId: string) {
	return projectConversationWindows({ db, prefix, ...partition, sessionId })
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	await client.connect()
	await ensureCollections(db, prefix)
	expect(
		(await chunks.indexes()).some(
			(index) => index.unique && index.name !== "_id_",
		),
	).toBe(false)
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
		await client.close()
	}
})
it("shared session across agents preserves both owners and their text", async () => {
	const sessionId = randomUUID()
	const a: Partition = {
		agentId: randomUUID(),
		scope: "session",
		scopeRef: `session:${sessionId}`,
	}
	const b = { ...a, agentId: randomUUID() }
	await seed(a, sessionId, "owner A")
	await seed(b, sessionId, "owner B")
	await project(a, sessionId)
	const original = await chunks.findOne({ ...a, sessionId })
	expect(original).not.toBeNull()
	await project(b, sessionId)
	expect(await chunks.findOne({ ...a, sessionId })).toEqual(original)
	expect(await chunks.countDocuments({ sessionId })).toBe(2)
	const second = await chunks.findOne({ ...b, sessionId })
	expect(second?.text).toContain("owner B")
	expect(second?.text).not.toContain("owner A")
})
it.each([
	["different scopes", "tenant", "user:one"],
	["different scope references", "user", "user:two"],
] as const)("separates one agent's %s during selection and writes", async (_label, scope, scopeRef) => {
	const sessionId = randomUUID()
	const a: Partition = {
		agentId: randomUUID(),
		scope: "user",
		scopeRef: "user:one",
	}
	const b: Partition = { ...a, scope, scopeRef }
	await seed(a, sessionId, "partition A")
	await seed(b, sessionId, "partition B")
	await project(a, sessionId)
	const original = await chunks.findOne({ ...a, sessionId })
	expect(original?.text).toContain("partition A")
	expect(original?.text).not.toContain("partition B")
	await project(b, sessionId)
	expect(await chunks.findOne({ ...a, sessionId })).toEqual(original)
	const second = await chunks.findOne({ ...b, sessionId })
	expect(second?.text).toContain("partition B")
	expect(second?.text).not.toContain("partition A")
	expect(await chunks.countDocuments({ sessionId })).toBe(2)
})
it("same owner preserves row and embedding while expiry derives and becomes permanent", async () => {
	const sessionId = randomUUID()
	const p: Partition = {
		agentId: randomUUID(),
		scope: "session",
		scopeRef: `session:${sessionId}`,
	}
	const expiry = new Date(Date.now() + 86_400_000)
	await seed(p, sessionId, "same owner", expiry)
	expect(await project(p, sessionId)).toEqual({ windowsCreated: 1 })
	const first = await chunks.findOne({ ...p, sessionId })
	expect(first?.expiresAt).toEqual(expiry)
	expect(first).not.toBeNull()
	await chunks.updateOne(
		{ ...p, sessionId },
		{ $set: { embedding: [0.1, 0.2] } },
	)
	await db
		.collection(`${prefix}events`)
		.updateMany({ ...p, sessionId }, { $unset: { expiresAt: "" } })
	await project(p, sessionId)
	const second = await chunks.findOne({ ...p, sessionId })
	expect(second?._id).toEqual(first?._id)
	expect(second?.createdAt).toEqual(first?.createdAt)
	expect(second?.embedding).toEqual([0.1, 0.2])
	expect(second).not.toHaveProperty("expiresAt")
	expect(await chunks.countDocuments({ ...p, sessionId })).toBe(1)
})
it("ignores malformed imported events with missing or null partition fields", async () => {
	const sessionId = randomUUID()
	const p: Partition = {
		agentId: randomUUID(),
		scope: "user",
		scopeRef: "user:one",
	}
	await seed(p, sessionId, "valid partition")
	await db.collection(`${prefix}events`).insertMany(
		[
			{ scope: undefined, scopeRef: p.scopeRef },
			{ scope: null, scopeRef: p.scopeRef },
			{ scope: p.scope, scopeRef: undefined },
			{ scope: p.scope, scopeRef: null },
		].map((partition) => ({
			...partition,
			eventId: randomUUID(),
			agentId: p.agentId,
			sessionId,
			role: "user",
			body: "malformed partition secret",
			timestamp: new Date(),
		})),
		{ bypassDocumentValidation: true, ignoreUndefined: true },
	)
	await project(p, sessionId)
	const row = await chunks.findOne({ ...p, sessionId })
	expect(row?.text).toContain("valid partition")
	expect(row?.text).not.toContain("malformed partition secret")
})
it("does not overwrite another source at the same path and partition", async () => {
	const sessionId = randomUUID()
	const p: Partition = {
		agentId: randomUUID(),
		scope: "user",
		scopeRef: "user:one",
	}
	await seed(p, sessionId, "window content")
	const inserted = await chunks.insertOne({
		...p,
		path: `windows/${sessionId}/0`,
		source: "memory",
		text: "file content",
		hash: "filehash",
		updatedAt: new Date(),
	})
	const original = await chunks.findOne({ _id: inserted.insertedId })
	await project(p, sessionId)
	expect(await chunks.findOne({ _id: inserted.insertedId })).toEqual(original)
	expect(await chunks.countDocuments({ path: `windows/${sessionId}/0` })).toBe(
		2,
	)
})
