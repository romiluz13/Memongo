import type { MemongoClient } from "@memongo/client"
import { describe, expect, it, vi } from "vitest"
import { handleToolCall } from "./server.js"
import { coreTools } from "./tools/core.js"

describe.each(["memongo_search"])("%s session hint", (name) => {
	it("advertises optional sessionKey", () => {
		const schema = coreTools.find((tool) => tool.name === name)?.inputSchema
		expect(schema?.properties?.sessionKey).toEqual(
			expect.objectContaining({ type: "string" }),
		)
		expect(schema?.required).not.toContain("sessionKey")
	})
	it.each([
		{ query: "preference", sessionKey: "session-one" },
		{
			query: "preference",
			sessionKey: "session-one",
			scope: "user",
			scopeRef: "user:alice",
		},
	])("forwards %j without changing explicit scope", async (input) => {
		const search = vi.fn(async (_params: Record<string, unknown>) => ({
			results: [],
		}))
		const searchDetailed = vi.fn(async (_params: Record<string, unknown>) => ({
			results: [],
			metadata: {},
		}))
		const result = await handleToolCall(name, input, {
			search,
			searchDetailed,
		} as unknown as MemongoClient)
		expect(result.isError).not.toBe(true)
		expect(
			name === "memongo_search" ? search : searchDetailed,
		).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(input))
	})
	it("preserves absent sessionKey", async () => {
		const search = vi.fn(async (_params: Record<string, unknown>) => ({
			results: [],
		}))
		const searchDetailed = vi.fn(async (_params: Record<string, unknown>) => ({
			results: [],
			metadata: {},
		}))
		await handleToolCall(name, { query: "preference" }, {
			search,
			searchDetailed,
		} as unknown as MemongoClient)
		const forwarded = (name === "memongo_search" ? search : searchDetailed).mock
			.calls[0]?.[0]
		expect(forwarded?.sessionKey).toBeUndefined()
		expect(forwarded?.scope).toBeUndefined()
	})
})

describe("detailed search keeps its distinct contract", () => {
	it("does not advertise unsupported top-level sessionKey", () => {
		expect(
			coreTools.find((tool) => tool.name === "memongo_search_detailed")
				?.inputSchema.properties?.sessionKey,
		).toBeUndefined()
	})
})
