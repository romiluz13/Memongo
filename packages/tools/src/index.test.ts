import type { MemongoClient } from "@memongo/client"
import type { z } from "zod"
import { describe, expect, it, vi } from "vitest"
import { createMemongoTools } from "./index.js"

type ExecutableTool = {
	inputSchema: z.ZodType
	execute: (input: unknown, options: unknown) => Promise<unknown>
}

describe("createMemongoTools", () => {
	it("accepts and forwards canonical event validity inputs", async () => {
		const writeEvent = vi.fn(async () => ({
			ok: true as const,
			eventId: "evt-1",
			chunkCreated: true,
		}))
		const tools = createMemongoTools({ writeEvent } as unknown as MemongoClient)
		const eventTool = tools.memongo_write_event as ExecutableTool
		const input = {
			role: "user",
			body: "Historical statement",
			timestamp: "2026-04-08T12:00:00.000Z",
			validAt: "2026-04-08T12:00:00.000Z",
			invalidAt: "2026-04-09T12:00:00.000Z",
		}

		expect(eventTool.inputSchema.parse(input)).toEqual(input)
		await eventTool.execute(input, {})

		expect(writeEvent).toHaveBeenCalledWith(input)
	})

	it("accepts and forwards historical asOf recall", async () => {
		const recallConversation = vi.fn(async () => ({
			results: [],
			metadata: {
				totalMatched: 0,
				filtersApplied: [],
				searchMethod: "standard" as const,
				durationMs: 0,
			},
		}))
		const tools = createMemongoTools({
			recallConversation,
		} as unknown as MemongoClient)
		const recallTool = tools.memongo_recall_conversation as ExecutableTool
		const input = { query: "deployment", asOf: "2026-04-09T12:00:00.000Z" }

		expect(recallTool.inputSchema.parse(input)).toEqual(input)
		await recallTool.execute(input, {})

		expect(recallConversation).toHaveBeenCalledWith(input)
	})

	it("accepts scopeRef on the scanNovelty/consolidate schemas (P2.8)", async () => {
		const scanNovelty = vi.fn(async () => ({ novel: [] }))
		const consolidate = vi.fn(async () => ({ consolidated: 0 }))
		const tools = createMemongoTools({
			scanNovelty,
			consolidate,
		} as unknown as MemongoClient)
		const noveltyTool = tools.memongo_novelty_scan as ExecutableTool
		const consolidateTool = tools.memongo_consolidate as ExecutableTool

		const noveltyInput = { scope: "tenant", scopeRef: "acme" }
		expect(noveltyTool.inputSchema.parse(noveltyInput)).toEqual(noveltyInput)
		await noveltyTool.execute(noveltyInput, {})
		expect(scanNovelty).toHaveBeenCalledWith(noveltyInput)

		const consolidateInput = { scope: "workspace", scopeRef: "acme/platform" }
		expect(consolidateTool.inputSchema.parse(consolidateInput)).toEqual(
			consolidateInput,
		)
		await consolidateTool.execute(consolidateInput, {})
		expect(consolidate).toHaveBeenCalledWith(consolidateInput)
	})
})
