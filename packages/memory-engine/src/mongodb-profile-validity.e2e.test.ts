/**
 * E2E regression for synthesizeProfile's two honesty invariants:
 *
 * 1. Temporal eligibility: the structured lane must exclude rows whose
 *    validity window has not opened (validFrom in the future) or has closed
 *    (validTo in the past), in addition to TTL-expired rows. Before the fix,
 *    only the TTL guard was applied and future/ended rows leaked into the
 *    synthesized profile.
 *
 * 2. Availability honesty: when any source collection fails, the synthesis
 *    must reject and persist ok:false telemetry. Before the fix, per-source
 *    catches swallowed the error and the profile resolved empty with an
 *    ok:true telemetry row, making an outage indistinguishable from a
 *    legitimately empty agent.
 *
 * 3. Activity TTL (W5): the events activity lane must exclude TTL-expired
 *    events that are still physically present awaiting the asynchronous TTL
 *    sweep, while counting unexpired and legacy no-expiry events. The
 *    expired marker is proven present via an unguarded count before the
 *    synthesis runs; no TTL-sweep timing is assumed.
 *
 * Source failure is injected by a Db proxy that throws a labeled error from
 * collection() before any driver dispatch — synthesizeProfile itself is never
 * mocked.
 *
 * Requires a reachable MongoDB (atlas-local container or MONGODB_TEST_URI /
 * MEMONGO_TEST_MONGODB_URI). Uses a unique disposable database per run and
 * verifies it is dropped afterwards.
 */

import { randomUUID } from "node:crypto"
import { MongoClient, type Db, type Document } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { synthesizeProfile } from "./mongodb-profile.js"
import {
	ensureCollections,
	entitiesCollection,
	episodesCollection,
	eventsCollection,
	relationsCollection,
	structuredMemCollection,
	telemetryCollection,
} from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true",
)
const TEST_DB = `memongo_profile_validity_${randomUUID().slice(0, 8)}`
const PREFIX = "pv_"
const SCOPE = "agent" as const

const AGENT_TEMPORAL = "agent-profile-temporal"
const AGENT_ONE_OUTAGE = "agent-profile-one-source-outage"
const AGENT_ALL_OUTAGE = "agent-profile-all-source-outage"
const AGENT_EMPTY = "agent-profile-empty"
const AGENT_ACTIVITY_TTL = "agent-profile-activity-ttl"

const OUTAGE_LABEL = "INJECTED_SOURCE_OUTAGE"
const HOUR = 60 * 60 * 1000

let client: MongoClient
let db: Db

// Exact timestamps of the W5 activity fixtures, captured at insert time so
// lastActive can be asserted precisely.
let activityExpiredTs: Date
let activityCurrentTs: Date
let activityLegacyTs: Date

const prevTelemetryEnabled = process.env.MEMONGO_TELEMETRY_ENABLED
const prevTelemetryRate = process.env.MEMONGO_TELEMETRY_SAMPLE_RATE

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scopeFields(agentId: string): Document {
	return { agentId, scope: SCOPE, scopeRef: `${agentId}-ref` }
}

function structuredRow(
	key: string,
	type: string,
	extra: Document = {},
): Document {
	return {
		...scopeFields(AGENT_TEMPORAL),
		type,
		key,
		value: `${key}-value`,
		salience: "normal",
		state: "active",
		updatedAt: new Date(),
		...extra,
	}
}

/**
 * Returns a Db that throws a labeled error from collection() for the given
 * unprefixed collection suffixes, before any driver dispatch. All other
 * collections (including memory_telemetry) pass through to the real Db.
 */
function dbWithFailingSources(base: Db, failingSuffixes: string[]): Db {
	const failingNames = new Set(failingSuffixes.map((s) => `${PREFIX}${s}`))
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop !== "collection") {
				return Reflect.get(target, prop, receiver)
			}
			return (name: string) => {
				if (failingNames.has(name)) {
					throw new Error(`${OUTAGE_LABEL} on ${name}`)
				}
				return target.collection(name)
			}
		},
	})
}

async function waitForTelemetry(
	filter: Document,
	maxWaitMs = 5_000,
): Promise<Document | null> {
	const deadline = Date.now() + maxWaitMs
	while (Date.now() < deadline) {
		const doc = await telemetryCollection(db, PREFIX).findOne({
			"meta.operation": "profile-synthesis",
			...filter,
		})
		if (doc) {
			return doc
		}
		await new Promise((r) => setTimeout(r, 200))
	}
	return null
}

