import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const bridgeMocks = vi.hoisted(() => ({
	memongoBridgeAdd: vi.fn(),
	memongoBridgeAccessSummaries: vi.fn(),
	memongoBridgeAccessTrends: vi.fn(),
	memongoBridgeImportConversations: vi.fn(),
	memongoBridgeBuildContextBundle: vi.fn(),
	memongoBridgeBuildDiscoveryProjection: vi.fn(),
	memongoBridgeDeleteAllForAgent: vi.fn(),
	memongoBridgeDeleteLifecycleItem: vi.fn(),
	memongoBridgeApplyMemoryFeedback: vi.fn(),
	memongoBridgeGetState: vi.fn(),
	memongoBridgeGetDetailedStatus: vi.fn(),
	memongoBridgeExtractEvent: vi.fn(),
	memongoBridgeGetLifecycleHistory: vi.fn(),
	memongoBridgeGetLifecycleItem: vi.fn(),
	memongoBridgeGetMemoryJob: vi.fn(),
	memongoBridgeGetRecallTrace: vi.fn(),
	memongoBridgeHydrateActiveSlate: vi.fn(),
	memongoBridgeListMemoryJobs: vi.fn(),
	memongoBridgeListRecallTraces: vi.fn(),
	memongoBridgeProbeEmbedding: vi.fn(),
	memongoBridgeProbeVector: vi.fn(),
	memongoBridgeCapabilities: vi.fn(),
	memongoBridgeProfile: vi.fn(),
	memongoBridgeRecallConversation: vi.fn(),
	memongoBridgeReadFile: vi.fn(),
	memongoBridgeRelevanceExplain: vi.fn(),
	memongoBridgeRelevanceReport: vi.fn(),
	memongoBridgeRelevanceSampleRate: vi.fn(),
	memongoBridgeSearchWithDegradation: vi.fn(),
	memongoBridgeSearchDetailed: vi.fn(),
	memongoBridgeSearchKBWithDegradation: vi.fn(),
	memongoBridgeStats: vi.fn(),
	memongoBridgeStatus: vi.fn(),
	memongoBridgeSync: vi.fn(),
	memongoBridgeUpdateLifecycleItem: vi.fn(),
	memongoBridgeReportProcedureOutcome: vi.fn(),
	memongoBridgeWriteConversationEvent: vi.fn(),
	memongoBridgeWriteConversationEventsBatch: vi.fn(),
	memongoBridgeWriteProcedure: vi.fn(),
	memongoBridgeWriteStructuredMemory: vi.fn(),
	memongoBridgeTraceChain: vi.fn(),
	memongoBridgeScanNovelty: vi.fn(),
	memongoBridgeConsolidate: vi.fn(),
	memongoBridgeSelfEdit: vi.fn(),
	memongoBridgePingMongo: vi.fn(),
	buildMemongoConfig: vi.fn(),
}))

vi.mock("@memongo/memory-bridge", () => bridgeMocks)

import { createApp } from "./app.js"

