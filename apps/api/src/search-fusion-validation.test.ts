import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// M2 T11 (failure matrix, H-02 and H-05, X-05): a fusion method outside the
// two native ones is a typed 400 before any bridge call. It is never ignored
// and never replaced by the configured default.

const bridge = vi.hoisted(() => ({
	memongoBridgeSearchKBWithDegradation: vi.fn(),
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

beforeEach(() => {
	vi.resetAllMocks()
	vi.stubEnv("MEMONGO_API_KEY", "fixture-admin")
	vi.stubEnv("MEMONGO_API_SCOPED_KEYS", "")
	vi.stubEnv("MEMONGO_API_RATE_LIMIT", "0")
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

function post(path: string, body: Record<string, unknown>) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer fixture-admin",
		},
		body: JSON.stringify({ agentId: "owner", query: "q", ...body }),
	})
}

describe("fusion method validation", () => {
	it.each([
		"js-merge",
		"vector-only",
		"",
	])("/v1/search-kb rejects fusionMethod %j with a typed 400", async (value) => {
		const res = await post("/v1/search-kb", { fusionMethod: value })

		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe("VALIDATION_ERROR")
		expect(bridge.memongoBridgeSearchKBWithDegradation).not.toHaveBeenCalled()
	})

	it.each([
		"js-merge",
		"vector-only",
	])("/v1/search-detailed rejects searchConfig.fusionMethod %j with a typed 400", async (value) => {
		const res = await post("/v1/search-detailed", {
			searchConfig: { fusionMethod: value },
		})

		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("VALIDATION_ERROR")
		expect(body.error.message).toContain("fusionMethod")
		expect(bridge.memongoBridgeSearchDetailed).not.toHaveBeenCalled()
	})

	it.each([
		"scoreFusion",
		"rankFusion",
	])("/v1/search-kb forwards the native method %s", async (value) => {
		bridge.memongoBridgeSearchKBWithDegradation.mockResolvedValue({
			results: [],
		})

		const res = await post("/v1/search-kb", { fusionMethod: value })

		expect(res.status).toBe(200)
		expect(bridge.memongoBridgeSearchKBWithDegradation).toHaveBeenCalledWith(
			expect.objectContaining({ fusionMethod: value }),
		)
	})
})
