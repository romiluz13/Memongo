import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { ensureCollections } from "./mongodb-schema.js"
import { syncToMongoDB } from "./mongodb-sync.js"
import { captureAdmissionToken } from "./mongodb-write-fence.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E138 owned local MongoDB only")
const client = new MongoClient(uri),
	name = `memongo_e138_${randomUUID().replaceAll("-", "")}`,
	db = client.db(name),
	prefix = "test_"
let sandbox: string
function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/enumeration-${label}.json`,
			JSON.stringify(data),
		)
}
beforeAll(async () => {
	sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "memongo-e138-"))
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
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
		evidence("cleanup", { name, databases: listed.databases })
		expect(listed.databases).toEqual([])
	} finally {
		await client.close()
		await fs.rm(sandbox, { recursive: true, force: true })
	}
})
async function rows(agentId: string) {
	const result: Record<string, unknown[]> = {}
	for (const suffix of ["chunks", "files"])
		result[suffix] = await db
			.collection(`${prefix}${suffix}`)
			.find({ agentId })
			.sort({ _id: 1 })
			.toArray()
	return result
}
it.each([
	"root",
	"nested",
	"extra",
] as const)("incomplete %s enumeration preserves persisted rows then healthy cleanup resumes", async (mode) => {
	const agentId = `agent-${randomUUID()}`,
		workspaceDir = path.join(sandbox, agentId),
		root = path.join(workspaceDir, "memory"),
		child = path.join(root, "nested"),
		extra = path.join(workspaceDir, "extra")
	await fs.mkdir(child, { recursive: true })
	await fs.writeFile(
		path.join(child, "old.md"),
		"Stored content that must survive incomplete enumeration",
	)
	await fs.mkdir(extra)
	await fs.writeFile(path.join(extra, "extra.md"), "Configured extra source")
	const admission = await captureAdmissionToken({ db, prefix, agentId })
	const sync = () =>
		syncToMongoDB({
			db,
			prefix,
			client,
			agentId,
			workspaceDir,
			extraPaths: mode === "extra" ? [extra] : [],
			embeddingMode: "automated",
			sessionMemoryEnabled: false,
			admission,
		})
	const initial = await sync()
	expect(initial.enumerationComplete).toBe(true)
	const before = await rows(agentId)
	expect(before.chunks.length).toBe(mode === "extra" ? 2 : 1)
	expect(before.files.length).toBe(mode === "extra" ? 2 : 1)
	const original = fs.readdir
	let hit = mode === "extra"
	let actualError: unknown
	if (mode === "extra") await fs.rm(extra, { recursive: true })
	else
		vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
			if (mode === "root" && String(args[0]) === root && !hit) {
				hit = true
				await fs.rm(root, { recursive: true })
			}
			try {
				const entries = await Reflect.apply(original, fs, args)
				if (mode === "nested" && String(args[0]) === root && !hit) {
					hit = true
					await fs.rm(child, { recursive: true })
				}
				return entries
			} catch (error) {
				actualError = error
				throw error
			}
		})
	const failed = await sync()
	expect(hit).toBe(true)
	expect(failed.enumerationComplete).toBe(false)
	expect(failed.staleDeleted).toBe(0)
	expect(await rows(agentId)).toEqual(before)
	if (mode !== "extra")
		expect(actualError).toMatchObject({
			code: "ENOENT",
			path: mode === "root" ? root : child,
		})
	evidence(`preserved-${mode}`, { agentId, hit, failed, rowsUnchanged: true })
	vi.restoreAllMocks()
	await fs.mkdir(root, { recursive: true })
	await fs.writeFile(path.join(root, "fresh.md"), "Fresh source")
	if (mode === "extra") await fs.mkdir(extra)
	const healthy = await sync()
	expect(healthy.enumerationComplete).toBe(true)
	expect(healthy.staleDeleted).toBeGreaterThan(0)
	const after = await rows(agentId)
	expect(after.chunks.length).toBe(mode === "extra" ? 2 : 1)
	expect(after.files.length).toBe(mode === "extra" ? 2 : 1)
	evidence(`healthy-${mode}`, { healthy, rows: after })
})
