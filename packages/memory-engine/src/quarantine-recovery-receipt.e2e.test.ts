import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Collection, MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { MongoDBManagerAdminOps } from "./mongodb-manager-admin.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { insertQuarantinedForReview } from "./mongodb-quarantine-review.js"
import { ensureCollections } from "./mongodb-schema.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("Quarantine recovery requires owned local MongoDB")

const client = new MongoClient(uri)
const name = `memongo_nqr_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
const content = "I prefer tabs over spaces in TypeScript files"

function evidence(label: string, data: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/quarantine-recovery-${label}.json`,
			JSON.stringify(data),
		)
}

function manager(agentId: string) {
	return new MongoDBManagerAdminOps({
		db,
		prefix,
		client,
		agentId,
		config: { mongodb: { embeddingMode: "automated" } },
	} as unknown as MongoDBManagerHost)
}

async function seed(agentId = `agent-${randomUUID()}`) {
	const scopeRef = `session-${randomUUID()}`
	const { quarantineId } = await insertQuarantinedForReview({
		db,
		prefix,
		agentId,
		content,
		scope: "session",
		scopeRef,
	})
	return { agentId, quarantineId, scopeRef }
}

async function expire(quarantineId: string) {
	await db
		.collection(`${prefix}memory_quarantine`)
		.updateOne(
			{ quarantineId },
			{ $set: { promoteLeaseExpiresAt: new Date(Date.now() - 1000) } },
		)
}

function failAudit() {
	const insert = Collection.prototype.insertOne
	vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (
		this: Collection,
		...args
	) {
		if (
			this.dbName === name &&
			this.collectionName === `${prefix}memory_mutations`
		)
			return Promise.reject(new Error("fixture reject audit failed"))
		return Reflect.apply(insert, this, args)
	})
}

beforeAll(async () => {
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
		expect(listed.databases).toEqual([])
		evidence("cleanup", { name, databases: listed.databases })
	} finally {
		await client.close()
	}
})

it.each([
	false,
	true,
])("discloses retained memory after actual promotion and failed finalize (audit failure: %s)", async (auditFails) => {
	const entry = await seed()
	const admin = manager(entry.agentId)
	const update = Collection.prototype.updateOne
	const finalize = vi
		.spyOn(Collection.prototype, "updateOne")
		.mockImplementation(function (this: Collection, ...args) {
			const fields = Reflect.get(Object(args[1]), "$set")
			if (
				this.dbName === name &&
				this.collectionName === `${prefix}memory_quarantine` &&
				fields?.status === "promoted"
			)
				return Promise.reject(new Error("fixture finalize failed"))
			return Reflect.apply(update, this, args)
		})
	const promoted = await admin.promoteQuarantined({
		quarantineId: entry.quarantineId,
	})
	finalize.mockRestore()
	expect(promoted.finalizeError).toBe("fixture finalize failed")
	expect(promoted.memoryId).toBeTruthy()
	const memory = await db.collection(`${prefix}structured_mem`).findOne({
		agentId: entry.agentId,
		scope: "session",
		scopeRef: entry.scopeRef,
	})
	expect(memory).toMatchObject({
		value: content,
		state: "active",
		provenance: { quarantineId: entry.quarantineId },
	})
	expect(memory?._id.toString()).toBe(promoted.memoryId)
	expect(
		await db.collection(`${prefix}memory_quarantine`).findOne({
			quarantineId: entry.quarantineId,
		}),
	).toMatchObject({ status: "promoting" })
	await expire(entry.quarantineId)
	if (auditFails) failAudit()
	const receipt = await admin.rejectQuarantined({
		quarantineId: entry.quarantineId,
		reviewerId: "fixture-reviewer",
	})
	expect(receipt.status).toBe("rejected")
	expect(receipt.auditError).toBe(
		auditFails ? "fixture reject audit failed" : undefined,
	)
	expect(
		await db
			.collection(`${prefix}structured_mem`)
			.findOne({ _id: memory?._id }),
	).toEqual(memory)
	evidence(`retained-${auditFails}`, { promoted, receipt, memory })
	expect(receipt).toHaveProperty("memoryMayRemain", true)
})

