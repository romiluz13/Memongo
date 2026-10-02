import { randomUUID } from "node:crypto"
import { Code, type Db, Long, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { writeEvent, writeEventsBatch } from "./mongodb-events.js"
import { eventsCollection } from "./mongodb-schema.js"

const URI = "mongodb://127.0.0.1:27017/?directConnection=true"
const DB_NAME = `memongo_event_identity_${randomUUID().replaceAll("-", "")}`
const PREFIX = "identity_"
const IGNORE_UNDEFINED_PREFIX = "identity_omit_"
const SERIALIZE_FUNCTIONS_PREFIX = "identity_functions_"
const READ_OPTIONS_PREFIX = "identity_read_"
const TIMEOUT = 60_000

let client: MongoClient
let db: Db
let ignoreUndefinedDb: Db
let serializeFunctionsDb: Db
let inheritedReadOptionsDb: Db

function eventId(label: string): string {
	return `${label}-${randomUUID()}`
}

function eventInput(
	id: string,
	overrides: Partial<Parameters<typeof writeEvent>[0]["event"]> = {},
): Parameters<typeof writeEvent>[0]["event"] {
	return {
		eventId: id,
		agentId: "agent-identity",
		role: "user",
		body: "The original event",
		scope: "agent",
		scopeRef: "agent:agent-identity",
		...overrides,
	}
}

beforeAll(async () => {
	client = new MongoClient(URI)
	await client.connect()
	db = client.db(DB_NAME)
	ignoreUndefinedDb = client.db(DB_NAME, { ignoreUndefined: true })
	serializeFunctionsDb = client.db(DB_NAME, { serializeFunctions: true })
	inheritedReadOptionsDb = client.db(DB_NAME, {
		useBigInt64: true,
		fieldsAsRaw: { metadata: true },
	})
	await Promise.all(
		[
			PREFIX,
			IGNORE_UNDEFINED_PREFIX,
			SERIALIZE_FUNCTIONS_PREFIX,
			READ_OPTIONS_PREFIX,
		].map((prefix) =>
			eventsCollection(db, prefix).createIndex(
				{ eventId: 1 },
				{ name: "uq_events_eventid", unique: true },
			),
		),
	)
}, TIMEOUT)

afterAll(async () => {
	try {
		await db?.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name: DB_NAME } })
		expect(
			listed.databases,
			"disposable identity database must be absent after teardown",
		).toHaveLength(0)
	} finally {
		await client?.close()
	}
}, TIMEOUT)

