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

	it("accepts scopeRef and control flags on consolidation schemas (P2.8, B8)", async () => {
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

		const consolidateInput = {
			scope: "workspace",
			scopeRef: "acme/platform",
			resolveContradictions: false,
			llmDedup: true,
		}
		expect(consolidateTool.inputSchema.parse(consolidateInput)).toEqual(
			consolidateInput,
		)
		await consolidateTool.execute(consolidateInput, {})
		expect(consolidate).toHaveBeenCalledWith(consolidateInput)
	})

	it.each([
		[
			"memongo_search_kb",
			"searchKB",
			{ query: "runbook", scope: "workspace", scopeRef: "acme/platform" },
			{ results: [] },
		],
		[
			"memongo_profile",
			"profile",
			{ scope: "user", scopeRef: "user-1" },
			{ preferences: [] },
		],
		[
			"memongo_recall_conversation",
			"recallConversation",
			{ query: "rollback", scope: "session", scopeRef: "session-1" },
			{ results: [] },
		],
		[
			"memongo_import_conversations",
			"importConversations",
			{
				datasetPath: "imports/history.json",
				scope: "tenant",
				scopeRef: "tenant-1",
			},
			{ conversationsImported: 0 },
		],
	] as const)("%s preserves and forwards tenant coordinates", async (toolName, clientMethod, input, response) => {
		const clientCall = vi.fn(async () => response)
		const tools = createMemongoTools({
			[clientMethod]: clientCall,
		} as unknown as MemongoClient)
		const sdkTool = tools[toolName] as ExecutableTool

		const parsed = sdkTool.inputSchema.parse(input)
		expect(parsed).toEqual(input)
		await sdkTool.execute(parsed, {})

		expect(clientCall).toHaveBeenCalledWith(input)
	})
})
