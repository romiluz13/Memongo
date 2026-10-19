import { describe, expect, it, vi } from "vitest"
import { type MemongoClient, MemongoClientError } from "@memongo/client"
import { handleToolCall } from "./server.js"
import { coreTools } from "./tools/core.js"

// M2 T5 (#114): there is no reranker. The MCP tool advertises the demand
// switch, forwards it, and a refused demand reaches the agent as a tool error
// naming RERANK_UNSUPPORTED, never as an empty answer.

describe("MCP rerank demand", () => {
	it("advertises searchConfig.rerank on the detailed search tool", () => {
		const tool = coreTools.find((t) => t.name === "memongo_search_detailed")
		const searchConfig = tool?.inputSchema?.properties?.searchConfig as {
			properties: Record<string, { type: string; description?: string }>
		}
		expect(searchConfig.properties.rerank?.type).toBe("boolean")
		expect(searchConfig.properties.rerank?.description).toContain(
			"rerank-unsupported",
		)
	})

	it("forwards searchConfig.rerank to the client", async () => {
		const searchDetailed = vi.fn(async (_params: Record<string, unknown>) => ({
			results: [],
			metadata: {},
		}))

		await handleToolCall(
			"memongo_search_detailed",
			{ query: "q", searchConfig: { rerank: false } },
			{ searchDetailed } as unknown as MemongoClient,
		)

		expect(searchDetailed).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ searchConfig: { rerank: false } }),
		)
	})

	it("turns a refused rerank demand into a tool error naming the code", async () => {
		const searchDetailed = vi.fn().mockRejectedValue(
			new MemongoClientError(
				400,
				JSON.stringify({
					error: {
						code: "RERANK_UNSUPPORTED",
						message: "rerank is not supported",
					},
				}),
			),
		)

		const out = await handleToolCall(
			"memongo_search_detailed",
			{ query: "q", searchConfig: { rerank: true } },
			{ searchDetailed } as unknown as MemongoClient,
		)

		expect(out.isError).toBe(true)
		expect(JSON.parse(out.content[0].text).error).toContain(
			"RERANK_UNSUPPORTED",
		)
	})
})
