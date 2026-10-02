import { randomUUID } from "node:crypto"
import {
	type CollectionInfo,
	type Db,
	type Document,
	MongoClient,
} from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ensureOrdinaryDiagnosticCollection } from "./mongodb-schema-collections.js"
import { ensureCollections, ensureTimeseriesOrPlain } from "./mongodb-schema.js"

const URI = "mongodb://127.0.0.1:27017/?directConnection=true"
const DB_NAME = `memongo_diag_${randomUUID().slice(0, 8)}`
const FRESH_PREFIX = "fresh_"
const TIMEOUT = 60_000

let client: MongoClient
let db: Db

async function collectionInfo(name: string): Promise<CollectionInfo> {
	const [info] = await db
		.listCollections({ name }, { nameOnly: false })
		.toArray()
	if (!info) {
		throw new Error(`expected collection metadata for ${name}`)
	}
	return info
}

function ttlIndex(indexes: Document[]): Document | undefined {
	return indexes.find(
		(index) =>
			Object.keys(index.key).length === 1 &&
			index.key.ts === 1 &&
			typeof index.expireAfterSeconds === "number",
	)
}

beforeAll(async () => {
	client = new MongoClient(URI)
	await client.connect()
	const listed = await client
		.db("admin")
		.admin()
		.listDatabases({ nameOnly: true, filter: { name: DB_NAME } })
	expect(
		listed.databases,
		"disposable diagnostics database must be absent before setup",
	).toHaveLength(0)
	db = client.db(DB_NAME)
}, TIMEOUT)

afterAll(async () => {
	try {
		if (db) {
			await db.dropDatabase()
			const listed = await client
				.db("admin")
				.admin()
				.listDatabases({ nameOnly: true, filter: { name: DB_NAME } })
			expect(
				listed.databases,
				"disposable diagnostics database must be absent after teardown",
			).toHaveLength(0)
		}
	} finally {
		await client?.close()
	}
}, TIMEOUT)

