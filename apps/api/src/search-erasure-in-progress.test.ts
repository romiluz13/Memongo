import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// M2 T13 (review F2): a search-shaped read refused by the erasure gate is a
// typed 409 ERASURE_IN_PROGRESS on every search route, never a 500 and never
// an empty answer. The engine throws ErasureGateConflictError when erasure is
// in progress at admission, and for the direct KB read when erasure began
// while Search ran.

const bridge = vi.hoisted(() => ({
	memongoBridgeSearchKBWithDegradation: vi.fn(),
	memongoBridgeSearchWithDegradation: vi.fn(),
	memongoBridgeSearchDetailed: vi.fn(),
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
import { openApiSpec } from "./openapi-spec.js"

const QUERY = "CANARY-QUERY-TEXT what does the retention policy say"

function erasureConflict(): Error {
	const err = new Error("erasure gate conflict for agent owner")
	err.name = "ErasureGateConflictError"
	return err
}

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

function post(path: string) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer fixture-admin",
		},
		body: JSON.stringify({ agentId: "owner", query: QUERY }),
	})
}

describe("an erasure in progress refuses a search read", () => {
	it.each([
		["/v1/search-kb", "memongoBridgeSearchKBWithDegradation"],
		["/v1/search", "memongoBridgeSearchWithDegradation"],
		["/v1/search-detailed", "memongoBridgeSearchDetailed"],
	] as const)("%s answers 409 ERASURE_IN_PROGRESS", async (path, bridgeCall) => {
		bridge[bridgeCall].mockRejectedValue(erasureConflict())

		const res = await post(path)

		expect(res.status).toBe(409)
		const json = (await res.json()) as {
			error: { code: string; message: string }
			results?: unknown
		}
		expect(json.error.code).toBe("ERASURE_IN_PROGRESS")
		expect(json.results).toBeUndefined()
		expect(JSON.stringify(json)).not.toContain("CANARY-QUERY-TEXT")
	})

	it("keeps an unrelated failure on the route's internal error", async () => {
		bridge.memongoBridgeSearchKBWithDegradation.mockRejectedValue(
			new Error("boom"),
		)

		const res = await post("/v1/search-kb")

		expect(res.status).toBe(500)
		expect(await res.json()).toMatchObject({
			error: { code: "SEARCH_KB_FAILED" },
		})
	})

	it("documents the 409 on the KB search operation", () => {
		const paths = openApiSpec.paths as unknown as Record<
			string,
			Record<string, { responses: Record<string, { description: string }> }>
		>
		expect(paths["/v1/search-kb"].post.responses["409"].description).toContain(
			"ERASURE_IN_PROGRESS",
		)
	})
})
