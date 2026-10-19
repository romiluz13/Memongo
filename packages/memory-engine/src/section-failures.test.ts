import { createHash } from "node:crypto"
import type { SubsystemLogger } from "@memongo/lib"
import { MongoServerError } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	SearchBudgetDeniedError,
	SearchLaneError,
	SearchLaneUnavailableError,
} from "./search-outcomes.js"
import {
	SectionFailureCollector,
	bestEffortFailureCount,
	nestSectionFailures,
	noteBestEffortFailure,
	representativeSectionError,
	resetBestEffortFailureCounts,
	sectionFailureFromError,
	sectionFailuresFromLaneOutcomes,
} from "./section-failures.js"

const QUERY = "violet launch SECRETTAIL"

function makeLog() {
	return {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	} as unknown as SubsystemLogger & { warn: ReturnType<typeof vi.fn> }
}

const driverError = () =>
	new MongoServerError({
		errmsg: `bad ${QUERY}`,
		code: 2,
		codeName: "BadValue",
	})

beforeEach(() => resetBestEffortFailureCounts())

describe("sectionFailureFromError", () => {
	it("types a driver error as a failed row with enum fields only", () => {
		const { failure, error } = sectionFailureFromError(
			"episodes",
			"atlas-search",
			driverError(),
			"episodic",
		)
		expect(failure).toEqual({
			section: "episodes",
			stage: "atlas-search",
			outcome: "failed",
			reason: "query-error",
		})
		expect(error).toBeInstanceOf(SearchLaneError)
		expect(JSON.stringify(failure)).not.toContain("SECRETTAIL")
	})

	it("keeps a typed error's own stage and reason", () => {
		const { failure } = sectionFailureFromError(
			"episodes",
			"lane",
			new SearchLaneUnavailableError({ lane: "episodic", stage: "vector" }),
		)
		expect(failure).toEqual({
			section: "episodes",
			stage: "vector",
			outcome: "failed",
			reason: "lane-unavailable",
		})
	})

	it("types a budget denial as budget-denied, never a failure", () => {
		const { failure, error } = sectionFailureFromError(
			"query-evidence",
			"lane",
			new SearchBudgetDeniedError({
				stage: "request",
				reason: "budget-aggregations",
			}),
		)
		expect(failure).toEqual({
			section: "query-evidence",
			stage: "request",
			outcome: "budget-denied",
			reason: "budget-aggregations",
		})
		expect(error).toBeInstanceOf(SearchBudgetDeniedError)
	})

	it("types a thrown string without carrying it", () => {
		const { failure } = sectionFailureFromError("x", "lane", QUERY)
		expect(JSON.stringify(failure)).not.toContain("SECRETTAIL")
		expect(failure.outcome).toBe("failed")
	})
})

describe("representativeSectionError", () => {
	const defect = new SearchLaneError({ stage: "lane", reason: "query-error" })
	const internal = new SearchLaneError({
		stage: "lane",
		reason: "internal-error",
	})
	const unavailable = new SearchLaneUnavailableError({ stage: "lane" })
	const budget = new SearchBudgetDeniedError({
		stage: "request",
		reason: "budget-deadline",
	})

	it("ranks a defect over unavailability over a budget denial", () => {
		expect(representativeSectionError([budget, unavailable, defect])).toBe(
			defect,
		)
		expect(representativeSectionError([budget, unavailable])).toBe(unavailable)
		expect(representativeSectionError([budget])).toBe(budget)
		expect(representativeSectionError([unavailable, internal])).toBe(internal)
	})

	it("keeps the first of equal severity and returns nothing for no errors", () => {
		expect(representativeSectionError([defect, internal])).toBe(defect)
		expect(representativeSectionError([])).toBeUndefined()
	})
})

