import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// M2 T5 (#114): there is no reranker. A request that demands one is a typed
// 400 RERANK_UNSUPPORTED, never an unreranked 200, and the API metadata
// (OpenAPI, the capability table) says the same thing.

const bridge = vi.hoisted(() => ({
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

import { formatCapabilityTable } from "./lib/capabilities.js"
import { RERANK_UNSUPPORTED_MESSAGE } from "./lib/search-outcomes.js"
import { createApp } from "./app.js"
import { openApiSpec } from "./openapi-spec.js"

const QUERY = "CANARY-QUERY-TEXT where did the q3 offsite happen"

const rerankUnsupportedError = {
	name: "SearchLaneError",
	stage: "request",
	reason: "rerank-unsupported",
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

function post(path: string, body: Record<string, unknown>) {
	return createApp().request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer fixture-admin",
		},
		body: JSON.stringify({ agentId: "owner", query: QUERY, ...body }),
	})
}

describe("a rerank demand is a typed 400", () => {
	it("forwards searchConfig.rerank to the engine and maps rerank-unsupported to 400", async () => {
		bridge.memongoBridgeSearchDetailed.mockRejectedValue(
			Object.assign(
				new Error("search lane failed at request: rerank-unsupported"),
				{
					...rerankUnsupportedError,
				},
			),
		)

		const res = await post("/v1/search-detailed", {
			searchConfig: { rerank: true },
		})

		expect(res.status).toBe(400)
		const json = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(json.error).toEqual({
			code: "RERANK_UNSUPPORTED",
			message: RERANK_UNSUPPORTED_MESSAGE,
		})
		expect(JSON.stringify(json)).not.toContain("CANARY-QUERY-TEXT")
		expect(bridge.memongoBridgeSearchDetailed).toHaveBeenCalledWith(
			expect.objectContaining({ searchConfig: { rerank: true } }),
		)
	})

	it("uses the same mapping on every search route", async () => {
		bridge.memongoBridgeSearchWithDegradation.mockRejectedValue(
			Object.assign(new Error("rerank-unsupported"), rerankUnsupportedError),
		)

		const res = await post("/v1/search", {})

		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({
			error: { code: "RERANK_UNSUPPORTED" },
		})
	})

	it("accepts rerank: false and returns the normal 200", async () => {
		bridge.memongoBridgeSearchDetailed.mockResolvedValue({
			results: [],
			metadata: { reranked: false },
		})

		const res = await post("/v1/search-detailed", {
			searchConfig: { rerank: false },
		})

		expect(res.status).toBe(200)
	})

	it("rejects a non-boolean rerank as a validation error", async () => {
		const res = await post("/v1/search-detailed", {
			searchConfig: { rerank: "yes" },
		})

		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({
			error: { code: "VALIDATION_ERROR" },
		})
		expect(bridge.memongoBridgeSearchDetailed).not.toHaveBeenCalled()
	})

	it("keeps a different search failure on its own mapping", async () => {
		bridge.memongoBridgeSearchDetailed.mockRejectedValue(
			Object.assign(new Error("lane"), {
				name: "SearchLaneError",
				stage: "lane",
				reason: "index-not-ready",
			}),
		)

		const res = await post("/v1/search-detailed", {})

		expect(res.status).toBe(503)
	})
})

type Operation = {
	requestBody?: {
		content: {
			"application/json": {
				schema: {
					properties: { searchConfig: { properties: Record<string, any> } }
				}
			}
		}
	}
	responses: Record<string, any>
}
const paths = openApiSpec.paths as unknown as Record<
	string,
	Record<string, Operation>
>

describe("API metadata says there is no reranker", () => {
	it("documents searchConfig.rerank and its 400 in OpenAPI", () => {
		const operation = paths["/v1/search-detailed"].post
		const rerank =
			operation.requestBody?.content["application/json"].schema.properties
				.searchConfig.properties.rerank
		expect(rerank.type).toBe("boolean")
		expect(rerank.description).toContain("RERANK_UNSUPPORTED")
		expect(rerank.description).toContain("rerank-unsupported")
		expect(operation.responses["400"].description).toContain(
			"RERANK_UNSUPPORTED",
		)
	})

	it("lists rerank-unsupported in the outcome reason vocabulary", () => {
		const text = JSON.stringify(paths["/v1/search-detailed"].post)
		expect(text).toContain('"rerank-unsupported"')
	})

	it("states reranked is always false", () => {
		const text = JSON.stringify(
			paths["/v1/search-detailed"].post.responses["200"],
		)
		expect(text).toContain("Always false: there is no reranker")
	})

	it("describes the status rerank block as unsupported by the engine and unknown on the server", () => {
		const status = paths["/v1/status"].get.responses["200"]
		const rerank =
			status.content["application/json"].schema.properties.custom.properties
				.rerank
		expect(
			rerank.properties.nativeRerank.properties.engineSupport.enum,
		).toEqual([false])
		expect(
			rerank.properties.nativeRerank.properties.serverSupport.enum,
		).toEqual(["unknown"])
		expect(rerank.properties.lane.properties.outcome.enum).toEqual([
			"not-applicable",
		])
		expect(rerank.properties.lane.properties.reason.enum).toEqual([
			"capability-absent",
		])
	})

	it("prints the same rerank state in the capability table", () => {
		const table = formatCapabilityTable({
			hybrid: true,
			vector: true,
			keyword: true,
		})
		expect(table).toContain("rerank:  unsupported")
		expect(table).toContain("native $rerank is not implemented")
		expect(table).toContain("rerank-unsupported")
	})
})
