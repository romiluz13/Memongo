import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { writeProcedure, type ProcedureEntry } from "./mongodb-procedures.js"
import { captureAdmissionToken } from "./mongodb-write-fence.js"
import { ensureCollections } from "./mongodb-schema.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E152 owned local MongoDB only")
const client = new MongoClient(uri)
const name = `memongo_e152_receipt_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
const col = db.collection(`${prefix}procedures`)
const audits = db.collection(`${prefix}memory_mutations`)
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/procedure-receipt-${label}.json`,
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
function entry(): ProcedureEntry {
	return {
		agentId: `agent-${randomUUID()}`,
		procedureId: "deploy",
		name: "Deploy app",
		steps: ["build", "verify", "ship"],
		intentTags: ["deploy"],
		confidence: 0.9,
		sourceEventIds: ["fixture-source"],
		provenance: { origin: "fixture" },
	}
}
it.each([
	"admitted",
	"external transaction",
] as const)("records persisted create payload with %s", async (mode) => {
	const value = entry(),
		params = { db, prefix, entry: value, embeddingMode: "automated" as const }
	if (mode === "admitted")
		await writeProcedure({
			...params,
			admission: await captureAdmissionToken({
				db,
				prefix,
				agentId: value.agentId,
			}),
		})
	else
		await client.withSession(async (session) => {
			await session.withTransaction(async () => {
				await writeProcedure({
					...params,
					session,
					transactionalSideEffects: "inline",
				})
			})
		})
	const row = await col.findOne({ agentId: value.agentId }),
		audit = await audits.findOne({ agentId: value.agentId })
	expect(row).not.toBeNull()
	expect(audit).toMatchObject({
		operation: "create",
		oldValue: null,
		documentId: value.procedureId,
	})
	const payload = { ...row }
	delete payload._id
	expect(audit?.newValue).toEqual(payload)
	expect(audit?.changedFields).toEqual(
		expect.arrayContaining([
			"procedureId",
			"agentId",
			"scope",
			"scopeRef",
			"name",
			"steps",
			"revision",
			"validFrom",
			"version",
			"successCount",
			"failCount",
			"evolutionHistory",
		]),
	)
	expect(audit?.changedFields).not.toContain("_id")
	expect(audit?.changedFields).not.toContain("createdAt")
	expect(audit?.changedFields).not.toContain("updatedAt")
})
it("no-op replay adds no audit and subsequent update carries changed steps", async () => {
	const value = entry(),
		admission = await captureAdmissionToken({
			db,
			prefix,
			agentId: value.agentId,
		})
	const params = {
		db,
		prefix,
		entry: value,
		admission,
		embeddingMode: "automated" as const,
	}
	await writeProcedure(params)
	await writeProcedure(params)
	expect(await audits.countDocuments({ agentId: value.agentId })).toBe(1)
	await writeProcedure({
		...params,
		entry: { ...value, steps: ["build", "verify", "rollout"] },
	})
	const audit = await audits.findOne({
		agentId: value.agentId,
		operation: "update",
	})
	expect(audit?.newValue.steps).toEqual(["build", "verify", "rollout"])
	expect(audit?.changedFields).toContain("steps")
	expect(await audits.countDocuments({ agentId: value.agentId })).toBe(2)
})
