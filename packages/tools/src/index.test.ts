import type { MemongoClient } from "@memongo/client"
import {
	CHAIN_TRACE_COLLECTION_VALUES,
	CONTEXT_BUNDLE_MODE_VALUES,
	isChainTraceCollectionValue,
	isContextBundleModeValue,
	type ChainTraceCollectionValue,
	type ContextBundleModeValue,
} from "@memongo/lib"
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

	it("single-sources context-bundle modes from @memongo/lib (C-013)", async () => {
		const buildContextBundle = vi.fn(async () => ({}))
		const tools = createMemongoTools({
			buildContextBundle,
		} as unknown as MemongoClient)
		const bundleTool = tools.memongo_build_context_bundle as ExecutableTool

		// Every canonical lib mode parses and forwards.
		for (const mode of CONTEXT_BUNDLE_MODE_VALUES) {
			const input = { mode }
			expect(bundleTool.inputSchema.parse(input)).toEqual(input)
			await bundleTool.execute(input, {})
			expect(buildContextBundle).toHaveBeenCalledWith(input)
		}

		// A mode outside the lib set fails at the tool boundary.
		expect(() => bundleTool.inputSchema.parse({ mode: "compact" })).toThrow()

		// Type-level (C-013): the guard narrows the parsed value to the lib
		// union, so the tool schema and the contract cannot drift apart.
		const rawMode: unknown = (
			bundleTool.inputSchema.parse({ mode: "full" }) as { mode: unknown }
		).mode
		if (typeof rawMode === "string" && isContextBundleModeValue(rawMode)) {
			const mode: ContextBundleModeValue = rawMode
			expect(CONTEXT_BUNDLE_MODE_VALUES).toContain(mode)
		} else {
			throw new Error("parsed mode did not match the lib union")
		}
	})

	it("single-sources chain-trace collections from @memongo/lib (C-015)", async () => {
		const traceChain = vi.fn(async () => ({}))
		const tools = createMemongoTools({ traceChain } as unknown as MemongoClient)
		const chainTool = tools.memongo_chain_trace as ExecutableTool

		// Every collection the engine can actually traverse parses and forwards.
		for (const collection of CHAIN_TRACE_COLLECTION_VALUES) {
			const input = { factId: "fact-1", collection }
			expect(chainTool.inputSchema.parse(input)).toEqual(input)
			await chainTool.execute(input, {})
			expect(traceChain).toHaveBeenCalledWith(input)
		}

		// Plausible-but-wrong collection names fail at the tool boundary
		// instead of surfacing as an opaque API 400 (or, pre-C-015, a
		// fabricated empty chain).
		expect(() =>
			chainTool.inputSchema.parse({ factId: "fact-1", collection: "events" }),
		).toThrow()
		expect(() =>
			chainTool.inputSchema.parse({ factId: "fact-1", collection: "episodes" }),
		).toThrow()

		// Type-level (C-015): the guard narrows the parsed value to the lib
		// union, so the tool schema and the contract cannot drift apart.
		const rawCollection: unknown = chainTool.inputSchema.parse({
			factId: "fact-1",
			collection: "structured_mem",
		})
		if (
			typeof rawCollection === "object" &&
			rawCollection !== null &&
			typeof (rawCollection as { collection?: unknown }).collection ===
				"string" &&
			isChainTraceCollectionValue(
				(rawCollection as { collection: string }).collection,
			)
		) {
			const collection: ChainTraceCollectionValue = (
				rawCollection as { collection: ChainTraceCollectionValue }
			).collection
			expect(CHAIN_TRACE_COLLECTION_VALUES).toContain(collection)
		} else {
			throw new Error("parsed collection did not match the lib union")
		}
	})
})