describe("SectionFailureCollector", () => {
	it("returns the value of a healthy section and records nothing", async () => {
		const log = makeLog()
		const collector = new SectionFailureCollector({
			log,
			operation: "op",
			query: QUERY,
		})
		const settled = await collector.settle("a", "lane", async () => 7)
		expect(settled).toEqual({ ok: true, value: 7 })
		expect(collector.failures).toEqual([])
		expect(collector.allFailed).toBe(false)
		expect(log.warn).not.toHaveBeenCalled()
	})

	it("records a failed section as a row, a log line and a failed count", async () => {
		const log = makeLog()
		const collector = new SectionFailureCollector({
			log,
			operation: "buildX",
			query: QUERY,
		})
		const healthy = collector.settle("a", "lane", async () => 1)
		const broken = collector.settle("b", "atlas-search", async () => {
			throw driverError()
		})
		await Promise.all([healthy, broken])
		expect(collector.failures).toEqual([
			{
				section: "b",
				stage: "atlas-search",
				outcome: "failed",
				reason: "query-error",
			},
		])
		expect(collector.allFailed).toBe(false)
		expect(() => collector.throwIfAllFailed()).not.toThrow()
		expect(log.warn).toHaveBeenCalledTimes(1)
		const [message, meta] = log.warn.mock.calls[0] as [string, object]
		expect(message).toBe("buildX: b query failed")
		expect(meta).toEqual({
			code: 2,
			queryLength: QUERY.length,
			queryDigest: createHash("sha256")
				.update(QUERY)
				.digest("hex")
				.slice(0, 12),
			stage: "atlas-search",
			reason: "query-error",
		})
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain("SECRETTAIL")
	})

	it("omits the query digest for a queryless section and honors a label", async () => {
		const log = makeLog()
		const collector = new SectionFailureCollector({
			log,
			operation: "buildX",
			query: QUERY,
		})
		await collector.settle(
			"recent-events",
			"lane",
			async () => {
				throw driverError()
			},
			{ queryless: true, label: "events" },
		)
		const [message, meta] = log.warn.mock.calls[0] as [string, object]
		expect(message).toBe("buildX: events query failed")
		expect(meta).not.toHaveProperty("queryDigest")
		expect(meta).not.toHaveProperty("queryLength")
	})

	it("reports rows in plan order regardless of failure order", async () => {
		const collector = new SectionFailureCollector({
			log: makeLog(),
			operation: "op",
		})
		let releaseFirst: () => void = () => {}
		const first = collector.settle(
			"first",
			"lane",
			() =>
				new Promise((_resolve, reject) => {
					releaseFirst = () => reject(driverError())
				}),
		)
		const second = collector.settle("second", "lane", async () => {
			throw driverError()
		})
		await second
		releaseFirst()
		await first
		expect(collector.failures.map((row) => row.section)).toEqual([
			"first",
			"second",
		])
	})

	it("throws the representative typed error only when every planned section failed", async () => {
		const collector = new SectionFailureCollector({
			log: makeLog(),
			operation: "op",
		})
		await collector.settle("a", "lane", async () => {
			throw new SearchBudgetDeniedError({
				stage: "request",
				reason: "budget-embeds",
			})
		})
		await collector.settle("b", "lane", async () => {
			throw new SearchLaneUnavailableError({ stage: "lane" })
		})
		expect(collector.allFailed).toBe(true)
		let thrown: unknown
		try {
			collector.throwIfAllFailed()
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(SearchLaneUnavailableError)
	})

	it("never reports all-failed for a collector that planned nothing", () => {
		const collector = new SectionFailureCollector({
			log: makeLog(),
			operation: "op",
		})
		expect(collector.allFailed).toBe(false)
		expect(() => collector.throwIfAllFailed()).not.toThrow()
	})

	it("counts a failed row as failed and an adopted row as degraded", async () => {
		const collector = new SectionFailureCollector({
			log: makeLog(),
			operation: "op",
		})
		await collector.settle("a", "lane", async () => 1)
		await collector.settle("b", "lane", async () => 1)
		collector.adopt([
			{
				section: "a:inner",
				stage: "lane",
				outcome: "failed",
				reason: "query-error",
			},
		])
		expect(collector.allFailed).toBe(false)
		collector.failRow({
			section: "a",
			stage: "request",
			outcome: "budget-denied",
			reason: "budget-reservation",
		})
		collector.failRow({
			section: "b",
			stage: "lane",
			outcome: "failed",
			reason: "index-missing",
		})
		expect(collector.allFailed).toBe(true)
		expect(collector.failures).toHaveLength(3)
		expect(() => collector.throwIfAllFailed()).toThrow(SearchLaneError)
	})
})

describe("nestSectionFailures", () => {
	it("names nested rows parent:child and keeps the rest", () => {
		expect(
			nestSectionFailures("discovery-projection", [
				{
					section: "episodes",
					stage: "atlas-search",
					outcome: "failed",
					reason: "index-not-ready",
				},
			]),
		).toEqual([
			{
				section: "discovery-projection:episodes",
				stage: "atlas-search",
				outcome: "failed",
				reason: "index-not-ready",
			},
		])
	})
})

describe("sectionFailuresFromLaneOutcomes", () => {
	it("turns a throttle into one budget-denied request row", () => {
		expect(
			sectionFailuresFromLaneOutcomes({
				section: "query-evidence",
				throttled: { retryAfterMs: 10 },
				laneOutcomes: [
					{
						lane: "hybrid",
						stage: "lane",
						outcome: "failed",
						reason: "query-error",
					},
				],
			}),
		).toEqual([
			{
				section: "query-evidence",
				stage: "request",
				outcome: "budget-denied",
				reason: "budget-reservation",
			},
		])
	})

	it("keeps failed and denied lane rows and drops explain, ok and not-applicable rows", () => {
		expect(
			sectionFailuresFromLaneOutcomes({
				section: "query-evidence",
				outcomeStatus: "partial",
				laneOutcomes: [
					{ lane: "structured", stage: "lane", outcome: "ok", resultCount: 1 },
					{
						lane: "hybrid",
						stage: "atlas-search",
						outcome: "failed",
						reason: "index-missing",
					},
					{
						lane: "procedural",
						stage: "reservation",
						outcome: "budget-denied",
						reason: "budget-embeds",
					},
					{
						lane: "hybrid",
						stage: "explain",
						outcome: "failed",
						reason: "query-error",
					},
					{
						lane: "graph",
						stage: "lane",
						outcome: "not-applicable",
						reason: "capability-absent",
					},
				],
			}),
		).toEqual([
			{
				section: "query-evidence",
				stage: "atlas-search",
				outcome: "failed",
				reason: "index-missing",
			},
			{
				section: "query-evidence",
				stage: "reservation",
				outcome: "budget-denied",
				reason: "budget-embeds",
			},
		])
	})

	it("types a failed status with no failing row as an internal-error request row", () => {
		expect(
			sectionFailuresFromLaneOutcomes({
				section: "query-evidence",
				outcomeStatus: "failed",
				laneOutcomes: [],
			}),
		).toEqual([
			{
				section: "query-evidence",
				stage: "request",
				outcome: "failed",
				reason: "internal-error",
			},
		])
	})

	it("reports nothing for a complete answer", () => {
		expect(
			sectionFailuresFromLaneOutcomes({
				section: "query-evidence",
				outcomeStatus: "complete",
				laneOutcomes: [
					{
						lane: "structured",
						stage: "lane",
						outcome: "ok-empty",
						reason: "zero-hits",
					},
				],
			}),
		).toEqual([])
		expect(
			sectionFailuresFromLaneOutcomes({ section: "query-evidence" }),
		).toEqual([])
	})
})

describe("best-effort failure counter", () => {
	it("counts each failure per label and logs the numeric code only", () => {
		const log = makeLog()
		expect(bestEffortFailureCount("run-record")).toBe(0)
		noteBestEffortFailure(log, "run-record", driverError())
		noteBestEffortFailure(log, "run-record", new Error(QUERY))
		noteBestEffortFailure(log, "other", driverError())
		expect(bestEffortFailureCount("run-record")).toBe(2)
		expect(bestEffortFailureCount("other")).toBe(1)
		expect(log.warn).toHaveBeenCalledTimes(3)
		expect(log.warn.mock.calls[0]).toEqual([
			"run-record: best-effort write failed",
			{ code: 2 },
		])
		expect(JSON.stringify(log.warn.mock.calls)).not.toContain("SECRETTAIL")
	})

	it("resets for isolated tests", () => {
		noteBestEffortFailure(makeLog(), "run-record", new Error("x"))
		resetBestEffortFailureCounts()
		expect(bestEffortFailureCount("run-record")).toBe(0)
	})
})
