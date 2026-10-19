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
