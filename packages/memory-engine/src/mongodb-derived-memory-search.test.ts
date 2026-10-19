// T7 (#116): the supporting-event lookup behind derived-memory promotion runs
// on `$search` over the events text index: `phrase` for a full LLM claim and
// `text` for a plain value. The Search stage only proposes candidates. Tenant
// and lifecycle are checked again on the hydrated event, and every hit must
// pass the same verifier the regex lookup applied (the anchored full claim, or
// the literal value) before it counts as corroboration.
import type { Db, Document } from "mongodb"
import { describe, expect, it } from "vitest"
import {
	prepareDerivedMemoryPromotion,
	resolveStructuredCandidatesForPromotion,
} from "./mongodb-derived-memory.js"
import { runWithIndexHealth } from "./mongodb-index-health.js"
import { SearchLaneError } from "./search-outcomes.js"
import { createIndexHealthSource } from "./test-helpers/index-health-source.js"
import {
	type SearchStageFakeEntry,
	createSearchStageFake,
	manifestDefinition,
} from "./test-helpers/search-stage-fake.js"

const PREFIX = "t7_"
const INDEX = `${PREFIX}events_text`
const CLAIM = "My favorite color is blue."
const CURRENT_AT = new Date("2026-03-21T10:00:00Z")

function stored(overrides: Document): Document {
	return {
		eventId: "evt",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
		role: "user",
		body: CLAIM,
		timestamp: new Date("2026-03-20T10:00:00Z"),
		...overrides,
	}
}

function stage(entries: SearchStageFakeEntry[], failure?: Error) {
	const fake = createSearchStageFake({
		indexName: INDEX,
		definition: manifestDefinition(PREFIX, INDEX),
		entries,
		failure,
	})
	const db = {
		collection: (name: string) => {
			if (name === `${PREFIX}events`) return fake.collection
			if (name === `${PREFIX}structured_mem`) {
				return { findOne: async () => null }
			}
			throw new Error(`unexpected collection ${name}`)
		},
	} as unknown as Db
	return { ...fake, db }
}

function currentEvent(body: string) {
	return {
		eventId: "evt-current",
		agentId: "agent-1",
		role: "user" as const,
		body,
		timestamp: CURRENT_AT,
		scope: "agent" as const,
		scopeRef: "agent:agent-1",
	}
}

// An LLM-extracted full claim: the claim lane (`phrase` plus the anchored verifier).
async function claimSupport(
	entries: SearchStageFakeEntry[],
	claim = CLAIM,
	currentBody = claim,
) {
	const fake = stage([
		{ indexed: stored({ eventId: "evt-current", body: currentBody }) },
		...entries,
	])
	const promotable = await resolveStructuredCandidatesForPromotion({
		db: fake.db,
		prefix: PREFIX,
		event: currentEvent(currentBody),
		prefetchedLlmFacts: [claim],
	})
	return {
		fake,
		promotable,
		ids: (promotable[0]?.provenance?.supportingEventIds ?? []) as string[],
	}
}

const PREFERENCE = "I prefer concise answers with direct tradeoffs."

// A regex-extracted preference: the value lane (`text` plus the literal verifier).
async function valueSupport(entries: SearchStageFakeEntry[]) {
	const fake = stage([
		{ indexed: stored({ eventId: "evt-current", body: PREFERENCE }) },
		...entries,
	])
	const promotable = await resolveStructuredCandidatesForPromotion({
		db: fake.db,
		prefix: PREFIX,
		event: currentEvent(PREFERENCE),
	})
	return {
		fake,
		promotable,
		ids: (promotable[0]?.provenance?.supportingEventIds ?? []) as string[],
	}
}

function hit(eventId: string, body: string, overrides: Document = {}) {
	return { indexed: stored({ eventId, body, ...overrides }) }
}