describe("fresh ordinary diagnostic schema (real replica set)", () => {
	it(
		"creates ordinary sinks with the required retention and document shape",
		async () => {
			await ensureCollections(db, FRESH_PREFIX)

			for (const [baseName, retention] of [
				["memory_telemetry", 7 * 24 * 3600],
				["access_events", 30 * 24 * 3600],
			] as const) {
				const name = `${FRESH_PREFIX}${baseName}`
				const info = await collectionInfo(name)
				expect(info.type).toBe("collection")
				expect(info.options?.timeseries).toBeUndefined()

				const indexes = await db.collection(name).listIndexes().toArray()
				expect(ttlIndex(indexes)).toMatchObject({
					key: { ts: 1 },
					expireAfterSeconds: retention,
				})

				const row = {
					ts: new Date(),
					meta: { agentId: "shape-agent", operation: "shape-check" },
					payload: { retained: true },
				}
				const inserted = await db.collection(name).insertOne(row)
				expect(
					await db.collection(name).findOne({ _id: inserted.insertedId }),
				).toMatchObject(row)
			}
		},
		TIMEOUT,
	)

	it(
		"repairs interrupted TTL setup without replacing the collection or its data",
		async () => {
			const prefix = "repair_"
			const name = `${prefix}memory_telemetry`
			await db.createCollection(name)
			await db
				.collection(name)
				.insertOne({ marker: "survives", ts: new Date(), meta: {} })
			const before = await collectionInfo(name)

			await ensureCollections(db, prefix)

			const after = await collectionInfo(name)
			expect(after.type).toBe("collection")
			expect(after.info?.uuid).toEqual(before.info?.uuid)
			expect(
				await db.collection(name).countDocuments({ marker: "survives" }),
			).toBe(1)
			const indexes = await db.collection(name).listIndexes().toArray()
			expect(ttlIndex(indexes)).toMatchObject({
				key: { ts: 1 },
				expireAfterSeconds: 7 * 24 * 3600,
			})
		},
		TIMEOUT,
	)

	it(
		"leaves an existing time-series bucket UUID, options, and data untouched",
		async () => {
			const prefix = "legacy_"
			const name = `${prefix}memory_telemetry`
			await db.createCollection(name, {
				timeseries: {
					timeField: "ts",
					metaField: "meta",
					granularity: "seconds",
				},
				expireAfterSeconds: 7 * 24 * 3600,
			})
			await db
				.collection(name)
				.insertOne({ marker: "legacy", ts: new Date(), meta: { agentId: "a" } })
			const before = await collectionInfo(name)
			const bucketBefore = await collectionInfo(`system.buckets.${name}`)
			expect(bucketBefore.info?.uuid).toBeDefined()

			await ensureCollections(db, prefix)

			const after = await collectionInfo(name)
			const bucketAfter = await collectionInfo(`system.buckets.${name}`)
			expect(after.type).toBe("timeseries")
			expect(bucketAfter.info?.uuid).toEqual(bucketBefore.info?.uuid)
			expect(after.options).toEqual(before.options)
			expect(
				await db.collection(name).countDocuments({ marker: "legacy" }),
			).toBe(1)
		},
		TIMEOUT,
	)

	it(
		"rejects a partial-only TTL at the expected duration without changing it",
		async () => {
			const name = "partial_only"
			await db.createCollection(name)
			await db.collection(name).createIndex(
				{ ts: 1 },
				{
					name: "partial_policy",
					expireAfterSeconds: 7 * 24 * 3600,
					partialFilterExpression: { "meta.agentId": "one-agent" },
				},
			)
			const beforeInfo = await collectionInfo(name)
			const beforeIndexes = await db.collection(name).listIndexes().toArray()

			await expect(
				ensureOrdinaryDiagnosticCollection(db, name, 7 * 24 * 3600),
			).rejects.toThrow(/incompatible TTL index policy/)

			expect((await collectionInfo(name)).info?.uuid).toEqual(
				beforeInfo.info?.uuid,
			)
			expect(await db.collection(name).listIndexes().toArray()).toEqual(
				beforeIndexes,
			)
		},
		TIMEOUT,
	)

	it(
		"rejects a shorter partial TTL after the required full TTL without changing either",
		async () => {
			const name = "full_and_short_partial"
			await db.createCollection(name)
			await db
				.collection(name)
				.createIndex(
					{ ts: 1 },
					{ name: "full_expected", expireAfterSeconds: 7 * 24 * 3600 },
				)
			await db.collection(name).createIndex(
				{ ts: 1 },
				{
					name: "partial_policy",
					expireAfterSeconds: 60,
					partialFilterExpression: { "meta.agentId": "one-agent" },
				},
			)
			const beforeInfo = await collectionInfo(name)
			const beforeIndexes = await db.collection(name).listIndexes().toArray()

			await expect(
				ensureOrdinaryDiagnosticCollection(db, name, 7 * 24 * 3600),
			).rejects.toThrow(/incompatible TTL index policy/)

			expect((await collectionInfo(name)).info?.uuid).toEqual(
				beforeInfo.info?.uuid,
			)
			expect(await db.collection(name).listIndexes().toArray()).toEqual(
				beforeIndexes,
			)
		},
		TIMEOUT,
	)

	it(
		"commits and aborts gate plus both ordinary diagnostic writes atomically",
		async () => {
			const gate = db.collection(`${FRESH_PREFIX}diagnostic_gate`)
			const telemetry = db.collection(`${FRESH_PREFIX}memory_telemetry`)
			const accessEvents = db.collection(`${FRESH_PREFIX}access_events`)
			await gate.insertOne({ _id: "gate", serial: 0 })

			const commitSession = client.startSession()
			try {
				await commitSession.withTransaction(async () => {
					await gate.updateOne(
						{ _id: "gate" },
						{ $inc: { serial: 1 } },
						{ session: commitSession },
					)
					await telemetry.insertOne(
						{ marker: "commit", ts: new Date(), meta: {} },
						{ session: commitSession },
					)
					await accessEvents.insertOne(
						{ marker: "commit", ts: new Date(), meta: {} },
						{ session: commitSession },
					)
				})
			} finally {
				await commitSession.endSession()
			}
			expect(await gate.findOne({ _id: "gate" })).toMatchObject({ serial: 1 })
			expect(await telemetry.countDocuments({ marker: "commit" })).toBe(1)
			expect(await accessEvents.countDocuments({ marker: "commit" })).toBe(1)

			const abortSession = client.startSession()
			try {
				await expect(
					abortSession.withTransaction(async () => {
						await gate.updateOne(
							{ _id: "gate" },
							{ $inc: { serial: 1 } },
							{ session: abortSession },
						)
						await telemetry.insertOne(
							{ marker: "abort", ts: new Date(), meta: {} },
							{ session: abortSession },
						)
						await accessEvents.insertOne(
							{ marker: "abort", ts: new Date(), meta: {} },
							{ session: abortSession },
						)
						throw new Error("injected diagnostic callback failure")
					}),
				).rejects.toThrow("injected diagnostic callback failure")
			} finally {
				await abortSession.endSession()
			}
			expect(await gate.findOne({ _id: "gate" })).toMatchObject({ serial: 1 })
			expect(await telemetry.countDocuments({ marker: "abort" })).toBe(0)
			expect(await accessEvents.countDocuments({ marker: "abort" })).toBe(0)
		},
		TIMEOUT,
	)

	it(
		"shows the former fresh time-series path cannot join the transaction",
		async () => {
			const prefix = "timeseries_tx_"
			const telemetryName = `${prefix}memory_telemetry`
			const accessEventsName = `${prefix}access_events`
			await ensureTimeseriesOrPlain(db, telemetryName, {
				timeField: "ts",
				metaField: "meta",
				granularity: "seconds",
				expireAfterSeconds: 7 * 24 * 3600,
			})
			await ensureTimeseriesOrPlain(db, accessEventsName, {
				timeField: "ts",
				metaField: "meta",
				granularity: "minutes",
				expireAfterSeconds: 30 * 24 * 3600,
			})
			expect((await collectionInfo(telemetryName)).type).toBe("timeseries")
			expect((await collectionInfo(accessEventsName)).type).toBe("timeseries")

			const gate = db.collection(`${prefix}gate`)
			await gate.insertOne({ _id: "gate", serial: 0 })
			const session = client.startSession()
			try {
				await expect(
					session.withTransaction(async () => {
						await gate.updateOne(
							{ _id: "gate" },
							{ $inc: { serial: 1 } },
							{ session },
						)
						await db
							.collection(telemetryName)
							.insertOne(
								{ marker: "rejected", ts: new Date(), meta: {} },
								{ session },
							)
						await db
							.collection(accessEventsName)
							.insertOne(
								{ marker: "rejected", ts: new Date(), meta: {} },
								{ session },
							)
					}),
				).rejects.toThrow()
			} finally {
				await session.endSession()
			}
			expect(await gate.findOne({ _id: "gate" })).toMatchObject({ serial: 0 })
			expect(
				await db
					.collection(telemetryName)
					.countDocuments({ marker: "rejected" }),
			).toBe(0)
			expect(
				await db
					.collection(accessEventsName)
					.countDocuments({ marker: "rejected" }),
			).toBe(0)
		},
		TIMEOUT,
	)
})
