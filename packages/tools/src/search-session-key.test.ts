import type { MemongoClient } from "@memongo/client"
import type { z } from "zod"
import { describe, expect, it, vi } from "vitest"
import { createMemongoTools } from "./index.js"

type Executable = {
	inputSchema: z.ZodType
	execute: (input: unknown, options: unknown) => Promise<unknown>
}
describe("AI SDK search session hint", () => {
	it.each([
		{ query: "preference", sessionKey: "session-one" },
		{
			query: "preference",
			sessionKey: "session-one",
			scope: "user",
			scopeRef: "user:alice",
		},
		{ query: "preference" },
	])("preserves %j through parsing and execution", async (input) => {
		const search = vi.fn(async (_params: Record<string, unknown>) => ({
			results: [],
		}))
		const executable = createMemongoTools({
			search,
		} as unknown as MemongoClient).memongo_search as Executable
		const parsed = executable.inputSchema.parse(input)
		expect(parsed).toEqual(input)
		await executable.execute(parsed, {})
		expect(search).toHaveBeenCalledExactlyOnceWith(input)
	})
})