describe("supporting events for a full LLM claim: $search phrase", () => {
	it("runs one $search phrase over body and never a content find", async () => {
		const { fake, ids } = await claimSupport([hit("evt-a", CLAIM)])
		expect(ids).toEqual(["evt-a"])
		expect(fake.findCalls).toEqual([])
		expect(fake.pipelines).toHaveLength(1)
		const search = fake.pipelines[0][0].$search as Document
		expect(search.index).toBe(INDEX)
		expect(search.compound.must).toEqual([
			{
				phrase: {
					query: [
						"My favorite color is blue",
						"The user's favorite color is blue",
					],
					path: "body",
				},
			},
		])
		expect(search.compound.filter).toEqual([
			{ equals: { path: "agentId", value: "agent-1" } },
			{ equals: { path: "scope", value: "agent" } },
			{ equals: { path: "scopeRef", value: "agent:agent-1" } },
		])
		expect(JSON.stringify(fake.pipelines)).not.toContain("$regex")
		expect(fake.options[0]).toEqual({ maxTimeMS: expect.any(Number) })
	})

	it("accepts the same claim in any case, with or without the final period, and in the alternate form", async () => {
		const { ids } = await claimSupport([
			hit("evt-lower", "my favorite color is blue."),
			hit("evt-upper", "MY FAVORITE COLOR IS BLUE"),
			hit("evt-alternate", "The user's favorite color is blue."),
		])
		expect(ids.toSorted()).toEqual(["evt-alternate", "evt-lower", "evt-upper"])
	})

	it("lets a Search hit corroborate nothing when the body is more than the full claim", async () => {
		const longer = [
			hit("evt-longer", "My favorite color is blue and green."),
			hit("evt-quoted", "I said my favorite color is blue."),
			hit("evt-negated", "I don't think my favorite color is blue."),
			hit("evt-prefixed", "Note: My favorite color is blue."),
		]
		const { fake, ids, promotable } = await claimSupport(longer)
		const [pipeline] = fake.pipelines
		const proposed = await fake.collection.aggregate([pipeline[0]]).toArray()
		expect(proposed.map((doc) => doc.eventId).toSorted()).toEqual([
			"evt-current",
			"evt-longer",
			"evt-negated",
			"evt-prefixed",
			"evt-quoted",
		])
		expect(ids).toEqual([])
		expect(promotable).toEqual([])
	})

	it("keeps internal punctuation significant even though Search ignores it", async () => {
		const { ids } = await claimSupport([
			hit("evt-comma", "My favorite color, is blue."),
			hit("evt-bang", "My favorite color is blue!"),
			hit("evt-dash", "My favorite color is - blue."),
			hit("evt-ok", "My favorite color is blue."),
		])
		expect(ids).toEqual(["evt-ok"])
	})

	it("matches numbers as whole terms", async () => {
		const claim = "My lucky number is 42."
		const { ids } = await claimSupport(
			[
				hit("evt-420", "My lucky number is 420."),
				hit("evt-4", "My lucky number is 4."),
				hit("evt-42", "My lucky number is 42."),
			],
			claim,
		)
		expect(ids).toEqual(["evt-42"])
	})

	it("does not treat a negated or reworded statement as the claim", async () => {
		const { ids } = await claimSupport([
			hit("evt-not", "My favorite color is not blue."),
			hit("evt-reworded", "Blue is my favorite color."),
			hit("evt-near", "My favourite color is blue."),
			hit("evt-ok", CLAIM),
		])
		expect(ids).toEqual(["evt-ok"])
	})

	it("never counts another agent, scope or scope reference", async () => {
		const { ids } = await claimSupport([
			hit("evt-mine", CLAIM),
			hit("evt-agent", CLAIM, { agentId: "agent-2" }),
			hit("evt-scope", CLAIM, { scope: "workspace" }),
			hit("evt-ref", CLAIM, { scopeRef: "agent:agent-2" }),
		])
		expect(ids).toEqual(["evt-mine"])
	})

	it("drops an event that was re-scoped, expired, invalidated or deleted after it was indexed", async () => {
		const clock = new Date()
		const past = new Date(clock.getTime() - 60_000)
		const future = new Date(clock.getTime() + 3_600_000)
		const { ids } = await claimSupport([
			hit("evt-kept", CLAIM),
			{
				indexed: stored({ eventId: "evt-moved" }),
				current: stored({ eventId: "evt-moved", scopeRef: "agent:agent-2" }),
			},
			{
				indexed: stored({ eventId: "evt-expired" }),
				current: stored({ eventId: "evt-expired", expiresAt: past }),
			},
			{
				indexed: stored({ eventId: "evt-invalidated" }),
				current: stored({ eventId: "evt-invalidated", invalidAt: past }),
			},
			{
				indexed: stored({ eventId: "evt-not-yet-valid" }),
				current: stored({ eventId: "evt-not-yet-valid", validAt: future }),
			},
			{ indexed: stored({ eventId: "evt-deleted" }), current: null },
		])
		expect(ids).toEqual(["evt-kept"])
	})

	it("keeps an event whose lifecycle fields are unset or still open", async () => {
		const clock = new Date()
		const { ids } = await claimSupport([
			hit("evt-open", CLAIM, {
				validAt: new Date(clock.getTime() - 3_600_000),
				invalidAt: new Date(clock.getTime() + 3_600_000),
				expiresAt: new Date(clock.getTime() + 3_600_000),
			}),
			hit("evt-null-invalid", CLAIM, { invalidAt: null }),
		])
		expect(ids.toSorted()).toEqual(["evt-null-invalid", "evt-open"])
	})

	it("never counts the event being promoted as its own corroboration", async () => {
		const { ids, promotable } = await claimSupport([])
		expect(ids).toEqual([])
		expect(promotable).toEqual([])
	})

	it("returns the three most recent verified events, newest first", async () => {
		const day = (n: number) => new Date(Date.UTC(2026, 2, n, 10))
		const { ids, promotable } = await claimSupport([
			hit("evt-d1", CLAIM, { timestamp: day(1) }),
			hit("evt-d5", CLAIM, { timestamp: day(5) }),
			hit("evt-d3", CLAIM, { timestamp: day(3) }),
			hit("evt-d4", CLAIM, { timestamp: day(4) }),
			hit("evt-d2", CLAIM, { timestamp: day(2) }),
		])
		expect(ids).toEqual(["evt-d5", "evt-d4", "evt-d3"])
		expect(promotable[0]?.reinforcementCount).toBe(4)
		expect(promotable[0]?.provenance).toMatchObject({
			promotionTrigger: "repeated-evidence",
			supportingEventCount: 3,
		})
	})

	it("applies the cap of three after verification, not before", async () => {
		const day = (n: number) => new Date(Date.UTC(2026, 2, n, 10))
		const { ids } = await claimSupport([
			hit("evt-new-1", "I said my favorite color is blue.", {
				timestamp: day(20),
			}),
			hit("evt-new-2", "My favorite color is blue and green.", {
				timestamp: day(19),
			}),
			hit("evt-new-3", "Note: My favorite color is blue.", {
				timestamp: day(18),
			}),
			hit("evt-old-1", CLAIM, { timestamp: day(3) }),
			hit("evt-old-2", CLAIM, { timestamp: day(2) }),
		])
		expect(ids).toEqual(["evt-old-1", "evt-old-2"])
	})

	it("examines a bounded window of Search candidates", async () => {
		const day = (n: number) => new Date(Date.UTC(2026, 0, n + 1, 10))
		const entries = Array.from({ length: 30 }, (_, index) =>
			hit(`evt-${index}`, CLAIM, { timestamp: day(index) }),
		)
		const { fake, ids } = await claimSupport(entries)
		const limit = fake.pipelines[0].find((step) => "$limit" in step)
		expect(limit).toEqual({ $limit: 25 })
		expect(ids).toEqual(["evt-24", "evt-23", "evt-22"])
	})

	it("does not search when the event being promoted is not itself the claim", async () => {
		const fake = stage([hit("evt-a", CLAIM)])
		const promotable = await resolveStructuredCandidatesForPromotion({
			db: fake.db,
			prefix: PREFIX,
			event: currentEvent("ok sounds good"),
			prefetchedLlmFacts: [CLAIM],
		})
		expect(promotable).toEqual([])
		expect(fake.pipelines).toEqual([])
	})
})

