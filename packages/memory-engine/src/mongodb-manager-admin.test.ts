/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	classifyCanonicalIngestHealth,
	classifyProjectionHealth,
	classifyRetrievalHealth,
	computeOverallV2Health,
	getV2Status,
} from "./mongodb-manager.js"
import { MongoDBManagerAdminOps } from "./mongodb-manager-admin.js"
import { resolveMemoryJobBacklogAlertThreshold } from "./mongodb-manager-jobs.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { mocked, fakeDb, fakePrefix } from "./test-helpers/manager-test-kit.js"

vi.mock("./mongodb-schema-capabilities.js", () => ({
	probeSearchLaneReadiness: vi.fn(),
}))

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)

vi.mock("./mongodb-retrieval-planner.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).retrievalPlannerModuleMock(),
)

vi.mock("./mongodb-episodes.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
)

vi.mock("./mongodb-graph.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).graphModuleMock(),
)

vi.mock("./mongodb-schema.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).schemaModuleMock(),
)

vi.mock("./mongodb-schema-integrity.js", () => ({
	// WS-14 (C-024): the orphan checkers run at their own seam (their logic
	// is covered by mongodb-schema-integrity.test.ts). Defaults report zero
	// orphans so unconfigured tests stay complete; wiring tests override.
	checkRelationEntityOrphans: vi.fn(async () => ({
		orphanedRelationCount: 0,
		orphanedEntityIds: [],
	})),
	checkEntityLinkOrphans: vi.fn(async () => ({
		orphanedLinkCount: 0,
		orphanedEntityIds: [],
	})),
	checkChunkEventOrphans: vi.fn(async () => ({
		orphanedChunkCount: 0,
		orphanedEventIds: [],
	})),
	checkEpisodeEventOrphans: vi.fn(async () => ({
		orphanedEpisodeCount: 0,
		orphanedEventIds: [],
	})),
}))

vi.mock("./mongodb-query-cache.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).queryCacheModuleMock(),
)

vi.mock("./mongodb-query-rewriter.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).queryRewriterModuleMock(),
)

vi.mock("./mongodb-reranker.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).rerankerModuleMock(),
)

vi.mock("./mongodb-lane-coverage.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).laneCoverageModuleMock(),
)

vi.mock("./mongodb-memory-jobs.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).memoryJobsModuleMock(),
)

vi.mock("./mongodb-consolidator.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).consolidatorModuleMock(),
)

vi.mock("./mongodb-derived-memory.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).derivedMemoryModuleMock(),
)

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

const { getLatestIngestRun, getLatestProjectionRun, getProjectionLag } =
	await import("./mongodb-ops.js")
const {
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	episodesCollection,
	proceduresCollection,
	relevanceRunsCollection,
	chunksCollection,
	memoryJobsCollection,
	entityLinksCollection,
} = await import("./mongodb-schema.js")
const {
	checkRelationEntityOrphans,
	checkEntityLinkOrphans,
	checkChunkEventOrphans,
	checkEpisodeEventOrphans,
} = await import("./mongodb-schema-integrity.js")
const { probeSearchLaneReadiness } = await import(
	"./mongodb-schema-capabilities.js"
)
const { getLaneCoverage } = await import("./mongodb-lane-coverage.js")

// ---------------------------------------------------------------------------
// 8.3: getV2Status
// ---------------------------------------------------------------------------

