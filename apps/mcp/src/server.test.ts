import { describe, expect, it, vi } from "vitest"
import { handleToolCall, toolList } from "./server.js"

function parseTextPayload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0]?.text ?? "null")
}

describe("toolList", () => {
	it("includes Wave 5 semantic aliases for stable recall and memory flows", () => {
		const names = new Set(toolList.map((tool) => tool.name))
		expect(names.has("memongo_recall_messages")).toBe(true)
		expect(names.has("memongo_memory_get")).toBe(true)
		expect(names.has("memongo_memory_update")).toBe(true)
		expect(names.has("memongo_memory_delete")).toBe(true)
		expect(names.has("memongo_memory_history")).toBe(true)
		expect(names.has("memongo_import_conversation_history")).toBe(true)
		expect(names.has("memongo_procedure_outcome")).toBe(true)
		expect(names.has("memongo_memory_feedback")).toBe(true)
	})

	it("publishes event validity and historical recall inputs", () => {
		const writeEvent = toolList.find(
			(tool) => tool.name === "memongo_write_event",
		)
		const recall = toolList.find(
			(tool) => tool.name === "memongo_recall_conversation",
		)
		expect(writeEvent?.inputSchema.properties).toEqual(
			expect.objectContaining({
				timestamp: expect.any(Object),
				validAt: expect.any(Object),
				invalidAt: expect.any(Object),
			}),
		)
		expect(recall?.inputSchema.properties).toEqual(
			expect.objectContaining({ asOf: expect.any(Object) }),
		)
	})

	it("keeps benchmark-only controls off detailed search", () => {
		const detailedSearch = toolList.find(
			(tool) => tool.name === "memongo_search_detailed",
		)
		const properties = detailedSearch?.inputSchema.properties as Record<
			string,
			unknown
		>

		expect(properties).not.toHaveProperty("datasetSha256")
		expect(properties).not.toHaveProperty("retrievalLane")
		expect(properties).not.toHaveProperty("qualityThresholds")
	})

	it("publishes the dataset-discriminated benchmark quality contract", () => {
		const benchmark = toolList.find(
			(tool) => tool.name === "memongo_relevance_benchmark",
		)
		const qualityThresholds = (
			benchmark?.inputSchema.properties as Record<string, unknown>
		).qualityThresholds as { oneOf?: Array<{ required?: string[] }> }

		expect(qualityThresholds.oneOf).toHaveLength(2)
		expect(qualityThresholds.oneOf?.[0]?.required).toEqual(
			expect.arrayContaining([
				"contractId",
				"version",
				"datasetKind",
				"minSessionRecallAnyAt10",
				"minSessionNdcgAnyAt10",
			]),
		)
		expect(qualityThresholds.oneOf?.[1]?.required).toEqual(
			expect.arrayContaining([
				"contractId",
				"version",
				"datasetKind",
				"minSessionEvidenceRecallAt10",
				"minAnswerAccuracy",
				"maxJudgeFalsePositiveRate",
				"minAnswerCoverage",
			]),
		)
	})
})

