/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	classifyCanonicalIngestHealth,
	classifyProjectionHealth,
	classifyRetrievalHealth,
	computeOverallV2Health,
	getV2Status,
} from "./mongodb-manager.js"
import { mocked, fakeDb, fakePrefix } from "./test-helpers/manager-test-kit.js"

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./benchmark-quality-contracts.js", async (importOriginal) =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkQualityContractsModuleMock(importOriginal),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)

vi.mock("./mongodb-benchmark-harness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkHarnessModuleMock(),
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

vi.mock("./mongodb-benchmark-readiness.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).benchmarkReadinessModuleMock(),
)

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

const { getProjectionLag } = await import("./mongodb-ops.js")
const {
	eventsCollection,
	entitiesCollection,
	relationsCollection,
	episodesCollection,
	proceduresCollection,
	relevanceRunsCollection,
} = await import("./mongodb-schema.js")

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
	})
})
