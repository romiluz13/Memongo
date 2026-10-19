import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// M2 T10 (ticket #119): at the HTTP seam an engine failure is a typed
// non-2xx or a typed failure row, never an empty 200. The bridge is the fake
// engine: it rejects (post-T9 engine contract) or resolves with the shapes
// the engine returns today.

const bridge = vi.hoisted(() => ({
	memongoBridgeScanNovelty: vi.fn(),
	memongoBridgeReadFile: vi.fn(),
	memongoBridgeRelevanceExplain: vi.fn(),
	memongoBridgeGetState: vi.fn(),
	memongoBridgeSearchDetailed: vi.fn(),
	memongoBridgeTraceChain: vi.fn(),
}))
vi.mock(
	"@memongo/memory-bridge",
	() =>
		new Proxy(bridge, {
			get(target, key) {
				if (key === "then") return undefined
				if (key in target) return target[key as keyof typeof target]
				return vi.fn(() => {
					throw new Error("unexpected bridge call")
				})
			},
		}),
)

import { createApp } from "./app.js"

beforeEach(() => {
	vi.resetAllMocks()
	vi.stubEnv("MEMONGO_API_KEY", "fixture-admin")
	vi.stubEnv("MEMONGO_API_SCOPED_KEYS", "")
	vi.stubEnv("MEMONGO_API_RATE_LIMIT", "0")
	vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

function post(path: string, body: Record<string, unknown> = {}) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer fixture-admin",
		},
		body: JSON.stringify({ agentId: "owner", ...body }),
	})
}

function get(path: string) {
	return createApp().request(path, {
		headers: { Authorization: "Bearer fixture-admin" },
	})
}

type Body = {
	error?: { code: string; message: string }
	outcomes?: { status: string; lanes: unknown[] }
	[key: string]: unknown
}

async function json(response: Response): Promise<Body> {
	return (await response.json()) as Body
}

function typedLaneError(reason: string, stage = "vector") {
	return Object.assign(new Error("private provider detail"), {
		name: "SearchLaneError",
		lane: "search",
		stage,
		reason,
	})
}

