// P4.2 stateful consolidator-gate tests. mongodb-consolidator.test.ts mocks
// the collection accessors; these tests run consolidateMemory against the
// stateful Mongo fake with seeded events / structured_mem documents and
// assert post-run collection STATE: the gate lease document, dreamer-process
// markers, promoted/invalidated/pruned facts with provenance.
//
// Stubbed seams (not collection accessors):
//   - resolveEnrichmentProvider → a deterministic in-test LLM (no network);
//     contradiction detection, merge adjudication, and deduction/induction
//     all route through it.
//   - extractAndUpsertEntities (Phase 2.5 side effect; graph subsystem has
//     its own suites).
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Document } from "mongodb"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

// ---------------------------------------------------------------------------
// Deterministic LLM provider. Routes on the system prompt: contradiction
// detection returns the test-programmed findings, merge adjudication never
// merges (P4.4.3 is off by default anyway), deduction/induction infer
// nothing. Every response is valid JSON in the shape the caller parses.
// ---------------------------------------------------------------------------
const llmState = {
	contradictions: [] as Array<{ key: string; rationale: string }>,
}

vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		resolveEnrichmentProvider: () => ({
			name: "stateful-fake-llm",
			chatCompletion: async (params: {
				messages: Array<{ role: string; content: string }>
			}) => {
				const system = params.messages
					.filter((message) => message.role === "system")
					.map((message) => message.content)
					.join("\n")
				if (system.includes("detect direct contradictions")) {
					return {
						content: JSON.stringify({
							contradictions: llmState.contradictions.map((finding) => ({
								key: finding.key,
								rationale: finding.rationale,
							})),
						}),
					}
				}
				if (system.includes("should be merged into one")) {
					return { content: JSON.stringify({ verdict: "NO_MERGE" }) }
				}
				return { content: JSON.stringify({ facts: [] }) }
			},
		}),
	}
})

vi.mock("./mongodb-graph.js", async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		extractAndUpsertEntities: vi.fn(async () => ({ entities: [] })),
	}
})

const PREFIX = "test_"
const AGENT = "agent-1"
const SCOPE_REF = `agent:${AGENT}`

function seedEvent(
	fake: ReturnType<typeof createStatefulMongoFake>,
	event: { eventId: string; body: string; timestamp?: Date; role?: string },
) {
	return fake.collection("events").insertOne({
		eventId: event.eventId,
		agentId: AGENT,
		role: event.role ?? "user",
		body: event.body,
		scope: "agent",
		scopeRef: SCOPE_REF,
		timestamp: event.timestamp ?? new Date("2026-08-03T10:00:00.000Z"),
	})
}

function seedFact(
	fake: ReturnType<typeof createStatefulMongoFake>,
	fact: {
		key: string
		value: string
		type?: string
		state?: string
		updatedAt?: Date
		sourceEventIds?: string[]
	},
) {
	const now = new Date("2026-08-01T00:00:00.000Z")
	return fake.collection("structured_mem").insertOne({
		agentId: AGENT,
		scope: "agent",
		scopeRef: SCOPE_REF,
		type: fact.type ?? "fact",
		key: fact.key,
		value: fact.value,
		state: fact.state ?? "active",
		revision: 1,
		embeddingStatus: "pending",
		sourceEventIds: fact.sourceEventIds ?? [],
		createdAt: now,
		updatedAt: fact.updatedAt ?? now,
		validFrom: now,
	})
}

// B7: the unscoped gate key for AGENT under the length-prefixed JSON tuple
// encoding (see consolidationGateKey in mongodb-consolidator.ts).
const AGENT_GATE_KEY = '7:"agent-1"|0:""|0:""'

function gateDoc(fake: ReturnType<typeof createStatefulMongoFake>) {
	return fake.findDoc("consolidation_runs", { gateKey: AGENT_GATE_KEY })
}

beforeEach(() => {
	llmState.contradictions = []
})

