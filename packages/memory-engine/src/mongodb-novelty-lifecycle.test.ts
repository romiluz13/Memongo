// M2 T13 (#120): the novelty scan scores only live events. Both its candidate
// read and its k-NN neighbor read apply the event lifecycle, so an expired,
// invalidated or not-yet-valid event is neither scored nor counted as a
// neighbor. The vector stage is MODELED: the prefilter selects from the
// indexed documents and every later stage runs on the document mongod holds.
import type { Db, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import { scanNovelty } from "./mongodb-novelty.js"
import {
	createStatefulMongoFake,
	matchesFilter,
} from "./test-helpers/stateful-mongo-fake.js"

const AGENT_ID = "agent-1"
const PREFIX = "test_"
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const ahead = (days: number) => new Date(Date.now() + days * DAY)

function event(eventId: string, over: Document = {}): Document {
	return {
		agentId: AGENT_ID,
		scope: "agent",
		scopeRef: `agent:${AGENT_ID}`,
		eventId,
		role: "user",
		body: `body of ${eventId}`,
		timestamp: ago(1),
		...over,
	}
}

async function dbWith(events: Document[]) {
	const fake = createStatefulMongoFake({ prefix: PREFIX })
	await fake.collection("events").insertMany(events)
	const eventsCollection = fake.collection("events")
	const neighborPipelines: Document[][] = []
	const wrapped = {
		find: (filter: Document) => eventsCollection.find(filter),
		aggregate: (pipeline: Document[]) => {
			neighborPipelines.push(pipeline)
			const [vector, ...rest] = pipeline
			let docs = eventsCollection.docs.filter((doc) =>
				matchesFilter(doc, vector.$vectorSearch.filter as Document),
			)
			for (const stage of rest) {
				if (stage.$match) {
					docs = docs.filter((doc) => matchesFilter(doc, stage.$match))
				} else if (stage.$project) {
					docs = docs.map((doc) => ({ ...doc, __vs: 0.9 }))
				}
			}
			return { toArray: async () => docs }
		},
	}
	const db = { collection: () => wrapped } as unknown as Db
	return { db, neighborPipelines }
}

describe("scanNovelty lifecycle", () => {
	it("scores only live events: an expired, invalidated or not-yet-valid event is not a candidate", async () => {
		const { db } = await dbWith([
			event("live"),
			event("expired", { expiresAt: ago(1) }),
			event("invalidated", { invalidAt: ago(1) }),
			event("future", { validAt: ahead(1) }),
			event("permanent-with-open-window", { invalidAt: null }),
		])

		const report = await scanNovelty({ db, prefix: PREFIX, agentId: AGENT_ID })

		expect(report.events.map((entry) => entry.eventId).toSorted()).toEqual([
			"live",
			"permanent-with-open-window",
		])
		expect(report.scannedCount).toBe(2)
	})

	it("an expired event is not a neighbor of a live one: its only possible neighbor does not lower its novelty", async () => {
		const { db } = await dbWith([
			event("live"),
			event("expired", { expiresAt: ago(1) }),
		])

		const report = await scanNovelty({ db, prefix: PREFIX, agentId: AGENT_ID })

		expect(report.events.map((entry) => entry.eventId)).toEqual(["live"])
		expect(report.events[0].noveltyScore).toBe(1)
	})

	it("keeps the vector prefilter unchanged and re-checks lifecycle after it", async () => {
		const { db, neighborPipelines } = await dbWith([event("live")])

		await scanNovelty({ db, prefix: PREFIX, agentId: AGENT_ID })

		const [vector, recheck] = neighborPipelines[0]
		expect(vector.$vectorSearch.filter).toEqual({ agentId: AGENT_ID })
		expect(recheck.$match).toBeDefined()
	})
})