describe("POST /v1/novelty-scan (X-10)", () => {
	it("maps a typed engine failure to a typed 503 with its outcome row", async () => {
		bridge.memongoBridgeScanNovelty.mockRejectedValue(
			typedLaneError("lane-unavailable"),
		)

		const response = await post("/v1/novelty-scan")

		expect(response.status).toBe(503)
		const body = await json(response)
		expect(body.error?.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(body.outcomes).toEqual({
			status: "failed",
			lanes: [
				{
					lane: "search",
					stage: "vector",
					outcome: "failed",
					reason: "lane-unavailable",
				},
			],
		})
		expect(JSON.stringify(body)).not.toContain("private")
	})

	it("maps a typed query defect to a typed 500", async () => {
		bridge.memongoBridgeScanNovelty.mockRejectedValue(
			typedLaneError("query-error"),
		)

		const response = await post("/v1/novelty-scan")

		expect(response.status).toBe(500)
		expect((await json(response)).error?.code).toBe("SEARCH_LANES_FAILED")
	})

	it("never serves the engine's error-in-report shape as a 200", async () => {
		bridge.memongoBridgeScanNovelty.mockResolvedValue({
			events: [],
			scannedCount: 0,
			error: "mongot_unavailable",
			agentId: "owner",
		})

		const response = await post("/v1/novelty-scan")

		expect(response.status).toBe(503)
		const body = await json(response)
		expect(body.error?.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(body.outcomes?.status).toBe("failed")
		expect(body.events).toBeUndefined()
	})

	it("keeps an untyped failure on the route's internal error code", async () => {
		bridge.memongoBridgeScanNovelty.mockRejectedValue(
			new Error("private driver text"),
		)

		const response = await post("/v1/novelty-scan")

		expect(response.status).toBe(500)
		const body = await json(response)
		expect(body.error?.code).toBe("NOVELTY_SCAN_FAILED")
		expect(JSON.stringify(body)).not.toContain("private")
	})

	it("serves a healthy empty scan as a 200", async () => {
		const report = { events: [], scannedCount: 0, agentId: "owner" }
		bridge.memongoBridgeScanNovelty.mockResolvedValue(report)

		const response = await post("/v1/novelty-scan")

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual(report)
	})
})

describe("POST /v1/admin/relevance/explain (X-11)", () => {
	const failedRow = {
		lane: "hybrid",
		stage: "lane",
		outcome: "failed",
		reason: "lane-unavailable",
	}
	const explain = (extra: Record<string, unknown>) => ({
		latencyMs: 12,
		sourceScope: "all",
		health: "insufficient-data",
		sampleRate: 0.05,
		artifacts: [],
		results: [],
		...extra,
	})

	it("serves an explain whose lanes all failed as a typed 503, not a health verdict", async () => {
		bridge.memongoBridgeRelevanceExplain.mockResolvedValue(
			explain({ outcomes: { status: "failed", lanes: [failedRow] } }),
		)

		const response = await post("/v1/admin/relevance/explain", {
			query: "topic",
		})

		expect(response.status).toBe(503)
		const body = await json(response)
		expect(body.error?.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(body.outcomes).toEqual({ status: "failed", lanes: [failedRow] })
		expect(body.health).toBeUndefined()
	})

	it("keeps a partial explain as a 200 that carries its failure rows", async () => {
		bridge.memongoBridgeRelevanceExplain.mockResolvedValue(
			explain({
				outcomes: { status: "partial", lanes: [failedRow] },
				results: [{ path: "a", score: 1 }],
			}),
		)

		const response = await post("/v1/admin/relevance/explain", {
			query: "topic",
		})

		expect(response.status).toBe(200)
		const body = await json(response)
		expect(body.health).toBe("insufficient-data")
		expect(body.outcomes).toEqual({ status: "partial", lanes: [failedRow] })
	})

	it("reports a run that could not be stored on the 200", async () => {
		bridge.memongoBridgeRelevanceExplain.mockResolvedValue(
			explain({
				health: "ok",
				persistFailure: { reason: "dependency-unavailable" },
			}),
		)

		const response = await post("/v1/admin/relevance/explain", {
			query: "topic",
		})

		expect(response.status).toBe(200)
		const body = await json(response)
		expect(body.persistFailure).toEqual({ reason: "dependency-unavailable" })
		expect(body.runId).toBeUndefined()
	})

	it("maps a typed engine failure to its typed status", async () => {
		bridge.memongoBridgeRelevanceExplain.mockRejectedValue(
			typedLaneError("query-error", "request"),
		)

		const response = await post("/v1/admin/relevance/explain", {
			query: "topic",
		})

		expect(response.status).toBe(500)
		expect((await json(response)).error?.code).toBe("SEARCH_LANES_FAILED")
	})
})

describe("POST /v1/read-file (G2-69)", () => {
	const erasing = () =>
		Object.assign(new Error("private gate detail"), {
			name: "ErasureGateConflictError",
		})

	it("maps an active erasure to a typed 409, not an empty miss", async () => {
		bridge.memongoBridgeReadFile.mockRejectedValue(erasing())

		const response = await post("/v1/read-file", { relPath: "notes/a.md" })

		expect(response.status).toBe(409)
		const body = await json(response)
		expect(body.error?.code).toBe("ERASURE_IN_PROGRESS")
		expect(JSON.stringify(body)).not.toContain("private")
	})

	it("keeps an untyped failure on the route's internal error code", async () => {
		bridge.memongoBridgeReadFile.mockRejectedValue(new Error("private text"))

		const response = await post("/v1/read-file", { relPath: "notes/a.md" })

		expect(response.status).toBe(500)
		expect((await json(response)).error?.code).toBe("READ_FILE_FAILED")
	})

	it("serves a real read as a 200", async () => {
		bridge.memongoBridgeReadFile.mockResolvedValue({
			text: "hi",
			path: "notes/a.md",
		})

		const response = await post("/v1/read-file", { relPath: "notes/a.md" })

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ text: "hi", path: "notes/a.md" })
	})
})

describe("POST /v1/search-detailed searchConfig.fusionMethod (X-05)", () => {
	const detailed = {
		results: [],
		metadata: { outcomeStatus: "complete", laneOutcomes: [] },
	}

	it.each([
		"js-merge",
		"reciprocal",
	])("rejects %s with a typed 400 before the engine runs", async (fusionMethod) => {
		const response = await post("/v1/search-detailed", {
			query: "q",
			searchConfig: { fusionMethod },
		})

		expect(response.status).toBe(400)
		const body = await json(response)
		expect(body.error?.code).toBe("VALIDATION_ERROR")
		expect(body.error?.message).toContain("searchConfig.fusionMethod")
		expect(bridge.memongoBridgeSearchDetailed).not.toHaveBeenCalled()
	})

	it.each([
		"scoreFusion",
		"rankFusion",
	])("accepts the native %s mode", async (fusionMethod) => {
		bridge.memongoBridgeSearchDetailed.mockResolvedValue(detailed)

		const response = await post("/v1/search-detailed", {
			query: "q",
			searchConfig: { fusionMethod },
		})

		expect(response.status).toBe(200)
		expect(bridge.memongoBridgeSearchDetailed).toHaveBeenCalledWith(
			expect.objectContaining({ searchConfig: { fusionMethod } }),
		)
	})
})
