import type { Db } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("./mongodb-lane-coverage.js", () => ({
	getLaneCoverage: vi.fn().mockResolvedValue(null),
}))
vi.mock("./mongodb-retrieval-planner.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("./mongodb-retrieval-planner.js")>()
	return { ...original, planRetrieval: vi.fn(original.planRetrieval) }
})

import { planRetrieval } from "./mongodb-retrieval-planner.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { emitTelemetry } from "./mongodb-telemetry.js"
import {
	DEFAULT_SEARCH_ADMISSION_BURST,
	resetSearchAdmissionForTests,
	tryConsumeSearchAdmission,
} from "./mongodb-search-admission.js"
import {
	DEFAULT_SEARCH_BUDGET,
	runWithSearchBudget,
} from "./mongodb-search-budget.js"
import {
	clampSearchQuery,
	MAX_SEARCH_QUERY_LENGTH,
} from "./mongodb-search-ranking.js"

const head = "alpha ".repeat(333) + "al"
const full = head + " yesterday TAILMARK"
const context = { availablePaths: new Set<"raw-window">(["raw-window"]) }
const fakeDb = {} as Db

function clampEvents() {
	return vi
		.mocked(emitTelemetry)
		.mock.calls.filter(
			(call) => call[2].meta.operation === "search-query-clamped",
		)
}

function denyAdmission() {
	for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST; i++)
		tryConsumeSearchAdmission()
}

describe("searchV2 top-level query clamp (F206)", () => {
	beforeEach(() => {
		vi.stubEnv("MEMONGO_SEARCH_ADMISSION_RPM", "1")
		vi.clearAllMocks()
		resetSearchAdmissionForTests(Date.now())
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it("preserves original admission for input clamp and throttle telemetry", async () => {
		denyAdmission()
		const admission = {
			kind: "admission" as const,
			agentId: "agent-a",
			epoch: 17,
		}
		await searchV2(fakeDb, "t_", full, "agent-a", { ...context, admission })
		const calls = vi.mocked(emitTelemetry).mock.calls
		expect(calls).toHaveLength(2)
		for (const call of calls)
			expect(Reflect.get(call, 3)).toEqual({ admission })
	})
	it("keeps throttled search response when admitted telemetry rejects", async () => {
		denyAdmission()
		vi.mocked(emitTelemetry).mockRejectedValueOnce(new Error("private command"))
		const result = await searchV2(fakeDb, "t_", full, "agent-a", {
			...context,
			admission: { kind: "admission", agentId: "agent-a", epoch: 17 },
		})
		expect(result.metadata.throttled).toBeDefined()
		expect(result.results).toEqual([])
	})

	it("clamps before the denied-admission planner can infer a tail constraint", async () => {
		expect(head).toHaveLength(MAX_SEARCH_QUERY_LENGTH)
		const expected = planRetrieval(head, context)
		denyAdmission()
		const result = await searchV2(fakeDb, "t_", full, "agent-a", context)
		expect(result.metadata.throttled).toBeDefined()
		expect(result.metadata.plan).toEqual(expected)
		expect(result.metadata.plan.constraints?.timeRange).toBeUndefined()
		expect(vi.mocked(planRetrieval).mock.lastCall?.[0]).toBe(head)
	})

	it("emits one clamp attempt with original length, separately from throttling", async () => {
		denyAdmission()
		await searchV2(fakeDb, "t_", full, "agent-a", context)
		expect(clampEvents()).toHaveLength(1)
		expect(clampEvents()[0][2]).toEqual({
			meta: { agentId: "agent-a", operation: "search-query-clamped" },
			durationMs: 0,
			ok: true,
			queryLength: full.length,
		})
		expect(
			vi.mocked(emitTelemetry).mock.calls.filter((call) => call[2].throttled),
		).toHaveLength(1)
	})

	it.each([
		"hello",
		head,
		clampSearchQuery(full),
	])("does not emit another clamp event for an already bounded query", async (query) => {
		denyAdmission()
		await searchV2(fakeDb, "t_", query, "agent-a", context)
		expect(clampEvents()).toHaveLength(0)
		expect(vi.mocked(planRetrieval).mock.lastCall?.[0]).toBe(query)
	})

	it("applies the existing ceiling at 2001 code units without adding trimming", async () => {
		const query = " " + "a".repeat(MAX_SEARCH_QUERY_LENGTH)
		denyAdmission()
		await searchV2(fakeDb, "t_", query, "agent-a", context)
		expect(vi.mocked(planRetrieval).mock.lastCall?.[0]).toBe(
			query.slice(0, MAX_SEARCH_QUERY_LENGTH),
		)
		expect(clampEvents()).toHaveLength(1)
	})

	it("delivers the bounded query to admitted search and preserves the error object", async () => {
		const errorLine = vi.spyOn(console, "error").mockImplementation(() => {})
		let boom: Error | undefined
		vi.mocked(planRetrieval).mockImplementationOnce((query) => {
			boom = new Error(`planner failed: ${query}`)
			throw boom
		})
		let caught: unknown
		try {
			await searchV2(fakeDb, "t_", full, "agent-a", context)
		} catch (err) {
			caught = err
		}
		expect(boom).toBeDefined()
		expect(caught).toBe(boom)
		expect(vi.mocked(planRetrieval).mock.lastCall?.[0]).toBe(head)
		expect(clampEvents()).toHaveLength(1)
		expect(errorLine).toHaveBeenCalledTimes(1)
		const line = errorLine.mock.calls[0].join(" ")
		const meta = JSON.parse(line.slice(line.indexOf("{")))
		expect(meta.queryLength).toBe(MAX_SEARCH_QUERY_LENGTH)
		expect(meta.queryDigest).toBe(
			createHash("sha256").update(head).digest("hex").slice(0, 12),
		)
		expect(meta).not.toHaveProperty("error")
		expect(line).not.toContain("planner failed")
		expect(line).not.toContain("TAILMARK")
	})

	it("bounds shared-budget re-entries and preserves the original failure", async () => {
		const errorLine = vi.spyOn(console, "error").mockImplementation(() => {})
		const boom = new Error("shared-budget failure")
		vi.mocked(planRetrieval).mockImplementationOnce(() => {
			throw boom
		})
		await expect(
			runWithSearchBudget(DEFAULT_SEARCH_BUDGET, () =>
				searchV2(fakeDb, "t_", full, "agent-a", context),
			),
		).rejects.toBe(boom)
		expect(vi.mocked(planRetrieval).mock.lastCall?.[0]).toBe(head)
		expect(clampEvents()).toHaveLength(1)
		expect(clampEvents()[0][2].queryLength).toBe(full.length)
		expect(errorLine).toHaveBeenCalledTimes(1)
		const line = errorLine.mock.calls[0].join(" ")
		expect(JSON.parse(line.slice(line.indexOf("{"))).queryLength).toBe(
			MAX_SEARCH_QUERY_LENGTH,
		)
	})
})
