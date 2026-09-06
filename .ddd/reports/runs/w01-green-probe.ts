/**
 * W01 GREEN probe — verifies the access-identity fix against the LIVE
 * memongo-preview MongoDB using the PRODUCTION AccessTracker and
 * accessTargetFromSearchResult, on a disposable scratch database.
 *
 * Phases:
 * 1. Audit repro through the new API: a narrow target (key only, the exact
 *    identity recordSearchAccess used to derive) must fail SAFE — no
 *    canonical increment anywhere, raw access history still recorded.
 * 2. Full-identity targets must increment exactly the owning row across
 *    every collection; all other same-key rows (other tenant, other scope,
 *    other type) must stay untouched.
 * 3. Search-result identity: accessTargetFromSearchResult feeding the
 *    tracker with the production lane result shapes (structured canonicalId
 *    + scope fields, relation locator, scope-less fallback).
 *
 * Exit code 0 = GREEN; any assertion failure prints the diff and exits 1.
 */

import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import {
	AccessTracker,
	accessTargetFromSearchResult,
} from "../../../packages/memory-engine/src/mongodb-access-tracker.ts"

const database = `ddd_w01_${randomUUID().replaceAll("-", "")}`
const client = new MongoClient(
	"mongodb://127.0.0.1:27017/?directConnection=true",
	{ serverSelectionTimeoutMS: 5000 },
)

