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
	memongoBridgeSearch: vi.fn(),
	memongoBridgeSearchDetailed: vi.fn(),
	memongoBridgeSearchKB: vi.fn(),
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
		bridgeMocks.memongoBridgeSearch.mockReset()
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
		bridgeMocks.memongoBridgeSearch.mockResolvedValue([])
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

	it("forwards the Idempotency-Key header to write-event (header wins over customId)", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": "hdr-key-1",
			},
			body: JSON.stringify({
				role: "user",
				body: "hello",
				agentId: "agent-42",
				customId: "body-key-1",
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "hdr-key-1" }),
		)
	})

	it("forwards customId as the idempotency key when no header is present", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "user",
				body: "hello",
				agentId: "agent-42",
				customId: "body-key-2",
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "body-key-2" }),
		)
	})

	it("forwards customId on /v1/add", async () => {
		const res = await createApp().request("/v1/add", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "remember this",
				agentId: "agent-42",
				customId: "add-key-1",
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeAdd).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: "add-key-1" }),
		)
	})

	it("returns 422 when an idempotency key is reused with a different payload", async () => {
		bridgeMocks.memongoBridgeWriteConversationEvent.mockRejectedValue(
			Object.assign(
				new Error(
					'idempotency key "body-key-3" was reused with a different payload',
				),
				{ name: "IdempotencyConflictError" },
			),
		)

		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "user",
				body: "hello again",
				agentId: "agent-42",
				customId: "body-key-3",
			}),
		})

		expect(res.status).toBe(422)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "IDEMPOTENCY_CONFLICT",
				message:
					'idempotency key "body-key-3" was reused with a different payload',
			},
		})
	})

	it("forwards expiresAt on /v1/write-event (B1)", async () => {
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "user",
				body: "session-scoped note",
				expiresAt,
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }))
	})

	it("returns 400 for an invalid expiresAt on /v1/write-event (B1)", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "user",
				body: "hello",
				expiresAt: "not-a-date",
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "expiresAt must be a valid date string when provided",
			},
		})
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).not.toHaveBeenCalled()
	})

	it("returns 400 for a past expiresAt on /v1/write-event (B1)", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "user",
				body: "hello",
				expiresAt: new Date(Date.now() - 1_000).toISOString(),
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "expiresAt must be in the future",
			},
		})
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).not.toHaveBeenCalled()
	})

	it("forwards expiresAt on /v1/add (B1)", async () => {
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
		const res = await createApp().request("/v1/add", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "remember briefly", expiresAt }),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeAdd).toHaveBeenCalledWith(
			expect.objectContaining({ expiresAt }),
		)
	})

	it("returns 400 for an invalid expiresAt on /v1/add (B1)", async () => {
		const res = await createApp().request("/v1/add", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "remember briefly", expiresAt: 42 }),
		})

		expect(res.status).toBe(400)
		expect(bridgeMocks.memongoBridgeAdd).not.toHaveBeenCalled()
	})

	it("forwards per-item expiresAt on /v1/write-events (B1)", async () => {
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
		bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockResolvedValue([
			{ ok: true, eventId: "evt-1", chunkCreated: true },
		])

		const res = await createApp().request("/v1/write-events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				events: [{ role: "user", body: "one", expiresAt }],
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEventsBatch,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				events: [expect.objectContaining({ expiresAt })],
			}),
		)
	})

	it("fails only the item with an invalid expiresAt on /v1/write-events (B1)", async () => {
		bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockResolvedValue([
			{ ok: true, eventId: "evt-2", chunkCreated: true },
		])

		const res = await createApp().request("/v1/write-events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				events: [
					{ role: "user", body: "bad", expiresAt: "not-a-date" },
					{ role: "user", body: "good" },
				],
			}),
		})

		expect(res.status).toBe(200)
		const payload = (await res.json()) as {
			receipts: Array<Record<string, unknown>>
		}
		expect(payload.receipts[0]).toEqual({
			ok: false,
			code: "VALIDATION_ERROR",
			message: "expiresAt must be a valid date string when provided",
		})
		expect(payload.receipts[1]).toEqual({
			ok: true,
			eventId: "evt-2",
			chunkCreated: true,
		})
	})

	it("forwards entry.expiresAt as a Date on /v1/write-structured (B1)", async () => {
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockReset()
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockResolvedValue({
			id: "s1",
		})
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString()

		const res = await createApp().request("/v1/write-structured", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				entry: {
					type: "fact",
					key: "temporary-fact",
					value: "expires soon",
					expiresAt,
				},
			}),
		})

		expect(res.status).toBe(200)
		const call =
			bridgeMocks.memongoBridgeWriteStructuredMemory.mock.calls[0]?.[0]
		expect(call?.entry?.expiresAt).toBeInstanceOf(Date)
		expect((call?.entry?.expiresAt as Date).toISOString()).toBe(expiresAt)
	})

	it("returns 400 for an invalid entry.expiresAt on /v1/write-structured (B1)", async () => {
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockReset()
		const res = await createApp().request("/v1/write-structured", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				entry: {
					type: "fact",
					key: "temporary-fact",
					value: "expires soon",
					expiresAt: "not-a-date",
				},
			}),
		})

		expect(res.status).toBe(400)
		expect(
			bridgeMocks.memongoBridgeWriteStructuredMemory,
		).not.toHaveBeenCalled()
	})

	it("returns 400 for a past entry.expiresAt on /v1/write-structured (B1)", async () => {
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockReset()
		const res = await createApp().request("/v1/write-structured", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				entry: {
					type: "fact",
					key: "temporary-fact",
					value: "expires soon",
					expiresAt: new Date(Date.now() - 1_000).toISOString(),
				},
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "entry.expiresAt must be in the future",
			},
		})
		expect(
			bridgeMocks.memongoBridgeWriteStructuredMemory,
		).not.toHaveBeenCalled()
	})

	it("returns a safe 500 envelope without leaking driver internals (P0.8)", async () => {
		bridgeMocks.memongoBridgeSearch.mockRejectedValue(
			Object.assign(
				new Error(
					"MongoServerError: connection to 10.0.0.5:27017 timed out at /data/db",
				),
				{ name: "MongoServerError" },
			),
		)

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "q", agentId: "agent-42" }),
		})

		expect(res.status).toBe(500)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("SEARCH_FAILED")
		expect(body.error.message).not.toContain("10.0.0.5")
		expect(body.error.message).not.toContain("27017")
		expect(body.error.message).not.toContain("MongoServerError")
		expect(body.error.message).not.toContain("/data/db")
		// Detail is logged server-side under a request id; the body carries
		// only the reference so operators can correlate reports.
		expect(body.error.message).toMatch(
			/internal server error \(request id: [0-9a-f-]{36}\)/i,
		)
	})

	it("returns a safe 500 envelope on /v1/add without leaking internals (P0.8)", async () => {
		bridgeMocks.memongoBridgeAdd.mockRejectedValue(
			new Error(
				"E11000 duplicate key error collection: memongo_events index: uq_x",
			),
		)

		const res = await createApp().request("/v1/add", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "hello", agentId: "agent-42" }),
		})

		expect(res.status).toBe(500)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("ADD_FAILED")
		expect(body.error.message).not.toContain("E11000")
		expect(body.error.message).not.toContain("memongo_events")
		expect(body.error.message).toMatch(
			/internal server error \(request id: [0-9a-f-]{36}\)/i,
		)
	})

	it("returns a safe 500 envelope on GET routes too (P0.8)", async () => {
		bridgeMocks.memongoBridgeStatus.mockRejectedValue(
			new Error(
				"MongoNetworkTimeoutError: connection 5 to 127.0.0.1:27017 closed",
			),
		)

		const res = await createApp().request("/v1/status?agentId=agent-42")

		expect(res.status).toBe(500)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("STATUS_FAILED")
		expect(body.error.message).not.toContain("27017")
		expect(body.error.message).not.toContain("MongoNetworkTimeoutError")
	})

	it("forwards a valid fusionMethod on /v1/search-kb (P0.10)", async () => {
		const res = await createApp().request("/v1/search-kb", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "architecture",
				agentId: "agent-42",
				fusionMethod: "scoreFusion",
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearchKB).toHaveBeenCalledWith(
			expect.objectContaining({ fusionMethod: "scoreFusion" }),
		)
	})

	it("ignores an invalid fusionMethod on /v1/search-kb (P0.10)", async () => {
		const res = await createApp().request("/v1/search-kb", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "architecture",
				agentId: "agent-42",
				fusionMethod: "made-up",
			}),
		})

		expect(res.status).toBe(200)
		const call = bridgeMocks.memongoBridgeSearchKB.mock.calls.at(-1)?.[0] as {
			fusionMethod?: string
		}
		expect(call.fusionMethod).toBeUndefined()
	})

	it("schedules background extraction for one event", async () => {
		const res = await createApp().request("/v1/extract", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ eventId: "evt-1", agentId: "agent-42" }),
		})

		expect(res.status).toBe(202)
		await expect(res.json()).resolves.toEqual({
			ok: true,
			jobId: "extraction-evt-1",
			scheduled: true,
		})
		expect(bridgeMocks.memongoBridgeExtractEvent).toHaveBeenCalledWith({
			agentId: "agent-42",
			eventId: "evt-1",
		})
	})

	it("rejects extract when eventId is missing", async () => {
		const res = await createApp().request("/v1/extract", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: { code: "VALIDATION_ERROR", message: "eventId is required" },
		})
	})

	it("lists memory jobs via jobs route", async () => {
		bridgeMocks.memongoBridgeListMemoryJobs.mockResolvedValue([
			{
				jobId: "consolidation-1",
				jobType: "consolidation",
				agentId: "agent-42",
				status: "running",
				createdAt: "2026-04-09T12:00:00.000Z",
			},
		])

		const res = await createApp().request(
			"/v1/jobs?agentId=agent-42&status=running&jobType=consolidation&limit=10",
		)

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual([
			expect.objectContaining({ jobId: "consolidation-1" }),
		])
		expect(bridgeMocks.memongoBridgeListMemoryJobs).toHaveBeenCalledWith({
			agentId: "agent-42",
			status: "running",
			limit: 10,
			jobType: "consolidation",
		})
	})

	it("clamps memory jobs list limit to 100", async () => {
		await createApp().request(
			"/v1/jobs?agentId=agent-42&status=running&limit=999999999",
		)

		expect(bridgeMocks.memongoBridgeListMemoryJobs).toHaveBeenCalledWith({
			agentId: "agent-42",
			status: "running",
			limit: 100,
			jobType: undefined,
		})
	})

	it("gets one memory job via jobs route", async () => {
		bridgeMocks.memongoBridgeGetMemoryJob.mockResolvedValue({
			jobId: "consolidation-1",
			jobType: "consolidation",
			agentId: "agent-42",
			status: "completed",
			createdAt: "2026-04-09T12:00:00.000Z",
		})

		const res = await createApp().request(
			"/v1/jobs/consolidation-1?agentId=agent-42",
		)

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({ jobId: "consolidation-1" }),
		)
		expect(bridgeMocks.memongoBridgeGetMemoryJob).toHaveBeenCalledWith({
			agentId: "agent-42",
			jobId: "consolidation-1",
		})
	})

	it("rejects chain-trace when factId is missing", async () => {
		const res = await createApp().request("/v1/chain-trace", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ collection: "structured" }),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: { code: "VALIDATION_ERROR", message: "factId is required" },
		})
	})

	it("rejects chain-trace when collection is missing", async () => {
		const res = await createApp().request("/v1/chain-trace", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ factId: "fact-1" }),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: { code: "VALIDATION_ERROR", message: "collection is required" },
		})
	})

	it("scans for novel observations via novelty-scan", async () => {
		bridgeMocks.memongoBridgeScanNovelty.mockResolvedValue({
			novelItems: [
				{ id: "evt-1", body: "surprising observation", surprisal: 0.95 },
			],
			totalScanned: 50,
		})

		const res = await createApp().request("/v1/novelty-scan", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				limit: 10,
				scope: "workspace",
			}),
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json).toEqual(
			expect.objectContaining({
				novelItems: expect.any(Array),
				totalScanned: 50,
			}),
		)
		expect(bridgeMocks.memongoBridgeScanNovelty).toHaveBeenCalledWith({
			agentId: "agent-42",
			limit: 10,
			scope: "workspace",
		})
	})

	it("runs dreamer consolidation via consolidate", async () => {
		bridgeMocks.memongoBridgeConsolidate.mockResolvedValue({
			factsExtracted: 3,
			eventsProcessed: 10,
			skipped: 2,
		})

		const res = await createApp().request("/v1/consolidate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				maxEvents: 20,
				minCombinedScore: 0.15,
				resolveContradictions: false,
				llmDedup: true,
				scope: "workspace",
			}),
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json).toEqual(
			expect.objectContaining({
				factsExtracted: 3,
				eventsProcessed: 10,
			}),
		)
		expect(bridgeMocks.memongoBridgeConsolidate).toHaveBeenCalledWith({
			agentId: "agent-42",
			maxEvents: 20,
			minCombinedScore: 0.15,
			resolveContradictions: false,
			llmDedup: true,
			scope: "workspace",
		})
	})

	it.each([
		["resolveContradictions", "false"],
		["llmDedup", 1],
	])("rejects malformed consolidate %s", async (field, value) => {
		const res = await createApp().request("/v1/consolidate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ [field]: value }),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: `${field} must be a boolean when provided`,
			},
		})
		expect(bridgeMocks.memongoBridgeConsolidate).not.toHaveBeenCalled()
	})

	it("edits core memory block via self-edit", async () => {
		bridgeMocks.memongoBridgeSelfEdit.mockResolvedValue({
			upserted: true,
			id: "core:user",
		})

		const res = await createApp().request("/v1/self-edit", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				block: "user",
				action: "append",
				content: "User prefers dark mode",
			}),
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json).toEqual(
			expect.objectContaining({
				upserted: true,
				id: "core:user",
			}),
		)
		expect(bridgeMocks.memongoBridgeSelfEdit).toHaveBeenCalledWith({
			agentId: "agent-42",
			block: "user",
			action: "append",
			content: "User prefers dark mode",
		})
	})

	it("rejects self-edit when block is missing", async () => {
		const res = await createApp().request("/v1/self-edit", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "replace", content: "test" }),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "block must be user|persona|instructions",
			},
		})
	})

	it("rejects self-edit when content is missing", async () => {
		const res = await createApp().request("/v1/self-edit", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ block: "user", action: "replace" }),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: { code: "VALIDATION_ERROR", message: "content is required" },
		})
	})

	it("forwards searchDetailed request options and returns bridge metadata", async () => {
		bridgeMocks.memongoBridgeSearchDetailed.mockResolvedValue({
			results: [
				{
					path: "structured:decision:phoenix",
					startLine: 0,
					endLine: 0,
					snippet: "exact answer",
					score: 0.92,
					source: "structured",
				},
			],
			metadata: {
				mode: "agentic",
				classification: "temporal",
				sourceOrder: ["structured", "conversation"],
				resolvedSearchConfig: {
					recipe: "deep",
					recallProfile: "balanced",
					maxResults: 4,
					searchMode: "agentic",
					maxPasses: 3,
					sourcePreference: ["structured", "conversation"],
					needExactEvidence: true,
					numCandidates: 60,
					fusionMethod: "rankFusion",
					hybridMode: "hybrid",
					allowHybridBackstop: true,
					lexicalPrefilter: "disabled",
				},
				passes: [
					{
						pass: 1,
						query: "what changed",
						reason: "baseline",
						pathsExecuted: ["structured"],
						resultCount: 1,
						queryRewritten: false,
						reranked: true,
					},
				],
				queriesTried: ["what changed"],
				constraintsApplied: ["scope:workspace"],
				resultsRejected: [],
				evidenceCoverage: "direct",
				pathsExecuted: ["structured"],
				resultsByPath: { structured: 1 },
				queryRewritten: false,
				reranked: true,
			},
		})

		const res = await createApp().request("/v1/search-detailed", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "what changed",
				agentId: "agent-42",
				scope: "workspace",
				scopeRef: "/workspace/memongo",
				limit: 4,
				minScore: 0.4,
				searchMode: "agentic",
				sourcePreference: ["structured", "conversation"],
				timeRange: {
					preset: "last-7d",
					start: "2026-04-01T00:00:00.000Z",
					end: "2026-04-05T00:00:00.000Z",
				},
				needExactEvidence: true,
				maxPasses: 3,
				returnPlan: true,
				conversationScope: { sessionKey: "session-9" },
				structuredScope: {
					type: "decision",
					state: ["active"],
					salience: ["high"],
				},
				referenceScope: {
					source: "kb",
					category: "runbook",
					tags: ["memory"],
				},
				proceduralScope: {
					state: "active",
					intentTags: ["recall"],
				},
				searchConfig: {
					recipe: "deep",
					numCandidates: 60,
					fusionMethod: "rankFusion",
				},
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({
			results: [
				{
					path: "structured:decision:phoenix",
					startLine: 0,
					endLine: 0,
					snippet: "exact answer",
					score: 0.92,
					source: "structured",
				},
			],
			metadata: expect.objectContaining({
				mode: "agentic",
				classification: "temporal",
				resolvedSearchConfig: expect.objectContaining({
					recipe: "deep",
					fusionMethod: "rankFusion",
				}),
			}),
		})
		expect(bridgeMocks.memongoBridgeSearchDetailed).toHaveBeenCalledWith({
			query: "what changed",
			agentId: "agent-42",
			scope: "workspace",
			scopeRef: "/workspace/memongo",
			maxResults: 4,
			minScore: 0.4,
			searchMode: "agentic",
			sourcePreference: ["structured", "conversation"],
			timeRange: {
				preset: "last-7d",
				start: "2026-04-01T00:00:00.000Z",
				end: "2026-04-05T00:00:00.000Z",
			},
			needExactEvidence: true,
			maxPasses: 3,
			returnPlan: true,
			conversationScope: { sessionKey: "session-9" },
			structuredScope: {
				type: "decision",
				state: ["active"],
				salience: ["high"],
			},
			referenceScope: {
				source: "kb",
				category: "runbook",
				tags: ["memory"],
			},
			proceduralScope: {
				state: "active",
				intentTags: ["recall"],
			},
			searchConfig: {
				recipe: "deep",
				numCandidates: 60,
				fusionMethod: "rankFusion",
			},
		})
	})
})
