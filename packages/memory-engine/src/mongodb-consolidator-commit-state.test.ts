// M2 review D3: a consolidation run that fails after committing work reports
// what it committed on the typed error it throws. These tests run
// consolidateMemory against the stateful Mongo fake and inject collection-level
// failures, so the commit report is checked against the collection state the
// run really left behind.
//
// Stubbed seams (not collection accessors): the enrichment provider (none
// configured: the declared deterministic-only mode), the graph projection
// (its own suites cover it) and the novelty scan (switchable, for a failure
// before any write).
import type { Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { SearchLaneError } from "./search-outcomes.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	resolveEnrichmentProvider: () => null,
}))

vi.mock("./mongodb-graph.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	extractAndUpsertEntities: vi.fn(async () => ({
		entities: [],
		diagnostics: {
			durationMs: 1,
			extractionMethod: "regex",
			entitiesExtracted: 0,
			relationsCreated: 0,
		},
	})),
}))

const novelty = vi.hoisted(() => ({ failure: undefined as Error | undefined }))
vi.mock("./mongodb-novelty.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-novelty.js")>()
	return {
		...actual,
		scanNovelty: (params: Parameters<typeof actual.scanNovelty>[0]) => {
			if (novelty.failure) throw novelty.failure
			return actual.scanNovelty(params)
		},
	}
})

const PREFIX = "test_"
const AGENT = "agent-1"
const SCOPE_REF = `agent:${AGENT}`
const AGENT_GATE_KEY = '7:"agent-1"|0:""|0:""'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Fake = ReturnType<typeof createStatefulMongoFake>

function seedDecisionEvent(
	fake: Fake,
	eventId: string,
	body: string,
	timestamp: string,
) {
	return fake.collection("events").insertOne({
		eventId,
		agentId: AGENT,
		role: "user",
		body,
		scope: "agent",
		scopeRef: SCOPE_REF,
		timestamp: new Date(timestamp),
	})
}

function gateDoc(fake: Fake) {
	return fake.findDoc("consolidation_runs", { gateKey: AGENT_GATE_KEY })
}

async function failureOf(run: Promise<unknown>): Promise<Error> {
	try {
		await run
	} catch (err) {
		return err as Error
	}
	throw new Error("expected the consolidation run to fail")
}

function uncertainCommitError() {
	return Object.assign(new Error("commit result unknown"), {
		hasErrorLabel: (label: string) =>
			label === "UnknownTransactionCommitResult",
	})
}

beforeEach(() => {
	novelty.failure = undefined
})

describe("consolidation failures report their commit state (D3)", () => {
	it("a typed Search failure after a committed candidate keeps its type and carries the run identity and the committed work", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedDecisionEvent(
			fake,
			"evt-a",
			"We decided to use Biome for linting",
			"2026-08-03T10:00:00.000Z",
		)
		await seedDecisionEvent(
			fake,
			"evt-b",
			"We decided to use Vitest for testing",
			"2026-08-03T11:00:00.000Z",
		)
		const structured = fake.collection("structured_mem")
		const original = structured.aggregate.bind(structured)
		let probes = 0
		vi.spyOn(structured, "aggregate").mockImplementation((pipeline) => {
			const vector = pipeline[0]?.$vectorSearch as Document | undefined
			if (vector?.numCandidates !== 100) return original(pipeline)
			probes += 1
			if (probes === 1) return original(pipeline)
			throw new Error("owned similarity failure")
		})

		const failure = await failureOf(
			consolidateMemory({ db: fake.db, prefix: PREFIX, agentId: AGENT }),
		)

		// The typed failure and its fields are exactly what they were.
		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			name: "SearchLaneError",
			stage: "vector",
			reason: "internal-error",
		})
		// One candidate really committed; the other did not.
		expect(fake.all("structured_mem")).toHaveLength(1)
		const acknowledged = fake
			.all("events")
			.filter((event) => event.dreamerProcessedAt !== undefined)
		expect(acknowledged).toHaveLength(1)
		// The failure says so, with the run's own identity.
		const gate = gateDoc(fake)
		expect(gate?.status).toBe("failed")
		expect(gate?.runId).toMatch(UUID)
		expect(failure).toHaveProperty("commitState", "committed")
		expect(failure).toHaveProperty("commit", {
			operation: "consolidate",
			runId: gate?.runId,
			eventsProcessed: 1,
			factsPromoted: 1,
			factsInferred: 0,
			factsMerged: 0,
			factsPruned: 0,
		})
	})

	it("a failure before any write reports none: the run committed nothing but its own row", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedDecisionEvent(
			fake,
			"evt-a",
			"We decided to use Biome for linting",
			"2026-08-03T10:00:00.000Z",
		)
		novelty.failure = new SearchLaneError({
			stage: "vector",
			reason: "dependency-unavailable",
		})

		const failure = await failureOf(
			consolidateMemory({ db: fake.db, prefix: PREFIX, agentId: AGENT }),
		)

		expect(failure).toBe(novelty.failure)
		expect(fake.all("structured_mem")).toHaveLength(0)
		expect(
			fake.findDoc("events", { eventId: "evt-a" })?.dreamerProcessedAt,
		).toBeUndefined()
		expect(failure).toHaveProperty("commitState", "none")
		expect(failure).toHaveProperty("commit", {
			operation: "consolidate",
			runId: gateDoc(fake)?.runId,
			eventsProcessed: 0,
			factsPromoted: 0,
			factsInferred: 0,
			factsMerged: 0,
			factsPruned: 0,
		})
	})

	it("a write whose commit outcome is uncertain reports unknown, never zero and never a rollback", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedDecisionEvent(
			fake,
			"evt-a",
			"We decided to use Biome for linting",
			"2026-08-03T10:00:00.000Z",
		)
		const uncertain = uncertainCommitError()
		fake.injectFailure({
			collection: "structured_mem",
			method: "updateOne",
			error: uncertain,
			times: 50,
		})

		const failure = await failureOf(
			consolidateMemory({ db: fake.db, prefix: PREFIX, agentId: AGENT }),
		)

		expect(failure).toBe(uncertain)
		expect(failure).toHaveProperty("commitState", "unknown")
		expect(failure).toHaveProperty("commit.operation", "consolidate")
		expect(failure).toHaveProperty("commit.runId", gateDoc(fake)?.runId)
	})

	it("an error that already states its own commit outcome keeps it", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedDecisionEvent(
			fake,
			"evt-a",
			"We decided to use Biome for linting",
			"2026-08-03T10:00:00.000Z",
		)
		novelty.failure = Object.assign(
			new SearchLaneError({ stage: "vector", reason: "internal-error" }),
			{ commitState: "unknown" },
		)

		const failure = await failureOf(
			consolidateMemory({ db: fake.db, prefix: PREFIX, agentId: AGENT }),
		)

		expect(failure).toHaveProperty("commitState", "unknown")
		expect(failure).not.toHaveProperty("commit")
	})

	it("a healthy run throws nothing and its result carries no commit report", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedDecisionEvent(
			fake,
			"evt-a",
			"We decided to use Biome for linting",
			"2026-08-03T10:00:00.000Z",
		)

		const result = await consolidateMemory({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(result.factsPromoted).toBe(1)
		expect(result).not.toHaveProperty("commitState")
	})
})
