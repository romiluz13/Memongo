import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { MemongoClient } from "@memongo/client"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createV1Router } from "../apps/api/src/routes/v1.js"
import { createMemongoServer, handleToolCall } from "../apps/mcp/src/server.js"

const bridge = vi.hoisted(() => ({
	memongoBridgeSearchDetailed: vi.fn(
		async (_params: Record<string, unknown>) => ({ results: [], metadata: {} }),
	),
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
const requests: Record<string, unknown>[] = []
const statuses: number[] = []
beforeEach(() => {
	vi.clearAllMocks()
	requests.length = 0
	statuses.length = 0
	const app = new Hono().route("/v1", createV1Router())
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init)
		requests.push((await request.clone().json()) as Record<string, unknown>)
		const response = await app.request(request)
		statuses.push(response.status)
		return response
	})
})
afterEach(() => vi.restoreAllMocks())

async function sdkCall(args: Record<string, unknown>) {
	const server = createMemongoServer()
	const client = new Client({ name: "search-constraint-fixture", version: "0" })
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair()
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	])
	try {
		return await client.callTool({
			name: "memongo_search_detailed",
			arguments: { query: "memory", ...args },
		})
	} finally {
		await client.close()
		await server.close()
	}
}

describe("MCP search constraints reach the API validation", () => {
	it.each([
		{ searchMode: "autox" },
		{ searchMode: null },
		{ searchMode: 42 },
		{ searchConfig: null },
		{ searchConfig: "fast" },
		{ searchConfig: [] },
		{ searchConfig: { recipe: "fastst" } },
		{ searchConfig: { searchMode: "autox" } },
		{ searchConfig: { sourcePreference: ["reference", "typo"] } },
		{ searchConfig: { sourcePreference: "reference" } },
		{ searchConfig: { needExactEvidence: "true" } },
		{ searchConfig: { allowConstraintRelaxation: null } },
		{ searchConfig: { maxResults: "5" } },
		{ searchConfig: { maxPasses: 0 } },
		{ searchConfig: { timeRange: null } },
		{ searchConfig: { timeRange: { start: 42 } } },
		{ searchConfig: { timeRange: { preset: "last-7-days" } } },
		{ searchConfig: { recallProfile: "speed" } },
		{ searchConfig: { fusionMethod: "sum" } },
		{ searchConfig: { allowHybridBackstop: "false" } },
		{ searchConfig: { typoConstraint: true } },
	])("reports invalid constraints via HTTP 400 and MCP isError (%#)", async (args) => {
		const result = await sdkCall(args)
		expect(requests).toEqual([{ query: "memory", ...args }])
		expect(statuses).toEqual([400])
		expect(result.isError).toBe(true)
		expect(result.structuredContent).toEqual({
			error: expect.stringContaining("VALIDATION_ERROR"),
		})
		expect(bridge.memongoBridgeSearchDetailed).not.toHaveBeenCalled()
	})
	it("preserves every supported nested control through SDK, client and API", async () => {
		const searchConfig = {
			recipe: "hybrid",
			recallProfile: "proof",
			maxResults: 5,
			searchMode: "direct",
			maxPasses: 2,
			sourcePreference: ["reference", "structured"],
			timeRange: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" },
			needExactEvidence: true,
			allowConstraintRelaxation: false,
			numCandidates: 50,
			fusionMethod: "js-merge",
			hybridMode: "hybrid",
			allowHybridBackstop: false,
			lexicalPrefilter: "disabled",
		}
		const result = await sdkCall({ searchMode: "auto", searchConfig })
		expect(requests).toEqual([
			{ query: "memory", searchMode: "auto", searchConfig },
		])
		expect(statuses).toEqual([200])
		expect(result.isError).not.toBe(true)
		expect(bridge.memongoBridgeSearchDetailed).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ searchMode: "auto", searchConfig }),
		)
	})
	it("keeps omitted controls absent and retains the default search", async () => {
		const result = await sdkCall({})
		expect(requests).toEqual([{ query: "memory" }])
		expect(statuses).toEqual([200])
		expect(result.isError).not.toBe(true)
		expect(bridge.memongoBridgeSearchDetailed).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				searchMode: undefined,
				searchConfig: undefined,
			}),
		)
	})
	it("preserves explicitly injected silent-client degradation semantics", async () => {
		const client = new MemongoClient({
			baseUrl: "https://fixture.invalid",
			silent: true,
		})
		const result = await handleToolCall(
			"memongo_search_detailed",
			{ query: "memory", searchConfig: null },
			client,
		)
		expect(statuses).toEqual([400])
		expect(result.isError).not.toBe(true)
		expect(result.structuredContent).toEqual(
			expect.objectContaining({ results: [], degradation: expect.any(Object) }),
		)
		expect(bridge.memongoBridgeSearchDetailed).not.toHaveBeenCalled()
	})
})
