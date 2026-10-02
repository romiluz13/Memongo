import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { MEMORY_QUARANTINE_SCHEMA } from "./mongodb-schema-validator-operations.js"
import { ensureSchemaValidation } from "./mongodb-schema-validators.js"
import {
	promoteQuarantined,
	rejectQuarantined,
} from "./mongodb-quarantine-review.js"

const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E24 requires the explicit owned local server")
const client = new MongoClient(uri)
const name = `memongo_e24_validator_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const collection = db.collection("test_memory_quarantine")
beforeAll(async () => {
	if (process.env.E22_FETCH_EVIDENCE_DIR) {
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/fixture-worker.json`,
			JSON.stringify({ fixturePid: process.pid }),
		)
	}
	await client.connect()
	await db.createCollection(collection.collectionName, {
		validator: MEMORY_QUARANTINE_SCHEMA,
		validationLevel: "moderate",
		validationAction: "error",
	})
})
afterAll(async () => {
	try {
		await db.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name } })
		expect(listed.databases).toEqual([])
	} finally {
		await client.close()
	}
})
function pending(quarantineId: string) {
	return {
		quarantineId,
		agentId: "agent1",
		scope: "user",
		scopeRef: "user:user1",
		content: "I prefer tabs over spaces",
		classification: "injection-likely",
		matchedPatterns: [],
		status: "pending-review",
		createdAt: new Date(),
	}
}
describe("quarantine validator on the owned real database", () => {
	it("permits the actual promoting claim and final state for an initially valid row", async () => {
		await collection.insertOne(pending("transition"))
		const result = await collection.updateOne(
			{ quarantineId: "transition", status: "pending-review" },
			{
				$set: {
					status: "promoting",
					promoteClaimedAt: new Date(),
					promoteLeaseExpiresAt: new Date(Date.now() + 120000),
				},
			},
		)
		expect(result.modifiedCount).toBe(1)
		expect(
			(await collection.findOne({ quarantineId: "transition" }))?.status,
		).toBe("promoting")
		await collection.updateOne(
			{ quarantineId: "transition", status: "promoting" },
			{ $set: { status: "promoted" } },
		)
		expect(
			(await collection.findOne({ quarantineId: "transition" }))?.status,
		).toBe("promoted")
	})
	it("continues rejecting unknown statuses on an initially valid row", async () => {
		await collection.insertOne(pending("invalid-status"))
		await expect(
			collection.updateOne(
				{ quarantineId: "invalid-status" },
				{ $set: { status: "unknown" } },
			),
		).rejects.toMatchObject({ code: 121 })
		expect(
			(await collection.findOne({ quarantineId: "invalid-status" }))?.status,
		).toBe("pending-review")
	})
	it("lets the actual reviewer store memory and finish the promoting claim", async () => {
		await collection.insertOne(pending("review"))
		const receipt = await promoteQuarantined({
			db,
			prefix: "test_",
			agentId: "agent1",
			quarantineId: "review",
			embeddingMode: "automated",
			reviewerId: "fixture-reviewer",
		})
		expect(receipt.status).toBe("promoted")
		expect(receipt.finalizeError).toBeUndefined()
		expect((await collection.findOne({ quarantineId: "review" }))?.status).toBe(
			"promoted",
		)
		expect(
			await db.collection("test_structured_mem").countDocuments({
				agentId: "agent1",
				scope: "user",
				scopeRef: "user:user1",
			}),
		).toBe(1)
	})
	it("applies the expanded validator to an existing collection before promotion", async () => {
		const oldSchema = structuredClone(MEMORY_QUARANTINE_SCHEMA)
		oldSchema.$jsonSchema.properties.status.enum = [
			"pending-review",
			"rejected",
			"promoted",
		]
		await db.command({
			collMod: collection.collectionName,
			validator: oldSchema,
			validationLevel: "moderate",
			validationAction: "error",
		})
		await collection.insertOne(pending("existing-validator"))
		await expect(
			collection.updateOne(
				{ quarantineId: "existing-validator" },
				{ $set: { status: "promoting" } },
			),
		).rejects.toMatchObject({ code: 121 })
		await ensureSchemaValidation(db, "test_")
		const installed = (
			await db
				.listCollections(
					{ name: collection.collectionName },
					{ nameOnly: false },
				)
				.toArray()
		)[0]?.options
		expect(installed?.validator?.$jsonSchema.properties.status.enum).toContain(
			"promoting",
		)
		expect(installed?.validationLevel).toBe("moderate")
		expect(installed?.validationAction).toBe("error")
		const receipt = await promoteQuarantined({
			db,
			prefix: "test_",
			agentId: "agent1",
			quarantineId: "existing-validator",
			embeddingMode: "automated",
		})
		expect(receipt.status).toBe("promoted")
		expect(receipt.finalizeError).toBeUndefined()
	})
	it("keeps existing promoting rows recoverable after a moderate validator downgrade", async () => {
		for (const id of [
			"rollback-finalize",
			"rollback-revert",
			"rollback-reject",
		]) {
			await collection.insertOne(pending(id))
			await collection.updateOne(
				{ quarantineId: id },
				{
					$set: {
						status: "promoting",
						promoteClaimedAt: new Date(Date.now() - 120000),
						promoteLeaseExpiresAt: new Date(Date.now() - 60000),
					},
				},
			)
		}
		const oldSchema = structuredClone(MEMORY_QUARANTINE_SCHEMA)
		oldSchema.$jsonSchema.properties.status.enum = [
			"pending-review",
			"rejected",
			"promoted",
		]
		await db.command({
			collMod: collection.collectionName,
			validator: oldSchema,
			validationLevel: "moderate",
			validationAction: "error",
		})
		expect(
			(
				await collection.updateOne(
					{ quarantineId: "rollback-finalize", status: "promoting" },
					{ $set: { status: "promoted" } },
				)
			).modifiedCount,
		).toBe(1)
		expect(
			(
				await collection.updateOne(
					{ quarantineId: "rollback-revert", status: "promoting" },
					{
						$set: { status: "pending-review" },
						$unset: { promoteClaimedAt: "", promoteLeaseExpiresAt: "" },
					},
				)
			).modifiedCount,
		).toBe(1)
		const reverted = await collection.findOne({
			quarantineId: "rollback-revert",
		})
		expect(reverted?.promoteClaimedAt).toBeUndefined()
		expect(reverted?.promoteLeaseExpiresAt).toBeUndefined()
		const receipt = await rejectQuarantined({
			db,
			prefix: "test_",
			agentId: "agent1",
			quarantineId: "rollback-reject",
		})
		expect(receipt.status).toBe("rejected")
		expect(receipt.auditError).toBeUndefined()
		expect(
			(await collection.findOne({ quarantineId: "rollback-reject" }))?.status,
		).toBe("rejected")
		await collection.insertOne(pending("rollback-fresh"))
		await expect(
			collection.updateOne(
				{ quarantineId: "rollback-fresh" },
				{ $set: { status: "promoting" } },
			),
		).rejects.toMatchObject({ code: 121 })
		await expect(
			collection.updateOne(
				{ quarantineId: "rollback-fresh" },
				{ $set: { status: "unknown" } },
			),
		).rejects.toMatchObject({ code: 121 })
	})
})
