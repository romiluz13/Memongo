import { describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMemongoServer, handleToolCall, toolList } from "./server.js"
import { toolCatalog } from "./tool-registry.js"

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

	it("publishes consolidation control flags", () => {
		const consolidate = toolList.find(
			(tool) => tool.name === "memongo_consolidate",
		)
		expect(consolidate?.inputSchema.properties).toEqual(
			expect.objectContaining({
				resolveContradictions: expect.objectContaining({ type: "boolean" }),
				llmDedup: expect.objectContaining({ type: "boolean" }),
			}),
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

describe("server instructions (P1.4)", () => {
	it("advertises a memory-policy block in the initialize response", async () => {
		const server = createMemongoServer()
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair()
		const client = new Client({ name: "test-client", version: "0.0.1" })
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		])
		try {
			const instructions = client.getInstructions()
			expect(instructions).toBeDefined()
			// Memory policy: when to SAVE, when to SEARCH, which tool for what.
			expect(instructions).toMatch(/SAVE/)
			expect(instructions).toMatch(/SEARCH/)
			expect(instructions).toContain("memongo_write_event")
			expect(instructions).toContain("memongo_search")
			expect(instructions).toContain("memongo_recall_conversation")
			expect(instructions).toContain("memongo_build_context_bundle")
		} finally {
			await client.close()
			await server.close()
		}
	})
})

describe("core tool descriptions (P1.4)", () => {
	it("gives every core tool explicit when-to-use guidance", () => {
		const core = toolCatalog.filter((tool) => tool.category === "core")
		expect(core).toHaveLength(12)
		// Spot-assert the three highest-traffic tools.
		const byName = new Map(core.map((tool) => [tool.name, tool.description]))
		expect(byName.get("memongo_search")).toMatch(/[Uu]se when/)
		expect(byName.get("memongo_write_event")).toMatch(/[Uu]se when/)
		expect(byName.get("memongo_build_context_bundle")).toMatch(/[Uu]se when/)
		// The write path must warn against saving ephemeral chatter.
		expect(byName.get("memongo_write_event")).toMatch(/ephemeral/i)
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

	it("forwards consolidation control flags", async () => {
		const consolidate = vi.fn().mockResolvedValue({ factsExtracted: 0 })

		const out = await handleToolCall(
			"memongo_consolidate",
			{
				resolveContradictions: false,
				llmDedup: true,
			},
			{ consolidate } as any,
		)

		expect(consolidate).toHaveBeenCalledWith(
			expect.objectContaining({
				resolveContradictions: false,
				llmDedup: true,
			}),
		)
		expect(out.isError).toBeUndefined()
	})

	it.each([
		["resolveContradictions", "false"],
		["llmDedup", 1],
	])("rejects malformed consolidation %s", async (field, value) => {
		const consolidate = vi.fn()

		const out = await handleToolCall(
			"memongo_consolidate",
			{ [field]: value },
			{ consolidate } as any,
		)

		expect(consolidate).not.toHaveBeenCalled()
		expect(out.isError).toBe(true)
		expect(parseTextPayload(out)).toEqual({
			error: `${field} must be a boolean when provided`,
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

describe("memongo_extract (P1.2)", () => {
	it("forwards extract calls to the API client", async () => {
		const extract = vi
			.fn()
			.mockResolvedValue({ ok: true, jobId: "job-1", scheduled: true })

		const out = await handleToolCall(
			"memongo_extract",
			{ eventId: "evt-1", scope: "user", scopeRef: "user-1" },
			{ extract } as any,
		)

		expect(extract).toHaveBeenCalledWith({
			eventId: "evt-1",
			agentId: undefined,
			scope: "user",
			scopeRef: "user-1",
		})
		expect(out.isError).toBeUndefined()
		expect(parseTextPayload(out)).toEqual({
			ok: true,
			jobId: "job-1",
			scheduled: true,
		})
		expect(out.structuredContent).toEqual({
			ok: true,
			jobId: "job-1",
			scheduled: true,
		})
	})

	it("rejects a missing eventId before calling the client", async () => {
		const extract = vi.fn()

		const out = await handleToolCall("memongo_extract", {}, { extract } as any)

		expect(extract).not.toHaveBeenCalled()
		expect(out.isError).toBe(true)
		expect(parseTextPayload(out)).toEqual({ error: "eventId is required" })
	})
})

describe("structuredContent envelopes (P1.2)", () => {
	// Every registered tool must emit structuredContent alongside the text
	// serialization, regardless of which env flags expose it.
	const stubClient = new Proxy(
		{},
		{ get: () => async () => ({}) },
	) as unknown as Parameters<typeof handleToolCall>[2]

	// Minimal valid arguments for tools that validate inputs before calling
	// the client; all other tools accept an empty argument object.
	const validStructuredHandle = {
		family: "structured",
		id: "mem-1",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent-1",
		revision: 1,
		state: "active",
		structured: { type: "fact", key: "k" },
	}
	const validProcedureHandle = {
		family: "procedure",
		id: "proc-1",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent-1",
		revision: 1,
		state: "active",
		procedure: { procedureId: "proc-1" },
	}
	const minimalArgs: Record<string, Record<string, unknown>> = {
		memongo_write_event: { role: "user", body: "hello" },
		memongo_self_edit: { block: "user", action: "replace", content: "x" },
		memongo_procedure_outcome: { handle: validProcedureHandle, success: true },
		memongo_memory_feedback: {
			handle: validStructuredHandle,
			signal: "confirm",
		},
		memongo_lifecycle_get: { handle: validStructuredHandle },
		memongo_lifecycle_update: {
			handle: validStructuredHandle,
			patch: { value: "v" },
		},
		memongo_lifecycle_delete: { handle: validStructuredHandle },
		memongo_lifecycle_history: { handle: validStructuredHandle },
		memongo_memory_get: { handle: validStructuredHandle },
		memongo_memory_update: {
			handle: validStructuredHandle,
			patch: { value: "v" },
		},
		memongo_memory_delete: { handle: validStructuredHandle },
		memongo_memory_history: { handle: validStructuredHandle },
		memongo_discovery_projection: { kind: "what-changed" },
		memongo_benchmark_ingest: { datasetPath: "data.json" },
		memongo_import_conversations: { datasetPath: "data.json" },
		memongo_import_conversation_history: { datasetPath: "data.json" },
		memongo_admin_access_summaries: {
			collection: "events",
			memoryIds: ["mem-1"],
		},
		memongo_admin_get_trace: { traceId: "trace-1" },
		memongo_get_job: { jobId: "job-1" },
		memongo_extract: { eventId: "evt-1" },
	}

	for (const tool of toolCatalog) {
		it(`returns structuredContent for ${tool.name}`, async () => {
			const out = await handleToolCall(
				tool.name,
				minimalArgs[tool.name] ?? {},
				stubClient,
			)

			expect(out.isError).toBeUndefined()
			expect(out.structuredContent).toBeDefined()
			expect(typeof out.structuredContent).toBe("object")
			expect(out.content[0]?.type).toBe("text")
			expect(() => JSON.parse(out.content[0]?.text ?? "")).not.toThrow()
		})
	}
})

describe("scope validation (P2.8)", () => {
	const SCOPE_ERROR = "scope must be session|user|agent|workspace|tenant|global"

	it("rejects an invalid scope on memongo_hydrate_active_slate instead of casting it through", async () => {
		const hydrateActiveSlate = vi.fn()

		const out = await handleToolCall(
			"memongo_hydrate_active_slate",
			{ scope: "bogus" },
			{ hydrateActiveSlate } as any,
		)

		expect(out.isError).toBe(true)
		expect(parseTextPayload(out)).toEqual({ error: SCOPE_ERROR })
		expect(hydrateActiveSlate).not.toHaveBeenCalled()
	})

	it("rejects an invalid scope on memongo_discovery_projection instead of casting it through", async () => {
		const buildDiscoveryProjection = vi.fn()

		const out = await handleToolCall(
			"memongo_discovery_projection",
			{ kind: "what-changed", scope: "bogus" },
			{ buildDiscoveryProjection } as any,
		)

		expect(out.isError).toBe(true)
		expect(parseTextPayload(out)).toEqual({ error: SCOPE_ERROR })
		expect(buildDiscoveryProjection).not.toHaveBeenCalled()
	})

	it("rejects an invalid scope on memongo_state_unified instead of casting it through", async () => {
		const state = vi.fn()

		const out = await handleToolCall(
			"memongo_state_unified",
			{ scope: "bogus" },
			{ state } as any,
		)

		expect(out.isError).toBe(true)
		expect(parseTextPayload(out)).toEqual({ error: SCOPE_ERROR })
		expect(state).not.toHaveBeenCalled()
	})

	it("rejects an invalid scope on memongo_write_event", async () => {
		const writeEvent = vi.fn()

		const out = await handleToolCall(
			"memongo_write_event",
			{ role: "user", body: "hello", scope: "bogus" },
			{ writeEvent } as any,
		)

		expect(out.isError).toBe(true)
		expect(parseTextPayload(out)).toEqual({ error: SCOPE_ERROR })
		expect(writeEvent).not.toHaveBeenCalled()
	})

	it("passes a valid scope through on memongo_hydrate_active_slate", async () => {
		const hydrateActiveSlate = vi.fn().mockResolvedValue({ items: [] })

		const out = await handleToolCall(
			"memongo_hydrate_active_slate",
			{ scope: "workspace", scopeRef: "acme/platform" },
			{ hydrateActiveSlate } as any,
		)

		expect(out.isError).toBeUndefined()
		expect(hydrateActiveSlate).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "workspace",
				scopeRef: "acme/platform",
			}),
		)
	})

	it("forwards scopeRef on memongo_novelty_scan", async () => {
		const scanNovelty = vi.fn().mockResolvedValue({ novel: [] })

		const out = await handleToolCall(
			"memongo_novelty_scan",
			{ scope: "tenant", scopeRef: "acme" },
			{ scanNovelty } as any,
		)

		expect(out.isError).toBeUndefined()
		expect(scanNovelty).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "tenant", scopeRef: "acme" }),
		)
	})
})

describe("handleToolCall B2a contract field forwarding", () => {
	it("forwards scope and scopeRef on memongo_search", async () => {
		const search = vi.fn().mockResolvedValue({ results: [] })

		const out = await handleToolCall(
			"memongo_search",
			{ query: "deploy plan", scope: "workspace", scopeRef: "acme/platform" },
			{ search } as any,
		)

		expect(out.isError).toBeUndefined()
		expect(search).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "deploy plan",
				scope: "workspace",
				scopeRef: "acme/platform",
			}),
		)
	})

	it("rejects an invalid scope on memongo_search", async () => {
		const search = vi.fn()

		const out = await handleToolCall(
			"memongo_search",
			{ query: "deploy plan", scope: "bogus" },
			{ search } as any,
		)

		expect(out.isError).toBe(true)
		expect(search).not.toHaveBeenCalled()
	})

	it("forwards the full KB field set on memongo_search_kb", async () => {
		const searchKB = vi.fn().mockResolvedValue({ results: [] })

		const out = await handleToolCall(
			"memongo_search_kb",
			{
				query: "runbook",
				scopeRef: "acme/platform",
				minScore: 0.4,
				filter: { tags: ["ops"], category: "runbook", source: "wiki" },
				fusionMethod: "rankFusion",
			},
			{ searchKB } as any,
		)

		expect(out.isError).toBeUndefined()
		expect(searchKB).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "runbook",
				scopeRef: "acme/platform",
				minScore: 0.4,
				filter: { tags: ["ops"], category: "runbook", source: "wiki" },
				fusionMethod: "rankFusion",
			}),
		)
	})

	it("rejects a malformed KB filter on memongo_search_kb", async () => {
		const searchKB = vi.fn()

		const out = await handleToolCall(
			"memongo_search_kb",
			{ query: "runbook", filter: { tags: "ops" } },
			{ searchKB } as any,
		)

		expect(out.isError).toBe(true)
		expect(searchKB).not.toHaveBeenCalled()
	})

	it("rejects an unknown fusionMethod on memongo_search_kb", async () => {
		const searchKB = vi.fn()

		const out = await handleToolCall(
			"memongo_search_kb",
			{ query: "runbook", fusionMethod: "superFusion" },
			{ searchKB } as any,
		)

		expect(out.isError).toBe(true)
		expect(searchKB).not.toHaveBeenCalled()
	})

	it("forwards metadata, scope, scopeRef, and customId on memongo_add", async () => {
		const add = vi.fn().mockResolvedValue({ eventId: "evt-1" })

		const out = await handleToolCall(
			"memongo_add",
			{
				content: "remember this",
				metadata: { origin: "test" },
				scope: "workspace",
				scopeRef: "acme/platform",
				customId: "add-key-1",
			},
			{ add } as any,
		)

		expect(out.isError).toBeUndefined()
		expect(add).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "remember this",
				metadata: { origin: "test" },
				scope: "workspace",
				scopeRef: "acme/platform",
				customId: "add-key-1",
			}),
		)
	})

	it("forwards metadata and customId on memongo_write_event", async () => {
		const writeEvent = vi.fn().mockResolvedValue({ eventId: "evt-1" })

		const out = await handleToolCall(
			"memongo_write_event",
			{
				role: "assistant",
				body: "decision recorded",
				metadata: { origin: "test" },
				customId: "evt-key-1",
			},
			{ writeEvent } as any,
		)

		expect(out.isError).toBeUndefined()
		expect(writeEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: { origin: "test" },
				customId: "evt-key-1",
			}),
		)
	})

	it("C4: one scope pair drives BOTH the MCP add write and the MCP search read", async () => {
		const add = vi.fn().mockResolvedValue({ eventId: "evt-1" })
		const search = vi.fn().mockResolvedValue({ results: [] })
		const scope = { scope: "workspace", scopeRef: "acme/platform" }

		const addOut = await handleToolCall(
			"memongo_add",
			{ content: "the deploy runbook lives in the wiki", ...scope },
			{ add } as any,
		)
		const searchOut = await handleToolCall(
			"memongo_search",
			{ query: "deploy runbook", ...scope },
			{ search } as any,
		)

		expect(addOut.isError).toBeUndefined()
		expect(searchOut.isError).toBeUndefined()
		expect(add).toHaveBeenCalledWith(expect.objectContaining(scope))
		expect(search).toHaveBeenCalledWith(expect.objectContaining(scope))
	})

	it("forwards expiresAt on memongo_add and memongo_write_event (B1)", async () => {
		const add = vi.fn().mockResolvedValue({ eventId: "evt-1" })
		const writeEvent = vi.fn().mockResolvedValue({ eventId: "evt-2" })
		const expiresAt = "2030-01-01T00:00:00.000Z"

		const addOut = await handleToolCall(
			"memongo_add",
			{ content: "brief note", expiresAt },
			{ add } as any,
		)
		const eventOut = await handleToolCall(
			"memongo_write_event",
			{ role: "user", body: "brief note", expiresAt },
			{ writeEvent } as any,
		)

		expect(addOut.isError).toBeUndefined()
		expect(eventOut.isError).toBeUndefined()
		expect(add).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }))
		expect(writeEvent).toHaveBeenCalledWith(
			expect.objectContaining({ expiresAt }),
		)
	})
})

