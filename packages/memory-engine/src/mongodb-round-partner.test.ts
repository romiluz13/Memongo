import type { Document } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { attachRoundPartners } from "./mongodb-round-partner.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"
import type { MemorySearchResult } from "./types.js"

// C-2: the official reader expands every retrieved turn into its round. All
// data below is fictional.

const NAMESPACE = { agentId: "agent-1", scope: "agent", scopeRef: "agent:wren" }

function at(minute: number): Date {
	return new Date(Date.UTC(2031, 3, 2, 10, minute))
}

function event(
	eventId: string,
	role: "user" | "assistant",
	minute: number,
	extra: Document = {},
): Document {
	return {
		eventId,
		...NAMESPACE,
		sessionId: "s-oak",
		role,
		body: `fictional ${role} turn ${eventId}`,
		timestamp: at(minute),
		...extra,
	}
}

function turnResult(
	eventId: string,
	role: "user" | "assistant",
	sessionId = "s-oak",
): MemorySearchResult {
	return {
		path: `events/${eventId}`,
		startLine: 0,
		endLine: 0,
		score: 0.5,
		snippet: `fictional ${role} turn ${eventId}`,
		source: "conversation",
		canonicalId: `event:${eventId}`,
		sessionId,
		role,
	}
}

async function fixture(events: Document[]) {
	const fake = createStatefulMongoFake({ prefix: "test_" })
	await fake.collection("events").insertMany(events)
	return fake
}

afterEach(() => {
	vi.useRealTimers()
})