it.each([
	false,
	true,
])("discloses possibility for a crashed claim with no memory (audit failure: %s)", async (auditFails) => {
	const entry = await seed()
	await db.collection(`${prefix}memory_quarantine`).updateOne(
		{ quarantineId: entry.quarantineId },
		{
			$set: {
				status: "promoting",
				promoteClaimedAt: new Date(Date.now() - 121_000),
				promoteLeaseExpiresAt: new Date(Date.now() - 1000),
			},
		},
	)
	if (auditFails) failAudit()
	const receipt = await manager(entry.agentId).rejectQuarantined({
		quarantineId: entry.quarantineId,
	})
	expect(receipt.status).toBe("rejected")
	expect(receipt.auditError).toBe(
		auditFails ? "fixture reject audit failed" : undefined,
	)
	expect(
		await db.collection(`${prefix}structured_mem`).countDocuments({
			agentId: entry.agentId,
		}),
	).toBe(0)
	evidence(`no-memory-${auditFails}`, { receipt, memoryCount: 0 })
	expect(receipt).toHaveProperty("memoryMayRemain", true)
})

it("ordinary pending rejection omits recovery disclosure", async () => {
	const entry = await seed()
	const receipt = await manager(entry.agentId).rejectQuarantined({
		quarantineId: entry.quarantineId,
	})
	expect(receipt.status).toBe("rejected")
	expect(receipt.mutationId).toBeTruthy()
	expect(receipt).not.toHaveProperty("memoryMayRemain")
	expect(receipt).not.toHaveProperty("finalizeError")
})

it("live promotion still conflicts and leaves the row untouched", async () => {
	const entry = await seed()
	const collection = db.collection(`${prefix}memory_quarantine`)
	await collection.updateOne(
		{ quarantineId: entry.quarantineId },
		{
			$set: {
				status: "promoting",
				promoteLeaseExpiresAt: new Date(Date.now() + 60_000),
			},
		},
	)
	const before = await collection.findOne({ quarantineId: entry.quarantineId })
	await expect(
		manager(entry.agentId).rejectQuarantined({
			quarantineId: entry.quarantineId,
		}),
	).rejects.toMatchObject({ name: "QuarantineReviewError", reason: "conflict" })
	expect(
		await collection.findOne({ quarantineId: entry.quarantineId }),
	).toEqual(before)
})

it("rejects foreign-owner recovery and preserves unrelated session memory", async () => {
	const entry = await seed()
	const foreign = await seed()
	const session = await seed(entry.agentId)
	await manager(session.agentId).promoteQuarantined({
		quarantineId: session.quarantineId,
	})
	await db.collection(`${prefix}memory_quarantine`).updateOne(
		{ quarantineId: foreign.quarantineId },
		{
			$set: {
				status: "promoting",
				promoteLeaseExpiresAt: new Date(Date.now() - 1000),
			},
		},
	)
	const foreignBefore = await db
		.collection(`${prefix}memory_quarantine`)
		.findOne({ quarantineId: foreign.quarantineId })
	const sessionBefore = await db
		.collection(`${prefix}structured_mem`)
		.find({ scopeRef: session.scopeRef })
		.toArray()
	expect(sessionBefore).toHaveLength(1)
	await expect(
		manager(entry.agentId).rejectQuarantined({
			quarantineId: foreign.quarantineId,
		}),
	).rejects.toMatchObject({
		name: "QuarantineReviewError",
		reason: "not-found",
	})
	await manager(entry.agentId).rejectQuarantined({
		quarantineId: entry.quarantineId,
	})
	expect(
		await db
			.collection(`${prefix}memory_quarantine`)
			.findOne({ quarantineId: foreign.quarantineId }),
	).toEqual(foreignBefore)
	expect(
		await db
			.collection(`${prefix}structured_mem`)
			.find({ scopeRef: session.scopeRef })
			.toArray(),
	).toEqual(sessionBefore)
})

it("successful promotion keeps its existing receipt without recovery fields", async () => {
	const entry = await seed()
	const receipt = await manager(entry.agentId).promoteQuarantined({
		quarantineId: entry.quarantineId,
	})
	expect(receipt.status).toBe("promoted")
	expect(receipt.memoryId).toBeTruthy()
	expect(receipt).not.toHaveProperty("memoryMayRemain")
	expect(receipt).not.toHaveProperty("finalizeError")
})
