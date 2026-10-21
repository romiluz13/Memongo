// Governed get-event-by-id: one event, confined to the caller's
// {agentId, scope, scopeRef} plus the expiry guard. Any event outside that
// identity reads as absent (null), indistinguishable from a missing id.
import { describe, expect, it } from "vitest"
import { MongoDBManagerReadOps } from "./mongodb-manager-read.js"
import { MongoDBManagerSearchOps } from "./mongodb-manager-search.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const PREFIX = "test_"
const AGENT = "agent-1"

function buildReadOps(fake: ReturnType<typeof createStatefulMongoFake>) {
	const host = {
		db: fake.db,
		prefix: PREFIX,
		agentId: AGENT,
	} as unknown as MongoDBManagerHost
	const searchOps = new MongoDBManagerSearchOps(host)
	host.resolveSearchIdentity = (opts) => searchOps.resolveSearchIdentity(opts)
	return new MongoDBManagerReadOps(host)
}

async function seed(fake: ReturnType<typeof createStatefulMongoFake>) {
	const timestamp = new Date("2026-10-01T09:30:00.000Z")
	await fake.collection("events").insertMany([
		{
			eventId: "evt-own",
			agentId: AGENT,
			role: "user",
			body: "the deploy window moved to Thursday",
			scope: "user",
			scopeRef: "user:alice",
			timestamp,
			validAt: timestamp,
		},
		{
			eventId: "evt-default",
			agentId: AGENT,
			role: "assistant",
			body: "noted",
			scope: "agent",
			scopeRef: `agent:${AGENT}`,
			timestamp,
		},
		{
			eventId: "evt-other-agent",
			agentId: "agent-2",
			role: "user",
			body: "other agent secret",
			scope: "user",
			scopeRef: "user:alice",
			timestamp,
		},
		{
			eventId: "evt-other-ref",
			agentId: AGENT,
			role: "user",
			body: "bob's secret",
			scope: "user",
			scopeRef: "user:bob",
			timestamp,
		},
		{
			eventId: "evt-other-scope",
			agentId: AGENT,
			role: "user",
			body: "tenant secret",
			scope: "tenant",
			scopeRef: "user:alice",
			timestamp,
		},
		{
			eventId: "evt-expired",
			agentId: AGENT,
			role: "user",
			body: "expired body",
			scope: "user",
			scopeRef: "user:alice",
			timestamp,
			expiresAt: new Date(Date.now() - 1_000),
		},
	])
}

const ALICE = { scope: "user" as const, scopeRef: "user:alice" }

describe("MongoDBManagerReadOps.getEvent", () => {
	it("returns the caller's own event as a structured record", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seed(fake)

		const record = await buildReadOps(fake).getEvent({
			eventId: "evt-own",
			...ALICE,
		})

		expect(record).toEqual({
			eventId: "evt-own",
			role: "user",
			body: "the deploy window moved to Thursday",
			timestamp: "2026-10-01T09:30:00.000Z",
			scope: "user",
			scopeRef: "user:alice",
			validAt: "2026-10-01T09:30:00.000Z",
		})
	})

	it("resolves an absent scope to the canonical default identity", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seed(fake)
		const ops = buildReadOps(fake)

		expect(await ops.getEvent({ eventId: "evt-default" })).toEqual({
			eventId: "evt-default",
			role: "assistant",
			body: "noted",
			timestamp: "2026-10-01T09:30:00.000Z",
			scope: "agent",
			scopeRef: `agent:${AGENT}`,
		})
		expect(await ops.getEvent({ eventId: "evt-own" })).toBeNull()
	})

	it("resolves a session coordinate to the session partition", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await fake.collection("events").insertOne({
			eventId: "evt-session",
			agentId: AGENT,
			role: "user",
			body: "session turn",
			scope: "session",
			scopeRef: "session:s-1",
			timestamp: new Date("2026-10-01T09:30:00.000Z"),
		})
		const ops = buildReadOps(fake)

		expect(
			await ops.getEvent({
				eventId: "evt-session",
				scope: "session",
				sessionKey: "s-1",
			}),
		).toMatchObject({ scope: "session", scopeRef: "session:s-1" })
		expect(
			await ops.getEvent({ eventId: "evt-session", sessionKey: "s-2" }),
		).toBeNull()
	})

	it.each([
		["another agent's event", "evt-other-agent"],
		["an event under another scopeRef", "evt-other-ref"],
		["an event under another scope", "evt-other-scope"],
		["an expired event", "evt-expired"],
		["an unknown id", "evt-missing"],
	])("reads %s as absent", async (_label, eventId) => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seed(fake)

		expect(await buildReadOps(fake).getEvent({ eventId, ...ALICE })).toBeNull()
	})
})