describe("v2 health classification helpers", () => {
	it("classifies ingest health from the latest ingest run", () => {
		expect(classifyCanonicalIngestHealth(null)).toBe("health-uncertain")
		expect(classifyCanonicalIngestHealth({ status: "ok" })).toBe("ok")
		expect(classifyCanonicalIngestHealth({ status: "failed" })).toBe(
			"canonical-ingest-failed",
		)
	})

	it("classifies projection health from latest run and lag", () => {
		expect(
			classifyProjectionHealth({ latestRun: null, lagSeconds: null }),
		).toBe("health-uncertain")
		expect(
			classifyProjectionHealth({
				latestRun: { status: "failed" },
				lagSeconds: null,
			}),
		).toBe("derived-product-unavailable")
		expect(
			classifyProjectionHealth({
				latestRun: { status: "ok" },
				lagSeconds: 601,
			}),
		).toBe("projection-behind")
		expect(
			classifyProjectionHealth({ latestRun: { status: "ok" }, lagSeconds: 12 }),
		).toBe("ok")
	})

	it("distinguishes degraded retrieval from no relevant results", () => {
		expect(classifyRetrievalHealth({ status: null, hitSources: null })).toEqual(
			{
				state: "health-uncertain",
				recentNoRelevantResults: false,
			},
		)
		expect(
			classifyRetrievalHealth({ status: "ok", hitSources: ["conversation"] }),
		).toEqual({
			state: "ok",
			recentNoRelevantResults: false,
		})
		expect(
			classifyRetrievalHealth({ status: "degraded", hitSources: [] }),
		).toEqual({
			state: "retrieval-degraded",
			recentNoRelevantResults: true,
		})
	})

	it("computes the overall status from retrieval, ingest, and derived-product states", () => {
		expect(
			computeOverallV2Health({
				retrieval: "ok",
				canonicalIngest: "ok",
				derivedProducts: ["ok", "ok"],
			}),
		).toBe("ok")
		expect(
			computeOverallV2Health({
				retrieval: "retrieval-degraded",
				canonicalIngest: "ok",
				derivedProducts: ["ok", "ok"],
			}),
		).toBe("degraded")
		expect(
			computeOverallV2Health({
				retrieval: "ok",
				canonicalIngest: "health-uncertain",
				derivedProducts: ["ok", "ok"],
			}),
		).toBe("health-uncertain")
	})
})

