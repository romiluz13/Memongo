import { randomUUID } from "node:crypto"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { EVENT_IDENTITY_READ_OPTIONS } from "./mongodb-event-metadata-identity.js"
import { IdempotencyConflictError, writeEvent } from "./mongodb-events.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { eventsCollection } from "./mongodb-schema.js"

const URI = "mongodb://127.0.0.1:27017/?directConnection=true"
const DB_NAME = `memongo_manager_metadata_${randomUUID().replaceAll("-", "")}`
const TIMEOUT = 60_000
const AGENT_ID = "synthetic-owner"
const DATE_FINGERPRINT =
	"57cbbabf06523c34acdaad3d80e599a251d0c6721c745f5b74ccb19dd8534dd6"
const REGEXP_FINGERPRINT =
	"ae5cd0d523111322bd08b8aafe7f7ed8e543d53ee707b7ee41d246c872bdf30b"

let client: MongoClient
let db: Db
let hostileReadDb: Db

function makeManager(targetDb: Db, prefix: string): MongoDBMemoryManager {
	return Reflect.construct(MongoDBMemoryManager, [
		{
			client,
			db: targetDb,
			prefix,
			agentId: AGENT_ID,
			workspaceDir: "/tmp/memongo-w9-metadata",
			capabilities: {},
			nativeBitemporalVectorPrefilter: false,
			config: {
				mongodb: {
					embeddingMode: "automated",
					episodes: { enabled: false, minEventsForEpisode: 6 },
				},
			},
			ownsClient: false,
		},
	]) as MongoDBMemoryManager
}

beforeAll(async () => {
	client = new MongoClient(URI)
	await client.connect()
	db = client.db(DB_NAME)
	hostileReadDb = client.db(DB_NAME, {
		useBigInt64: true,
		fieldsAsRaw: { metadata: true },
	})
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
			"disposable manager metadata database must be absent after teardown",
		).toHaveLength(0)
	} finally {
		await client?.close()
	}
}, TIMEOUT)

describe("manager keyed metadata identity (real MongoDB)", () => {
	it.each([
		{
			label: "default inherited read options",
			targetDb: () => db,
			prefix: "manager_metadata_default_",
		},
		{
			label: "hostile inherited read options",
			targetDb: () => hostileReadDb,
			prefix: "manager_metadata_hostile_",
		},
	])(
		"preserves old hashes and BSON metadata identity with $label",
		async ({ targetDb, prefix }) => {
			const target = targetDb()
			const events = eventsCollection(target, prefix)
			await events.createIndex({ eventId: 1 }, { unique: true })
			await events.createIndex(
				{ agentId: 1, idempotencyKey: 1 },
				{ unique: true },
			)

			const seenAt = new Date("2026-01-01T00:00:00.000Z")
			const dateEvent = {
				role: "user" as const,
				body: "synthetic metadata fact",
				scope: "agent" as const,
				metadata: { seenAt },
				idempotencyKey: "stable-date-key",
			}
			const regexpEvent = {
				role: "user" as const,
				body: "synthetic regexp fact",
				scope: "agent" as const,
				metadata: { pattern: /alpha/i },
				idempotencyKey: "stable-regexp-key",
			}
			const seededDate = await writeEvent({
				db: target,
				prefix,
				event: {
					...dateEvent,
					eventId: "original-date-event",
					agentId: AGENT_ID,
					idempotencyFingerprint: DATE_FINGERPRINT,
				},
			})
			const seededRegExp = await writeEvent({
				db: target,
				prefix,
				event: {
					...regexpEvent,
					eventId: "original-regexp-event",
					agentId: AGENT_ID,
					idempotencyFingerprint: REGEXP_FINGERPRINT,
				},
			})
			const manager = makeManager(target, prefix)

			await expect(manager.writeConversationEvent(dateEvent)).resolves.toEqual({
				eventId: seededDate.eventId,
				chunkCreated: false,
			})
			await expect(
				manager.writeConversationEvent({
					...dateEvent,
					metadata: { seenAt: seenAt.toISOString() },
				}),
			).rejects.toBeInstanceOf(IdempotencyConflictError)
			await expect(
				manager.writeConversationEventsBatch([
					{
						...dateEvent,
						metadata: { seenAt: seenAt.toISOString() },
					},
				]),
			).resolves.toMatchObject([{ ok: false, code: "IDEMPOTENCY_CONFLICT" }])

			await expect(
				manager.writeConversationEvent(regexpEvent),
			).resolves.toEqual({
				eventId: seededRegExp.eventId,
				chunkCreated: false,
			})
			await expect(
				manager.writeConversationEvent({
					...regexpEvent,
					metadata: { pattern: /beta/i },
				}),
			).rejects.toBeInstanceOf(IdempotencyConflictError)

			const storedDate = await events.findOne(
				{ eventId: seededDate.eventId },
				EVENT_IDENTITY_READ_OPTIONS,
			)
			const storedRegExp = await events.findOne(
				{ eventId: seededRegExp.eventId },
				EVENT_IDENTITY_READ_OPTIONS,
			)
			expect(storedDate?.metadata?.seenAt).toBeInstanceOf(Date)
			expect(storedRegExp?.metadata?.pattern).toMatchObject({
				pattern: "alpha",
				options: "i",
			})
			expect(
				await events.countDocuments({
					eventId: { $in: [seededDate.eventId, seededRegExp.eventId] },
				}),
			).toBe(2)
		},
		TIMEOUT,
	)
})