describe("handleToolCall B2a typed lifecycle handles", () => {
	const validProcedureHandle = {
		family: "procedure",
		id: "proc-1",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent-1",
		revision: 3,
		state: "active",
		procedure: { procedureId: "proc-1" },
	}

	it("rejects a handle with an unknown family before calling the client", async () => {
		const getLifecycleItem = vi.fn()

		const out = await handleToolCall(
			"memongo_memory_get",
			{ handle: { family: "bogus", id: "x" } },
			{ getLifecycleItem } as any,
		)

		expect(out.isError).toBe(true)
		expect(getLifecycleItem).not.toHaveBeenCalled()
	})

	it("rejects a structured handle missing its type/key payload", async () => {
		const updateLifecycleItem = vi.fn()

		const out = await handleToolCall(
			"memongo_memory_update",
			{
				handle: {
					family: "structured",
					id: "mem-1",
					agentId: "agent-1",
					scope: "workspace",
					scopeRef: "acme/platform",
					revision: 1,
					state: "active",
				},
				patch: { value: "new value" },
			},
			{ updateLifecycleItem } as any,
		)

		expect(out.isError).toBe(true)
		expect(updateLifecycleItem).not.toHaveBeenCalled()
	})

	it("rejects a non-object handle instead of fabricating one", async () => {
		const deleteLifecycleItem = vi.fn()

		const out = await handleToolCall(
			"memongo_memory_delete",
			{ handle: "mem-1" },
			{ deleteLifecycleItem } as any,
		)

		expect(out.isError).toBe(true)
		expect(deleteLifecycleItem).not.toHaveBeenCalled()
	})

	it("passes a valid procedure handle through typed", async () => {
		const getLifecycleItem = vi.fn().mockResolvedValue({ family: "procedure" })

		const out = await handleToolCall(
			"memongo_lifecycle_get",
			{ handle: validProcedureHandle },
			{ getLifecycleItem } as any,
		)

		expect(out.isError).toBeUndefined()
		expect(getLifecycleItem).toHaveBeenCalledWith({
			handle: validProcedureHandle,
		})
	})
})
