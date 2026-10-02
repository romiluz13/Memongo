import type { Collection, Db, Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import {
	searchConversationEvidenceEvents,
	searchTemporalCoverageEvents,
	searchTurnEventsWithinSessions,
} from "./mongodb-search-lanes.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"

// Freshness revalidation — turn-event session + conversation-evidence lanes.
//
// The inline Search stages run against the INDEXED copy, which can lag a
// majority-committed mutation: a live platform probe reproduced stale index
// admissions after owner/scope mutation and after invalidation. Every lane
// therefore revalidates, post-stage and against the hydrated document:
//   1. the FULL request predicate (owner/scope/scopeRef/session), and
//   2. the lifecycle window (validAt/invalidAt/expiresAt).
// Clock contract: historical validity (validAt/invalidAt) is evaluated at
// the caller's questionDate when supplied; expiresAt is RETENTION and is
// always evaluated at wall-now so a historical question cannot revive data
// awaiting physical TTL deletion.
// These tests pin that contract behaviorally: every fixture carries a real
// agentId, and each case pairs an authorized positive control with a
// stale-admission negative control.

const CAPS: DetectedCapabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

// Bounded pipeline-aware mock: applies a pipeline's $match/$limit stages to
// the candidate set the way mongod would, limited to the operators these
// tests use (equality, null equality, $in, $and/$or, $exists, $lte/$gt).
// It simulates the probe scenario: the Search stage admits a STALE index
// copy of a mutated event; the post-stage $match on the hydrated document
// is the corrective.
function matchesFilter(doc: Document, filter: Document): boolean {
	return Object.entries(filter).every(([key, value]) => {
		if (key === "$and" && Array.isArray(value)) {
			return value.every((entry) => matchesFilter(doc, entry as Document))
		}
		if (key === "$or" && Array.isArray(value)) {
			return value.some((entry) => matchesFilter(doc, entry as Document))
		}
		if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			!(value instanceof Date)
		) {
			return Object.entries(value as Document).every(([op, operand]) => {
				switch (op) {
					case "$in":
						return (
							Array.isArray(operand) &&
							(operand as unknown[]).includes(doc[key])
						)
					case "$exists":
						return (doc[key] !== undefined) === operand
					case "$lte":
						return doc[key] <= operand
					case "$gt":
						return doc[key] > operand
					default:
						return false
				}
			})
		}
		// MQL null equality matches both explicit null and missing fields.
		if (value === null) {
			return doc[key] === null || doc[key] === undefined
		}
		return doc[key] === value
	})
}

function mockEventsCollection(
	candidates: Document[],
	options: { applyTextFilter?: boolean } = {},
): {
	col: Collection
	pipelines: Document[][]
	finds: Document[]
} {
	const pipelines: Document[][] = []
	const finds: Document[] = []
	const col = {
		aggregate: vi.fn((pipeline: Document[]) => {
			pipelines.push(pipeline)
			return {
				toArray: vi.fn(async () => {
					let docs = candidates
					for (const stage of pipeline) {
						// Opt-in native text semantics: a $search `must` text clause
						// matches when the body contains ANY query term (MongoDB text
						// OR semantics). Off by default so existing stale-index
						// simulations keep their admit-all Search stage.
						if (options.applyTextFilter && stage.$search) {
							const mustClauses = (stage.$search.compound?.must ??
								[]) as Document[]
							for (const clause of mustClauses) {
								const query = clause.text?.query
								const terms = (Array.isArray(query) ? query : [query]).filter(
									(term): term is string => typeof term === "string",
								)
								if (terms.length > 0) {
									docs = docs.filter((doc) => {
										const body =
											typeof doc.body === "string" ? doc.body.toLowerCase() : ""
										return terms.some((term) =>
											body.includes(term.toLowerCase()),
										)
									})
								}
							}
						}
						if (stage.$match) {
							docs = docs.filter((doc) => matchesFilter(doc, stage.$match))
						}
						if (typeof stage.$limit === "number") {
							docs = docs.slice(0, stage.$limit)
						}
					}
					return docs
				}),
			}
		}),
		find: vi.fn((filter: Document, findOptions?: Document) => {
			finds.push(filter)
			let docs = candidates.filter((doc) => matchesFilter(doc, filter))
			if (findOptions?.sort && typeof findOptions.sort === "object") {
				const [sortKey, sortDir] = Object.entries(
					findOptions.sort as Record<string, number>,
				)[0] ?? ["timestamp", 1]
				docs = [...docs].sort((left, right) => {
					const leftMs =
						left[sortKey] instanceof Date ? left[sortKey].getTime() : 0
					const rightMs =
						right[sortKey] instanceof Date ? right[sortKey].getTime() : 0
					return sortDir === -1 ? rightMs - leftMs : leftMs - rightMs
				})
			}
			if (typeof findOptions?.limit === "number") {
				docs = docs.slice(0, findOptions.limit)
			}
			return { toArray: vi.fn(async () => docs) }
		}),
	} as unknown as Collection
	return { col, pipelines, finds }
}