describe("consolidation gate + promotion — collection state", () => {
	it("claims the gate, promotes the pattern-matched fact, and marks every event dreamer-processed", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedEvent(fake, {
			eventId: "evt-decision",
			body: "We decided to use Biome for linting",
			timestamp: new Date("2026-08-03T10:00:00.000Z"),
		})
		await seedEvent(fake, {
			eventId: "evt-noise",
			body: "the rain in spain stays mainly on the plain",
			timestamp: new Date("2026-08-03T11:00:00.000Z"),
		})

		const result = await consolidateMemory({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(result.eventsProcessed).toBe(2)
		expect(result.factsPromoted).toBe(1)

		// --- structured_mem state: one promoted fact with full provenance ---
		const facts = fake.all("structured_mem")
		expect(facts).toHaveLength(1)
		const fact = facts[0]
		expect(fact.type).toBe("decision")
		expect(fact.key).toBe("to use Biome for linting")
		expect(fact.value).toBe("We decided to use Biome for linting")
		expect(fact.state).toBe("active")
		expect(fact.scope).toBe("agent")
		expect(fact.scopeRef).toBe(SCOPE_REF)
		expect(fact.sourceEventIds).toEqual(["evt-decision"])
		expect(fact.sourceAgent).toMatchObject({
			id: AGENT,
			name: "dreamer",
			runId: result.runId,
		})

		// --- events state: both acked with the run id ---
		const events = fake.all("events")
		for (const event of events) {
			expect(event.dreamerProcessedAt).toBeInstanceOf(Date)
			expect(event.dreamerRunId).toBe(result.runId)
		}

		// --- gate state: completed, lease released ---
		const gate = gateDoc(fake)
		expect(gate).not.toBeNull()
		expect(gate?.runId).toBe(result.runId)
		expect(gate?.status).toBe("completed")
		expect(gate?.eventsProcessed).toBe(2)
		expect(gate?.factsPromoted).toBe(1)
		expect(gate?.startedAt).toBeInstanceOf(Date)
		expect(gate?.completedAt).toBeInstanceOf(Date)
		expect(gate?.leaseToken).toBeUndefined()
		expect(gate?.leaseExpiresAt).toBeUndefined()

		// --- orient stats came from the real ($facet) aggregation ---
		expect(result.orientStats?.unprocessedCount).toBe(2)
		expect(result.orientStats?.byRole).toEqual([{ role: "user", count: 2 }])
	})

	it("rate-limits an immediate second run at the gate (unique gateKey, empty result)", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedEvent(fake, {
			eventId: "evt-1",
			body: "We decided to use Biome for linting",
		})

		const first = await consolidateMemory({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})
		const second = await consolidateMemory({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// The second claim collided on uq_consolidation_runs_gate: the run is
		// a no-op and the gate document still belongs to the first run.
		expect(second.eventsProcessed).toBe(0)
		expect(second.factsPromoted).toBe(0)
		expect(second.runId).not.toBe(first.runId)
		expect(fake.all("consolidation_runs")).toHaveLength(1)
		expect(gateDoc(fake)?.runId).toBe(first.runId)
		expect(gateDoc(fake)?.status).toBe("completed")
	})

	it("re-claims the gate when the previous holder's lease expired", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		// A crashed run: status running, lease long expired.
		await fake.collection("consolidation_runs").insertOne({
			gateKey: AGENT_GATE_KEY,
			agentId: AGENT,
			runId: "stale-run",
			status: "running",
			startedAt: new Date("2026-08-01T00:00:00.000Z"),
			leaseToken: "stale-token",
			leaseExpiresAt: new Date("2026-08-01T00:15:00.000Z"),
		})
		await seedEvent(fake, {
			eventId: "evt-1",
			body: "We decided to use Biome for linting",
		})

		const result = await consolidateMemory({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(result.eventsProcessed).toBe(1)
		// The expired lease self-healed: the gate doc was claimed by this run.
		expect(fake.all("consolidation_runs")).toHaveLength(1)
		expect(gateDoc(fake)?.runId).toBe(result.runId)
		expect(gateDoc(fake)?.status).toBe("completed")
		expect(gateDoc(fake)?.leaseToken).toBeUndefined()
	})
})

describe("NOOP gate — similarity decision against stored state", () => {
	it("does not promote a fact when an identical memory already exists", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedFact(fake, {
			key: "existing decision record",
			type: "decision",
			value: "We decided to use Biome for linting",
			sourceEventIds: ["evt-original"],
		})
		await seedEvent(fake, {
			eventId: "evt-repeat",
			body: "We decided to use Biome for linting",
		})

		const result = await consolidateMemory({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(result.factsPromoted).toBe(0)
		// No new fact written; the existing one is untouched.
		const facts = fake.all("structured_mem")
		expect(facts).toHaveLength(1)
		expect(facts[0].key).toBe("existing decision record")
		expect(facts[0].sourceEventIds).toEqual(["evt-original"])
		// The event was still processed (NOOP is a decision, not a failure).
		expect(
			fake.findDoc("events", { eventId: "evt-repeat" })?.dreamerRunId,
		).toBe(result.runId)
		expect(gateDoc(fake)?.status).toBe("completed")
	})
})

describe("P4.4.2 contradiction resolution — collection state", () => {
	it("invalidates the losing existing fact with provenance and promotes the winning candidate", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		// The conflicted same-key record that trips the hasConflict gate…
		await seedFact(fake, {
			key: "down after the deploy",
			value: "stale conflicted statement",
			state: "conflicted",
		})
		// …and the active different-key fact the candidate contradicts.
		await seedFact(fake, {
			key: "server status",
			value: "The server is up and healthy",
		})
		await seedEvent(fake, {
			eventId: "evt-outage",
			body: "The server is down after the deploy",
		})
		llmState.contradictions = [
			{
				key: "server status",
				rationale: "the server cannot be both up and down",
			},
		]

		const result = await consolidateMemory({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(result.conflictsResolved).toBe(1)
		expect(result.factsPromoted).toBe(1)

		// --- loser state: invalidated with contradiction provenance ---
		const loser = fake.findDoc("structured_mem", { key: "server status" })
		expect(loser?.state).toBe("invalidated")
		expect(loser?.validTo).toBeInstanceOf(Date)
		expect(loser?.revision).toBe(2)
		expect(loser?.invalidatedBy).toMatchObject({
			reason: "contradiction",
			byKey: "down after the deploy",
			byValue: "The server is down after the deploy",
			rationale: "the server cannot be both up and down",
		})

		// --- winner state: the candidate was re-evaluated and written ---
		const winner = fake.findDoc("structured_mem", {
			key: "down after the deploy",
		})
		expect(winner?.state).toBe("active")
		expect(winner?.value).toBe("The server is down after the deploy")
		expect(winner?.sourceEventIds).toContain("evt-outage")
		expect(winner?.revision).toBe(2)

		// --- revision history records the invalidation ---
		const revisions = fake.all("structured_mem_revisions")
		expect(revisions.length).toBeGreaterThanOrEqual(1)
		expect(
			revisions.some((revision: Document) => revision.key === "server status"),
		).toBe(true)

		const gate = gateDoc(fake)
		expect(gate?.status).toBe("completed")
		expect(gate?.conflictsResolved).toBe(1)
	})
})

describe("prune — near-duplicate merge against stored state", () => {
	it("invalidates the older near-duplicate and keeps the newer fact active", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		// An unprocessed event so the run reaches Phase 5 (matches no pattern).
		await seedEvent(fake, {
			eventId: "evt-noise",
			body: "the rain in spain stays mainly on the plain",
		})
		await seedFact(fake, {
			key: "deploy window",
			value: "the deploy window starts at 4pm",
			updatedAt: new Date("2026-07-01T00:00:00.000Z"),
		})
		await seedFact(fake, {
			key: "release window",
			value: "the deploy window starts at 4pm",
			updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		})

		const result = await consolidateMemory({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(result.factsPruned).toBe(1)
		expect(result.factsPromoted).toBe(0)

		// Older duplicate invalidated; newer fact survives.
		expect(
			fake.findDoc("structured_mem", { key: "deploy window" })?.state,
		).toBe("invalidated")
		expect(
			fake.findDoc("structured_mem", { key: "release window" })?.state,
		).toBe("active")

		// The pattern-less event was still acked as processed.
		expect(fake.findDoc("events", { eventId: "evt-noise" })?.dreamerRunId).toBe(
			result.runId,
		)
		expect(gateDoc(fake)?.factsPruned).toBe(1)
	})
})