describe("event ID logical replay identity (real MongoDB)", () => {
	it("returns the first stored receipt when generated clocks and optional identity were omitted", async () => {
		const id = eventId("stored-receipt")
		const first = await writeEvent({
			db,
			prefix: PREFIX,
			event: eventInput(id),
		})
		const replay = await writeEvent({
			db,
			prefix: PREFIX,
			event: eventInput(id),
		})

		expect(replay).toEqual(first)
		const stored = await eventsCollection(db, PREFIX).findOne({ eventId: id })
		expect(stored?.timestamp).toEqual(first.timestamp)
		expect(stored?.scopeRef).toBe(first.scopeRef)
	})

	it.each([
		[
			"a different owner",
			{
				agentId: "agent-intruder",
				scopeRef: "agent:agent-intruder",
			},
		],
		["a changed payload", { body: "A different event" }],
	])("rejects event ID reuse by %s", async (_label, overrides) => {
		const id = eventId("identity-conflict")
		await writeEvent({
			db,
			prefix: PREFIX,
			event: eventInput(id),
		})

		await expect(
			writeEvent({
				db,
				prefix: PREFIX,
				event: eventInput(id, overrides),
			}),
		).rejects.toThrow(
			`event ID "${id}" is already assigned to a different event`,
		)
	})

	it("rejects omitted immutable optional identity that the stored event contains", async () => {
		const cases: Array<
			[string, Partial<Parameters<typeof writeEvent>[0]["event"]>]
		> = [
			["sessionId", { sessionId: "stored-session" }],
			["channel", { channel: "stored-channel" }],
			["metadata", { metadata: { stored: true } }],
		]

		for (const [label, storedOverrides] of cases) {
			const id = eventId(`omitted-${label}`)
			await writeEvent({
				db,
				prefix: PREFIX,
				event: eventInput(id, storedOverrides),
			})

			await expect(
				writeEvent({
					db,
					prefix: PREFIX,
					event: eventInput(id),
				}),
				label,
			).rejects.toThrow(
				`event ID "${id}" is already assigned to a different event`,
			)
		}
	})

	it("preserves BSON metadata types and array order while ignoring object key order", async () => {
		const id = eventId("metadata")
		const observedAt = new Date("2024-05-06T07:08:09.000Z")
		await writeEvent({
			db,
			prefix: PREFIX,
			event: eventInput(id, {
				metadata: {
					observedAt,
					pattern: /alpha/i,
					ranked: ["first", "second"],
					nested: { first: 1, second: true },
				},
			}),
		})

		await expect(
			writeEvent({
				db,
				prefix: PREFIX,
				event: eventInput(id, {
					metadata: {
						nested: { second: true, first: 1 },
						ranked: ["first", "second"],
						pattern: /alpha/i,
						observedAt,
					},
				}),
			}),
		).resolves.toMatchObject({ eventId: id })

		for (const metadata of [
			{
				observedAt: observedAt.toISOString(),
				pattern: /alpha/i,
				ranked: ["first", "second"],
				nested: { first: 1, second: true },
			},
			{
				observedAt,
				pattern: /beta/i,
				ranked: ["first", "second"],
				nested: { first: 1, second: true },
			},
			{
				observedAt,
				pattern: /alpha/i,
				ranked: ["second", "first"],
				nested: { first: 1, second: true },
			},
		]) {
			await expect(
				writeEvent({
					db,
					prefix: PREFIX,
					event: eventInput(id, { metadata }),
				}),
			).rejects.toThrow(
				`event ID "${id}" is already assigned to a different event`,
			)
		}
	})

	it.each([
		{
			label: "driver-default null",
			targetDb: () => db,
			prefix: PREFIX,
			storedMetadata: { nested: { optional: null } },
			conflictingMetadata: { nested: {} },
		},
		{
			label: "inherited omission",
			targetDb: () => ignoreUndefinedDb,
			prefix: IGNORE_UNDEFINED_PREFIX,
			storedMetadata: { nested: {} },
			conflictingMetadata: { nested: { optional: null } },
		},
	])("replays nested undefined metadata using the $label write representation", async ({
		targetDb,
		prefix,
		storedMetadata,
		conflictingMetadata,
	}) => {
		const target = targetDb()
		const singleId = eventId("undefined-single")
		const event = eventInput(singleId, {
			metadata: { nested: { optional: undefined } },
		})
		const first = await writeEvent({ db: target, prefix, event })

		await expect(writeEvent({ db: target, prefix, event })).resolves.toEqual(
			first,
		)
		expect(
			(
				await eventsCollection(target, prefix).findOne({
					eventId: singleId,
				})
			)?.metadata,
		).toEqual(storedMetadata)
		await expect(
			writeEvent({
				db: target,
				prefix,
				event: eventInput(singleId, {
					metadata: conflictingMetadata,
				}),
			}),
		).rejects.toThrow(
			`event ID "${singleId}" is already assigned to a different event`,
		)

		const batchId = eventId("undefined-batch")
		const batchEvent = eventInput(batchId, {
			metadata: { nested: { optional: undefined } },
		})
		const inserted = await writeEventsBatch({
			db: target,
			prefix,
			events: [batchEvent],
		})
		expect(inserted[0]).toMatchObject({ ok: true, eventId: batchId })
		if (!inserted[0]?.ok) {
			throw new Error("expected initial batch write to succeed")
		}
		const replayed = await writeEventsBatch({
			db: target,
			prefix,
			events: [batchEvent],
		})
		expect(replayed[0]).toEqual({
			ok: true,
			eventId: batchId,
			timestamp: inserted[0].timestamp,
			scopeRef: "agent:agent-identity",
			duplicateKey: true,
		})
		const conflict = await writeEventsBatch({
			db: target,
			prefix,
			events: [
				eventInput(batchId, {
					metadata: conflictingMetadata,
				}),
			],
		})
		expect(conflict[0]).toEqual({
			ok: false,
			eventId: batchId,
			duplicateKey: false,
			message: `event ID "${batchId}" is already assigned to a different event`,
		})
	})

	it("honors inherited serializeFunctions during replay comparison", async () => {
		function transform(value: unknown): unknown {
			return value
		}
		const id = eventId("function-metadata")
		const event = eventInput(id, { metadata: { transform } })
		const first = await writeEvent({
			db: serializeFunctionsDb,
			prefix: SERIALIZE_FUNCTIONS_PREFIX,
			event,
		})

		await expect(
			writeEvent({
				db: serializeFunctionsDb,
				prefix: SERIALIZE_FUNCTIONS_PREFIX,
				event,
			}),
		).resolves.toEqual(first)
		const stored = await eventsCollection(
			serializeFunctionsDb,
			SERIALIZE_FUNCTIONS_PREFIX,
		).findOne({ eventId: id })
		expect(stored?.metadata?.transform).toEqual(new Code(transform.toString()))
		await expect(
			writeEvent({
				db: serializeFunctionsDb,
				prefix: SERIALIZE_FUNCTIONS_PREFIX,
				event: eventInput(id, {
					metadata: {
						transform(value: unknown): unknown {
							return { value }
						},
					},
				}),
			}),
		).rejects.toThrow(
			`event ID "${id}" is already assigned to a different event`,
		)
	})

	it("uses a compatible full-document decode despite inherited read options", async () => {
		const id = eventId("read-options")
		const event = eventInput(id, {
			metadata: {
				count: Long.fromNumber(7),
				pattern: /alpha/i,
			},
		})
		const first = await writeEvent({
			db: inheritedReadOptionsDb,
			prefix: READ_OPTIONS_PREFIX,
			event,
		})

		await expect(
			writeEvent({
				db: inheritedReadOptionsDb,
				prefix: READ_OPTIONS_PREFIX,
				event,
			}),
		).resolves.toEqual(first)
		await expect(
			writeEventsBatch({
				db: inheritedReadOptionsDb,
				prefix: READ_OPTIONS_PREFIX,
				events: [event],
			}),
		).resolves.toMatchObject([{ ok: true, eventId: id, duplicateKey: true }])
	})

	it("reconciles repeated batch positions independently and preserves siblings", async () => {
		const heldId = eventId("batch-held")
		const held = await writeEvent({
			db,
			prefix: PREFIX,
			event: eventInput(heldId, { channel: "stored-channel" }),
		})
		const freshId = eventId("batch-fresh")

		const results = await writeEventsBatch({
			db,
			prefix: PREFIX,
			events: [
				eventInput(freshId, { body: "Fresh sibling" }),
				eventInput(heldId, { channel: "stored-channel" }),
				eventInput(heldId),
			],
		})

		expect(results[0]).toMatchObject({
			ok: true,
			eventId: freshId,
		})
		expect(results[1]).toEqual({
			ok: true,
			eventId: heldId,
			timestamp: held.timestamp,
			scopeRef: held.scopeRef,
			duplicateKey: true,
		})
		expect(results[2]).toEqual({
			ok: false,
			eventId: heldId,
			duplicateKey: false,
			message: `event ID "${heldId}" is already assigned to a different event`,
		})
		expect(
			await eventsCollection(db, PREFIX).countDocuments({
				eventId: { $in: [heldId, freshId] },
			}),
		).toBe(2)
	})
})
