import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it } from "vitest"
import { projectConversationWindows } from "./mongodb-conversation-windows.js"
import {
	projectEventChunk,
	writeEvent,
	type CanonicalEvent,
} from "./mongodb-events.js"
import { ensureCollections } from "./mongodb-schema.js"
import { resolveScopeRef } from "./mongodb-scope.js"
import { syncToMongoDB } from "./mongodb-sync.js"
import { captureAdmissionToken } from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E139 owned local MongoDB only")
const client = new MongoClient(uri),
	name = `memongo_e139_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	prefix = "test_",
	chunks = db.collection(`${prefix}chunks`)
let sandbox: string
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/producer-${label}.json`,
			JSON.stringify(data),
		)
}
beforeAll(async () => {
	sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-e139-"))
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
})
afterAll(async () => {
	try {
		await db.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name } })
		evidence("cleanup", { name, databases: listed.databases })
		expect(listed.databases).toEqual([])
	} finally {
		await client.close()
		await fs.rm(sandbox, { recursive: true, force: true })
	}
})
async function entry(admitted: boolean) {
	const agentId = `agent-${randomUUID()}`,
		workspaceDir = path.join(sandbox, agentId)
	await fs.mkdir(workspaceDir)
	const scopeRef = resolveScopeRef({
		scope: "workspace",
		agentId,
		workspaceDir,
	})
	const admission = admitted
		? await captureAdmissionToken({ db, prefix, agentId })
		: undefined
	const namespace = {
		agentId,
		scope: "workspace" as const,
		scopeRef,
		source: "conversation",
	}
	return {
		agentId,
		workspaceDir,
		namespace,
		sync: (extraPaths: string[] = [], force = false) =>
			syncToMongoDB({
				db,
				prefix,
				client,
				agentId,
				workspaceDir,
				extraPaths,
				force,
				admission,
				embeddingMode: "automated",
				sessionMemoryEnabled: false,
			}),
	}
}
async function projected(
	e: Awaited<ReturnType<typeof entry>>,
	id: string,
	sessionId?: string,
) {
	const event: CanonicalEvent = {
		eventId: id,
		agentId: e.agentId,
		role: "user",
		body: `Durable canonical ${id}`,
		timestamp: new Date(),
		scope: "workspace",
		scopeRef: e.namespace.scopeRef,
		...(sessionId ? { sessionId } : {}),
	}
	await writeEvent({ db, prefix, event })
	await projectEventChunk({ db, prefix, event, recordRun: false })
	return event
}
it.each([
	false,
	true,
])("healthy cleanup preserves actual event/window/unknown rows and deletes only file stale rows admitted=%s", async (admitted) => {
	const e = await entry(admitted),
		root = path.join(e.workspaceDir, "memory"),
		old = path.join(root, "old.md")
	await fs.mkdir(root)
	await fs.writeFile(path.join(root, "live.md"), "Live filesystem source")
	await fs.writeFile(old, "Old filesystem source")
	expect((await e.sync()).enumerationComplete).toBe(true)
	const sessionId = randomUUID(),
		event = await projected(e, randomUUID(), sessionId)
	for (let i = 0; i < 4; i++)
		await writeEvent({
			db,
			prefix,
			event: { ...event, eventId: randomUUID(), body: `Window source ${i}` },
		})
	expect(
		(
			await projectConversationWindows({
				db,
				prefix,
				agentId: e.agentId,
				sessionId,
				scope: "workspace",
				scopeRef: e.namespace.scopeRef,
			})
		).windowsCreated,
	).toBe(1)
	const eventRow = await chunks.findOne({
			...e.namespace,
			path: `events/${event.eventId}`,
		}),
		windowRow = await chunks.findOne({
			...e.namespace,
			path: `windows/${sessionId}/0`,
		})
	expect(eventRow).not.toBeNull()
	expect(windowRow).not.toBeNull()
	expect(Object.hasOwn(eventRow!, "startLine")).toBe(false)
	expect(Object.hasOwn(windowRow!, "startLine")).toBe(false)
	const unknown = {
		...e.namespace,
		path: "unknown/legacy",
		text: "Unknown producer",
		hash: "legacy",
		updatedAt: new Date(),
	}
	const inserted = await chunks.insertOne(unknown),
		unknownRow = await chunks.findOne({ _id: inserted.insertedId })
	await fs.rm(old)
	const result = await e.sync()
	expect(result.enumerationComplete).toBe(true)
	expect(await chunks.findOne({ _id: eventRow!._id })).toEqual(eventRow)
	expect(await chunks.findOne({ _id: windowRow!._id })).toEqual(windowRow)
	expect(await chunks.findOne({ _id: inserted.insertedId })).toEqual(unknownRow)
	expect(
		await chunks.countDocuments({ ...e.namespace, path: "memory/old.md" }),
	).toBe(0)
	expect(
		await chunks.countDocuments({ ...e.namespace, path: "memory/live.md" }),
	).toBe(1)
	expect(result.staleDeleted).toBe(1)
	evidence(`healthy-${admitted}`, {
		result,
		eventRow,
		windowRow,
		unknownRetained: true,
	})
})
it.each([
	false,
	true,
])("event-first same-path file replacement and cleanup preserve the separate event row admitted=%s", async (admitted) => {
	const e = await entry(admitted),
		eventId = `${randomUUID()}.md`,
		event = await projected(e, eventId),
		sourceDir = path.join(e.workspaceDir, "events"),
		file = path.join(sourceDir, eventId),
		rel = `events/${eventId}`
	const before = await chunks.findOne({ ...e.namespace, path: rel })
	expect(before).not.toBeNull()
	await fs.mkdir(sourceDir)
	await fs.writeFile(file, "Filesystem body first")
	expect((await e.sync([file])).enumerationComplete).toBe(true)
	expect(await chunks.findOne({ _id: before!._id })).toEqual(before)
	expect(await chunks.countDocuments({ ...e.namespace, path: rel })).toBe(2)
	await fs.writeFile(file, "Filesystem body changed")
	expect((await e.sync([file], true)).enumerationComplete).toBe(true)
	expect(await chunks.findOne({ _id: before!._id })).toEqual(before)
	const fileRows = await chunks
		.find({ ...e.namespace, path: rel, startLine: { $exists: true } })
		.toArray()
	expect(fileRows).toHaveLength(1)
	expect(fileRows[0].text).toContain("Filesystem body changed")
	await fs.rm(file)
	const cleanup = await e.sync()
	expect(cleanup.enumerationComplete).toBe(true)
	expect(cleanup.staleDeleted).toBe(1)
	expect(await chunks.findOne({ _id: before!._id })).toEqual(before)
	expect(await chunks.countDocuments({ ...e.namespace, path: rel })).toBe(1)
	evidence(`event-first-${admitted}`, {
		eventId: event.eventId,
		cleanup,
		eventUnchanged: true,
	})
})
it("records the unfixed file-first projection collision as a residual", async () => {
	const e = await entry(true),
		eventId = "file-first.md",
		dir = path.join(e.workspaceDir, "events"),
		file = path.join(dir, eventId),
		rel = `events/${eventId}`
	await fs.mkdir(dir)
	await fs.writeFile(file, "File body must not become event content")
	await e.sync([file])
	const before = await chunks.findOne({ ...e.namespace, path: rel })
	expect(before).not.toBeNull()
	const event = await projected(e, eventId),
		after = await chunks.findOne({ _id: before!._id })
	expect(await chunks.countDocuments({ ...e.namespace, path: rel })).toBe(1)
	expect(Object.hasOwn(after!, "startLine")).toBe(true)
	expect(after!.text).toBe(before!.text)
	expect(String(after!.text)).not.toContain(event.body)
	evidence("file-first-residual", {
		sameRow: true,
		startLineRetained: true,
		eventProjectionBodyAbsent: true,
		repaired: false,
	})
})