function synthesizeFor(agentId: string, target: Db = db) {
	return synthesizeProfile({
		db: target,
		prefix: PREFIX,
		agentId,
		scope: SCOPE,
		scopeRef: `${agentId}-ref`,
	})
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
	// Emit every telemetry document regardless of the operator's sampling
	// configuration, so the ok-flag assertions observe all rows.
	process.env.MEMONGO_TELEMETRY_ENABLED = "1"
	process.env.MEMONGO_TELEMETRY_SAMPLE_RATE = "1"

	client = new MongoClient(TEST_URI, {
		serverSelectionTimeoutMS: 5_000,
		connectTimeoutMS: 5_000,
	})
	await client.connect()
	await client.db("admin").command({ ping: 1 })
	db = client.db(TEST_DB)
	await db.dropDatabase()
	await ensureCollections(db, PREFIX)

	const now = Date.now()

	// Temporal eligibility fixtures: six active structured rows sharing one
	// scope, each probing a different edge of the temporal guards.
	await structuredMemCollection(db, PREFIX).insertMany([
		// Currently valid: in the profile.
		structuredRow("pref-current", "preference", {
			validFrom: new Date(now - HOUR),
		}),
		// Legacy row with no validity fields at all: in the profile.
		structuredRow("pref-no-validity-window", "preference"),
		// Not yet valid: excluded by the validFrom edge.
		structuredRow("pref-future", "preference", {
			validFrom: new Date(now + 24 * HOUR),
		}),
		// Validity window already closed: excluded by the validTo edge.
		structuredRow("pref-ended", "preference", {
			validFrom: new Date(now - 2 * HOUR),
			validTo: new Date(now - HOUR),
		}),
		// TTL-expired but not yet swept: excluded by the unexpired guard
		// (already guarded before the fix — pinned against conflation).
		structuredRow("pref-ttl-expired", "preference", {
			validFrom: new Date(now - HOUR),
			expiresAt: new Date(now - HOUR),
		}),
		// A currently valid fact to check the other facet pipelines.
		structuredRow("fact-current", "fact", {
			validFrom: new Date(now - HOUR),
		}),
	])

	// One entity with one outgoing and one incoming relation (relationCount 2).
	await entitiesCollection(db, PREFIX).insertOne({
		...scopeFields(AGENT_TEMPORAL),
		entityId: "ent-ada",
		name: "Ada",
		type: "person",
		updatedAt: new Date(),
	})
	await relationsCollection(db, PREFIX).insertMany([
		{
			...scopeFields(AGENT_TEMPORAL),
			fromEntityId: "ent-ada",
			toEntityId: "ent-memongo",
			type: "works_on",
			updatedAt: new Date(),
		},
		{
			...scopeFields(AGENT_TEMPORAL),
			fromEntityId: "ent-memongo",
			toEntityId: "ent-ada",
			type: "worked_on_by",
			updatedAt: new Date(),
		},
	])

	// One recent episode and two recent events.
	await episodesCollection(db, PREFIX).insertOne({
		...scopeFields(AGENT_TEMPORAL),
		episodeId: "ep-1",
		type: "thread",
		title: "session recap",
		summary: "discussed profile synthesis",
		timeRange: {
			start: new Date(now - HOUR),
			end: new Date(now - HOUR + 1000),
		},
		sourceEventCount: 2,
		updatedAt: new Date(),
	})
	await eventsCollection(db, PREFIX).insertMany([
		{
			...scopeFields(AGENT_TEMPORAL),
			eventId: "evt-1",
			role: "user",
			body: "first",
			timestamp: new Date(now - 1000),
		},
		{
			...scopeFields(AGENT_TEMPORAL),
			eventId: "evt-2",
			role: "user",
			body: "second",
			timestamp: new Date(now - 500),
		},
	])

	// W5 activity TTL fixtures: one TTL-expired event still physically
	// present (the sweep is asynchronous), one unexpired control, one legacy
	// no-expiry control. The expired marker is the most recent event so a
	// missing read-side guard is visible in counts, roles, and lastActive.
	activityExpiredTs = new Date(now - 250)
	activityCurrentTs = new Date(now - 500)
	activityLegacyTs = new Date(now - 750)
	await eventsCollection(db, PREFIX).insertMany([
		{
			...scopeFields(AGENT_ACTIVITY_TTL),
			eventId: "evt-ttl-expired",
			role: "user",
			body: "expired marker",
			timestamp: activityExpiredTs,
			expiresAt: new Date(now - 60_000),
		},
		{
			...scopeFields(AGENT_ACTIVITY_TTL),
			eventId: "evt-ttl-current",
			role: "assistant",
			body: "unexpired control",
			timestamp: activityCurrentTs,
			expiresAt: new Date(now + HOUR),
		},
		{
			...scopeFields(AGENT_ACTIVITY_TTL),
			eventId: "evt-ttl-legacy",
			role: "user",
			body: "legacy no-expiry control",
			timestamp: activityLegacyTs,
		},
	])
})

