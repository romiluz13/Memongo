import { describe, expect, it, vi } from "vitest"
import { type MemongoClient, MemongoClientError } from "@memongo/client"
import { handleToolCall } from "./server.js"
import { toolCatalog } from "./tool-registry.js"

// M2 T10 (ticket #119): an MCP tool error carries the typed reason, and the
// js-merge fusion mode is rejected as a typed validation error.

type ToolResult = Awaited<ReturnType<typeof handleToolCall>>

const payload = (out: ToolResult) => JSON.parse(out.content[0].text)

const FAILED = {
	status: "failed",
	lanes: [
		{
			lane: "structured",
			stage: "lane",
			outcome: "failed",
			reason: "lane-unavailable",
		},
	],
} as const

const apiError = (status: number, code: string, extra: object = {}) =>
	new MemongoClientError(
		status,
		JSON.stringify({ error: { code, message: "refused" }, ...extra }),
	)

describe("MCP tool errors carry the typed reason", () => {
	it("a read refused by an erasure names its code and status", async () => {
		const readFile = vi
			.fn()
			.mockRejectedValue(apiError(409, "ERASURE_IN_PROGRESS"))

		const out = await handleToolCall("memongo_read_file", { relPath: "a.md" }, {
			readFile,
		} as unknown as MemongoClient)

		expect(out.isError).toBe(true)
		expect(payload(out)).toMatchObject({
			code: "ERASURE_IN_PROGRESS",
			status: 409,
		})
		expect(out.structuredContent).toMatchObject({
			code: "ERASURE_IN_PROGRESS",
		})
	})

	it("a failed search keeps its outcome rows on the error", async () => {
		const search = vi
			.fn()
			.mockRejectedValue(
				apiError(503, "SEARCH_LANES_UNAVAILABLE", { outcomes: FAILED }),
			)

		const out = await handleToolCall("memongo_search", { query: "q" }, {
			search,
		} as unknown as MemongoClient)

		expect(out.isError).toBe(true)
		expect(payload(out)).toMatchObject({
			code: "SEARCH_LANES_UNAVAILABLE",
			status: 503,
			outcomes: FAILED,
		})
	})

	it("an untyped failure stays a plain message", async () => {
		const search = vi.fn().mockRejectedValue(new Error("socket hang up"))

		const out = await handleToolCall("memongo_search", { query: "q" }, {
			search,
		} as unknown as MemongoClient)

		expect(out.isError).toBe(true)
		expect(payload(out)).toEqual({ error: "socket hang up" })
	})

	it("state failure rows pass through as the tool result", async () => {
		const state = {
			bundle: { sections: [] },
			partial: true,
			failures: [{ section: "profile", reason: "dependency-unavailable" }],
		}

		const out = await handleToolCall("memongo_state_unified", {}, {
			state: vi.fn().mockResolvedValue(state),
		} as unknown as MemongoClient)

		expect(out.isError).toBeUndefined()
		expect(payload(out)).toMatchObject(state)
	})
})

describe("MCP rejects js-merge and unknown fusion modes (X-05)", () => {
	it.each([
		{ tool: "memongo_search_kb", method: "searchKB", args: {} },
		{
			tool: "memongo_search_detailed",
			method: "searchDetailed",
			args: { searchConfig: {} },
		},
	])("$tool rejects js-merge as a typed validation error", async ({
		tool,
		method,
		args,
	}) => {
		const dispatch = vi.fn()
		const fusion = { fusionMethod: "js-merge" }
		const callArgs =
			"searchConfig" in args
				? { query: "q", searchConfig: fusion }
				: { query: "q", ...fusion }

		const out = await handleToolCall(tool, callArgs, {
			[method]: dispatch,
		} as unknown as MemongoClient)

		expect(out.isError).toBe(true)
		expect(payload(out)).toMatchObject({ code: "VALIDATION_ERROR" })
		expect(payload(out).error).toContain("fusionMethod")
		expect(dispatch).not.toHaveBeenCalled()
	})

	it("memongo_search_detailed rejects an unknown mode", async () => {
		const searchDetailed = vi.fn()

		const out = await handleToolCall(
			"memongo_search_detailed",
			{ query: "q", searchConfig: { fusionMethod: "reciprocal" } },
			{ searchDetailed } as unknown as MemongoClient,
		)

		expect(out.isError).toBe(true)
		expect(payload(out).code).toBe("VALIDATION_ERROR")
		expect(searchDetailed).not.toHaveBeenCalled()
	})

	it("memongo_search_detailed passes the native modes through", async () => {
		const searchDetailed = vi.fn().mockResolvedValue({ results: [] })

		const out = await handleToolCall(
			"memongo_search_detailed",
			{ query: "q", searchConfig: { fusionMethod: "rankFusion" } },
			{ searchDetailed } as unknown as MemongoClient,
		)

		expect(out.isError).toBeUndefined()
		expect(searchDetailed).toHaveBeenCalledWith(
			expect.objectContaining({ searchConfig: { fusionMethod: "rankFusion" } }),
		)
	})

	it("no tool schema offers js-merge", () => {
		expect(JSON.stringify(toolCatalog)).not.toContain("js-merge")
	})
})