function mockDb(col: Collection): Db {
	return { collection: () => col } as unknown as Db
}

// Authorized positive-control baseline: every event the lanes may lawfully
// return carries the request's owner/scope/scopeRef/session identity.
function eventDoc(
	overrides: Partial<Document> & { eventId: string },
): Document {
	return {
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:test",
		sessionId: "s1",
		body: `body of ${overrides.eventId}`,
		role: "user",
		timestamp: new Date("2026-01-02T00:00:00.000Z"),
		invalidAt: null,
		score: 0.9,
		...overrides,
	}
}

const SESSION_PARAMS = {
	prefix: "mem_",
	query: "what did the user say",
	agentId: "agent-1",
	scope: "agent",
	scopeRef: "agent:test",
	sessionIds: ["s1"],
	maxResults: 5,
	numCandidates: 100,
	capabilities: CAPS,
	embeddingMode: "automated",
	queryEmbeddingModel: undefined,
} as const

describe("searchTurnEventsWithinSessions freshness revalidation", () => {
	it("reapplies the full request filter and the lifecycle window post-stage in BOTH lanes", async () => {
		const { col, pipelines } = mockEventsCollection([])
		const results = await searchTurnEventsWithinSessions({
			db: mockDb(col),
			...SESSION_PARAMS,
		})

		expect(results).toEqual([])
		expect(pipelines).toHaveLength(2)
		const [vectorPipeline, textPipeline] = pipelines
		expect(vectorPipeline[0]?.$vectorSearch).toBeDefined()
		expect(textPipeline[0]?.$search).toBeDefined()
		for (const pipeline of [vectorPipeline, textPipeline]) {
			// Presence, not clause-count shape: SOME post-stage $match carries
			// the request's owner/scope/scopeRef/session predicate values,
			// re-checked against the hydrated document.
			const fullFilterIndex = pipeline.findIndex(
				(stage) =>
					stage.$match !== undefined &&
					stage.$match.agentId === "agent-1" &&
					stage.$match.scope === "agent" &&
					stage.$match.scopeRef === "agent:test",
			)
			expect(fullFilterIndex).toBeGreaterThan(0)
			expect(pipeline[fullFilterIndex]?.$match?.sessionId).toEqual({
				$in: ["s1"],
			})
			// And a LATER post-stage $match carries the lifecycle window
			// (validity, non-invalidation, non-expiry).
			const lifecycleIndex = pipeline.findIndex(
				(stage) =>
					stage.$match !== undefined &&
					JSON.stringify(stage.$match).includes("validAt") &&
					JSON.stringify(stage.$match).includes("invalidAt") &&
					JSON.stringify(stage.$match).includes("expiresAt"),
			)
			expect(lifecycleIndex).toBeGreaterThan(fullFilterIndex)
		}
	})

	it("excludes stale admissions whose owner/scope or session drifted, keeping the authorized control", async () => {
		// The Search stages admit all three from stale index copies (the
		// indexed document still carries the pre-mutation identity); the
		// post-stage full-filter $match on the hydrated documents must drop
		// both drifted victims.
		const ownerScopeDrifted = eventDoc({
			eventId: "ev-owner-drift",
			agentId: "synthetic-b",
			scopeRef: "agent:other",
			score: 0.99,
		})
		const sessionDrifted = eventDoc({
			eventId: "ev-session-drift",
			sessionId: "s2",
			score: 0.98,
		})
		const control = eventDoc({ eventId: "ev-control" })
		const { col } = mockEventsCollection([
			ownerScopeDrifted,
			sessionDrifted,
			control,
		])
		const results = await searchTurnEventsWithinSessions({
			db: mockDb(col),
			...SESSION_PARAMS,
		})

		expect(results.map((result) => result.path)).toEqual(["events/ev-control"])
	})

	it("excludes a stale invalidated event when the clock defaults to wall-now (questionDate omitted)", async () => {
		// Hydrated current state: invalidated in the past. The indexed copy
		// still carries the pre-mutation (valid) values, so the Search
		// stages admit it; the lifecycle $match must not.
		const staleVictim = eventDoc({
			eventId: "ev-victim",
			body: "retracted claim still indexed as valid",
			role: "assistant",
			invalidAt: new Date("2026-09-05T00:00:00.000Z"),
			score: 0.99,
		})
		const freshControl = eventDoc({ eventId: "ev-control" })
		const { col } = mockEventsCollection([staleVictim, freshControl])
		const results = await searchTurnEventsWithinSessions({
			db: mockDb(col),
			...SESSION_PARAMS,
		})

		expect(results.map((result) => result.path)).toEqual(["events/ev-control"])
	})

	it("evaluates historical validity at the caller's questionDate while retention stays at wall-now", async () => {
		const questionDate = new Date("2026-01-10T00:00:00.000Z")
		// Retracted AFTER the question: invalid at wall-now, but VALID as of
		// the question. Admitted only when validity uses the question clock.
		const validAtQuestion = eventDoc({
			eventId: "ev-valid-at-question",
			invalidAt: new Date("2026-01-15T00:00:00.000Z"),
			score: 0.99,
		})
		// Retracted BEFORE the question: excluded under any clock.
		const invalidBeforeQuestion = eventDoc({
			eventId: "ev-invalid-before-question",
			invalidAt: new Date("2026-01-05T00:00:00.000Z"),
			score: 0.98,
		})
		// Historically valid but expired after the question and before
		// wall-now: retention must NOT honor the question clock — the turn
		// is awaiting physical TTL deletion.
		const expiredSinceQuestion = eventDoc({
			eventId: "ev-expired-since-question",
			expiresAt: new Date("2026-01-15T00:00:00.000Z"),
			score: 0.97,
		})
		const { col } = mockEventsCollection([
			validAtQuestion,
			invalidBeforeQuestion,
			expiredSinceQuestion,
		])
		const results = await searchTurnEventsWithinSessions({
			db: mockDb(col),
			...SESSION_PARAMS,
			questionDate,
		})

		expect(results.map((result) => result.path)).toEqual([
			"events/ev-valid-at-question",
		])
	})
})