afterAll(async () => {
	if (db) {
		await db.dropDatabase()
		const names = (
			await client.db("admin").admin().listDatabases()
		).databases.map((d) => d.name)
		if (names.includes(TEST_DB)) {
			throw new Error(`disposable database ${TEST_DB} still present after drop`)
		}
	}
	if (client) {
		await client.close()
	}
	if (prevTelemetryEnabled === undefined) {
		delete process.env.MEMONGO_TELEMETRY_ENABLED
	} else {
		process.env.MEMONGO_TELEMETRY_ENABLED = prevTelemetryEnabled
	}
	if (prevTelemetryRate === undefined) {
		delete process.env.MEMONGO_TELEMETRY_SAMPLE_RATE
	} else {
		process.env.MEMONGO_TELEMETRY_SAMPLE_RATE = prevTelemetryRate
	}
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("synthesizeProfile validity and availability (e2e)", () => {
	it("includes only currently valid structured rows in the profile", async () => {
		const profile = await synthesizeFor(AGENT_TEMPORAL)

		expect(profile.preferences.map((p) => p.key).sort()).toEqual([
			"pref-current",
			"pref-no-validity-window",
		])
		expect(profile.facts.map((f) => f.key)).toEqual(["fact-current"])
		expect(profile.decisions).toEqual([])
		expect(profile.todos).toEqual([])

		// The other lanes are unaffected by the temporal guards.
		expect(profile.topEntities).toEqual([
			{ name: "Ada", type: "person", relationCount: 2 },
		])
		expect(profile.recentEpisodes).toHaveLength(1)
		expect(profile.recentEpisodes[0].title).toBe("session recap")
		expect(profile.activityPatterns.totalEvents).toBe(2)
		expect(profile.activityPatterns.roleDistribution).toEqual({ user: 2 })
		expect(profile.activityPatterns.lastActive).toBeInstanceOf(Date)
	})

	it("excludes TTL-expired events from activity while they await the sweep", async () => {
		// The expired event is physically present before the query: three
		// events exist for the agent under an unguarded count, so only the
		// read-side guard can keep the expired marker out of the aggregates.
		const physicalCount = await eventsCollection(db, PREFIX).countDocuments({
			...scopeFields(AGENT_ACTIVITY_TTL),
		})
		expect(physicalCount).toBe(3)

		const profile = await synthesizeFor(AGENT_ACTIVITY_TTL)

		expect(profile.activityPatterns.totalEvents).toBe(2)
		expect(profile.activityPatterns.roleDistribution).toEqual({
			user: 1,
			assistant: 1,
		})
		// lastActive is the unexpired control's timestamp, not the (more
		// recent) expired marker's.
		expect(profile.activityPatterns.lastActive).toEqual(activityCurrentTs)
	})

	it("rejects and persists ok:false telemetry when one source fails", async () => {
		const proxied = dbWithFailingSources(db, ["entities"])

		await expect(synthesizeFor(AGENT_ONE_OUTAGE, proxied)).rejects.toThrow(
			OUTAGE_LABEL,
		)

		const failureRow = await waitForTelemetry({
			"meta.agentId": AGENT_ONE_OUTAGE,
			ok: false,
		})
		expect(failureRow).not.toBeNull()
		// No success row may exist for a synthesis that rejected.
		const successRow = await telemetryCollection(db, PREFIX).findOne({
			"meta.operation": "profile-synthesis",
			"meta.agentId": AGENT_ONE_OUTAGE,
			ok: true,
		})
		expect(successRow).toBeNull()
	})

	it("rejects and persists ok:false telemetry when every source fails", async () => {
		const proxied = dbWithFailingSources(db, [
			"structured_mem",
			"entities",
			"episodes",
			"events",
		])

		await expect(synthesizeFor(AGENT_ALL_OUTAGE, proxied)).rejects.toThrow(
			OUTAGE_LABEL,
		)

		const failureRow = await waitForTelemetry({
			"meta.agentId": AGENT_ALL_OUTAGE,
			ok: false,
		})
		expect(failureRow).not.toBeNull()
		const successRow = await telemetryCollection(db, PREFIX).findOne({
			"meta.operation": "profile-synthesis",
			"meta.agentId": AGENT_ALL_OUTAGE,
			ok: true,
		})
		expect(successRow).toBeNull()
	})

	it("resolves an empty profile with ok:true telemetry for an agent with no rows", async () => {
		const profile = await synthesizeFor(AGENT_EMPTY)

		expect(profile.preferences).toEqual([])
		expect(profile.decisions).toEqual([])
		expect(profile.facts).toEqual([])
		expect(profile.todos).toEqual([])
		expect(profile.topEntities).toEqual([])
		expect(profile.recentEpisodes).toEqual([])
		expect(profile.activityPatterns.totalEvents).toBe(0)
		expect(profile.activityPatterns.lastActive).toBeNull()

		// The successful-empty case is distinguishable from the outage cases
		// above: it resolves, and its telemetry row carries ok:true.
		const successRow = await waitForTelemetry({
			"meta.agentId": AGENT_EMPTY,
			ok: true,
		})
		expect(successRow).not.toBeNull()
	})
})