describe("supporting events for a plain value: $search text", () => {
	it("runs one $search text over body that requires every term", async () => {
		const { fake, ids } = await valueSupport([hit("evt-a", PREFERENCE)])
		expect(ids).toEqual(["evt-a"])
		expect(fake.findCalls).toEqual([])
		expect(fake.pipelines).toHaveLength(1)
		const search = fake.pipelines[0][0].$search as Document
		expect(search.index).toBe(INDEX)
		expect(search.compound.must).toEqual([
			{
				text: {
					query: "concise answers with direct tradeoffs.",
					path: "body",
					matchCriteria: "all",
				},
			},
		])
		expect(JSON.stringify(fake.pipelines)).not.toContain("$regex")
	})

	it("counts the value inside a longer statement, in any case", async () => {
		const { ids } = await valueSupport([
			hit(
				"evt-embedded",
				"Honestly I PREFER CONCISE ANSWERS WITH DIRECT TRADEOFFS.",
			),
			hit("evt-plain", PREFERENCE),
		])
		expect(ids.toSorted()).toEqual(["evt-embedded", "evt-plain"])
	})

	it("lets a Search hit corroborate nothing when the terms are scattered", async () => {
		const scattered = [
			hit(
				"evt-scattered",
				"Direct tradeoffs matter; concise answers with detail.",
			),
			hit("evt-comma", "I prefer concise answers, with direct tradeoffs."),
			hit("evt-reordered", "tradeoffs with direct answers concise"),
		]
		const { fake, ids, promotable } = await valueSupport(scattered)
		const proposed = await fake.collection
			.aggregate([fake.pipelines[0][0]])
			.toArray()
		expect(proposed.map((doc) => doc.eventId).toSorted()).toEqual([
			"evt-comma",
			"evt-current",
			"evt-reordered",
			"evt-scattered",
		])
		expect(ids).toEqual([])
		expect(promotable).toEqual([])
	})

	it("does not match a body that lacks a term", async () => {
		const { fake, ids } = await valueSupport([
			hit("evt-missing", "I prefer concise answers with tradeoffs."),
			hit("evt-near", "I prefer concise answer with direct tradeoffs."),
		])
		const proposed = await fake.collection
			.aggregate([fake.pipelines[0][0]])
			.toArray()
		expect(proposed.map((doc) => doc.eventId)).toEqual(["evt-current"])
		expect(ids).toEqual([])
	})

	it("never counts another agent, scope or scope reference, or an event invalidated after indexing", async () => {
		const clock = new Date()
		const { ids } = await valueSupport([
			hit("evt-mine", PREFERENCE),
			hit("evt-agent", PREFERENCE, { agentId: "agent-2" }),
			hit("evt-scope", PREFERENCE, { scope: "workspace" }),
			hit("evt-ref", PREFERENCE, { scopeRef: "agent:agent-2" }),
			{
				indexed: stored({ eventId: "evt-invalidated", body: PREFERENCE }),
				current: stored({
					eventId: "evt-invalidated",
					body: PREFERENCE,
					invalidAt: new Date(clock.getTime() - 60_000),
				}),
			},
			{
				indexed: stored({ eventId: "evt-edited", body: PREFERENCE }),
				current: stored({ eventId: "evt-edited", scopeRef: "agent:agent-2" }),
			},
		])
		expect(ids).toEqual(["evt-mine"])
	})

	it("returns the three most recent verified events, newest first", async () => {
		const day = (n: number) => new Date(Date.UTC(2026, 2, n, 10))
		const { ids } = await valueSupport([
			hit("evt-d1", PREFERENCE, { timestamp: day(1) }),
			hit("evt-d4", PREFERENCE, { timestamp: day(4) }),
			hit("evt-d2", PREFERENCE, { timestamp: day(2) }),
			hit("evt-d3", PREFERENCE, { timestamp: day(3) }),
		])
		expect(ids).toEqual(["evt-d4", "evt-d3", "evt-d2"])
	})
})