describe("attachRoundPartners", () => {
	it("gives a user turn the next turn of its session", async () => {
		const fake = await fixture([
			event("e-u1", "user", 1),
			event("e-a1", "assistant", 2),
			event("e-u2", "user", 3),
		])
		const [result] = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate: undefined,
			results: [turnResult("e-u1", "user")],
		})
		expect(result?.roundPartner).toEqual({
			canonicalId: "event:e-a1",
			role: "assistant",
			text: "fictional assistant turn e-a1",
			timestamp: at(2),
		})
		expect(result?.roundPartnerMissing).toBeUndefined()
	})

	it("gives an assistant turn the previous turn of its session", async () => {
		const fake = await fixture([
			event("e-u1", "user", 1),
			event("e-a1", "assistant", 2),
			event("e-u2", "user", 3),
			event("e-a2", "assistant", 4),
		])
		const [result] = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate: undefined,
			results: [turnResult("e-a2", "assistant")],
		})
		expect(result?.roundPartner).toEqual({
			canonicalId: "event:e-u2",
			role: "user",
			text: "fictional user turn e-u2",
			timestamp: at(3),
		})
	})
	it("records the session's last user turn as having no partner", async () => {
		const fake = await fixture([
			event("e-u1", "user", 1),
			event("e-a1", "assistant", 2),
			event("e-u2", "user", 3),
		])
		const [result] = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate: undefined,
			results: [turnResult("e-u2", "user")],
		})
		expect(result).toHaveProperty("roundPartner", null)
		expect(result?.roundPartnerMissing).toBe("session-end")
	})
	it("breaks timestamp ties by insertion order (_id), not by event id", async () => {
		const fake = await fixture([
			event("e-u1", "user", 1, { _id: "000000000000000000000001" }),
			event("e-aa", "assistant", 2, { _id: "000000000000000000000003" }),
			event("e-zz", "assistant", 2, { _id: "000000000000000000000002" }),
		])
		const [user, laterAssistant] = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate: undefined,
			results: [turnResult("e-u1", "user"), turnResult("e-aa", "assistant")],
		})
		expect(user?.roundPartner?.canonicalId).toBe("event:e-zz")
		expect(laterAssistant?.roundPartner?.canonicalId).toBe("event:e-zz")
	})
	it("excludes a partner from after the question date", async () => {
		const fake = await fixture([
			event("e-u1", "user", 1),
			event("e-a1", "assistant", 5),
		])
		const [result] = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate: at(3),
			results: [turnResult("e-u1", "user")],
		})
		expect(result).toHaveProperty("roundPartner", null)
		expect(result?.roundPartnerMissing).toBe("partner-excluded")
	})
	it("excludes a retracted partner and never skips past it", async () => {
		const fake = await fixture([
			event("e-u1", "user", 1),
			event("e-a1", "assistant", 2, { invalidAt: at(4) }),
			event("e-u2", "user", 3),
		])
		const [result] = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate: at(10),
			results: [turnResult("e-u1", "user")],
		})
		expect(result).toHaveProperty("roundPartner", null)
		expect(result?.roundPartnerMissing).toBe("partner-excluded")
	})
	it("never pairs across agents or scopes that reuse the session id", async () => {
		const fake = await fixture([
			event("e-u1", "user", 1),
			event("e-other-agent", "assistant", 2, { agentId: "agent-2" }),
			event("e-other-scope", "assistant", 2, {
				scope: "session",
				scopeRef: "session:s-oak",
			}),
			event("e-a1", "assistant", 3),
		])
		const [result] = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate: undefined,
			results: [turnResult("e-u1", "user")],
		})
		expect(result?.roundPartner?.canonicalId).toBe("event:e-a1")
	})
	it("sends one batched, namespace-scoped query for every turn of the search", async () => {
		const now = new Date("2031-05-01T00:00:00.000Z")
		vi.useFakeTimers({ now, toFake: ["Date"] })
		const questionDate = at(30)
		const fake = await fixture([
			event("e-u1", "user", 1),
			event("e-a1", "assistant", 2),
			event("e-u3", "user", 3),
			event("e-a3", "assistant", 4),
			event("e-u2", "user", 1, { sessionId: "s-elm" }),
			event("e-a2", "assistant", 2, { sessionId: "s-elm" }),
		])
		const aggregate = vi.spyOn(fake.collection("events"), "aggregate")
		const chunk: MemorySearchResult = {
			path: "chunks/c1",
			startLine: 0,
			endLine: 0,
			score: 0.4,
			snippet: "fictional chunk",
			source: "conversation",
			canonicalId: "chunk:c1",
			sessionId: "s-pine",
		}
		const results = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate,
			results: [
				turnResult("e-u1", "user"),
				turnResult("e-a2", "assistant", "s-elm"),
				chunk,
				turnResult("e-u3", "user"),
			],
		})
		expect(aggregate).toHaveBeenCalledTimes(1)
		expect(aggregate.mock.calls[0]?.[0]).toEqual([
			{
				$match: {
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:wren",
					sessionId: { $in: ["s-oak", "s-elm"] },
				},
			},
			{
				$setWindowFields: {
					partitionBy: "$sessionId",
					sortBy: { timestamp: 1, _id: 1 },
					output: {
						previousEventId: {
							$shift: { output: "$eventId", by: -1, default: null },
						},
						nextEventId: {
							$shift: { output: "$eventId", by: 1, default: null },
						},
					},
				},
			},
			{
				$match: {
					$or: [
						{ eventId: { $in: ["e-u1", "e-a2", "e-u3"] } },
						{ previousEventId: { $in: ["e-u1", "e-u3"] } },
						{ nextEventId: { $in: ["e-a2"] } },
					],
				},
			},
			{ $match: { timestamp: { $lte: questionDate } } },
			{
				$match: {
					$and: [
						{
							$or: [
								{ validAt: { $exists: false } },
								{ validAt: { $lte: questionDate } },
							],
						},
						{
							$or: [
								{ invalidAt: { $exists: false } },
								{ invalidAt: null },
								{ invalidAt: { $gt: questionDate } },
							],
						},
						{
							$or: [
								{ expiresAt: { $exists: false } },
								{ expiresAt: { $gt: now } },
							],
						},
					],
				},
			},
			{
				$project: {
					_id: 0,
					eventId: 1,
					role: 1,
					body: 1,
					timestamp: 1,
					previousEventId: 1,
					nextEventId: 1,
				},
			},
		])
		expect(
			results.map((result) => result.roundPartner?.canonicalId ?? null),
		).toEqual(["event:e-a1", "event:e-u2", null, "event:e-a3"])
		expect(results[2]).toEqual(chunk)
	})
	it("names why a turn outside a user/assistant round has no partner", async () => {
		const fake = await fixture([
			event("e-u1", "user", 1),
			event("e-s1", "assistant", 2, { role: "system" }),
			event("e-a1", "assistant", 3),
			event("e-foreign", "user", 4, { agentId: "agent-2" }),
		])
		const [system, foreign] = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate: undefined,
			results: [
				{ ...turnResult("e-s1", "assistant"), role: "system" },
				turnResult("e-foreign", "user"),
			],
		})
		expect(system).toMatchObject({
			roundPartner: null,
			roundPartnerMissing: "no-round-role",
		})
		expect(foreign).toMatchObject({
			roundPartner: null,
			roundPartnerMissing: "turn-not-found",
		})
	})
	it("runs no query and reports not-applicable when no result is a turn", async () => {
		const fake = await fixture([event("e-u1", "user", 1)])
		const aggregate = vi.spyOn(fake.collection("events"), "aggregate")
		const rows: unknown[] = []
		const chunk: MemorySearchResult = {
			path: "chunks/c1",
			startLine: 0,
			endLine: 0,
			score: 0.4,
			snippet: "fictional chunk",
			source: "reference",
			canonicalId: "chunk:c1",
		}
		const results = await attachRoundPartners({
			db: fake.db,
			prefix: "test_",
			namespace: NAMESPACE,
			questionDate: undefined,
			results: [chunk],
			onTierOutcome: (row) => rows.push(row),
		})
		expect(aggregate).not.toHaveBeenCalled()
		expect(results).toEqual([chunk])
		expect(rows).toEqual([
			{ stage: "plan", outcome: "not-applicable", reason: "no-candidates" },
		])
	})

	it("surfaces a failed partner query as a typed lane error", async () => {
		const fake = await fixture([event("e-u1", "user", 1)])
		fake.injectFailure({
			collection: "events",
			method: "aggregate",
			error: new Error("fictional outage"),
		})
		await expect(
			attachRoundPartners({
				db: fake.db,
				prefix: "test_",
				namespace: NAMESPACE,
				questionDate: undefined,
				results: [turnResult("e-u1", "user")],
			}),
		).rejects.toMatchObject({ name: "SearchLaneError", stage: "lane" })
	})
})
