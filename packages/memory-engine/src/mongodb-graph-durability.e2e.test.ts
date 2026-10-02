// Real-DB boundary regressions for graph bulk-write durability: required
// graph writes that fail must fail the caller instead of completing silently.
// Error instances are genuinely captured from the real server (E11000 from a
// unique-index collision, an immutable-field writeError, a write concern
// failure from an unsatisfiable w), then deterministically injected into the
// product path through a db proxy — real captured errors at an injected
// boundary, not observed concurrency. Runs against a unique disposable
// database; teardown failure surfaces and absence is asserted.

import { randomUUID } from "node:crypto"
import { type Collection, type Db, MongoClient, ObjectId } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { writeEvent } from "./mongodb-events.js"
import { extractAndUpsertEntities } from "./mongodb-graph.js"
import {
	consolidationRunsCollection,
	entitiesCollection,
	eventsCollection,
} from "./mongodb-schema-collections.js"
import { ensureGraphStandardIndexes } from "./mongodb-schema-standard-indexes-graph.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27017/?directConnection=true",
)
const TEST_DB = `memongo_graph_durability_${randomUUID().slice(0, 8)}`
const PREFIX = ""
const AGENT = `agent-${randomUUID().slice(0, 8)}`

let client: MongoClient
let db: Db

/** Override bulkWrite/updateOne on the entities collection only. */
function dbWithEntitiesOverrides(
	base: Db,
	overrides: (real: Collection) => {
		bulkWrite?: Collection["bulkWrite"]
		updateOne?: Collection["updateOne"]
	},
): Db {
	const entitiesName = `${PREFIX}entities`
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop !== "collection") {
				const value = Reflect.get(target, prop, receiver)
				return typeof value === "function" ? value.bind(target) : value
			}
			return (name: string) => {
				const real = target.collection(name)
				if (name !== entitiesName) {
					return real
				}
				const fns = overrides(real)
				return new Proxy(real, {
					get(colTarget, colProp, colReceiver) {
						if (colProp === "bulkWrite" && fns.bulkWrite) {
							return fns.bulkWrite
						}
						if (colProp === "updateOne" && fns.updateOne) {
							return fns.updateOne
						}
						const value = Reflect.get(colTarget, colProp, colReceiver)
						return typeof value === "function" ? value.bind(colTarget) : value
					},
				})
			}
		},
	})
}

/** Genuine E11000 instance: reinsert the winner's unique key. */
async function captureRealDuplicateKeyError(
	col: Collection,
	winner: Record<string, unknown>,
): Promise<Error> {
	const { _id, ...rest } = winner
	const err = await col.insertOne(rest).then(
		() => null,
		(caught) => caught as Error & { code?: number },
	)
	expect(err).toBeTruthy()
	expect((err as { code?: number }).code).toBe(11000)
	return err as Error
}

/** Genuine non-duplicate writeError instance: immutable _id modification. */
async function captureRealNonDuplicateBulkError(
	col: Collection,
	name = "immutable-probe",
): Promise<Error> {
	await col.insertOne({
		name,
		// Unique identity fields: the entities unique index keys on
		// (entityId, agentId, scope, scopeRef), so repeated probes must not
		// collide with one another on an all-null key.
		entityId: `probe-${randomUUID()}`,
		agentId: `probe-${randomUUID()}`,
		scope: "probe",
		scopeRef: `probe-${randomUUID()}`,
		probeId: randomUUID(),
		createdAt: new Date(),
	})
	const err = await col
		.bulkWrite(
			[
				{
					updateOne: {
						filter: { name },
						update: { $set: { _id: new ObjectId() } },
						upsert: false,
					},
				},
			],
			{ ordered: false },
		)
		.then(
			() => null,
			(caught) => caught as Error & { writeErrors?: Array<{ code?: number }> },
		)
	expect(err).toBeTruthy()
	expect(
		(err as { writeErrors?: Array<{ code?: number }> }).writeErrors?.[0]?.code,
	).not.toBe(11000)
	return err as Error
}

function extract(
	targetDb: Db,
	name: string,
	sourceEventId: string,
): ReturnType<typeof extractAndUpsertEntities> {
	return extractAndUpsertEntities({
		db: targetDb,
		prefix: PREFIX,
		agentId: AGENT,
		eventContent: `Talked to @${name} about the project`,
		scope: "agent",
		sourceEventId,
	})
}