describe("supporting events never skip Search", () => {
	it("does not look anything up for an immediate promotion", async () => {
		const fake = stage([hit("evt-a", "the launch codeword is Blue Finch")])
		const promotable = await resolveStructuredCandidatesForPromotion({
			db: fake.db,
			prefix: PREFIX,
			event: currentEvent("Remember this: the launch codeword is Blue Finch."),
		})
		expect(promotable).toHaveLength(1)
		expect(fake.pipelines).toEqual([])
		expect(fake.findCalls).toEqual([])
	})

	it("types a Search failure and does not read it as 'no supporting events'", async () => {
		const fake = stage([], new Error("mongot unavailable"))
		const failure = await resolveStructuredCandidatesForPromotion({
			db: fake.db,
			prefix: PREFIX,
			event: currentEvent(PREFERENCE),
		}).catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({ stage: "atlas-search" })
		expect((failure as Error).message).not.toContain("mongot unavailable")
		expect(fake.pipelines).toHaveLength(1)
		expect(fake.findCalls).toEqual([])
	})

	it("fails the promotion preparation loudly when the lookup fails", async () => {
		const fake = stage([], new Error("mongot unavailable"))
		const failure = await prepareDerivedMemoryPromotion({
			db: fake.db,
			prefix: PREFIX,
			event: currentEvent(CLAIM),
			prefetchedLlmFacts: [CLAIM],
		}).catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(fake.findCalls).toEqual([])
	})
})

describe("supporting events check the job's index-health snapshot (#122 R2)", () => {
	it.each([
		{ damage: "STALE", patch: { status: "STALE" }, reason: "index-stale" },
		{ damage: "missing", patch: null, reason: "index-unavailable" },
	])("a $damage events text index fails the promotion decision typed and never runs the Search aggregate", async ({
		patch,
		reason,
	}) => {
		const fake = stage([
			{ indexed: stored({ eventId: "evt-current", body: PREFERENCE }) },
			hit("evt-a", PREFERENCE),
		])
		const health = createIndexHealthSource({
			prefix: PREFIX,
			patch: { events_text: patch },
		})

		const failure = await runWithIndexHealth(health, () =>
			resolveStructuredCandidatesForPromotion({
				db: fake.db,
				prefix: PREFIX,
				event: currentEvent(PREFERENCE),
			}),
		).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({ stage: "index-health", reason })
		expect(fake.pipelines).toEqual([])
	})

	it("a healthy events text index serves the lookup inside the snapshot", async () => {
		const fake = stage([
			{ indexed: stored({ eventId: "evt-current", body: PREFERENCE }) },
			hit("evt-a", PREFERENCE),
		])
		const health = createIndexHealthSource({ prefix: PREFIX })

		const promotable = await runWithIndexHealth(health, () =>
			resolveStructuredCandidatesForPromotion({
				db: fake.db,
				prefix: PREFIX,
				event: currentEvent(PREFERENCE),
			}),
		)

		expect(promotable[0]?.provenance?.supportingEventIds).toEqual(["evt-a"])
		expect(fake.pipelines).toHaveLength(1)
	})
})
