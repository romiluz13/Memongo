import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Collection, MongoClient, MongoServerError } from "mongodb"
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import { MongoDBManagerSyncOps } from "./mongodb-manager-sync.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { syncToMongoDB } from "./mongodb-sync.js"
import * as sessionFiles from "./session-files.js"
import { ensureCollections } from "./mongodb-schema.js"
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
	throw new Error("E121 owned local MongoDB only")
const client = new MongoClient(uri),
	other = new MongoClient(uri),
	name = `memongo_e121_sync_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	otherDb = other.db(name),
	prefix = "test_"
let sandbox: string
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/sync-${label}.json`,
			JSON.stringify(data),
		)
}
async function entry(
	files: Record<string, string> = { "one.md": "Original source memory" },
) {
	const agentId = `agent-${randomUUID()}`,
		workspaceDir = path.join(sandbox, agentId)
	await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true })
	for (const [file, content] of Object.entries(files))
		await fs.writeFile(path.join(workspaceDir, "memory", file), content)
	return { agentId, workspaceDir }
}
function leaf(
	e: { agentId: string; workspaceDir: string },
	admission?: AdmissionToken,
) {
	return Reflect.apply(syncToMongoDB, undefined, [
		{
			db,
			prefix,
			client,
			...e,
			embeddingMode: "automated",
			sessionMemoryEnabled: false,
			force: true,
			admission,
		},
	]) as ReturnType<typeof syncToMongoDB>
}
function manager(e: { agentId: string; workspaceDir: string }) {
	const host = {
		db,
		prefix,
		client,
		...e,
		extraMemoryPaths: [],
		config: { mongodb: { embeddingMode: "automated", maxSessionChunks: 20 } },
		dirty: true,
		fileCount: 0,
		chunkCount: 0,
		maybeAutoRefreshKB: vi.fn(async () => {}),
	}
	return {
		host,
		ops: new MongoDBManagerSyncOps(host as unknown as MongoDBManagerHost),
	}
}
async function rows(agentId: string) {
	const out: Record<string, unknown[]> = {}
	for (const suffix of ["files", "chunks"])
		out[suffix] = await db
			.collection(`${prefix}${suffix}`)
			.find({ agentId })
			.sort({ _id: 1 })
			.toArray()
	return out
}
async function erase(agentId: string) {
	expect(
		(await deleteAllForAgent({ db: otherDb, prefix, agentId })).status,
	).toBe("complete")
}
function code(error: unknown) {
	return Reflect.get(Object(error), "code")
}
async function outcome(p: Promise<unknown>) {
	return p.then(
		(value) => ({ kind: "resolved", value }),
		(error) => ({ kind: "rejected", error }),
	)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-e121-"))
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
		await other.close()
		await client.close()
		await fs.rm(sandbox, { recursive: true, force: true })
	}
})
it.each([
	false,
	true,
])("fresh manager sync commits files/chunks under original token empty=%s", async (empty) => {
	const e = await entry(
			empty
				? { "one.md": "" }
				: { "one.md": "One source", "two.md": "Two source" },
		),
		{ host, ops } = manager(e)
	await ops.runSync()
	const actual = await rows(e.agentId),
		n = empty ? 1 : 2
	expect(actual.files).toHaveLength(n)
	expect(actual.chunks).toHaveLength(n)
	expect(host.dirty).toBe(false)
	expect(host.maybeAutoRefreshKB).toHaveBeenCalledOnce()
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(n + 1)
})
it.each([
	false,
	true,
])("stale supplied epoch cannot write recreated files recreate=%s", async (recreate) => {
	const e = await entry(),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId })
	await erase(e.agentId)
	if (recreate) {
		await fs.writeFile(
			path.join(e.workspaceDir, "memory", "one.md"),
			"Fresh post-reopen source",
		)
		await manager(e).ops.runSync()
	}
	const before = await rows(e.agentId),
		gate = await readErasureGate({ db, prefix, agentId: e.agentId })
	await expect(leaf(e, token)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(await rows(e.agentId)).toEqual(before)
	expect(await readErasureGate({ db, prefix, agentId: e.agentId })).toEqual(
		gate,
	)
})
it.each([
	"owner",
	"kind",
])("wrong supplied token fails before collection and filesystem %s", async (which) => {
	const e = await entry(),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId }),
		reads = vi.spyOn(db, "collection"),
		fileReads = vi.spyOn(fs, "readFile")
	const bad =
		which === "owner"
			? { ...token, agentId: "foreign" }
			: { ...token, kind: "erasure" }
	await expect(
		Reflect.apply(syncToMongoDB, undefined, [
			{
				db,
				prefix,
				client,
				...e,
				embeddingMode: "automated",
				sessionMemoryEnabled: false,
				admission: bad,
			},
		]),
	).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
	expect(reads).not.toHaveBeenCalled()
	expect(fileReads).not.toHaveBeenCalled()
})
it("manager preserves token captured before erase/recreated source", async () => {
	const e = await entry(),
		original = Collection.prototype.findOneAndUpdate
	let reached = false,
		before: Awaited<ReturnType<typeof rows>> | undefined
	vi.spyOn(Collection.prototype, "findOneAndUpdate").mockImplementation(
		async function (this: Collection, ...args) {
			const result = await Reflect.apply(original, this, args)
			if (
				!reached &&
				this.collectionName === `${prefix}meta` &&
				Reflect.get(Object(args[0]), "_id") ===
					`tenant-erasure-epoch:${e.agentId}`
			) {
				reached = true
				await erase(e.agentId)
				before = await rows(e.agentId)
			}
			return result
		},
	)
	const { ops, host } = manager(e)
	expect(await outcome(ops.runSync())).toMatchObject({
		kind: "rejected",
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	expect(reached).toBe(true)
	expect(await rows(e.agentId)).toEqual(before)
	expect(host.dirty).toBe(true)
	expect(host.maybeAutoRefreshKB).not.toHaveBeenCalled()
})
it("a source read straddling erasure cannot reinsert content", async () => {
	const e = await entry(),
		original = fs.readFile
	let reached = false
	vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
		const result = await Reflect.apply(original, fs, args)
		if (
			!reached &&
			String(args[0]) === path.join(e.workspaceDir, "memory", "one.md")
		) {
			reached = true
			await erase(e.agentId)
		}
		return result
	})
	expect(await outcome(manager(e).ops.runSync())).toMatchObject({
		kind: "rejected",
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	expect(reached).toBe(true)
	expect(await rows(e.agentId)).toEqual({ files: [], chunks: [] })
})
it.each([
	"bulk",
	"metadata",
])("ordinary %s fault rolls back complete file but preserves partial result", async (kind) => {
	const e = await entry(),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId }),
		bulk = Collection.prototype.bulkWrite,
		update = Collection.prototype.updateOne,
		error = new Error("owned sync fault")
	if (kind === "bulk")
		vi.spyOn(Collection.prototype, "bulkWrite").mockImplementation(function (
			this: Collection,
			...args
		) {
			if (this.collectionName === `${prefix}chunks`)
				return Promise.reject(error)
			return Reflect.apply(bulk, this, args)
		})
	else
		vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
			this: Collection,
			...args
		) {
			if (this.collectionName === `${prefix}files`) return Promise.reject(error)
			return Reflect.apply(update, this, args)
		})
	const result = await leaf(e, token)
	expect(result.filesFailed).toBe(1)
	expect(result.filesProcessed).toBe(0)
	expect(await rows(e.agentId)).toEqual({ files: [], chunks: [] })
	expect(
		(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
	).toBe(1)
})
it("malformed gate at file transaction propagates rather than counting ordinary failure", async () => {
	const e = await entry(),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId })
	await otherDb
		.collection<{ _id: string; epoch: unknown }>(`${prefix}meta`)
		.updateOne(
			{ _id: `tenant-erasure-epoch:${e.agentId}` },
			{ $set: { epoch: "invalid" } },
		)
	const result = await outcome(leaf(e, token))
	expect(result).toMatchObject({ kind: "rejected" })
	expect(code(Reflect.get(Object(result), "error"))).toBe(
		"MALFORMED_ERASURE_GATE",
	)
	expect(await rows(e.agentId)).toEqual({ files: [], chunks: [] })
})
it.each([
	false,
	true,
])("driver replay retains original sync token erased=%s", async (erased) => {
	const e = await entry(),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId }),
		start = client.startSession.bind(client)
	let reached = false
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args),
			commit = session.commitTransaction.bind(session)
		if (session.explicit)
			vi.spyOn(session, "commitTransaction").mockImplementation(
				async (...commitArgs) => {
					if (!reached) {
						reached = true
						await session.abortTransaction()
						if (erased) await erase(e.agentId)
						const error = new MongoServerError({ message: "owned sync retry" })
						error.addErrorLabel("TransientTransactionError")
						throw error
					}
					return commit(...commitArgs)
				},
			)
		return session
	})
	const result = await outcome(leaf(e, token))
	expect(reached).toBe(true)
	if (erased) {
		expect(result).toMatchObject({
			kind: "rejected",
			error: { code: "ERASURE_GATE_CONFLICT" },
		})
		expect(await rows(e.agentId)).toEqual({ files: [], chunks: [] })
	} else {
		expect(result).toMatchObject({
			kind: "resolved",
			value: { filesProcessed: 1, filesFailed: 0 },
		})
		expect((await rows(e.agentId)).chunks).toHaveLength(1)
		expect(
			(await readErasureGate({ db, prefix, agentId: e.agentId }))?.serial,
		).toBe(2)
	}
})
it("stale cleanup under old token cannot remove a fresh replacement", async () => {
	const e = await entry(),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId }),
		start = client.startSession.bind(client)
	let explicit = 0,
		reached = false,
		before: Awaited<ReturnType<typeof rows>> | undefined
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === 2) {
			const txn = session.withTransaction.bind(session)
			vi.spyOn(session, "withTransaction").mockImplementation(
				async (...txnArgs) => {
					reached = true
					await erase(e.agentId)
					await fs.writeFile(
						path.join(e.workspaceDir, "memory", "fresh.md"),
						"Fresh replacement",
					)
					await leaf(
						e,
						await captureAdmissionToken({ db, prefix, agentId: e.agentId }),
					)
					before = await rows(e.agentId)
					return Reflect.apply(txn, session, txnArgs)
				},
			)
		}
		return session
	})
	expect(await outcome(leaf(e, token))).toMatchObject({
		kind: "rejected",
		error: { code: "ERASURE_GATE_CONFLICT" },
	})
	expect(reached).toBe(true)
	expect(await rows(e.agentId)).toEqual(before)
})
it.each([
	false,
	true,
])("admitted session transcript path retains token stale=%s", async (stale) => {
	const e = await entry({}),
		file = path.join(e.workspaceDir, "owned-session.jsonl"),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId })
	await fs.writeFile(
		file,
		JSON.stringify({
			type: "message",
			message: { role: "user", content: "Owned session content" },
		}),
	)
	const enumeration = vi
		.spyOn(sessionFiles, "listSessionFilesForAgent")
		.mockResolvedValue([file])
	if (stale) await erase(e.agentId)
	const result = await outcome(
		Reflect.apply(syncToMongoDB, undefined, [
			{
				db,
				prefix,
				client,
				...e,
				embeddingMode: "automated",
				sessionMemoryEnabled: true,
				admission: token,
			},
		]),
	)
	if (stale) {
		expect(result).toMatchObject({
			kind: "rejected",
			error: { code: "ERASURE_GATE_CONFLICT" },
		})
		expect(await rows(e.agentId)).toEqual({ files: [], chunks: [] })
	} else {
		expect(result).toMatchObject({
			kind: "resolved",
			value: { sessionFilesProcessed: 1 },
		})
		expect((await rows(e.agentId)).chunks[0]).toMatchObject({
			source: "sessions",
			text: "User: Owned session content",
		})
	}
	expect(enumeration).toHaveBeenCalledOnce()
})
it("oversized admitted transaction rolls back without direct fallback", async () => {
	const e = await entry(),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId }),
		update = Collection.prototype.updateOne
	let attempts = 0
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (this.collectionName === `${prefix}files`) {
			attempts++
			return Promise.reject(
				new MongoServerError({
					message: "owned too large transaction",
					code: 388,
				}),
			)
		}
		return Reflect.apply(update, this, args)
	})
	const result = await leaf(e, token)
	expect(result.filesFailed).toBe(1)
	expect(attempts).toBe(1)
	expect(await rows(e.agentId)).toEqual({ files: [], chunks: [] })
})
it("session malformed gate crosses both nested catches", async () => {
	const e = await entry({}),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId }),
		file = path.join(e.workspaceDir, "session.jsonl")
	await fs.writeFile(
		file,
		JSON.stringify({
			type: "message",
			message: { role: "user", content: "Session source" },
		}),
	)
	vi.spyOn(sessionFiles, "listSessionFilesForAgent").mockResolvedValue([file])
	await otherDb
		.collection<{ _id: string; epoch: unknown }>(`${prefix}meta`)
		.updateOne(
			{ _id: `tenant-erasure-epoch:${e.agentId}` },
			{ $set: { epoch: "invalid" } },
		)
	await expect(
		Reflect.apply(syncToMongoDB, undefined, [
			{
				db,
				prefix,
				client,
				...e,
				embeddingMode: "automated",
				sessionMemoryEnabled: true,
				admission: token,
			},
		]),
	).rejects.toMatchObject({ code: "MALFORMED_ERASURE_GATE" })
	expect(await rows(e.agentId)).toEqual({ files: [], chunks: [] })
})
it("old session cleanup cannot delete a fresh recreated stale path", async () => {
	const e = await entry({}),
		oldFile = path.join(e.workspaceDir, "old.jsonl"),
		currentFile = path.join(e.workspaceDir, "current.jsonl")
	for (const file of [oldFile, currentFile])
		await fs.writeFile(
			file,
			JSON.stringify({
				type: "message",
				message: { role: "user", content: path.basename(file) },
			}),
		)
	const enumeration = vi
		.spyOn(sessionFiles, "listSessionFilesForAgent")
		.mockResolvedValue([oldFile, currentFile])
	const run = (admission: AdmissionToken) =>
		Reflect.apply(syncToMongoDB, undefined, [
			{
				db,
				prefix,
				client,
				...e,
				embeddingMode: "automated",
				sessionMemoryEnabled: true,
				admission,
			},
		]) as ReturnType<typeof syncToMongoDB>
	await run(await captureAdmissionToken({ db, prefix, agentId: e.agentId }))
	const seeded = await rows(e.agentId),
		token = await captureAdmissionToken({ db, prefix, agentId: e.agentId }),
		start = client.startSession.bind(client)
	enumeration.mockResolvedValue([currentFile])
	let explicit = 0,
		reached = false,
		before: Awaited<ReturnType<typeof rows>> | undefined
	vi.spyOn(client, "startSession").mockImplementation((...args) => {
		const session = start(...args)
		if (session.explicit && ++explicit === 1) {
			const txn = session.withTransaction.bind(session)
			vi.spyOn(session, "withTransaction").mockImplementation(
				async (...txnArgs) => {
					reached = true
					await erase(e.agentId)
					for (const suffix of ["files", "chunks"])
						await otherDb
							.collection(`${prefix}${suffix}`)
							.insertMany(seeded[suffix].map((row) => ({ ...Object(row) })))
					before = await rows(e.agentId)
					return Reflect.apply(txn, session, txnArgs)
				},
			)
		}
		return session
	})
	await expect(run(token)).rejects.toMatchObject({
		code: "ERASURE_GATE_CONFLICT",
	})
	expect(reached).toBe(true)
	expect(await rows(e.agentId)).toEqual(before)
})