// Temporal coverage lane: the native $search candidates and the direct
// session-expansion find historically carried NO lifecycle predicate, and
// the Search stage had no post-stage canonical revalidation. A real-Mongo
// before probe reproduced four leaks into BOTH the event results
// and the synthesized timeline: expired-since-question, invalid-before-
// question, future-valid native candidates, plus an expired neighbor that
// enters only through session expansion. Contract under test:
//   - native Search candidate filters are retained (and gain no role
//     constraint they never had);
//   - post-stage, canonical agentId/scope/scopeRef/timestamp AND the
//     lifecycle window are revalidated against the hydrated document before
//     limit/projection;
//   - the expansion find keeps owner/scope/scopeRef/sessionIds/role/
//     timestamp AND adds the lifecycle window;
//   - clocks: validity (validAt/invalidAt) at the caller's questionDate,
//     retention (expiresAt) at wall-now — an expired-since-question record
//     is awaiting physical TTL deletion and must not resurface.
const TEMPORAL_COVERAGE_PARAMS = {
	prefix: "mem_",
	query: "recent freshness",
	agentId: "agent-1",
	scope: "agent",
	scopeRef: "agent:test",
	maxResults: 20,
	capabilities: CAPS,
} as const
const TEMPORAL_QUESTION_DATE = new Date("2026-01-10T00:00:00.000Z")

function temporalEventDoc(
	overrides: Partial<Document> & { eventId: string },
): Document {
	return eventDoc({
		body: `freshness marker-${overrides.eventId}`,
		timestamp: new Date("2026-01-09T00:00:00.000Z"),
		invalidAt: null,
		...overrides,
	})
}

