import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import {
	writeStructuredMemory,
	type StructuredMemoryEntry,
} from "./mongodb-structured-memory.js"
import { ensureCollections } from "./mongodb-schema.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E153 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e153_create_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const col = db.collection(`${prefix}structured_mem`)
const revisions = db.collection(`${prefix}structured_mem_revisions`)
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/create-winner-${label}.json`,
			JSON.stringify(value),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
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
		expect(listed.databases).toEqual([])
		evidence("cleanup", { name, databases: listed.databases })
	} finally {
		vi.unstubAllEnvs()
		await client.close()
	}
})
function entry(): StructuredMemoryEntry {
	return {
		agentId: `agent-${randomUUID()}`,
		scope: "agent",
		type: "fact",
		key: "favorite-city",
		value: "late first",
	}
}
it("does not reset a winner created and revised after a missing read", async () => {
	const value = entry(),
		original = Collection.prototype.findOne
	let changed = false
	vi.spyOn(Collection.prototype, "findOne").mockImplementation(async function (
		this: Collection,
		...args: Parameters<typeof original>
	) {
		const found = await original.apply(this, args)
		if (
			!changed &&
			this.collectionName === col.collectionName &&
			args[0]?.agentId === value.agentId &&
			found === null
		) {
			changed = true
			await writeStructuredMemory({
				db,
				prefix,
				entry: { ...value, value: "winner first" },
				embeddingMode: "automated",
			})
			await writeStructuredMemory({
				db,
				prefix,
				entry: { ...value, value: "winner revised" },
				embeddingMode: "automated",
			})
			expect(
				await original.call(col, { agentId: value.agentId }),
			).toMatchObject({ revision: 2, value: "winner revised" })
		}
		return found
	})
	try {
		await writeStructuredMemory({
			db,
			prefix,
			entry: value,
			embeddingMode: "automated",
		})
	} finally {
		vi.restoreAllMocks()
	}
	expect(changed).toBe(true)
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 3,
		value: value.value,
	})
	const history = await revisions
		.find({ agentId: value.agentId })
		.sort({ revision: 1 })
		.toArray()
	expect(history.map((d) => [d.revision, d.value])).toEqual([
		[1, "winner first"],
		[2, "winner revised"],
	])
})
it("an uncontended create still starts at revision one", async () => {
	const value = entry()
	const result = await writeStructuredMemory({
		db,
		prefix,
		entry: value,
		embeddingMode: "automated",
	})
	expect(result).toMatchObject({ upserted: true, changed: true })
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		value: value.value,
	})
	expect(await revisions.countDocuments({ agentId: value.agentId })).toBe(0)
})

it("a failed update followed by creation does not audit the old source union", async () => {
	const value = entry()
	await writeStructuredMemory({
		db,
		prefix,
		entry: { ...value, value: "old", sourceEventIds: ["old-source"] },
		embeddingMode: "automated",
	})
	const update = Collection.prototype.updateOne,
		insert = Collection.prototype.insertOne
	let deleted = false
	let receipt: unknown
	let resolveReceipt: () => void = () => {}
	const receiptDone = new Promise<void>((resolve) => {
		resolveReceipt = resolve
	})
	vi.spyOn(Collection.prototype, "updateOne").mockImplementation(
		async function (this: Collection, ...args: Parameters<typeof update>) {
			if (
				!deleted &&
				this.collectionName === col.collectionName &&
				args[0]?.agentId === value.agentId &&
				args[0]?.revision === 1
			) {
				deleted = true
				await col.deleteOne({ agentId: value.agentId })
			}
			return update.apply(this, args)
		},
	)
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(
		async function (this: Collection, ...args: Parameters<typeof insert>) {
			const result = await insert.apply(this, args)
			if (
				this.collectionName === `${prefix}memory_mutations` &&
				args[0].agentId === value.agentId &&
				args[0].newValue?.value === value.value
			) {
				receipt = args[0]
				resolveReceipt()
			}
			return result
		},
	)
	try {
		await writeStructuredMemory({
			db,
			prefix,
			entry: { ...value, sourceEventIds: ["fresh-source"] },
			embeddingMode: "automated",
		})
		await receiptDone
	} finally {
		vi.restoreAllMocks()
	}
	expect(deleted).toBe(true)
	const row = await col.findOne({ agentId: value.agentId })
	expect(row).toMatchObject({ revision: 1, sourceEventIds: ["fresh-source"] })
	expect(receipt).toMatchObject({
		operation: "create",
		oldValue: null,
		newValue: { sourceEventIds: ["fresh-source"] },
	})
})
