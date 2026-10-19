import { type MemongoClient, MemongoClientError } from "@memongo/client"
import { describe, expect, it, vi } from "vitest"
import { handleToolCall } from "./server.js"

// M2 T11 (failure matrix): every tool whose route can fail on a typed engine
// error turns the API's non-2xx answer into a tool error that names the code
// and status, and turns a healthy empty answer into a normal result.

const handle = {
	family: "structured",
	id: "mem-1",
	agentId: "agent-1",
	scope: "agent",
	scopeRef: "agent-1",
	revision: 1,
	state: "active",
	structured: { type: "fact", key: "k" },
}

const TOOLS: Array<[row: string, tool: string, args: Record<string, unknown>]> =
	[
		["T-01", "memongo_search", { query: "q" }],
		["T-02", "memongo_search_detailed", { query: "q" }],
		["T-03", "memongo_add", { content: "c" }],
		["T-04", "memongo_write_event", { role: "user", body: "b" }],
		["T-05", "memongo_write_structured", { entry: {} }],
		["T-06", "memongo_recall_conversation", { query: "q" }],
		["T-07", "memongo_build_context_bundle", {}],
		["T-09", "memongo_state_unified", {}],
		["T-13", "memongo_search_kb", { query: "q" }],
		["T-14", "memongo_read_file", { relPath: "a.md" }],
		["T-17", "memongo_lifecycle_delete", { handle }],
		["T-20", "memongo_status", {}],
		[
			"T-21",
			"memongo_chain_trace",
			{ factId: "f", collection: "structured_mem" },
		],
		["T-22", "memongo_novelty_scan", {}],
		["T-23", "memongo_consolidate", {}],
		["T-31", "memongo_hydrate_active_slate", {}],
		["T-32", "memongo_discovery_projection", { kind: "what-changed" }],
		["T-33", "memongo_write_procedure", { entry: {} }],
		["T-34", "memongo_status_detailed", {}],
		["T-35", "memongo_stats", {}],
		["T-36", "memongo_sync", {}],
		["T-43", "memongo_relevance_explain", { query: "q" }],
		["T-46", "memongo_recall_messages", { query: "q" }],
		["T-49", "memongo_memory_delete", { handle }],
	]

const failingClient = (error: Error) =>
	new Proxy(
		{},
		{ get: () => vi.fn().mockRejectedValue(error) },
	) as unknown as MemongoClient

const healthyClient = (value: unknown) =>
	new Proxy(
		{},
		{ get: () => vi.fn().mockResolvedValue(value) },
	) as unknown as MemongoClient

const unavailable = () =>
	new MemongoClientError(
		503,
		JSON.stringify({
			error: { code: "SEARCH_LANES_UNAVAILABLE", message: "unavailable" },
			outcomes: {
				status: "failed",
				lanes: [
					{
						lane: "hybrid",
						stage: "lane",
						outcome: "failed",
						reason: "index-unavailable",
					},
				],
			},
		}),
	)

describe.each(TOOLS)("%s %s", (_row, tool, args) => {
	it("a typed 503 from the route is a tool error naming its code and status", async () => {
		const out = await handleToolCall(tool, args, failingClient(unavailable()))

		expect(out.isError).toBe(true)
		expect(JSON.parse(out.content[0].text)).toMatchObject({
			code: "SEARCH_LANES_UNAVAILABLE",
			status: 503,
		})
	})

	it("a healthy empty answer is a normal result, not a tool error", async () => {
		const out = await handleToolCall(tool, args, healthyClient({}))

		expect(out.isError).toBeUndefined()
		expect(out.content[0].type).toBe("text")
	})
})