describe("graph bulk-write durability (live MongoDB, disposable database)", () => {
	beforeAll(async () => {
		client = new MongoClient(TEST_URI, {
			serverSelectionTimeoutMS: 10_000,
			connectTimeoutMS: 10_000,
		})
		await client.connect()
		db = client.db(TEST_DB)
		await ensureGraphStandardIndexes(db, PREFIX)
	}, 60_000)

	afterAll(async () => {
		if (!client) {
			return
		}
		try {
			// Cleanup failure must be visible: no swallow, absence is asserted,
			// and the client closes even when a cleanup step throws.
			await client.db(TEST_DB).dropDatabase()
			const remaining = await client.db().admin().listDatabases()
			const leftovers = remaining.databases.filter(
				(entry) => entry.name === TEST_DB,
			)
			expect(leftovers).toEqual([])
		} finally {
			await client.close()
		}
	}, 30_000)

	it("surfaces a real captured non-duplicate bulk error instead of completing silently", async () => {
		const col = entitiesCollection(db, PREFIX)
		await col.deleteMany({})
		const captured = await captureRealNonDuplicateBulkError(col)

		const proxied = dbWithEntitiesOverrides(db, () => ({
			bulkWrite: () => Promise.reject(captured),
		}))

		const err = await extract(proxied, "eve", "evt-s1").catch(
			(caught) => caught,
		)
		expect(err).toBeInstanceOf(Error)
		expect(err.message).toBe("bulkWrite entity upserts failed")
		// Bounded durable diagnostics: none of the server errmsg words leak.
		expect(err.message).not.toContain("immutable")
		// The failing batch was not applied (proxy threw before delegating).
		expect(await col.findOne({ name: "eve" })).toBeNull()
	}, 30_000)

	it("recovers a real captured duplicate-key error injected at the bulk boundary exactly once", async () => {
		const col = entitiesCollection(db, PREFIX)
		await col.deleteMany({})

		// Winner document via a normal call.
		await extract(db, "carol", "evt-s2")
		const winner = await col.findOne({ name: "carol" })
		expect(winner).toBeTruthy()

		const captured = await captureRealDuplicateKeyError(
			col,
			winner as unknown as Record<string, unknown>,
		)

		const proxied = dbWithEntitiesOverrides(db, () => ({
			// The losing bulk write applies nothing and rejects with the real
			// E11000; the retry updateOne delegates to the real collection.
			bulkWrite: () => Promise.reject(captured),
		}))

		await extract(proxied, "carol", "evt-s2")

		const after = await col.findOne({ name: "carol" })
		expect(after).toBeTruthy()
		expect((after as { mentionCount?: number }).mentionCount).toBe(1)
		expect(
			(after as { sourceEventIds?: unknown[] }).sourceEventIds,
		).toHaveLength(1)
	}, 30_000)

	it("fails when the duplicate retry target vanished before the retry", async () => {
		const col = entitiesCollection(db, PREFIX)
		await col.deleteMany({})

		await extract(db, "dave", "evt-s3")
		const winner = await col.findOne({ name: "dave" })
		expect(winner).toBeTruthy()

		const captured = await captureRealDuplicateKeyError(
			col,
			winner as unknown as Record<string, unknown>,
		)

		const proxied = dbWithEntitiesOverrides(db, (real) => ({
			bulkWrite: () => Promise.reject(captured),
			// The winner disappears between the bulk write and the retry.
			updateOne: (async (...args: unknown[]) => {
				await real.deleteOne({
					_id: (winner as { _id: unknown })._id,
				})
				return (
					real.updateOne as (
						...rest: unknown[]
					) => Promise<{ matchedCount: number }>
				)(...args)
			}) as Collection["updateOne"],
		}))

		await expect(extract(proxied, "dave", "evt-s3")).rejects.toThrow(
			/matched no document/,
		)
		expect(await col.findOne({ name: "dave" })).toBeNull()
	}, 30_000)

	it("surfaces an unsatisfiable-write-concern failure as a bounded error (classification recorded)", async (ctx) => {
		const col = entitiesCollection(db, PREFIX)
		await col.deleteMany({})

		// Probe whether this topology rejects an unsatisfiable write concern at
		// all; a multi-member replica set would satisfy w:5, leaving nothing to
		// exercise here — then this test is skipped, not silently passed.
		const probe = await col
			.insertOne(
				{ probe: randomUUID(), createdAt: new Date() },
				{ writeConcern: { w: 5, wtimeoutMS: 300 } },
			)
			.then(
				() => null,
				(caught) => caught as Error,
			)
		if (!probe) {
			ctx.skip(
				"topology satisfies w:5 — no unsatisfiable write concern available",
			)
		}

		// Capture the raw driver error so the report records whether the
		// failure surfaced as a writeConcernError (write applied, durability
		// uncertain) or a command rejection (write not applied) — the shape
		// depends on topology, so this test does not claim one.
		let rawError: unknown
		const proxied = dbWithEntitiesOverrides(db, (real) => ({
			bulkWrite: (async (...args: unknown[]) => {
				const ops = args[0] as Parameters<Collection["bulkWrite"]>[0]
				try {
					return await real.bulkWrite(ops, {
						ordered: false,
						writeConcern: { w: 5, wtimeoutMS: 300 },
					})
				} catch (caught) {
					rawError = caught
					throw caught
				}
			}) as Collection["bulkWrite"],
		}))

		const err = await extract(proxied, "frank", "evt-s4").catch(
			(caught) => caught,
		)
		expect(err).toBeInstanceOf(Error)
		// Bounded, static diagnostic regardless of the server-side shape.
		expect(err.message).toBe("bulkWrite entity upserts failed")
		expect(err.message).not.toContain("replication")

		expect(rawError).toBeTruthy()
		const raw = rawError as {
			err?: unknown
			result?: { getWriteConcernError?: () => unknown }
			code?: unknown
		}
		const classification =
			raw.err || raw.result?.getWriteConcernError?.()
				? "writeConcernError"
				: "command rejection"
		console.log(
			`unsatisfiable write concern surfaced as: ${classification} (code ${String(raw.code)})`,
		)
	}, 30_000)

	it("consolidation acknowledges only the graph-successful event and persists a failed run", async () => {
		// B1 boundary proof at real persistence: seed two real events, inject a
		// genuinely captured MongoBulkWriteError into the first entities
		// bulkWrite only, run the real consolidator, then verify from real
		// documents that (a) the graph-failed event has no dreamerProcessedAt,
		// (b) exactly one peer event is acknowledged, and (c) the
		// consolidation_runs document records status failed with the bounded
		// error — the job layer's retry path can re-drive the failed event.
		const entitiesCol = entitiesCollection(db, PREFIX)
		const eventsCol = eventsCollection(db, PREFIX)
		const runsCol = consolidationRunsCollection(db, PREFIX)
		const captured = await captureRealNonDuplicateBulkError(
			entitiesCol,
			`immutable-probe-${randomUUID().slice(0, 8)}`,
		)

		const agentId = `consol-${randomUUID().slice(0, 8)}`
		const seeded: string[] = []
		for (const [i, body] of [
			"Talked to @zoe about the rollout plan",
			"Talked to @yara about the migration window",
		].entries()) {
			const { eventId } = await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					agentId,
					role: "user",
					scope: "agent",
					body,
					timestamp: new Date(Date.now() - (10 - i) * 1000),
				},
			})
			seeded.push(eventId)
		}

		let entitiesBulkCalls = 0
		const proxied = dbWithEntitiesOverrides(db, (real) => ({
			bulkWrite: ((...args: unknown[]) => {
				entitiesBulkCalls += 1
				if (entitiesBulkCalls === 1) {
					return Promise.reject(captured)
				}
				return (real.bulkWrite as (...rest: unknown[]) => unknown)(...args)
			}) as Collection["bulkWrite"],
		}))

		await expect(
			consolidateMemory({
				db: proxied,
				prefix: PREFIX,
				agentId,
				options: { minIntervalMs: 0, minCombinedScore: 0 },
			}),
		).rejects.toThrow("bulkWrite entity upserts failed")
		// Both events reached the graph phase (one failed, one wrote).
		expect(entitiesBulkCalls).toBe(2)

		// Real persistence: exactly one event acknowledged, one left pending.
		const persisted = await eventsCol
			.find({ eventId: { $in: seeded } })
			.toArray()
		const acknowledged = persisted.filter(
			(doc) => doc.dreamerProcessedAt instanceof Date,
		)
		const pending = persisted.filter(
			(doc) => !(doc.dreamerProcessedAt instanceof Date),
		)
		expect(acknowledged).toHaveLength(1)
		expect(pending).toHaveLength(1)
		expect(acknowledged[0].dreamerRunId).toBeTruthy()
		// The pending event must be reprocessable: no dreamer fields at all.
		expect(pending[0]).not.toHaveProperty("dreamerRunId")

		// Real persistence: the run record flipped to failed with the bounded
		// error surfaced and only the acknowledged event counted.
		const run = await runsCol.findOne({ agentId }, { sort: { startedAt: -1 } })
		expect(run?.status).toBe("failed")
		expect(run?.error).toBe("bulkWrite entity upserts failed")
		expect(run?.eventsProcessed).toBe(1)
		// No server-side error text leaks into the durable record.
		expect(run?.error).not.toContain("immutable")
	}, 60_000)
})
