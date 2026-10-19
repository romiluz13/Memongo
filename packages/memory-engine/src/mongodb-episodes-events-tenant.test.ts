// M2 T13 (#120): episode and event reads confine themselves to the full tenant
// (agentId, scope, scopeRef). A document of another scopeRef that shares the
// agent is never read or changed, and a call without the full identity fails
// typed before any collection is touched.
import type { Db, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import {
	checkAutoEpisodeTriggers,
	getEpisodesByIds,
	getEpisodesByTimeRange,
	getEpisodesByType,
	materializeEpisode,
	searchEpisodes,
	updateEpisodeStatus,
} from "./mongodb-episodes.js"
import {
	getEventsBySession,
	getEventsByTimeRange,
	getSessionEventsWithBound,
	getUnconsolidatedEvents,
} from "./mongodb-events.js"
import { heuristicEpisodeSummarizer } from "./mongodb-derived-memory.js"
import { TenantIdentityRequiredError } from "./mongodb-tenant-identity.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const MINE = { scope: "workspace", scopeRef: "workspace:mine" } as const
const THEIRS = { scope: "workspace", scopeRef: "workspace:theirs" } as const
const START = new Date("2026-01-01T00:00:00Z")
const END = new Date("2026-01-02T00:00:00Z")
const MIDDLE = new Date("2026-01-01T12:00:00Z")

function episode(tenant: Document, episodeId: string): Document {
	return {
		agentId: AGENT_ID,
		...tenant,
		episodeId,
		type: "daily",
		status: "active",
		title: `title of ${episodeId}`,
		summary: `summary of ${episodeId}`,
		timeRange: { start: START, end: END },
		updatedAt: new Date(),
	}
}

function event(tenant: Document, eventId: string): Document {
	return {
		agentId: AGENT_ID,
		...tenant,
		eventId,
		role: "user",
		body: `body of ${eventId}`,
		sessionId: "sess-1",
		timestamp: MIDDLE,
	}
}

async function seeded() {
	const fake = createStatefulMongoFake({ prefix: PREFIX })
	await fake
		.collection("episodes")
		.insertMany([episode(MINE, "ep-mine"), episode(THEIRS, "ep-theirs")])
	await fake
		.collection("events")
		.insertMany([event(MINE, "evt-mine"), event(THEIRS, "evt-theirs")])
	return { fake, db: fake.db as unknown as Db }
}

describe("episode reads and writes stay inside the tenant", () => {
	it("getEpisodesByTimeRange returns only the tenant's episodes", async () => {
		const { db } = await seeded()

		const found = await getEpisodesByTimeRange({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			start: START,
			end: END,
			...MINE,
		})

		expect(found.map((doc) => doc.episodeId)).toEqual(["ep-mine"])
	})

	it("getEpisodesByType returns only the tenant's episodes", async () => {
		const { db } = await seeded()

		const found = await getEpisodesByType({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			type: "daily",
			...MINE,
		})

		expect(found.map((doc) => doc.episodeId)).toEqual(["ep-mine"])
	})

	it("getEpisodesByIds does not reopen another scopeRef's episode by id", async () => {
		const { db } = await seeded()

		const found = await getEpisodesByIds({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			episodeIds: ["ep-mine", "ep-theirs"],
			...MINE,
		})

		expect(found.map((doc) => doc.episodeId)).toEqual(["ep-mine"])
	})

	it("updateEpisodeStatus changes only the tenant's episode", async () => {
		const { fake, db } = await seeded()

		const crossTenant = await updateEpisodeStatus({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			episodeId: "ep-theirs",
			status: "archived",
			...MINE,
		})

		expect(crossTenant).toBe(false)
		expect(fake.collection("episodes").docs.map((doc) => doc.status)).toEqual([
			"active",
			"active",
		])

		const own = await updateEpisodeStatus({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			episodeId: "ep-mine",
			status: "archived",
			...MINE,
		})

		expect(own).toBe(true)
		expect(
			Object.fromEntries(
				fake
					.collection("episodes")
					.docs.map((doc) => [doc.episodeId, doc.status]),
			),
		).toEqual({ "ep-mine": "archived", "ep-theirs": "active" })
	})
})

describe("event reads stay inside the tenant", () => {
	it("getEventsByTimeRange returns only the tenant's events", async () => {
		const { db } = await seeded()

		const found = await getEventsByTimeRange({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			start: START,
			end: END,
			...MINE,
		})

		expect(found.map((doc) => doc.eventId)).toEqual(["evt-mine"])
	})

	it("getEventsBySession returns only the tenant's events", async () => {
		const { db } = await seeded()

		const found = await getEventsBySession({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			sessionId: "sess-1",
			...MINE,
		})

		expect(found.map((doc) => doc.eventId)).toEqual(["evt-mine"])
	})

	it("getUnconsolidatedEvents returns only the tenant's events", async () => {
		const { db } = await seeded()

		const found = await getUnconsolidatedEvents({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			...MINE,
		})

		expect(found.map((doc) => doc.eventId)).toEqual(["evt-mine"])
	})

	it("getSessionEventsWithBound returns only the tenant's events", async () => {
		const { db } = await seeded()

		const found = await getSessionEventsWithBound({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			sessionId: "sess-1",
			...MINE,
		})

		expect(found.map((doc) => doc.eventId)).toEqual(["evt-mine"])
	})
})

describe("a call without the full tenant identity fails typed before any read", () => {
	const untouched = {
		collection: () => {
			throw new Error("a collection was touched")
		},
	} as unknown as Db

	const calls: Array<[string, (identity: Document) => Promise<unknown>]> = [
		[
			"getEpisodesByTimeRange",
			(identity) =>
				getEpisodesByTimeRange({
					db: untouched,
					prefix: PREFIX,
					start: START,
					end: END,
					...identity,
				} as never),
		],
		[
			"getEpisodesByType",
			(identity) =>
				getEpisodesByType({
					db: untouched,
					prefix: PREFIX,
					type: "daily",
					...identity,
				} as never),
		],
		[
			"searchEpisodes",
			(identity) =>
				searchEpisodes({
					db: untouched,
					prefix: PREFIX,
					query: "anything",
					...identity,
				} as never),
		],
		[
			"getEpisodesByIds",
			(identity) =>
				getEpisodesByIds({
					db: untouched,
					prefix: PREFIX,
					episodeIds: ["ep-mine"],
					...identity,
				} as never),
		],
		[
			"updateEpisodeStatus",
			(identity) =>
				updateEpisodeStatus({
					db: untouched,
					prefix: PREFIX,
					episodeId: "ep-mine",
					status: "archived",
					...identity,
				} as never),
		],
		[
			"materializeEpisode",
			(identity) =>
				materializeEpisode({
					db: untouched,
					prefix: PREFIX,
					type: "daily",
					timeRange: { start: START, end: END },
					summarizer: heuristicEpisodeSummarizer,
					...identity,
				} as never),
		],
		[
			"checkAutoEpisodeTriggers",
			(identity) =>
				checkAutoEpisodeTriggers({
					db: untouched,
					prefix: PREFIX,
					summarizer: heuristicEpisodeSummarizer,
					...identity,
				} as never),
		],
		[
			"getEventsByTimeRange",
			(identity) =>
				getEventsByTimeRange({
					db: untouched,
					prefix: PREFIX,
					start: START,
					end: END,
					...identity,
				} as never),
		],
		[
			"getEventsBySession",
			(identity) =>
				getEventsBySession({
					db: untouched,
					prefix: PREFIX,
					sessionId: "sess-1",
					...identity,
				} as never),
		],
		[
			"getUnconsolidatedEvents",
			(identity) =>
				getUnconsolidatedEvents({
					db: untouched,
					prefix: PREFIX,
					...identity,
				} as never),
		],
		[
			"getSessionEventsWithBound",
			(identity) =>
				getSessionEventsWithBound({
					db: untouched,
					prefix: PREFIX,
					sessionId: "sess-1",
					...identity,
				} as never),
		],
	]

	const identities: Array<[string, Document, string[]]> = [
		["no scope", { agentId: AGENT_ID, scopeRef: "workspace:mine" }, ["scope"]],
		["no scopeRef", { agentId: AGENT_ID, scope: "workspace" }, ["scopeRef"]],
		[
			"an empty scopeRef",
			{ agentId: AGENT_ID, scope: "workspace", scopeRef: " " },
			["scopeRef"],
		],
		[
			"an unknown scope",
			{ agentId: AGENT_ID, scope: "galaxy", scopeRef: "x" },
			["scope"],
		],
		[
			"no agentId",
			{ scope: "workspace", scopeRef: "workspace:mine" },
			["agentId"],
		],
	]

	it.each(
		calls.flatMap(([name, call]) =>
			identities.map(([label, identity, missing]) => ({
				name,
				call,
				label,
				identity,
				missing,
			})),
		),
	)("$name with $label", async ({ name, call, identity, missing }) => {
		const failure = await call(identity).then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(TenantIdentityRequiredError)
		expect(failure).toMatchObject({ operation: name, missing })
	})
})
