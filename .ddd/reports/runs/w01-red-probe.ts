/**
 * W01 RED probe — reproduces audit finding W01 (access reinforcement outside
 * the owning tenant/scope) against the LIVE memongo-preview MongoDB using the
 * PRODUCTION AccessTracker at HEAD, on a disposable scratch database.
 *
 * Methodology mirrors docs/audits/2026-09-05-independent/evidence/probes/
 * mongo-live-probes.ts (timeseries access_events + canonical rows + production
 * tracker flush), extended with the cross-scope / cross-type / procedure /
 * entity / relation / event variants.
 *
 * Expected at HEAD (RED): B's narrow `recordAccess("timezone","structured_mem")`
 * increments A's row (wrong owner). Relations/procedures report the matched-0
 * or wrong-row behavior of single-field filters.
 */

import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import { AccessTracker } from "../../../packages/memory-engine/src/mongodb-access-tracker.ts"

const database = `ddd_w01_${randomUUID().replaceAll("-", "")}`
const client = new MongoClient(
	"mongodb://127.0.0.1:27017/?directConnection=true",
	{ serverSelectionTimeoutMS: 5000 },
)

let tracker: AccessTracker | undefined
try {
	await client.connect()
	const db = client.db(database)
	await db.createCollection("probe_access_events", {
		timeseries: { timeField: "ts", metaField: "meta" },
	})

	await db.collection("probe_structured_mem").insertMany([
		{ agentId: "A", scope: "agent", scopeRef: "agent:A", type: "preference", key: "timezone", accessCount: 0 },
		{ agentId: "B", scope: "agent", scopeRef: "agent:B", type: "preference", key: "timezone", accessCount: 0 },
		{ agentId: "B", scope: "user", scopeRef: "user:alice", type: "preference", key: "timezone", accessCount: 0 },
		{ agentId: "B", scope: "agent", scopeRef: "agent:B", type: "fact", key: "timezone", accessCount: 0 },
	])
	await db.collection("probe_procedures").insertMany([
		{ procedureId: "p-1", agentId: "A", scope: "agent", scopeRef: "agent:A", accessCount: 0 },
		{ procedureId: "p-1", agentId: "B", scope: "agent", scopeRef: "agent:B", accessCount: 0 },
	])
	await db.collection("probe_entities").insertMany([
		{ entityId: "e-1", agentId: "A", scope: "agent", scopeRef: "agent:A", accessCount: 0 },
		{ entityId: "e-1", agentId: "B", scope: "agent", scopeRef: "agent:B", accessCount: 0 },
	])
	await db.collection("probe_relations").insertMany([
		{ agentId: "A", scope: "agent", scopeRef: "agent:A", fromEntityId: "ent-1", toEntityId: "ent-2", type: "related_to", relationId: "ent-1-ent-2-related_to", accessCount: 0 },
		{ agentId: "B", scope: "agent", scopeRef: "agent:B", fromEntityId: "ent-1", toEntityId: "ent-2", type: "related_to", relationId: "ent-1-ent-2-related_to", accessCount: 0 },
	])
	await db.collection("probe_events").insertOne({
		eventId: "evt-1", agentId: "B", accessCount: 0,
	})

	// Agent B recalls its own memories (narrow identity — the only form the
	// current API accepts; this is exactly what recordSearchAccess feeds it
	// after slicing canonicalIds).
	tracker = new AccessTracker(db, "probe_", "B", {
		flushThreshold: 99,
		flushIntervalMs: 999_999,
	})
	tracker.recordAccess("timezone", "structured_mem")
	tracker.recordAccess("p-1", "procedures")
	tracker.recordAccess("e-1", "entities")
	tracker.recordAccess("ent-1:related_to:ent-2", "relations")
	tracker.recordAccess("evt-1", "events")
	await tracker.flush()
	await tracker.close()
	tracker = undefined

	const rows = (coll: string) =>
		db.collection(coll).find({}, { projection: { _id: 0 } }).toArray()

	const out = {
		probe: "W01 RED at HEAD — production AccessTracker, live server",
		structured_mem: await rows("probe_structured_mem"),
		procedures: await rows("probe_procedures"),
		entities: await rows("probe_entities"),
		relations: await rows("probe_relations"),
		events: await rows("probe_events"),
		raw: await db
			.collection("probe_access_events")
			.find({}, { projection: { _id: 0 } })
			.toArray(),
	}
	console.log(JSON.stringify(out, null, 2))
} finally {
	await tracker?.close()
	if (client) {
		await client.db(database).dropDatabase()
		console.log(
			JSON.stringify({ cleanup: "dropped disposable probe database", database }),
		)
		await client.close()
	}
}
