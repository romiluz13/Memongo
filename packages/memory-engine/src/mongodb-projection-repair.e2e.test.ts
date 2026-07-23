import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	projectChunksFromEvents,
	writeEvent,
} from "./mongodb-events.js"
import {
	chunksCollection,
	ensureCollections,
	eventsCollection,
} from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_projection_repair_${randomUUID().slice(0, 8)}`
const PREFIX = "repair_"
const AGENT = `agent-${randomUUID().slice(0, 8)}`

let client: MongoClient

describe("canonical event projection repair (live MongoDB)", () => {
	beforeAll(async () => {
		client = new MongoClient(TEST_URI)
		await client.connect()
		await ensureCollections(client.db(TEST_DB), PREFIX)
	})

	afterAll(async () => {
		await client?.db(TEST_DB).dropDatabase().catch(() => {})
		await client?.close()
	})

	it("recovers an unprojected event and is idempotent on retry", async () => {
		const db = client.db(TEST_DB)
		const written = await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId: "evt-repair",
				agentId: AGENT,
				role: "assistant",
				body: "The deployment requires projection repair.",
				scope: "agent",
			},
		})

		expect(
			await eventsCollection(db, PREFIX).findOne({ eventId: written.eventId }),
		).not.toHaveProperty("projectedAt")

		await expect(
			projectChunksFromEvents({
				db,
				prefix: PREFIX,
				agentId: AGENT,
				batchSize: 500,
			}),
		).resolves.toEqual({ eventsProcessed: 1, chunksCreated: 1 })

		const event = await eventsCollection(db, PREFIX).findOne({
			eventId: written.eventId,
		})
		const chunk = await chunksCollection(db, PREFIX).findOne({
			path: `events/${written.eventId}`,
		})
		expect(event?.projectedAt).toBeInstanceOf(Date)
		expect(chunk).toMatchObject({
			path: "events/evt-repair",
			text: "Assistant: The deployment requires projection repair.",
			agentId: AGENT,
			scope: "agent",
			scopeRef: `agent:${AGENT}`,
		})

		await expect(
			projectChunksFromEvents({
				db,
				prefix: PREFIX,
				agentId: AGENT,
				batchSize: 500,
			}),
		).resolves.toEqual({ eventsProcessed: 0, chunksCreated: 0 })
		expect(
			await chunksCollection(db, PREFIX).countDocuments({
				path: `events/${written.eventId}`,
			}),
		).toBe(1)
	})
})
