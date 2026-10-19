import { describe, expect, it, vi } from "vitest"
import { type MemongoClient, MemongoClientError } from "@memongo/client"
import { handleToolCall } from "./server.js"

// #101 / decision 16 (matrix section 4 step 9): the MCP adapter passes the
// client's search outcomes through unchanged, and a failed search reaches
// the agent as a tool error naming its code, never as an empty answer.

const PARTIAL = {
	status: "partial",
	lanes: [
		{
			lane: "structured",
			stage: "lane",
			outcome: "ok-empty",
			reason: "zero-hits",
		},
		{
			lane: "procedural",
			stage: "lane",
			outcome: "failed",
			reason: "query-error",
		},
	],
} as const

describe("MCP search outcome passthrough (#101)", () => {
	it.each([
		{ name: "memongo_search", method: "search" },
		{ name: "memongo_search_kb", method: "searchKB" },
	])("$name keeps a partial summary on its result", async ({
		name,
		method,
	}) => {
		const dispatch = vi
			.fn()
			.mockResolvedValue({ results: [], outcomes: PARTIAL })

		const out = await handleToolCall(name, { query: "q" }, {
			[method]: dispatch,
		} as unknown as MemongoClient)

		expect(out.isError).toBeUndefined()
		expect(JSON.parse(out.content[0].text).outcomes).toEqual(PARTIAL)
	})

	it("a failed search is a tool error naming its code", async () => {
		const dispatch = vi.fn().mockRejectedValue(
			new MemongoClientError(
				503,
				JSON.stringify({
					error: {
						code: "SEARCH_LANES_UNAVAILABLE",
						message: "search failed (request id: r-1)",
					},
					outcomes: {
						status: "failed",
						lanes: [
							{
								lane: "structured",
								stage: "lane",
								outcome: "failed",
								reason: "lane-unavailable",
							},
						],
					},
				}),
			),
		)

		const out = await handleToolCall("memongo_search", { query: "q" }, {
			search: dispatch,
		} as unknown as MemongoClient)

		expect(out.isError).toBe(true)
		expect(JSON.parse(out.content[0].text).error).toContain(
			"SEARCH_LANES_UNAVAILABLE",
		)
	})
})

// M2 decision 8: the MCP adapter carries both index-health reasons as
// retryable unavailability, the same as the HTTP API and the SDK. A failed
// search is a tool error that keeps the status, the code and the typed rows,
// so an agent can tell an unhealthy index from an empty answer and retry a 503.
describe("MCP index-health reasons (M2)", () => {
	const ROWS = [
		{
			lane: "hybrid:chunks",
			stage: "index-health",
			outcome: "failed",
			reason: "index-stale",
		},
		{
			lane: "kb",
			stage: "index-health",
			outcome: "failed",
			reason: "index-unavailable",
		},
	] as const

	it.each([
		{ name: "memongo_search", method: "search" },
		{ name: "memongo_search_kb", method: "searchKB" },
	])("$name keeps a partial index-health summary on its result", async ({
		name,
		method,
	}) => {
		const partial = {
			status: "partial",
			lanes: [
				{
					lane: "structured",
					stage: "lane",
					outcome: "ok-empty",
					reason: "zero-hits",
				},
				...ROWS,
			],
		}
		const dispatch = vi
			.fn()
			.mockResolvedValue({ results: [], outcomes: partial })

		const out = await handleToolCall(name, { query: "q" }, {
			[method]: dispatch,
		} as unknown as MemongoClient)

		expect(out.isError).toBeUndefined()
		expect(JSON.parse(out.content[0].text).outcomes).toEqual(partial)
	})

	it.each([
		{ name: "memongo_search", method: "search" },
		{ name: "memongo_search_kb", method: "searchKB" },
	])("$name: a failed index-health search is a 503 tool error with both reasons", async ({
		name,
		method,
	}) => {
		const dispatch = vi.fn().mockRejectedValue(
			new MemongoClientError(
				503,
				JSON.stringify({
					error: {
						code: "SEARCH_LANES_UNAVAILABLE",
						message: "search failed (request id: r-3)",
					},
					outcomes: { status: "failed", lanes: ROWS },
				}),
			),
		)

		const out = await handleToolCall(name, { query: "q" }, {
			[method]: dispatch,
		} as unknown as MemongoClient)

		expect(out.isError).toBe(true)
		const payload = JSON.parse(out.content[0].text)
		expect(payload.error).toContain("SEARCH_LANES_UNAVAILABLE")
		expect(payload.code).toBe("SEARCH_LANES_UNAVAILABLE")
		expect(payload.status).toBe(503)
		expect(payload.outcomes).toEqual({ status: "failed", lanes: ROWS })
	})

	it("an API error without outcomes carries its status and code and no rows", async () => {
		const dispatch = vi.fn().mockRejectedValue(
			new MemongoClientError(
				400,
				JSON.stringify({
					error: { code: "VALIDATION_ERROR", message: "bad input" },
				}),
			),
		)

		const out = await handleToolCall("memongo_search", { query: "q" }, {
			search: dispatch,
		} as unknown as MemongoClient)

		expect(out.isError).toBe(true)
		const payload = JSON.parse(out.content[0].text)
		expect(payload).toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
		expect(payload).not.toHaveProperty("outcomes")
	})
})