describe("searchTemporalCoverageEvents freshness revalidation", () => {
	it("revalidates canonical identity and lifecycle after the Search stage, before limit/projection", async () => {
		const callStart = new Date()
		const { col, pipelines, finds } = mockEventsCollection(
			[temporalEventDoc({ eventId: "anchor", sessionId: "s-anchor" })],
			{ applyTextFilter: true },
		)
		const results = await searchTemporalCoverageEvents({
			db: mockDb(col),
			...TEMPORAL_COVERAGE_PARAMS,
			questionDate: TEMPORAL_QUESTION_DATE,
		})
		const callEnd = new Date()

		expect(results.length).toBeGreaterThan(0)
		expect(pipelines).toHaveLength(1)
		const pipeline = pipelines[0] ?? []
		// Native Search candidate filters retained verbatim: identity equals +
		// timestamp range at the question clock, and NO role constraint on the
		// indexed candidates (the lane never had one).
		expect(pipeline[0]?.$search).toBeDefined()
		const compound = pipeline[0]?.$search?.compound as Document
		expect(compound.filter).toEqual([
			{ equals: { path: "agentId", value: "agent-1" } },
			{ equals: { path: "scope", value: "agent" } },
			{ equals: { path: "scopeRef", value: "agent:test" } },
			{ range: { path: "timestamp", lte: TEMPORAL_QUESTION_DATE } },
		])
		expect(JSON.stringify(pipeline[0]?.$search)).not.toContain('"role"')
		// Post-stage: SOME $match revalidates the canonical request predicate
		// (owner/scope/scopeRef/timestamp) against the hydrated document...
		const limitIndex = pipeline.findIndex(
			(stage) => typeof stage.$limit === "number",
		)
		const canonicalIndex = pipeline.findIndex(
			(stage) =>
				stage.$match !== undefined &&
				stage.$match.agentId === "agent-1" &&
				stage.$match.scope === "agent" &&
				stage.$match.scopeRef === "agent:test" &&
				(stage.$match.timestamp as { $lte?: Date })?.$lte?.getTime() ===
					TEMPORAL_QUESTION_DATE.getTime(),
		)
		expect(canonicalIndex).toBeGreaterThan(0)
		expect(canonicalIndex).toBeLessThan(limitIndex)
		// ...and a LATER $match carries the lifecycle window, still before
		// limit/projection.
		const lifecycleIndex = pipeline.findIndex(
			(stage) =>
				stage.$match !== undefined &&
				JSON.stringify(stage.$match).includes("validAt") &&
				JSON.stringify(stage.$match).includes("invalidAt") &&
				JSON.stringify(stage.$match).includes("expiresAt"),
		)
		expect(lifecycleIndex).toBeGreaterThan(canonicalIndex)
		expect(lifecycleIndex).toBeLessThan(limitIndex)
		const lifecycleMatch = pipeline[lifecycleIndex]?.$match as Document
		// Lifecycle clocks: validity arms at the question clock...
		const lifecycleArms = lifecycleMatch.$and as Document[]
		const validAtArm = lifecycleArms.find((arm) =>
			JSON.stringify(arm).includes("validAt"),
		)
		expect(JSON.stringify(validAtArm)).toContain(
			JSON.stringify(TEMPORAL_QUESTION_DATE),
		)
		// ...retention arm at wall-now, never at the question clock.
		const expiryArm = lifecycleArms.find((arm) =>
			JSON.stringify(arm).includes("expiresAt"),
		)
		const expiryGt = (expiryArm?.$or as Document[])?.[1]?.expiresAt?.$gt as
			| Date
			| undefined
		expect(expiryGt).toBeInstanceOf(Date)
		expect((expiryGt as Date).getTime()).toBeGreaterThanOrEqual(
			callStart.getTime(),
		)
		expect((expiryGt as Date).getTime()).toBeLessThanOrEqual(callEnd.getTime())
		expect((expiryGt as Date).getTime()).not.toBe(
			TEMPORAL_QUESTION_DATE.getTime(),
		)
		// The session-expansion find fired (the anchor's session) and carries
		// the retained canonical constraints plus the lifecycle window.
		expect(finds).toHaveLength(1)
		const findFilter = finds[0] ?? {}
		const findArms = (findFilter.$and ?? [findFilter]) as Document[]
		const findCanonical = findArms.find((arm) => arm.agentId === "agent-1")
		expect(findCanonical).toMatchObject({
			scope: "agent",
			scopeRef: "agent:test",
			role: "user",
			timestamp: { $lte: TEMPORAL_QUESTION_DATE },
		})
		expect(findCanonical?.sessionId).toEqual({ $in: ["s-anchor"] })
		const findLifecycle = findArms.find((arm) =>
			JSON.stringify(arm).includes("expiresAt"),
		)
		expect(findLifecycle).toBeDefined()
		const findExpiryGt = (findLifecycle?.$or as Document[])?.[1]?.expiresAt
			?.$gt as Date | undefined
		expect(findExpiryGt).toBeInstanceOf(Date)
		expect((findExpiryGt as Date).getTime()).not.toBe(
			TEMPORAL_QUESTION_DATE.getTime(),
		)
	})

	it("excludes expired/invalid/future-valid and drifted stale admissions, keeping authorized and historical controls", async () => {
		// Fixture matrix: the Search stage
		// admits every "freshness" candidate from stale index copies; the
		// post-stage revalidation is the corrective. The historical control
		// is invalid NOW (invalidAt after the question, before wall-now) but
		// valid as of the question and unexpired — it must remain usable.
		const candidates = [
			temporalEventDoc({ eventId: "anchor", sessionId: "s-anchor" }),
			temporalEventDoc({
				eventId: "historical-control",
				sessionId: "s-historical",
				invalidAt: new Date("2026-01-15T00:00:00.000Z"),
			}),
			temporalEventDoc({
				eventId: "native-expired",
				sessionId: "s-expired",
				expiresAt: new Date("2026-01-15T00:00:00.000Z"),
			}),
			temporalEventDoc({
				eventId: "native-invalid",
				sessionId: "s-invalid",
				invalidAt: new Date("2026-01-05T00:00:00.000Z"),
			}),
			temporalEventDoc({
				eventId: "native-future-valid",
				sessionId: "s-future",
				validAt: new Date("2026-01-15T00:00:00.000Z"),
			}),
			temporalEventDoc({
				eventId: "foreign",
				sessionId: "s-anchor",
				agentId: "synthetic-b",
				scopeRef: "agent:other",
			}),
			temporalEventDoc({
				eventId: "future-timestamp",
				sessionId: "s-anchor",
				timestamp: new Date("2026-01-20T00:00:00.000Z"),
			}),
		]
		const { col } = mockEventsCollection(candidates, { applyTextFilter: true })
		const results = await searchTemporalCoverageEvents({
			db: mockDb(col),
			...TEMPORAL_COVERAGE_PARAMS,
			questionDate: TEMPORAL_QUESTION_DATE,
		})

		const paths = results.map((result) => result.path)
		expect(paths).toContain("events/anchor")
		expect(paths).toContain("events/historical-control")
		for (const victim of [
			"native-expired",
			"native-invalid",
			"native-future-valid",
			"foreign",
			"future-timestamp",
		]) {
			expect(paths).not.toContain(`events/${victim}`)
		}
		// The synthesized timeline evidence must not carry the victims either.
		const timeline = results.find(
			(result) => result.provenance?.temporalTimeline === true,
		)
		expect(timeline).toBeDefined()
		expect(timeline?.sourceEventIds).toEqual(
			expect.arrayContaining(["anchor", "historical-control"]),
		)
		for (const victim of [
			"native-expired",
			"native-invalid",
			"native-future-valid",
			"foreign",
			"future-timestamp",
		]) {
			expect(timeline?.sourceEventIds ?? []).not.toContain(victim)
			expect(timeline?.snippet).not.toContain(`marker-${victim}`)
		}
	})

	it("session expansion keeps owner/scope/session/role/timestamp constraints and does not reintroduce expired, invalid, or future-valid records", async () => {
		// The expansion-only fixtures carry NO query term in their bodies, so
		// they cannot be native Search candidates — any appearance in results
		// or timeline evidence arrives through the session-expansion find.
		// Each lifecycle victim sits in its OWN expanded session as the
		// earliest-timestamp doc, so the lane's `sessionDocs[0]` pick admits
		// every one of them pre-fix (maxPerSession would otherwise cut the
		// zero-score ties and make the absence assertions non-discriminating).
		const candidates = [
			temporalEventDoc({ eventId: "anchor", sessionId: "s-anchor" }),
			temporalEventDoc({ eventId: "anchor-b", sessionId: "s-other" }),
			temporalEventDoc({ eventId: "anchor-c", sessionId: "s-third" }),
			temporalEventDoc({
				eventId: "expansion-expired",
				sessionId: "s-anchor",
				body: "orchard marker-expansion-expired",
				timestamp: new Date("2026-01-08T00:00:00.000Z"),
				expiresAt: new Date("2026-01-15T00:00:00.000Z"),
			}),
			temporalEventDoc({
				eventId: "expansion-invalid",
				sessionId: "s-other",
				body: "orchard marker-expansion-invalid",
				timestamp: new Date("2026-01-08T00:00:00.000Z"),
				invalidAt: new Date("2026-01-05T00:00:00.000Z"),
			}),
			temporalEventDoc({
				eventId: "expansion-future-valid",
				sessionId: "s-third",
				body: "orchard marker-expansion-future-valid",
				timestamp: new Date("2026-01-08T00:00:00.000Z"),
				validAt: new Date("2026-01-15T00:00:00.000Z"),
			}),
			temporalEventDoc({
				eventId: "expansion-assistant",
				sessionId: "s-anchor",
				body: "orchard marker-expansion-assistant",
				timestamp: new Date("2026-01-08T00:00:00.000Z"),
				role: "assistant",
			}),
			temporalEventDoc({
				eventId: "expansion-wrong-session",
				sessionId: "s-elsewhere",
				body: "orchard marker-expansion-wrong-session",
				timestamp: new Date("2026-01-08T00:00:00.000Z"),
			}),
			temporalEventDoc({
				eventId: "expansion-future-timestamp",
				sessionId: "s-anchor",
				body: "orchard marker-expansion-future-timestamp",
				timestamp: new Date("2026-01-20T00:00:00.000Z"),
			}),
			// Positive control: a valid same-session neighbor IS expanded in.
			// Earliest timestamp in its session so the guaranteed pick holds.
			temporalEventDoc({
				eventId: "expansion-neighbor",
				sessionId: "s-anchor",
				body: "orchard valid neighbor",
				timestamp: new Date("2026-01-07T00:00:00.000Z"),
			}),
		]
		const { col, finds } = mockEventsCollection(candidates, {
			applyTextFilter: true,
		})
		const results = await searchTemporalCoverageEvents({
			db: mockDb(col),
			...TEMPORAL_COVERAGE_PARAMS,
			questionDate: TEMPORAL_QUESTION_DATE,
		})

		const paths = results.map((result) => result.path)
		expect(paths).toContain("events/anchor")
		expect(paths).toContain("events/anchor-b")
		expect(paths).toContain("events/anchor-c")
		// Positive control: a valid same-session neighbor IS expanded in.
		expect(paths).toContain("events/expansion-neighbor")
		for (const victim of [
			"expansion-expired",
			"expansion-invalid",
			"expansion-future-valid",
			"expansion-assistant",
			"expansion-wrong-session",
			"expansion-future-timestamp",
		]) {
			expect(paths).not.toContain(`events/${victim}`)
		}
		// The find actually ran against the expanded sessions.
		expect(finds.length).toBeGreaterThan(0)
		const findFilter = finds[0] ?? {}
		const findArms = (findFilter.$and ?? [findFilter]) as Document[]
		const findCanonical = findArms.find((arm) => arm.agentId === "agent-1")
		expect(findCanonical?.role).toBe("user")
		expect(findCanonical?.sessionId).toEqual({
			$in: expect.arrayContaining(["s-anchor", "s-other"]),
		})
		// Timeline evidence stays clean of every expansion-only victim.
		const timeline = results.find(
			(result) => result.provenance?.temporalTimeline === true,
		)
		expect(timeline).toBeDefined()
		for (const victim of [
			"expansion-expired",
			"expansion-invalid",
			"expansion-future-valid",
			"expansion-assistant",
			"expansion-wrong-session",
			"expansion-future-timestamp",
		]) {
			expect(timeline?.sourceEventIds ?? []).not.toContain(victim)
			expect(timeline?.snippet).not.toContain(`marker-${victim}`)
		}
	})
})

describe("searchConversationEvidenceEvents freshness revalidation", () => {
	it("excludes owner/scope-mutated stale admissions and keeps the authorized control", async () => {
		const ownerScopeDrifted = eventDoc({
			eventId: "ev-owner-drift",
			agentId: "synthetic-b",
			scopeRef: "agent:other",
			score: 0.99,
		})
		const control = eventDoc({ eventId: "ev-control" })
		const { col, pipelines } = mockEventsCollection([
			ownerScopeDrifted,
			control,
		])
		const results = await searchConversationEvidenceEvents({
			db: mockDb(col),
			prefix: "mem_",
			query: "we discussed the plan",
			questionDate: undefined,
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:test",
			maxResults: 5,
			numCandidates: 100,
			capabilities: CAPS,
			embeddingMode: "automated",
			queryEmbeddingModel: undefined,
		})

		expect(results.map((result) => result.path)).toEqual(["events/ev-control"])
		// Both evidence lanes ran and carry the same post-stage revalidation.
		expect(pipelines).toHaveLength(2)
		expect(pipelines[0]?.[0]?.$vectorSearch).toBeDefined()
		expect(pipelines[1]?.[0]?.$search).toBeDefined()
	})
})
