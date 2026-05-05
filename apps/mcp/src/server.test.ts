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
			timezone: undefined,
			includeToolMessages: true,
			limit: 200,
		})
		expect(out.isError).toBeUndefined()
		expect(parseTextPayload(out)).toEqual({
			results: [{ citation: { eventId: "evt-1" } }],
		})
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