describe("handleToolCall", () => {
	it("routes the semantic recall alias to the canonical recall runtime", async () => {
		const recallConversation = vi.fn().mockResolvedValue({
			results: [{ citation: { eventId: "evt-1" } }],
		})

		const out = await handleToolCall(
			"memongo_recall_messages",
			{
				query: "rollback plan",
				roles: ["assistant", "tool"],
				limit: 999,
				includeToolMessages: true,
				asOf: "2026-04-09T12:00:00.000Z",
			},
			{
				recallConversation,
			} as any,
		)

		expect(recallConversation).toHaveBeenCalledWith({
			query: "rollback plan",
			agentId: undefined,
			sessionId: undefined,
			roles: ["assistant", "tool"],
			startTime: undefined,
			endTime: undefined,
			asOf: "2026-04-09T12:00:00.000Z",
			timezone: undefined,
			includeToolMessages: true,
			limit: 200,
		})
		expect(out.isError).toBeUndefined()
		expect(parseTextPayload(out)).toEqual({
			results: [{ citation: { eventId: "evt-1" } }],
		})
	})

	it("forwards canonical event validity inputs", async () => {
		const writeEvent = vi.fn().mockResolvedValue({ eventId: "evt-1" })

		await handleToolCall(
			"memongo_write_event",
			{
				role: "user",
				body: "Historical statement",
				timestamp: "2026-04-08T12:00:00.000Z",
				validAt: "2026-04-08T12:00:00.000Z",
				invalidAt: "2026-04-09T12:00:00.000Z",
			},
			{ writeEvent } as any,
		)

		expect(writeEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				timestamp: "2026-04-08T12:00:00.000Z",
				validAt: "2026-04-08T12:00:00.000Z",
				invalidAt: "2026-04-09T12:00:00.000Z",
			}),
		)
	})

	it("returns a tool execution error when semantic recall alias receives invalid roles", async () => {
		const recallConversation = vi.fn()

		const out = await handleToolCall(
			"memongo_recall_messages",
			{
				roles: ["assistant", "bad-role"],
			},
			{
				recallConversation,
			} as any,
		)

		expect(recallConversation).not.toHaveBeenCalled()
		expect(out.isError).toBe(true)
		expect(parseTextPayload(out)).toEqual({
			error: "roles must contain only user|assistant|system|tool",
		})
	})

	it("routes the semantic memory aliases to the same lifecycle runtime methods", async () => {
		const getLifecycleItem = vi.fn().mockResolvedValue({ family: "structured" })
		const updateLifecycleItem = vi.fn().mockResolvedValue({
			handle: { revision: 2 },
		})
		const deleteLifecycleItem = vi.fn().mockResolvedValue({
			handle: { state: "invalidated" },
		})
		const getLifecycleHistory = vi.fn().mockResolvedValue([{ revision: 1 }])
		const handle = {
			family: "structured",
			id: "mem-1",
			agentId: "agent-1",
			scope: "workspace",
			scopeRef: "acme/platform",
			revision: 1,
			state: "active",
			structured: { type: "fact", key: "deployment" },
		}

		await handleToolCall("memongo_memory_get", { handle }, {
			getLifecycleItem,
		} as any)
		await handleToolCall(
			"memongo_memory_update",
			{ handle, patch: { value: "new value" } },
			{
				updateLifecycleItem,
			} as any,
		)
		await handleToolCall(
			"memongo_memory_delete",
			{ handle, invalidatedBy: { reason: "cleanup" } },
			{
				deleteLifecycleItem,
			} as any,
		)
		await handleToolCall("memongo_memory_history", { handle, limit: 999 }, {
			getLifecycleHistory,
		} as any)

		expect(getLifecycleItem).toHaveBeenCalledWith({ handle })
		expect(updateLifecycleItem).toHaveBeenCalledWith({
			handle,
			patch: { value: "new value" },
		})
		expect(deleteLifecycleItem).toHaveBeenCalledWith({
			handle,
			invalidatedBy: { reason: "cleanup" },
		})
		expect(getLifecycleHistory).toHaveBeenCalledWith({ handle, limit: 200 })
	})

	it("wraps array payloads in structuredContent.items for MCP compliance", async () => {
		const getLifecycleHistory = vi.fn().mockResolvedValue([{ revision: 1 }])
		const handle = {
			family: "structured",
			id: "mem-1",
			agentId: "agent-1",
			scope: "workspace",
			scopeRef: "acme/platform",
			revision: 1,
			state: "active",
			structured: { type: "fact", key: "deployment" },
		}

		const out = await handleToolCall(
			"memongo_memory_history",
			{ handle, limit: 10 },
			{
				getLifecycleHistory,
			} as any,
		)

		expect(parseTextPayload(out)).toEqual([{ revision: 1 }])
		expect(
			"structuredContent" in out ? out.structuredContent : undefined,
		).toEqual({ items: [{ revision: 1 }] })
	})

	it("routes the semantic import alias to the canonical import runtime", async () => {
		const importConversations = vi.fn().mockResolvedValue({ importedTurns: 12 })

		const out = await handleToolCall(
			"memongo_import_conversation_history",
			{
				datasetPath: "imports/history.json",
				scope: "workspace",
				limitConversations: 3,
			},
			{
				importConversations,
			} as any,
		)

		expect(importConversations).toHaveBeenCalledWith({
			datasetPath: "imports/history.json",
			agentId: undefined,
			scope: "workspace",
			limitConversations: 3,
			limitTurnsPerConversation: undefined,
		})
		expect(out.isError).toBeUndefined()
		expect(parseTextPayload(out)).toEqual({ importedTurns: 12 })
	})

	it("routes procedure outcome calls to the canonical runtime", async () => {
		const reportProcedureOutcome = vi.fn().mockResolvedValue({
			family: "procedure",
			data: { successCount: 5, failCount: 1 },
		})
		const handle = {
			family: "procedure",
			id: "procedure:agent-1:agent:agent-1:deploy",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
			revision: 2,
			state: "active",
			procedure: { procedureId: "deploy" },
		}

		const out = await handleToolCall(
			"memongo_procedure_outcome",
			{
				handle,
				success: true,
				note: "Passed smoke test",
				actorRole: "assistant",
			},
			{
				reportProcedureOutcome,
			} as any,
		)

		expect(reportProcedureOutcome).toHaveBeenCalledWith({
			handle,
			success: true,
			note: "Passed smoke test",
			actorRole: "assistant",
		})
		expect(parseTextPayload(out)).toEqual({
			family: "procedure",
			data: { successCount: 5, failCount: 1 },
		})
	})

	it("routes memory feedback calls to the canonical runtime", async () => {
		const applyMemoryFeedback = vi.fn().mockResolvedValue({
			family: "structured",
			data: { reinforcementCount: 4 },
		})
		const handle = {
			family: "structured",
			id: "structured:agent-1:agent:agent-1:fact:launch",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
			revision: 1,
			state: "active",
			structured: { type: "fact", key: "launch" },
		}

		const out = await handleToolCall(
			"memongo_memory_feedback",
			{
				handle,
				signal: "correct",
				patch: { value: "Launch moved to Tuesday" },
				actorRole: "user",
			},
			{
				applyMemoryFeedback,
			} as any,
		)

		expect(applyMemoryFeedback).toHaveBeenCalledWith({
			handle,
			signal: "correct",
			patch: { value: "Launch moved to Tuesday" },
			actorRole: "user",
		})
		expect(parseTextPayload(out)).toEqual({
			family: "structured",
			data: { reinforcementCount: 4 },
		})
	})
})