describe("createApp", () => {
	const prevEnv = { ...process.env }

	beforeEach(() => {
		process.env = { ...prevEnv }
		// Hermetic auth state: an ambient MEMONGO_API_KEY from the developer's
		// shell (the dogfood lesson) must not activate auth in these tests —
		// tests that need a key set it explicitly.
		delete process.env.MEMONGO_API_KEY
		delete process.env.MEMONGO_API_SCOPED_KEYS
		process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH = "true"
		bridgeMocks.memongoBridgeSearchWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchDetailed.mockReset()
		bridgeMocks.memongoBridgeAdd.mockReset()
		bridgeMocks.memongoBridgeAccessSummaries.mockReset()
		bridgeMocks.memongoBridgeAccessTrends.mockReset()
		bridgeMocks.memongoBridgeImportConversations.mockReset()
		bridgeMocks.memongoBridgeBuildContextBundle.mockReset()
		bridgeMocks.memongoBridgeBuildDiscoveryProjection.mockReset()
		bridgeMocks.memongoBridgeDeleteAllForAgent.mockReset()
		bridgeMocks.memongoBridgeDeleteLifecycleItem.mockReset()
		bridgeMocks.memongoBridgeApplyMemoryFeedback.mockReset()
		bridgeMocks.memongoBridgeExtractEvent.mockReset()
		bridgeMocks.memongoBridgeGetLifecycleHistory.mockReset()
		bridgeMocks.memongoBridgeGetLifecycleItem.mockReset()
		bridgeMocks.memongoBridgeGetState.mockReset()
		bridgeMocks.memongoBridgeGetMemoryJob.mockReset()
		bridgeMocks.memongoBridgeGetRecallTrace.mockReset()
		bridgeMocks.memongoBridgeProfile.mockReset()
		bridgeMocks.memongoBridgeRecallConversation.mockReset()
		bridgeMocks.memongoBridgeListMemoryJobs.mockReset()
		bridgeMocks.memongoBridgeListRecallTraces.mockReset()
		bridgeMocks.memongoBridgeStatus.mockReset()
		bridgeMocks.memongoBridgeTraceChain.mockReset()
		bridgeMocks.memongoBridgeScanNovelty.mockReset()
		bridgeMocks.memongoBridgeConsolidate.mockReset()
		bridgeMocks.memongoBridgeSelfEdit.mockReset()
		bridgeMocks.memongoBridgePingMongo.mockReset()
		bridgeMocks.buildMemongoConfig.mockReset()
		bridgeMocks.memongoBridgeUpdateLifecycleItem.mockReset()
		bridgeMocks.memongoBridgeReportProcedureOutcome.mockReset()
		bridgeMocks.memongoBridgeWriteConversationEvent.mockReset()
		bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockReset()
		bridgeMocks.memongoBridgeSearchWithDegradation.mockResolvedValue({
			results: [],
		})
		bridgeMocks.memongoBridgeSearchKBWithDegradation.mockResolvedValue({
			results: [],
		})
		bridgeMocks.memongoBridgeSearchDetailed.mockResolvedValue({
			results: [],
			metadata: {
				mode: "auto",
				classification: "factoid",
				sourceOrder: ["conversation"],
				passes: [],
				queriesTried: [],
				constraintsApplied: [],
				resultsRejected: [],
				evidenceCoverage: {
					totalResults: 0,
					sourceCounts: {},
					exactEvidenceCount: 0,
					coverageRatio: 0,
				},
				pathsExecuted: [],
				resultsByPath: {},
				queryRewritten: false,
				reranked: false,
			},
		})
		bridgeMocks.memongoBridgeAdd.mockResolvedValue({
			eventId: "evt-1",
			chunkCreated: true,
		})
		bridgeMocks.memongoBridgeWriteConversationEvent.mockResolvedValue({
			eventId: "evt-2",
			chunkCreated: true,
		})
		bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockImplementation(
			async ({ events }: { events: Array<{ body: string }> }) =>
				events.map((_, index) => ({
					ok: true,
					eventId: `evt-batch-${index}`,
					chunkCreated: true,
				})),
		)
		bridgeMocks.memongoBridgeProfile.mockResolvedValue({ profile: [] })
		bridgeMocks.memongoBridgeHydrateActiveSlate.mockResolvedValue({
			agentId: "main",
			scope: "agent",
			scopeRef: "agent:main",
			items: [],
			metadata: {
				maxItems: 5,
				truncated: false,
				partial: false,
				countsByKind: {},
				sourceCounts: {},
			},
			hydratedAt: "2026-04-05T12:00:00.000Z",
		})
		bridgeMocks.memongoBridgeBuildDiscoveryProjection.mockResolvedValue({
			kind: "entity-brief",
			query: "Phoenix",
			title: "Phoenix entity brief",
			summary: "Phoenix has one active owner and one linked decision.",
			scope: "agent",
			scopeRef: "agent:main",
			sections: [],
			metadata: {
				partial: false,
				evidenceCount: 0,
				sourceCounts: {},
			},
			builtAt: "2026-04-05T12:00:00.000Z",
		})
		bridgeMocks.memongoBridgeBuildContextBundle.mockResolvedValue({
			agentId: "main",
			query: "Phoenix",
			scope: "agent",
			scopeRef: "agent:main",
			sessionId: "session-main",
			rendered:
				"## Active Slate\nHighest-salience durable state assembled from structured memory, procedures, and recent anchors.",
			sections: [],
			metadata: {
				tokenBudget: 320,
				estimatedTokensUsed: 48,
				partial: false,
				truncated: false,
				pathsExecuted: ["active-slate"],
				sectionsIncluded: [],
			},
			builtAt: "2026-04-05T12:00:00.000Z",
		})
		bridgeMocks.memongoBridgeRecallConversation.mockResolvedValue({
			results: [],
			metadata: {
				totalMatched: 0,
				filtersApplied: ["excludeToolMessages"],
				searchMethod: "standard",
				durationMs: 2,
			},
		})
		bridgeMocks.memongoBridgeGetLifecycleItem.mockResolvedValue({
			family: "structured",
			handle: {
				family: "structured",
				id: "structured:agent-42:agent:agent-42:decision:db",
				agentId: "agent-42",
				scope: "agent",
				scopeRef: "agent-42",
				revision: 2,
				state: "active",
				structured: { type: "decision", key: "db" },
				updatedAt: "2026-04-10T12:00:00.000Z",
			},
			data: {
				type: "decision",
				key: "db",
				value: "Use MongoDB Atlas Local",
				sourceAgent: { id: "dreamer", name: "Dreamer" },
			},
			createdAt: "2026-04-09T12:00:00.000Z",
			updatedAt: "2026-04-10T12:00:00.000Z",
		})
		bridgeMocks.memongoBridgeUpdateLifecycleItem.mockImplementation(
			async ({ handle, patch }) => ({
				family: handle.family,
				handle: {
					...handle,
					revision: handle.revision + 1,
					updatedAt: "2026-04-10T12:05:00.000Z",
				},
				data:
					handle.family === "structured"
						? {
								type: handle.structured.type,
								key: handle.structured.key,
								value:
									typeof patch?.value === "string"
										? patch.value
										: "Use MongoDB Atlas Local",
							}
						: {
								procedureId: handle.procedure.procedureId,
								name: typeof patch?.name === "string" ? patch.name : "Deploy",
								steps: Array.isArray(patch?.steps) ? patch.steps : ["Build"],
							},
				createdAt: "2026-04-09T12:00:00.000Z",
				updatedAt: "2026-04-10T12:05:00.000Z",
			}),
		)
		bridgeMocks.memongoBridgeDeleteLifecycleItem.mockImplementation(
			async ({ handle }) => ({
				family: handle.family,
				handle: {
					...handle,
					revision: handle.revision + 1,
					state: "invalidated",
					validTo: "2026-04-10T12:10:00.000Z",
					updatedAt: "2026-04-10T12:10:00.000Z",
				},
				data:
					handle.family === "structured"
						? {
								type: handle.structured.type,
								key: handle.structured.key,
								value: "Use MongoDB Atlas Local",
							}
						: {
								procedureId: handle.procedure.procedureId,
								name: "Deploy",
								steps: ["Build"],
							},
				createdAt: "2026-04-09T12:00:00.000Z",
				updatedAt: "2026-04-10T12:10:00.000Z",
			}),
		)
		bridgeMocks.memongoBridgeGetLifecycleHistory.mockResolvedValue([
			{
				family: "structured",
				handle: {
					family: "structured",
					id: "structured:agent-42:agent:agent-42:decision:db",
					agentId: "agent-42",
					scope: "agent",
					scopeRef: "agent-42",
					revision: 1,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
				data: {
					type: "decision",
					key: "db",
					value: "Use local files",
				},
				historyKind: "revision",
				supersededAt: "2026-04-10T12:00:00.000Z",
			},
			{
				family: "structured",
				handle: {
					family: "structured",
					id: "structured:agent-42:agent:agent-42:decision:db",
					agentId: "agent-42",
					scope: "agent",
					scopeRef: "agent-42",
					revision: 2,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
				data: {
					type: "decision",
					key: "db",
					value: "Use MongoDB Atlas Local",
				},
				historyKind: "current",
			},
		])
		bridgeMocks.memongoBridgeGetState.mockResolvedValue({
			profile: { profile: [] },
			blocks: {
				blocks: [],
				totalTokenBudget: 0,
				totalActualTokens: 0,
			},
			bundle: {
				agentId: "main",
				scope: "agent",
				scopeRef: "agent:main",
				rendered: "",
				sections: [],
				metadata: {
					tokenBudget: 320,
					estimatedTokensUsed: 0,
					partial: false,
					truncated: false,
					pathsExecuted: [],
					sectionsIncluded: [],
				},
				builtAt: "2026-04-05T12:00:00.000Z",
			},
		})
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({
			backend: "mongodb",
			provider: "voyage",
		})
		bridgeMocks.memongoBridgeExtractEvent.mockResolvedValue({
			jobId: "extraction-evt-1",
			scheduled: true,
		})
		bridgeMocks.memongoBridgeAccessTrends.mockResolvedValue([])
		bridgeMocks.memongoBridgeImportConversations.mockResolvedValue({
			datasetPath: "/tmp/history.json",
			datasetName: "history.json",
			datasetKind: "generic",
			conversationsImported: 1,
			turnsImported: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: "2026-04-11T09:00:00.000Z",
			completedAt: "2026-04-11T09:00:02.000Z",
		})
		bridgeMocks.memongoBridgeListRecallTraces.mockResolvedValue([])
		bridgeMocks.memongoBridgeListMemoryJobs.mockResolvedValue([])
	})

	afterEach(() => {
		process.env = { ...prevEnv }
	})

	it("forwards recall-conversation filters and returns cited results", async () => {
		bridgeMocks.memongoBridgeRecallConversation.mockResolvedValue({
			results: [
				{
					citation: {
						eventId: "evt-42",
						sessionId: "session-9",
						role: "assistant",
						timestamp: "2026-04-08T14:30:00.000Z",
						preview: "Assistant: Phoenix ships on Friday.",
					},
					score: 0.91,
					matchType: "semantic",
				},
			],
			metadata: {
				totalMatched: 1,
				queryUsed: "phoenix",
				filtersApplied: [
					"sessionId:session-9",
					"roles:assistant",
					"startTime:2026-04-08T00:00:00.000Z",
					"endTime:2026-04-08T23:59:59.999Z",
				],
				searchMethod: "semantic",
				durationMs: 12,
			},
		})

		const res = await createApp().request("/v1/recall-conversation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				query: "phoenix",
				sessionId: "session-9",
				roles: ["assistant"],
				startTime: "2026-04-08",
				endTime: "2026-04-08",
				asOf: "2026-04-09T12:00:00.000Z",
				timezone: "America/New_York",
				includeToolMessages: true,
				limit: 3,
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({
			results: [
				{
					citation: {
						eventId: "evt-42",
						sessionId: "session-9",
						role: "assistant",
						timestamp: "2026-04-08T14:30:00.000Z",
						preview: "Assistant: Phoenix ships on Friday.",
					},
					score: 0.91,
					matchType: "semantic",
				},
			],
			metadata: {
				totalMatched: 1,
				queryUsed: "phoenix",
				filtersApplied: [
					"sessionId:session-9",
					"roles:assistant",
					"startTime:2026-04-08T00:00:00.000Z",
					"endTime:2026-04-08T23:59:59.999Z",
				],
				searchMethod: "semantic",
				durationMs: 12,
			},
		})
		expect(bridgeMocks.memongoBridgeRecallConversation).toHaveBeenCalledWith({
			agentId: "agent-42",
			scope: undefined,
			scopeRef: undefined,
			query: "phoenix",
			sessionId: "session-9",
			roles: ["assistant"],
			startTime: "2026-04-08",
			endTime: "2026-04-08",
			asOf: "2026-04-09T12:00:00.000Z",
			timezone: "America/New_York",
			includeToolMessages: true,
			limit: 3,
		})
	})

	it("rejects an invalid recall-conversation asOf", async () => {
		const res = await createApp().request("/v1/recall-conversation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ asOf: "not-a-date" }),
		})

		expect(res.status).toBe(400)
		expect(bridgeMocks.memongoBridgeRecallConversation).not.toHaveBeenCalled()
	})

	it("gets lifecycle item by stable handle", async () => {
		const handle = {
			family: "structured",
			id: "structured:agent-42:agent:agent-42:decision:db",
			agentId: "agent-42",
			scope: "agent",
			scopeRef: "agent-42",
			revision: 2,
			state: "active",
			structured: { type: "decision", key: "db" },
			updatedAt: "2026-04-10T12:00:00.000Z",
		}

		const res = await createApp().request("/v1/lifecycle/get", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ handle }),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({
				family: "structured",
				data: expect.objectContaining({ value: "Use MongoDB Atlas Local" }),
			}),
		)
		expect(bridgeMocks.memongoBridgeGetLifecycleItem).toHaveBeenCalledWith({
			handle: expect.objectContaining({
				family: "structured",
				agentId: "agent-42",
				structured: { type: "decision", key: "db" },
			}),
		})
	})

	it("updates lifecycle item with a family-aware patch", async () => {
		const handle = {
			family: "structured",
			id: "structured:agent-42:agent:agent-42:decision:db",
			agentId: "agent-42",
			scope: "agent",
			scopeRef: "agent-42",
			revision: 2,
			state: "active",
			structured: { type: "decision", key: "db" },
		}

		const res = await createApp().request("/v1/lifecycle/update", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle,
				patch: {
					value: "Use MongoDB Atlas Preview",
					sourceAgent: { id: "dreamer", name: "Dreamer" },
				},
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({
				handle: expect.objectContaining({ revision: 3 }),
				data: expect.objectContaining({ value: "Use MongoDB Atlas Preview" }),
			}),
		)
		expect(bridgeMocks.memongoBridgeUpdateLifecycleItem).toHaveBeenCalledWith({
			handle: expect.objectContaining({
				family: "structured",
				structured: { type: "decision", key: "db" },
			}),
			patch: {
				value: "Use MongoDB Atlas Preview",
				sourceAgent: { id: "dreamer", name: "Dreamer" },
			},
		})
	})

	it("deletes lifecycle item with invalidate-with-history semantics", async () => {
		const handle = {
			family: "structured",
			id: "structured:agent-42:agent:agent-42:decision:db",
			agentId: "agent-42",
			scope: "agent",
			scopeRef: "agent-42",
			revision: 2,
			state: "active",
			structured: { type: "decision", key: "db" },
		}

		const res = await createApp().request("/v1/lifecycle/delete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle,
				invalidatedBy: { reason: "user-delete" },
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({
				handle: expect.objectContaining({ state: "invalidated" }),
			}),
		)
		expect(bridgeMocks.memongoBridgeDeleteLifecycleItem).toHaveBeenCalledWith({
			handle: expect.objectContaining({
				family: "structured",
				structured: { type: "decision", key: "db" },
			}),
			invalidatedBy: { reason: "user-delete" },
		})
	})

	it("returns ordered lifecycle history for a stable handle", async () => {
		const res = await createApp().request("/v1/lifecycle/history", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle: {
					family: "structured",
					id: "structured:agent-42:agent:agent-42:decision:db",
					agentId: "agent-42",
					scope: "agent",
					scopeRef: "agent-42",
					revision: 2,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
				limit: 20,
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ historyKind: "revision" }),
				expect.objectContaining({ historyKind: "current" }),
			]),
		)
		expect(bridgeMocks.memongoBridgeGetLifecycleHistory).toHaveBeenCalledWith({
			handle: expect.objectContaining({
				family: "structured",
				structured: { type: "decision", key: "db" },
			}),
			limit: 20,
		})
	})

	it("records procedure outcomes through the stable handle route", async () => {
		bridgeMocks.memongoBridgeReportProcedureOutcome.mockResolvedValue({
			family: "procedure",
			handle: {
				family: "procedure",
				id: "procedure:agent-42:agent:agent-42:deploy",
				agentId: "agent-42",
				scope: "agent",
				scopeRef: "agent-42",
				revision: 2,
				state: "active",
				procedure: { procedureId: "deploy" },
			},
			data: {
				procedureId: "deploy",
				name: "Deploy",
				steps: ["Build", "Ship"],
				successCount: 4,
				failCount: 1,
			},
		})

		const handle = {
			family: "procedure",
			id: "procedure:agent-42:agent:agent-42:deploy",
			agentId: "agent-42",
			scope: "agent",
			scopeRef: "agent-42",
			revision: 2,
			state: "active",
			procedure: { procedureId: "deploy" },
		}

		const res = await createApp().request("/v1/procedures/outcome", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle,
				success: true,
				note: "Passed production deploy",
				actorRole: "assistant",
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({
				family: "procedure",
				data: expect.objectContaining({ successCount: 4 }),
			}),
		)
		expect(
			bridgeMocks.memongoBridgeReportProcedureOutcome,
		).toHaveBeenCalledWith({
			handle,
			success: true,
			note: "Passed production deploy",
			actorRole: "assistant",
		})
	})

	it("applies structured memory feedback through the public feedback route", async () => {
		bridgeMocks.memongoBridgeApplyMemoryFeedback.mockResolvedValue({
			family: "structured",
			handle: {
				family: "structured",
				id: "structured:agent-42:agent:agent-42:decision:db",
				agentId: "agent-42",
				scope: "agent",
				scopeRef: "agent-42",
				revision: 3,
				state: "active",
				structured: { type: "decision", key: "db" },
			},
			data: {
				type: "decision",
				key: "db",
				value: "Use MongoDB Atlas Local",
				reinforcementCount: 7,
			},
		})

		const handle = {
			family: "structured",
			id: "structured:agent-42:agent:agent-42:decision:db",
			agentId: "agent-42",
			scope: "agent",
			scopeRef: "agent-42",
			revision: 3,
			state: "active",
			structured: { type: "decision", key: "db" },
		}

		const res = await createApp().request("/v1/memory/feedback", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle,
				signal: "confirm",
				note: "Still true",
				actorRole: "user",
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({
				family: "structured",
				data: expect.objectContaining({ reinforcementCount: 7 }),
			}),
		)
		expect(bridgeMocks.memongoBridgeApplyMemoryFeedback).toHaveBeenCalledWith({
			handle,
			signal: "confirm",
			note: "Still true",
			actorRole: "user",
		})
	})

	it("rejects lifecycle update when patch does not match the handle family", async () => {
		const res = await createApp().request("/v1/lifecycle/update", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle: {
					family: "structured",
					id: "structured:agent-42:agent:agent-42:decision:db",
					agentId: "agent-42",
					scope: "agent",
					scopeRef: "agent-42",
					revision: 2,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
				patch: {
					steps: ["Build", "Ship"],
				},
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "patch must be a valid lifecycle patch for the handle family",
			},
		})
	})

	it("rejects correct feedback when patch is missing", async () => {
		const res = await createApp().request("/v1/memory/feedback", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle: {
					family: "structured",
					id: "structured:agent-42:agent:agent-42:decision:db",
					agentId: "agent-42",
					scope: "agent",
					scopeRef: "agent-42",
					revision: 2,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
				signal: "correct",
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message:
					"patch must be a valid structured lifecycle patch for correct feedback",
			},
		})
	})

	it("rejects correct feedback when patch is empty", async () => {
		const res = await createApp().request("/v1/memory/feedback", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				handle: {
					family: "structured",
					id: "structured:agent-42:agent:agent-42:decision:db",
					agentId: "agent-42",
					scope: "agent",
					scopeRef: "agent-42",
					revision: 2,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
				signal: "correct",
				patch: {},
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message:
					"patch must be a valid structured lifecycle patch for correct feedback",
			},
		})
	})

	it("scope isolation: extract returns 404 when the event is not in the caller's authorized scope", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", scopes: ["tenant"], scopeRefs: ["ref-A"] },
		])
		bridgeMocks.memongoBridgeExtractEvent.mockReset()
		bridgeMocks.memongoBridgeExtractEvent.mockRejectedValue(
			Object.assign(new Error("event not found: evt-x"), {
				name: "EventNotInScopeError",
			}),
		)

		const res = await createApp().request(
			"/v1/extract?scope=tenant&scopeRef=ref-A",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer scoped-A",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ eventId: "evt-x" }),
			},
		)

		expect(res.status).toBe(404)
		const json = (await res.json()) as { error: { code: string } }
		expect(json.error.code).toBe("EVENT_NOT_FOUND")
	})

	it("scope isolation: novelty-scan, consolidate, and extract forward the authorized scopeRef", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", scopes: ["tenant"], scopeRefs: ["ref-A"] },
		])
		for (const mock of [
			bridgeMocks.memongoBridgeScanNovelty,
			bridgeMocks.memongoBridgeConsolidate,
			bridgeMocks.memongoBridgeExtractEvent,
		]) {
			mock.mockReset()
			mock.mockResolvedValue({})
		}
		const headers = {
			Authorization: "Bearer scoped-A",
			"Content-Type": "application/json",
		}
		const base = "?scope=tenant&scopeRef=ref-A"

		await createApp().request(`/v1/novelty-scan${base}`, {
			method: "POST",
			headers,
			body: JSON.stringify({}),
		})
		await createApp().request(`/v1/consolidate${base}`, {
			method: "POST",
			headers,
			body: JSON.stringify({}),
		})
		await createApp().request(`/v1/extract${base}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ eventId: "evt-1" }),
		})
		expect(
			bridgeMocks.memongoBridgeScanNovelty.mock.calls[0]?.[0]?.scopeRef,
		).toBe("ref-A")
		expect(
			bridgeMocks.memongoBridgeConsolidate.mock.calls[0]?.[0]?.scopeRef,
		).toBe("ref-A")
		expect(
			bridgeMocks.memongoBridgeExtractEvent.mock.calls[0]?.[0]?.scopeRef,
		).toBe("ref-A")
	})

	it("scope isolation: search-kb forwards the authorized scopeRef to the bridge", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", scopeRefs: ["ref-A"] },
		])
		bridgeMocks.memongoBridgeSearchKBWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchKBWithDegradation.mockResolvedValue({
			results: [],
		})

		const res = await createApp().request("/v1/search-kb?scopeRef=ref-A", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: "hello" }),
		})

		expect(res.status).toBe(200)
		const call =
			bridgeMocks.memongoBridgeSearchKBWithDegradation.mock.calls[0]?.[0]
		expect(call?.scopeRef).toBe("ref-A")
	})

	it("scope isolation: search-kb rejects a scope-only policy that cannot constrain its scopeRef filter", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"], scopes: ["agent"] },
		])
		bridgeMocks.memongoBridgeSearchKBWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchKBWithDegradation.mockResolvedValue({
			results: [],
		})

		const res = await createApp().request(
			"/v1/search-kb?agentId=agent-A&scope=agent&scopeRef=global",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer scoped-A",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query: "hello" }),
			},
		)

		expect(res.status).toBe(403)
		expect(
			bridgeMocks.memongoBridgeSearchKBWithDegradation,
		).not.toHaveBeenCalled()
	})

	it("scope isolation: recall-conversation forwards the authorized scope/scopeRef to the bridge", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", scopes: ["tenant"], scopeRefs: ["ref-A"] },
		])
		bridgeMocks.memongoBridgeRecallConversation.mockReset()
		bridgeMocks.memongoBridgeRecallConversation.mockResolvedValue({
			results: [],
			metadata: {
				totalMatched: 0,
				queryUsed: "x",
				filtersApplied: [],
				searchMethod: "standard",
				durationMs: 1,
			},
		})

		const res = await createApp().request("/v1/recall-conversation", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ scope: "tenant", scopeRef: "ref-A", query: "x" }),
		})

		expect(res.status).toBe(200)
		const call = bridgeMocks.memongoBridgeRecallConversation.mock.calls[0]?.[0]
		expect(call?.scope).toBe("tenant")
		expect(call?.scopeRef).toBe("ref-A")
	})

	it("rejects recall-conversation when roles contain unsupported values", async () => {
		const res = await createApp().request("/v1/recall-conversation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				roles: ["assistant", "narrator"],
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "roles must contain only user|assistant|system|tool",
			},
		})
	})

	it("P1.3: maps Mongo driver network errors to 503 SERVICE_UNAVAILABLE so client retry means something", async () => {
		const mongoDown = new Error("connection refused")
		mongoDown.name = "MongoServerSelectionError"
		bridgeMocks.memongoBridgeSearchWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchWithDegradation.mockRejectedValue(mongoDown)

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "hello" }),
		})

		expect(res.status).toBe(503)
		const json = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(json.error.code).toBe("SERVICE_UNAVAILABLE")
		// The raw driver message must not leak — only the request id reference.
		expect(json.error.message).not.toContain("connection refused")
		expect(json.error.message).toContain("request id:")
	})

	it.each([
		"MongoNetworkError",
		"MongoNetworkTimeoutError",
		"MongoServerSelectionError",
	])("P1.3: %s maps to 503", async (name) => {
		const err = new Error("driver down")
		err.name = name
		bridgeMocks.memongoBridgeSearchWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchWithDegradation.mockRejectedValue(err)

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "hello" }),
		})

		expect(res.status).toBe(503)
	})

	it("P1.3: a network error nested in an error cause chain still maps to 503", async () => {
		const cause = new Error("socket hang up")
		cause.name = "MongoNetworkError"
		const err = new Error("bridge call failed", { cause })
		bridgeMocks.memongoBridgeSearchWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchWithDegradation.mockRejectedValue(err)

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "hello" }),
		})

		expect(res.status).toBe(503)
	})

	it("P1.3: a generic 500 must NOT become retriable noise — non-network errors stay 500 with the route code", async () => {
		bridgeMocks.memongoBridgeSearchWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchWithDegradation.mockRejectedValue(
			new Error("unexpected invariant violation"),
		)

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "hello" }),
		})

		expect(res.status).toBe(500)
		const json = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(json.error.code).toBe("SEARCH_FAILED")
		expect(json.error.message).toContain("request id:")
	})

	it("P1.3: a message that merely mentions a network error name stays 500 (name-only classification)", async () => {
		bridgeMocks.memongoBridgeSearchWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchWithDegradation.mockRejectedValue(
			new Error("failed while handling MongoServerSelectionError fallback"),
		)

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "hello" }),
		})

		expect(res.status).toBe(500)
	})
})

describe("P2.8 boundary input validation", () => {
	const prevEnv = { ...process.env }

	beforeEach(() => {
		process.env = { ...prevEnv }
		delete process.env.MEMONGO_API_KEY
		delete process.env.MEMONGO_API_SCOPED_KEYS
		process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH = "true"
		bridgeMocks.memongoBridgeSearchWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchWithDegradation.mockResolvedValue({
			results: [],
		})
		bridgeMocks.memongoBridgeSearchKBWithDegradation.mockReset()
		bridgeMocks.memongoBridgeSearchKBWithDegradation.mockResolvedValue({
			results: [],
		})
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockReset()
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockResolvedValue({
			id: "s1",
		})
		bridgeMocks.memongoBridgeWriteProcedure.mockReset()
		bridgeMocks.memongoBridgeWriteProcedure.mockResolvedValue({ id: "p1" })
		bridgeMocks.memongoBridgeAdd.mockReset()
		bridgeMocks.memongoBridgeAdd.mockResolvedValue({
			eventId: "evt-1",
			chunkCreated: true,
		})
		bridgeMocks.memongoBridgeWriteConversationEvent.mockReset()
		bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockReset()
		bridgeMocks.memongoBridgeWriteConversationEvent.mockResolvedValue({
			eventId: "evt-2",
			chunkCreated: true,
		})
		bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockImplementation(
			async ({ events }: { events: Array<{ body: string }> }) =>
				events.map((_, index) => ({
					ok: true,
					eventId: `evt-batch-${index}`,
					chunkCreated: true,
				})),
		)
		bridgeMocks.memongoBridgeSync.mockReset()
		bridgeMocks.memongoBridgeSync.mockResolvedValue(undefined)
	})

	afterEach(() => {
		process.env = { ...prevEnv }
	})

	function postJson(path: string, body: unknown) {
		return createApp().request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		})
	}

	it("malformed JSON on /v1/search returns 400 INVALID_JSON instead of silently running with {}", async () => {
		const res = await postJson("/v1/search", "{")

		expect(res.status).toBe(400)
		const json = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(json.error.code).toBe("INVALID_JSON")
		expect(
			bridgeMocks.memongoBridgeSearchWithDegradation,
		).not.toHaveBeenCalled()
	})

	it("a genuinely empty body still works where it does today (/v1/sync)", async () => {
		const res = await createApp().request("/v1/sync", { method: "POST" })

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSync).toHaveBeenCalledOnce()
	})

	it("write-structured rejects an entry missing type/key/value naming the field", async () => {
		for (const [entry, field] of [
			[{ key: "city", value: "Berlin" }, "entry.type"],
			[{ type: "fact", value: "Berlin" }, "entry.key"],
			[{ type: "fact", key: "city" }, "entry.value"],
		] as const) {
			const res = await postJson("/v1/write-structured", { entry })

			expect(res.status).toBe(400)
			const json = (await res.json()) as {
				error: { code: string; message: string }
			}
			expect(json.error.code).toBe("VALIDATION_ERROR")
			expect(json.error.message).toContain(field)
		}
		expect(
			bridgeMocks.memongoBridgeWriteStructuredMemory,
		).not.toHaveBeenCalled()
	})

	it("write-structured accepts a valid entry and forwards it to the bridge", async () => {
		const res = await postJson("/v1/write-structured", {
			entry: { type: "fact", key: "city", value: "Berlin" },
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteStructuredMemory,
		).toHaveBeenCalledOnce()
		expect(
			bridgeMocks.memongoBridgeWriteStructuredMemory.mock.calls[0]?.[0]?.entry,
		).toEqual({ type: "fact", key: "city", value: "Berlin" })
	})

	it("write-procedure rejects an entry missing procedureId/name/steps naming the field", async () => {
		for (const [entry, field] of [
			[{ name: "deploy", steps: ["build"] }, "entry.procedureId"],
			[{ procedureId: "proc-1", steps: ["build"] }, "entry.name"],
			[{ procedureId: "proc-1", name: "deploy" }, "entry.steps"],
		] as const) {
			const res = await postJson("/v1/write-procedure", { entry })

			expect(res.status).toBe(400)
			const json = (await res.json()) as {
				error: { code: string; message: string }
			}
			expect(json.error.code).toBe("VALIDATION_ERROR")
			expect(json.error.message).toContain(field)
		}
		expect(bridgeMocks.memongoBridgeWriteProcedure).not.toHaveBeenCalled()
	})

	it("/v1/add rejects operator-shaped metadata keys ($-prefixed, dotted)", async () => {
		for (const metadata of [{ $where: "x" }, { "a.b": 1 }]) {
			const res = await postJson("/v1/add", {
				content: "remember this",
				metadata,
			})

			expect(res.status).toBe(400)
			const json = (await res.json()) as {
				error: { code: string; message: string }
			}
			expect(json.error.code).toBe("VALIDATION_ERROR")
			expect(json.error.message).toContain("metadata")
		}
		expect(bridgeMocks.memongoBridgeAdd).not.toHaveBeenCalled()
	})

	it("/v1/add accepts normal metadata and forwards it", async () => {
		const res = await postJson("/v1/add", {
			content: "remember this",
			metadata: { source: "chat", turn: 3 },
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeAdd).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: { source: "chat", turn: 3 },
			}),
		)
	})

	it("/v1/write-event rejects operator-shaped metadata keys", async () => {
		const res = await postJson("/v1/write-event", {
			role: "user",
			body: "hello",
			metadata: { $set: "x" },
		})

		expect(res.status).toBe(400)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).not.toHaveBeenCalled()
	})

	it("search limit 9999 is clamped to 100 before reaching the bridge", async () => {
		const res = await postJson("/v1/search", { query: "hello", limit: 9999 })

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearchWithDegradation).toHaveBeenCalledWith(
			expect.objectContaining({ maxResults: 100 }),
		)
	})

	it("search maxResults 9999 is clamped to 100; in-range limits pass through", async () => {
		const clamped = await postJson("/v1/search", {
			query: "hello",
			maxResults: 9999,
		})
		expect(clamped.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeSearchWithDegradation.mock.calls.at(-1)?.[0]
				?.maxResults,
		).toBe(100)

		const passthrough = await postJson("/v1/search", {
			query: "hello",
			limit: 25,
		})
		expect(passthrough.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeSearchWithDegradation.mock.calls.at(-1)?.[0]
				?.maxResults,
		).toBe(25)
	})

	it("/v1/search-kb rejects an untyped or operator-shaped filter", async () => {
		for (const filter of [{ tags: "not-an-array" }, { $where: "1" }]) {
			const res = await postJson("/v1/search-kb", {
				query: "architecture",
				filter,
			})

			expect(res.status).toBe(400)
			const json = (await res.json()) as {
				error: { code: string; message: string }
			}
			expect(json.error.code).toBe("VALIDATION_ERROR")
			expect(json.error.message).toContain("filter")
		}
		expect(
			bridgeMocks.memongoBridgeSearchKBWithDegradation,
		).not.toHaveBeenCalled()
	})

	it("/v1/search-kb accepts a typed filter and forwards it", async () => {
		const res = await postJson("/v1/search-kb", {
			query: "architecture",
			filter: { tags: ["db"], category: "runbook" },
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeSearchKBWithDegradation,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: { tags: ["db"], category: "runbook" },
			}),
		)
	})

	it("fuzz sweep: wrong-typed fields on the main write routes return 400, never 500", async () => {
		const cases: Array<{ path: string; body: Record<string, unknown> }> = [
			{ path: "/v1/add", body: { content: 42 } },
			{ path: "/v1/add", body: { content: "x", metadata: "nope" } },
			{ path: "/v1/write-event", body: { role: "bogus", body: "x" } },
			{ path: "/v1/write-event", body: { role: "user", body: 42 } },
			{ path: "/v1/write-structured", body: { entry: "nope" } },
			{
				path: "/v1/write-structured",
				body: { entry: { type: 1, key: "k", value: "v" } },
			},
			{
				path: "/v1/write-procedure",
				body: { entry: { procedureId: "p", name: "n", steps: "nope" } },
			},
		]
		for (const { path, body } of cases) {
			const res = await postJson(path, body)
			expect(res.status, `${path} with ${JSON.stringify(body)}`).toBe(400)
			const json = (await res.json()) as {
				error: { code: string; message: string }
			}
			expect(json.error.code).toBe("VALIDATION_ERROR")
		}
	})
})
