import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient } from "mongodb"
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
	throw new Error("E157 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e157_defaults_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const col = db.collection(`${prefix}structured_mem`)
const revisions = db.collection(`${prefix}structured_mem_revisions`)
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/effective-defaults-${label}.json`,
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
		agentId: randomUUID(),
		type: "fact",
		key: "defaults",
		value: "stable ordinary fact",
		scope: "agent",
	}
}
async function write(value: StructuredMemoryEntry) {
	const session = client.startSession()
	try {
		return await session.withTransaction(() =>
			writeStructuredMemory({
				db,
				prefix,
				entry: value,
				embeddingMode: "automated",
				session,
				transactionalSideEffects: "inline",
			}),
		)
	} finally {
		await session.endSession()
	}
}
it("unchanged omitted defaults reinforce rather than creating a revision", async () => {
	const value = entry()
	await write(value)
	await write(value)
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		reinforcementCount: 2,
		state: "active",
		salience: "normal",
		temporalScope: "ongoing",
		sourceReliability: 0.75,
	})
	expect(await revisions.countDocuments({ agentId: value.agentId })).toBe(0)
})
it("explicit defaults equivalent to stored defaults reinforce", async () => {
	const value = entry()
	await write(value)
	await write({
		...value,
		state: "active",
		salience: "normal",
		temporalScope: "ongoing",
		sourceReliability: 0.75,
	})
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		reinforcementCount: 2,
	})
	expect(await revisions.countDocuments({ agentId: value.agentId })).toBe(0)
})
it("changed explicit default metadata still revises", async () => {
	const value = entry()
	await write(value)
	await write({ ...value, salience: "critical" })
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 2,
		salience: "critical",
	})
	expect(await revisions.countDocuments({ agentId: value.agentId })).toBe(1)
})
it("legacy missing default fields are materialized through a revision", async () => {
	const value = entry()
	await write(value)
	await col.updateOne(
		{ agentId: value.agentId },
		{
			$unset: {
				state: "",
				salience: "",
				temporalScope: "",
				sourceReliability: "",
			},
		},
	)
	await write(value)
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 2,
		state: "active",
		salience: "normal",
		temporalScope: "ongoing",
		sourceReliability: 0.75,
	})
	expect(await revisions.countDocuments({ agentId: value.agentId })).toBe(1)
	await write(value)
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 2,
		reinforcementCount: 2,
	})
	expect(await revisions.countDocuments({ agentId: value.agentId })).toBe(1)
})
it("a new source receipt retains current revision behavior", async () => {
	const value = entry()
	await write({ ...value, sourceEventIds: ["e1"] })
	await write({ ...value, sourceEventIds: ["e2"] })
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 2,
		sourceEventIds: ["e1", "e2"],
	})
})
it("identical inferred replay with a new run ID is an exact no-op", async () => {
	const value = entry()
	await write({
		...value,
		reinforcementCount: 0,
		provenance: { origin: "llm-inference", runId: "r1" },
	})
	const before = await col.findOne({ agentId: value.agentId })
	const replay = await write({
		...value,
		reinforcementCount: 0,
		provenance: { origin: "llm-inference", runId: "r2" },
	})
	expect(replay).toEqual({
		upserted: false,
		id: "defaults",
		changed: false,
	})
	const after = await col.findOne({ agentId: value.agentId })
	expect(after).toEqual(before)
	expect(after).toMatchObject({
		revision: 1,
		reinforcementCount: 0,
		provenance: { runId: "r1" },
	})
	expect(await revisions.countDocuments({ agentId: value.agentId })).toBe(0)
	evidence("inferred-replay", { before, after, replay })
	const changed = await write({
		...value,
		value: "changed ordinary fact",
		reinforcementCount: 0,
		provenance: { origin: "llm-inference", runId: "r2" },
	})
	expect(changed).toEqual({
		upserted: false,
		id: "defaults",
		changed: true,
	})
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 2,
		value: "changed ordinary fact",
		provenance: { runId: "r2" },
	})
	expect(await revisions.countDocuments({ agentId: value.agentId })).toBe(1)
})

it("omitting stored non-default metadata persists defaults through a revision", async () => {
	const value = entry()
	await write({ ...value, salience: "critical" })
	await write(value)
	expect(await col.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 2,
		salience: "normal",
	})
	expect(await revisions.findOne({ agentId: value.agentId })).toMatchObject({
		revision: 1,
		salience: "critical",
	})
})