let failures = 0
/** Key-order-insensitive deep compare (MongoDB returns fields in doc order). */
function stable(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stable).join(",")}]`
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`
	}
	return JSON.stringify(value)
}
function check(label: string, actual: unknown, expected: unknown) {
	const ok = stable(actual) === stable(expected)
	if (!ok) {
		failures++
		console.error(
			`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		)
	} else {
		console.log(`ok   ${label} === ${JSON.stringify(expected)}`)
	}
}

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

	const structuredCounts = async () => {
		const rows = await db
			.collection("probe_structured_mem")
			.find({}, { projection: { _id: 0, agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1, accessCount: 1 } })
			.toArray()
		return rows.map((r) => `${r.agentId}/${r.scope}/${r.scopeRef}/${r.type}/${r.key}=${r.accessCount}`)
	}

	// ---------------------------------------------------------------
	// Phase 1 — the audit's exact repro shape must now fail safe.
	// ---------------------------------------------------------------
	tracker = new AccessTracker(db, "probe_", "B", {
		flushThreshold: 999,
		flushIntervalMs: 999_999,
	})
	tracker.recordAccess({ collection: "structured_mem", id: "timezone" })
	await tracker.flush()

	check("P1 narrow target leaves every structured row untouched (was: A=1)", await structuredCounts(), [
		"A/agent/agent:A/preference/timezone=0",
		"B/agent/agent:B/preference/timezone=0",
		"B/user/user:alice/preference/timezone=0",
		"B/agent/agent:B/fact/timezone=0",
	])
	const rawP1 = await db
		.collection("probe_access_events")
		.find({}, { projection: { _id: 0, ts: 0 } })
		.toArray()
	check("P1 raw access history still recorded for B", rawP1, [
		{ meta: { agentId: "B", collection: "structured_mem" }, memoryId: "timezone", count: 1 },
	])

	// ---------------------------------------------------------------
	// Phase 2 — full identity increments exactly the owning row.
	// ---------------------------------------------------------------
	tracker.recordAccess({ collection: "structured_mem", id: "timezone", scope: "agent", scopeRef: "agent:B", type: "preference" })
	tracker.recordAccess({ collection: "structured_mem", id: "timezone", scope: "agent", scopeRef: "agent:B", type: "preference" })
	tracker.recordAccess({ collection: "procedures", id: "p-1", scope: "agent", scopeRef: "agent:B" })
	tracker.recordAccess({ collection: "entities", id: "e-1", scope: "agent", scopeRef: "agent:B" })
	tracker.recordAccess({ collection: "relations", id: "ent-1:related_to:ent-2", scope: "agent", scopeRef: "agent:B", type: "related_to", fromEntityId: "ent-1", toEntityId: "ent-2" })
	tracker.recordAccess({ collection: "events", id: "evt-1" })
	await tracker.flush()

	check("P2 only B's agent-scope preference row incremented (x2)", await structuredCounts(), [
		"A/agent/agent:A/preference/timezone=0",
		"B/agent/agent:B/preference/timezone=2",
		"B/user/user:alice/preference/timezone=0",
		"B/agent/agent:B/fact/timezone=0",
	])
	const procRows = await db.collection("probe_procedures").find({}, { projection: { _id: 0, agentId: 1, accessCount: 1 } }).toArray()
	check("P2 procedures: only B's row incremented", procRows, [
		{ agentId: "A", accessCount: 0 },
		{ agentId: "B", accessCount: 1 },
	])
	const entRows = await db.collection("probe_entities").find({}, { projection: { _id: 0, agentId: 1, accessCount: 1 } }).toArray()
	check("P2 entities: only B's row incremented", entRows, [
		{ agentId: "A", accessCount: 0 },
		{ agentId: "B", accessCount: 1 },
	])
	const relRows = await db.collection("probe_relations").find({}, { projection: { _id: 0, agentId: 1, accessCount: 1 } }).toArray()
	check("P2 relations: only B's edge incremented", relRows, [
		{ agentId: "A", accessCount: 0 },
		{ agentId: "B", accessCount: 1 },
	])
	const evtRows = await db.collection("probe_events").find({}, { projection: { _id: 0, eventId: 1, accessCount: 1 } }).toArray()
	check("P2 events: B's event incremented", evtRows, [{ eventId: "evt-1", accessCount: 1 }])

	// ---------------------------------------------------------------
	// Phase 3 — search-result identity end to end.
	// ---------------------------------------------------------------
	const t1 = accessTargetFromSearchResult({
		canonicalId: "structured:preference:timezone",
		scope: "user",
		scopeRef: "user:alice",
	})
	check("P3 structured result parses to B's user-scope identity", t1, {
		collection: "structured_mem",
		id: "timezone",
		type: "preference",
		scope: "user",
		scopeRef: "user:alice",
	})
	if (t1) tracker.recordAccess(t1)

	const t2 = accessTargetFromSearchResult({
		canonicalId: "relation:ent-1:related_to:ent-2",
		scope: "agent",
		scopeRef: "agent:B",
	})
	check("P3 relation result parses to the edge identity", t2, {
		collection: "relations",
		id: "ent-1:related_to:ent-2",
		fromEntityId: "ent-1",
		type: "related_to",
		toEntityId: "ent-2",
		scope: "agent",
		scopeRef: "agent:B",
	})
	if (t2) tracker.recordAccess(t2)

	// A result that lost its scope fields: parse succeeds but the identity is
	// under-specified -> the tracker must fail safe (no canonical update).
	const t3 = accessTargetFromSearchResult({
		canonicalId: "structured:fact:timezone",
	})
	check("P3 scope-less structured result parses with missing scope", t3, {
		collection: "structured_mem",
		id: "timezone",
		type: "fact",
	})
	if (t3) tracker.recordAccess(t3)

	await tracker.flush()
	await tracker.close()
	tracker = undefined

	check("P3 user-scope row +1, relation +1, scope-less target wrote nothing", await structuredCounts(), [
		"A/agent/agent:A/preference/timezone=0",
		"B/agent/agent:B/preference/timezone=2",
		"B/user/user:alice/preference/timezone=1",
		"B/agent/agent:B/fact/timezone=0",
	])
	const relRows3 = await db.collection("probe_relations").find({}, { projection: { _id: 0, agentId: 1, accessCount: 1 } }).toArray()
	check("P3 relation row now 2", relRows3, [
		{ agentId: "A", accessCount: 0 },
		{ agentId: "B", accessCount: 2 },
	])

	// Raw access records carry the complete handle (W01 remedy).
	const raw = await db
		.collection("probe_access_events")
		.find({ "meta.collection": "structured_mem", memoryId: "timezone", scope: "user" }, { projection: { _id: 0, ts: 0 } })
		.toArray()
	check("P3 raw access event carries scope/scopeRef/type", raw, [
		{ meta: { agentId: "B", collection: "structured_mem" }, memoryId: "timezone", count: 1, scope: "user", scopeRef: "user:alice", type: "preference" },
	])

	if (failures > 0) {
		console.error(`\nW01 GREEN probe: ${failures} assertion(s) FAILED`)
		process.exitCode = 1
	} else {
		console.log("\nW01 GREEN probe: all assertions passed")
	}
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