// Covered by real v2 status checks in the live MongoDB gate. This unit block
// still assumes a stale module-mock seam.
describe("getV2Status", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns counts, projection lag, and retrieval paths", async () => {
		const latestDate = new Date("2026-03-15T12:00:00Z")

		const mockCountDocuments = vi.fn().mockResolvedValue(42)
		const eventCol = {
			countDocuments: mockCountDocuments,
			findOne: vi.fn().mockResolvedValue({ timestamp: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const derivedCol = {
			countDocuments: mockCountDocuments,
			findOne: vi.fn().mockResolvedValue({ updatedAt: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const relevanceCol = {
			findOne: vi.fn().mockResolvedValue({ status: "ok", hitSources: ["kb"] }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>

		mocked(eventsCollection).mockReturnValue(eventCol)
		mocked(entitiesCollection).mockReturnValue(derivedCol)
		mocked(relationsCollection).mockReturnValue(derivedCol)
		mocked(episodesCollection).mockReturnValue(derivedCol)
		mocked(proceduresCollection).mockReturnValue(derivedCol)
		mocked(relevanceRunsCollection).mockReturnValue(relevanceCol)

		mocked(getProjectionLag)
			.mockResolvedValueOnce(10) // chunks lag
			.mockResolvedValueOnce(20) // entities lag
			.mockResolvedValueOnce(30) // relations lag
			.mockResolvedValueOnce(null) // episodes lag (no data)
			.mockResolvedValueOnce(40) // structured lag
			.mockResolvedValueOnce(50) // procedures lag

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		expect(status.events.count).toBe(42)
		expect(status.events.latestTimestamp).toEqual(latestDate)
		expect(status.entities.count).toBe(42)
		expect(status.relations.count).toBe(42)
		expect(status.episodes.count).toBe(42)
		expect(status.procedures.count).toBe(42)
		expect(status.projectionLag.chunks).toBe(10)
		expect(status.projectionLag.entities).toBe(20)
		expect(status.projectionLag.relations).toBe(30)
		expect(status.projectionLag.episodes).toBeNull()
		expect(status.retrievalPaths).toEqual(
			expect.arrayContaining([
				"structured",
				"raw-window",
				"graph",
				"hybrid",
				"kb",
				"episodic",
			]),
		)
	})

	it("surfaces job counts including dead letters (WS-13)", async () => {
		const latestDate = new Date("2026-03-15T12:00:00Z")
		const eventCol = {
			countDocuments: vi.fn().mockResolvedValue(1),
			findOne: vi.fn().mockResolvedValue({ timestamp: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const derivedCol = {
			countDocuments: vi.fn().mockResolvedValue(1),
			findOne: vi.fn().mockResolvedValue({ updatedAt: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const relevanceCol = {
			findOne: vi.fn().mockResolvedValue({ status: "ok", hitSources: ["kb"] }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		// Dispatch counts by filter: pending 2, running 1, budget-left failed 4,
		// dead-lettered 3.
		const jobsCol = {
			countDocuments: vi.fn(async (filter: Record<string, unknown>) => {
				switch (filter.status) {
					case "pending":
						return 2
					case "running":
						return 1
					case "failed":
						return 4
					default:
						// Dead-letter query: no status, deadLetterAt $exists true.
						return 3
				}
			}),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>

		mocked(eventsCollection).mockReturnValue(eventCol)
		mocked(entitiesCollection).mockReturnValue(derivedCol)
		mocked(relationsCollection).mockReturnValue(derivedCol)
		mocked(episodesCollection).mockReturnValue(derivedCol)
		mocked(proceduresCollection).mockReturnValue(derivedCol)
		mocked(relevanceRunsCollection).mockReturnValue(relevanceCol)
		mocked(memoryJobsCollection).mockReturnValue(jobsCol)
		mocked(getProjectionLag).mockResolvedValue(10)

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		// Dead letters are counted separately from failures that still have
		// attempt budget, so an operator can see them and requeue or drop
		// them deliberately. WS-11: backlogAlert derives from these counts —
		// depth = pending + running (3 here) vs the configured threshold.
		expect(status.memoryJobs).toEqual({
			pending: 2,
			running: 1,
			failed: 4,
			deadLettered: 3,
			backlogAlert: {
				depth: 3,
				threshold: resolveMemoryJobBacklogAlertThreshold(),
				triggered: false,
			},
		})
		// The dead-letter count is its own filter, not a status match.
		expect(jobsCol.countDocuments).toHaveBeenCalledWith({
			agentId: "agent-1",
			deadLetterAt: { $exists: true },
		})
		expect(jobsCol.countDocuments).toHaveBeenCalledWith({
			agentId: "agent-1",
			status: "failed",
			deadLetterAt: { $exists: false },
		})
	})

	it.each([
		"structured-promotion",
		"procedures",
	] as const)("includes %s health when computing overall health", async (failedProjection) => {
		const collection = {
			countDocuments: vi.fn().mockResolvedValue(1),
			findOne: vi.fn().mockResolvedValue({ updatedAt: new Date() }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const eventCollection = {
			countDocuments: vi.fn().mockResolvedValue(1),
			findOne: vi.fn().mockResolvedValue({ timestamp: new Date() }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const relevanceCollection = {
			findOne: vi
				.fn()
				.mockResolvedValue({ status: "ok", hitSources: ["structured"] }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>

		mocked(eventsCollection).mockReturnValue(eventCollection)
		mocked(entitiesCollection).mockReturnValue(collection)
		mocked(relationsCollection).mockReturnValue(collection)
		mocked(episodesCollection).mockReturnValue(collection)
		mocked(proceduresCollection).mockReturnValue(collection)
		mocked(relevanceRunsCollection).mockReturnValue(relevanceCollection)
		mocked(getProjectionLag).mockResolvedValue(10)
		mocked(getLatestIngestRun).mockResolvedValue({
			status: "ok",
		} as Awaited<ReturnType<typeof getLatestIngestRun>>)
		mocked(getLatestProjectionRun).mockImplementation(
			async ({ projectionType }) =>
				({
					status: projectionType === failedProjection ? "failed" : "ok",
				}) as Awaited<ReturnType<typeof getLatestProjectionRun>>,
		)

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		expect(status.health.derivedProducts[failedProjection]).toBe(
			"derived-product-unavailable",
		)
		expect(status.health.overall).toBe("degraded")
	})

	it("returns partial results when some queries fail (Promise.allSettled)", async () => {
		// Events collection works, but entities/relations/episodes reject
		const workingCol = {
			countDocuments: vi.fn().mockResolvedValue(10),
			findOne: vi
				.fn()
				.mockResolvedValue({ timestamp: new Date("2026-03-15T12:00:00Z") }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const failingCol = {
			countDocuments: vi.fn().mockRejectedValue(new Error("connection lost")),
			findOne: vi.fn().mockRejectedValue(new Error("connection lost")),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>

		mocked(eventsCollection).mockReturnValue(workingCol)
		mocked(entitiesCollection).mockReturnValue(failingCol)
		mocked(relationsCollection).mockReturnValue(failingCol)
		mocked(episodesCollection).mockReturnValue(failingCol)
		mocked(proceduresCollection).mockReturnValue(failingCol)
		mocked(relevanceRunsCollection).mockReturnValue(failingCol)

		mocked(getProjectionLag)
			.mockResolvedValueOnce(5) // chunks lag works
			.mockRejectedValueOnce(new Error("timeout")) // entities lag fails
			.mockResolvedValueOnce(15) // relations lag works
			.mockRejectedValueOnce(new Error("timeout")) // episodes lag fails
			.mockRejectedValueOnce(new Error("timeout")) // structured lag fails
			.mockRejectedValueOnce(new Error("timeout")) // procedures lag fails

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		// Working values preserved
		expect(status.events.count).toBe(10)
		expect(status.events.latestTimestamp).toEqual(
			new Date("2026-03-15T12:00:00Z"),
		)
		expect(status.projectionLag.chunks).toBe(5)
		expect(status.projectionLag.relations).toBe(15)

		// Failed values default to safe fallbacks
		expect(status.entities.count).toBe(0)
		expect(status.relations.count).toBe(0)
		expect(status.episodes.count).toBe(0)
		expect(status.procedures.count).toBe(0)
		expect(status.projectionLag.entities).toBeNull()
		expect(status.projectionLag.episodes).toBeNull()
		expect(status.health.dataCompleteness).toBe("partial")
		expect(status.health.failedChecks).toEqual(
			expect.arrayContaining([
				"entities.count",
				"projectionLag.entities",
				"episodes.latestTimestamp",
			]),
		)
	})

	it("surfaces referential-integrity orphan counts per relation type (WS-14)", async () => {
		const latestDate = new Date("2026-03-15T12:00:00Z")
		const workingCountCol = {
			countDocuments: vi.fn().mockResolvedValue(7),
			findOne: vi.fn().mockResolvedValue({ timestamp: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const relevanceCol = {
			findOne: vi
				.fn()
				.mockResolvedValue({ status: "ok", hitSources: ["graph"] }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		// Checker-facing collections double as working count surfaces where
		// the status also queries them (relations, episodes); entity_links
		// and chunks only feed the checkers, so bare markers suffice.
		const relCol = {
			countDocuments: vi.fn().mockResolvedValue(7),
		} as unknown as import("mongodb").Collection
		const linkCol = {} as unknown as import("mongodb").Collection
		const chunkCol = {} as unknown as import("mongodb").Collection
		const episodeCol = {
			countDocuments: vi.fn().mockResolvedValue(7),
			findOne: vi.fn().mockResolvedValue({ updatedAt: latestDate }),
		} as unknown as import("mongodb").Collection

		mocked(eventsCollection).mockReturnValue(workingCountCol)
		mocked(entitiesCollection).mockReturnValue(workingCountCol)
		mocked(proceduresCollection).mockReturnValue(workingCountCol)
		mocked(relevanceRunsCollection).mockReturnValue(relevanceCol)
		mocked(relationsCollection).mockReturnValue(relCol)
		mocked(episodesCollection).mockReturnValue(episodeCol)
		mocked(chunksCollection).mockReturnValue(chunkCol)
		mocked(entityLinksCollection).mockReturnValue(linkCol)
		mocked(getProjectionLag).mockResolvedValue(10)

		mocked(checkRelationEntityOrphans).mockResolvedValueOnce({
			orphanedRelationCount: 3,
			orphanedEntityIds: ["ent-gone"],
		})
		mocked(checkEntityLinkOrphans).mockResolvedValueOnce({
			orphanedLinkCount: 2,
			orphanedEntityIds: ["ent-gone"],
		})
		mocked(checkChunkEventOrphans).mockResolvedValueOnce({
			orphanedChunkCount: 5,
			orphanedEventIds: ["ev-gone"],
		})
		mocked(checkEpisodeEventOrphans).mockResolvedValueOnce({
			orphanedEpisodeCount: 1,
			orphanedEventIds: ["ev-gone"],
		})

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		expect(status.referentialIntegrity).toEqual({
			relations: {
				orphanedRelationCount: 3,
				orphanedEntityIds: ["ent-gone"],
			},
			entityLinks: {
				orphanedLinkCount: 2,
				orphanedEntityIds: ["ent-gone"],
			},
			chunks: { orphanedChunkCount: 5, orphanedEventIds: ["ev-gone"] },
			episodes: { orphanedEpisodeCount: 1, orphanedEventIds: ["ev-gone"] },
		})
		// Each checker runs agent-scoped against the collections it owns.
		expect(checkRelationEntityOrphans).toHaveBeenCalledWith(
			relCol,
			workingCountCol,
			"agent-1",
		)
		expect(checkEntityLinkOrphans).toHaveBeenCalledWith(
			linkCol,
			workingCountCol,
			"agent-1",
		)
		expect(checkChunkEventOrphans).toHaveBeenCalledWith(
			chunkCol,
			workingCountCol,
			"agent-1",
		)
		expect(checkEpisodeEventOrphans).toHaveBeenCalledWith(
			episodeCol,
			workingCountCol,
			"agent-1",
		)
		// Everything answered: the status stays complete.
		expect(status.health.dataCompleteness).toBe("complete")
	})

	it("falls back to zero orphans and flags the failed check when an integrity query rejects (WS-14)", async () => {
		const latestDate = new Date("2026-03-15T12:00:00Z")
		const workingCountCol = {
			countDocuments: vi.fn().mockResolvedValue(3),
			findOne: vi.fn().mockResolvedValue({ timestamp: latestDate }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		const relevanceCol = {
			findOne: vi.fn().mockResolvedValue({ status: "ok", hitSources: [] }),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>

		mocked(eventsCollection).mockReturnValue(workingCountCol)
		mocked(entitiesCollection).mockReturnValue(workingCountCol)
		mocked(relationsCollection).mockReturnValue(workingCountCol)
		mocked(episodesCollection).mockReturnValue(workingCountCol)
		mocked(proceduresCollection).mockReturnValue(workingCountCol)
		mocked(relevanceRunsCollection).mockReturnValue(relevanceCol)
		mocked(getProjectionLag).mockResolvedValue(10)

		mocked(checkRelationEntityOrphans).mockRejectedValueOnce(
			new Error("cursor timeout"),
		)

		const status = await getV2Status(fakeDb, fakePrefix, "agent-1")

		// The rejected check falls back to zero counts — never mistaken for
		// "verified clean", because its label lands in failedChecks.
		expect(status.referentialIntegrity?.relations).toEqual({
			orphanedRelationCount: 0,
			orphanedEntityIds: [],
		})
		expect(status.health.failedChecks).toContain(
			"referentialIntegrity.relations",
		)
		expect(status.health.dataCompleteness).toBe("partial")
		// The other three checkers still report through the defaults.
		expect(status.referentialIntegrity?.entityLinks).toEqual({
			orphanedLinkCount: 0,
			orphanedEntityIds: [],
		})
	})
})

// ---------------------------------------------------------------------------
// C-016: runtime capability re-verification — live probes + status surface
// ---------------------------------------------------------------------------

describe("MongoDBManagerAdminOps — live probes and status surface (C-016)", () => {
	type FakeHostOverrides = {
		capabilities?: { vectorSearch: boolean; textSearch: boolean }
		embeddingMode?: string
		deploymentProfile?: string
		changeStreamWatcher?: { liveness: unknown } | null
	}

	function buildHost(overrides: FakeHostOverrides = {}): MongoDBManagerHost {
		return {
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-1",
			capabilities: overrides.capabilities ?? {
				vectorSearch: true,
				textSearch: true,
			},
			config: {
				mongodb: {
					embeddingMode: overrides.embeddingMode ?? "automated",
					deploymentProfile:
						overrides.deploymentProfile ?? "atlas-local-preview",
				},
			},
			changeStreamWatcher: overrides.changeStreamWatcher ?? null,
		} as unknown as MongoDBManagerHost
	}

	beforeEach(() => {
		vi.clearAllMocks()

		// Minimal working surface for getV2Status() inside getDetailedStatus().
		const zeroCol = {
			countDocuments: vi.fn().mockResolvedValue(0),
			findOne: vi.fn().mockResolvedValue(null),
		} as unknown as import("mongodb").Collection<import("mongodb").Document>
		mocked(eventsCollection).mockReturnValue(zeroCol)
		mocked(entitiesCollection).mockReturnValue(zeroCol)
		mocked(relationsCollection).mockReturnValue(zeroCol)
		mocked(episodesCollection).mockReturnValue(zeroCol)
		mocked(proceduresCollection).mockReturnValue(zeroCol)
		mocked(relevanceRunsCollection).mockReturnValue(zeroCol)
		mocked(getProjectionLag).mockResolvedValue(null)
		mocked(getLatestIngestRun).mockResolvedValue(null)
		mocked(getLatestProjectionRun).mockResolvedValue(null)
		mocked(getLaneCoverage).mockResolvedValue(null)
		mocked(chunksCollection).mockReturnValue({
			collectionName: "test_chunks",
		} as unknown as import("mongodb").Collection<import("mongodb").Document>)
		// Default live-probe outcome: both lanes healthy.
		mocked(probeSearchLaneReadiness).mockResolvedValue({
			vectorSearch: true,
			textSearch: true,
		})
	})

	it("probeVectorAvailability answers from a live index-status round trip, not the boot snapshot", async () => {
		// Boot snapshot says vector is up; the live probe says mongot died.
		mocked(probeSearchLaneReadiness).mockResolvedValue({
			vectorSearch: false,
			textSearch: true,
		})
		const ops = new MongoDBManagerAdminOps(
			buildHost({ capabilities: { vectorSearch: true, textSearch: true } }),
		)

		await expect(ops.probeVectorAvailability()).resolves.toBe(false)
		expect(probeSearchLaneReadiness).toHaveBeenCalledWith(fakeDb, "test_chunks")
	})

	it("probeVectorAvailability returns true when the live probe finds the index queryable", async () => {
		const ops = new MongoDBManagerAdminOps(buildHost())
		await expect(ops.probeVectorAvailability()).resolves.toBe(true)
		expect(probeSearchLaneReadiness).toHaveBeenCalledTimes(1)
	})

	it("probeVectorAvailability skips the live probe when the embedding mode cannot serve vector", async () => {
		const ops = new MongoDBManagerAdminOps(
			buildHost({ embeddingMode: "manual" }),
		)

		await expect(ops.probeVectorAvailability()).resolves.toBe(false)
		expect(probeSearchLaneReadiness).not.toHaveBeenCalled()
	})

	it("probeEmbeddingAvailability reports live vector-index readiness in automated mode", async () => {
		mocked(probeSearchLaneReadiness).mockResolvedValue({
			vectorSearch: false,
			textSearch: true,
		})
		const ops = new MongoDBManagerAdminOps(buildHost())

		await expect(ops.probeEmbeddingAvailability()).resolves.toEqual({
			ok: false,
			error: "vector search index is not queryable (live probe)",
		})

		mocked(probeSearchLaneReadiness).mockResolvedValue({
			vectorSearch: true,
			textSearch: true,
		})
		await expect(ops.probeEmbeddingAvailability()).resolves.toEqual({
			ok: true,
		})
	})

	it("noteSearchLaneFailure re-polls readiness (throttled) and surfaces the failure in getDetailedStatus", async () => {
		let resolveProbe!: (value: {
			vectorSearch: boolean
			textSearch: boolean
		}) => void
		mocked(probeSearchLaneReadiness).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveProbe = resolve
				}),
		)
		const ops = new MongoDBManagerAdminOps(buildHost())

		ops.noteSearchLaneFailure("hybrid", new Error("mongot down"))
		ops.noteSearchLaneFailure("vector", new Error("mongot still down"))

		// Throttled: one re-poll in flight, the second note only records.
		expect(probeSearchLaneReadiness).toHaveBeenCalledTimes(1)

		resolveProbe({ vectorSearch: false, textSearch: true })
		await new Promise((resolve) => setImmediate(resolve))

		const status = await ops.getDetailedStatus()
		expect(status.searchLanes).toMatchObject({
			vectorSearch: false,
			textSearch: true,
			lastFailure: {
				path: "vector",
				error: "mongot still down",
			},
		})
		expect(status.searchLanes?.probedAt).toBeInstanceOf(Date)
		expect(status.changeStream).toBeNull()
	})

	it("getDetailedStatus surfaces change-stream watcher liveness", async () => {
		const liveness = {
			active: false,
			state: "recovering",
			reopenAttempts: 3,
			nextReopenDelayMs: 8000,
		}
		const ops = new MongoDBManagerAdminOps(
			buildHost({ changeStreamWatcher: { liveness } }),
		)

		const status = await ops.getDetailedStatus()
		expect(status.changeStream).toEqual(liveness)
	})

	it("getDetailedStatus falls back to the boot snapshot before any probe has run", async () => {
		mocked(probeSearchLaneReadiness).mockResolvedValue({
			vectorSearch: false,
			textSearch: false,
		})
		const ops = new MongoDBManagerAdminOps(
			buildHost({ capabilities: { vectorSearch: true, textSearch: false } }),
		)

		const status = await ops.getDetailedStatus()
		expect(status.searchLanes).toEqual({
			vectorSearch: true, // boot snapshot — no probe ran yet
			textSearch: false,
			lastFailure: null,
		})
		expect(status.searchLanes?.probedAt).toBeUndefined()
	})
})
