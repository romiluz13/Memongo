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
	memongoBridgeListQuarantined: vi.fn(),
	memongoBridgeListRecallTraces: vi.fn(),
	memongoBridgeProbeEmbedding: vi.fn(),
	memongoBridgeProbeVector: vi.fn(),
	memongoBridgePromoteQuarantined: vi.fn(),
	memongoBridgeCapabilities: vi.fn(),
	memongoBridgeProfile: vi.fn(),
	memongoBridgeRecallConversation: vi.fn(),
	memongoBridgeReadFile: vi.fn(),
	memongoBridgeRelevanceExplain: vi.fn(),
	memongoBridgeRelevanceReport: vi.fn(),
	memongoBridgeRelevanceSampleRate: vi.fn(),
	memongoBridgeRejectQuarantined: vi.fn(),
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
		bridgeMocks.memongoBridgeListQuarantined.mockReset()
		bridgeMocks.memongoBridgeListRecallTraces.mockReset()
		bridgeMocks.memongoBridgeStatus.mockReset()
		bridgeMocks.memongoBridgeTraceChain.mockReset()
		bridgeMocks.memongoBridgeScanNovelty.mockReset()
		bridgeMocks.memongoBridgeConsolidate.mockReset()
		bridgeMocks.memongoBridgeSelfEdit.mockReset()
		bridgeMocks.memongoBridgePingMongo.mockReset()
		bridgeMocks.memongoBridgePromoteQuarantined.mockReset()
		bridgeMocks.memongoBridgeRejectQuarantined.mockReset()
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

	describe("/v1/write-events (P3.9 bulk write)", () => {
		function postBatch(body: unknown, headers?: Record<string, string>) {
			return createApp().request("/v1/write-events", {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify(body),
			})
		}

		it("writes a batch in ONE bridge call and returns per-item receipts", async () => {
			const res = await postBatch({
				agentId: "codex",
				events: [
					{ role: "user", body: "first event", sessionId: "s-1" },
					{
						role: "assistant",
						body: "second event",
						customId: "key-2",
						scope: "agent",
					},
				],
			})

			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json).toEqual({
				ok: true,
				receipts: [
					{ ok: true, eventId: "evt-batch-0", chunkCreated: true },
					{ ok: true, eventId: "evt-batch-1", chunkCreated: true },
				],
			})
			expect(
				bridgeMocks.memongoBridgeWriteConversationEventsBatch,
			).toHaveBeenCalledTimes(1)
			expect(
				bridgeMocks.memongoBridgeWriteConversationEventsBatch,
			).toHaveBeenCalledWith({
				agentId: "codex",
				events: [
					expect.objectContaining({
						role: "user",
						body: "first event",
						sessionId: "s-1",
					}),
					expect.objectContaining({
						role: "assistant",
						body: "second event",
						scope: "agent",
						idempotencyKey: "key-2",
					}),
				],
			})
		})

		it("maps a per-item idempotency conflict to a receipt entry, not a batch error", async () => {
			bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockResolvedValue([
				{
					ok: false,
					code: "IDEMPOTENCY_CONFLICT",
					message:
						'idempotency key "key-c" was reused with a different payload',
				},
				{ ok: true, eventId: "evt-new", chunkCreated: true },
			])

			const res = await postBatch({
				events: [
					{ role: "user", body: "conflicting payload", customId: "key-c" },
					{ role: "user", body: "fresh event" },
				],
			})

			expect(res.status).toBe(200)
			const json = (await res.json()) as {
				receipts: Array<Record<string, unknown>>
			}
			expect(json.receipts[0]).toEqual({
				ok: false,
				code: "IDEMPOTENCY_CONFLICT",
				message: 'idempotency key "key-c" was reused with a different payload',
			})
			expect(json.receipts[1]).toEqual({
				ok: true,
				eventId: "evt-new",
				chunkCreated: true,
			})
		})

		it("isolates per-item validation failures and still writes the valid items", async () => {
			const res = await postBatch({
				events: [
					{ role: "bogus", body: "bad role" },
					{ role: "user", body: "good event" },
					{ role: "user", body: "" },
					{ role: "user", body: "bad dates", timestamp: "not-a-date" },
				],
			})

			expect(res.status).toBe(200)
			const json = (await res.json()) as {
				ok: boolean
				receipts: Array<Record<string, unknown>>
			}
			expect(json.ok).toBe(true)
			expect(json.receipts).toHaveLength(4)
			expect(json.receipts[0]).toMatchObject({
				ok: false,
				code: "VALIDATION_ERROR",
			})
			expect(json.receipts[1]).toMatchObject({
				ok: true,
				eventId: "evt-batch-0",
			})
			expect(json.receipts[2]).toMatchObject({
				ok: false,
				code: "VALIDATION_ERROR",
			})
			expect(json.receipts[3]).toMatchObject({
				ok: false,
				code: "VALIDATION_ERROR",
			})
			// Only the valid item reached the engine.
			expect(
				bridgeMocks.memongoBridgeWriteConversationEventsBatch,
			).toHaveBeenCalledTimes(1)
			const call =
				bridgeMocks.memongoBridgeWriteConversationEventsBatch.mock.calls[0][0]
			expect(call.events).toHaveLength(1)
			expect(call.events[0]).toMatchObject({ body: "good event" })
		})

		it("rejects a malformed envelope with 400 and skips the bridge", async () => {
			for (const body of [
				{},
				{ events: [] },
				{ events: "not-an-array" },
				{
					events: Array.from({ length: 501 }, () => ({
						role: "user",
						body: "x",
					})),
				},
			]) {
				const res = await postBatch(body)
				expect(res.status).toBe(400)
			}
			expect(
				bridgeMocks.memongoBridgeWriteConversationEventsBatch,
			).not.toHaveBeenCalled()
		})

		it("rejects per-item tenant fields that contradict the authorized identity", async () => {
			const res = await postBatch({
				scope: "agent",
				scopeRef: "agent:codex",
				sessionId: "s-auth",
				events: [
					{ role: "user", body: "matching event", scope: "agent" },
					{
						role: "user",
						body: "cross-scope smuggle",
						scope: "tenant",
					},
					{
						role: "user",
						body: "cross-session smuggle",
						sessionId: "s-other",
					},
					{
						role: "user",
						body: "cross-scoperef smuggle",
						scopeRef: "agent:other",
					},
				],
			})

			expect(res.status).toBe(200)
			const json = (await res.json()) as {
				receipts: Array<Record<string, unknown>>
			}
			expect(json.receipts[0]).toMatchObject({ ok: true })
			expect(json.receipts[1]).toMatchObject({
				ok: false,
				code: "VALIDATION_ERROR",
			})
			expect(json.receipts[2]).toMatchObject({
				ok: false,
				code: "VALIDATION_ERROR",
			})
			expect(json.receipts[3]).toMatchObject({
				ok: false,
				code: "VALIDATION_ERROR",
			})
			const call =
				bridgeMocks.memongoBridgeWriteConversationEventsBatch.mock.calls[0][0]
			expect(call.events).toHaveLength(1)
			expect(call.events[0]).toMatchObject({
				scope: "agent",
				scopeRef: "agent:codex",
				sessionId: "s-auth",
			})
		})

		it("rejects operator-shaped metadata keys per item", async () => {
			const res = await postBatch({
				events: [
					{ role: "user", body: "ok event" },
					{
						role: "user",
						body: "operator smuggle",
						metadata: { $where: "x" },
					},
				],
			})

			expect(res.status).toBe(200)
			const json = (await res.json()) as {
				receipts: Array<Record<string, unknown>>
			}
			expect(json.receipts[0]).toMatchObject({ ok: true })
			expect(json.receipts[1]).toMatchObject({
				ok: false,
				code: "VALIDATION_ERROR",
			})
		})

		it("enforces the same bearer auth as the single-write route", async () => {
			process.env.MEMONGO_API_KEY = "secret"

			const unauthorized = await postBatch({
				events: [{ role: "user", body: "unauthorized" }],
			})
			expect(unauthorized.status).toBe(401)

			const authorized = await postBatch(
				{ events: [{ role: "user", body: "authorized" }] },
				{ Authorization: "Bearer secret" },
			)
			expect(authorized.status).toBe(200)
		})

		it("maps a bridge failure to 500", async () => {
			bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockRejectedValue(
				new Error("engine exploded"),
			)

			const res = await postBatch({
				events: [{ role: "user", body: "event" }],
			})

			expect(res.status).toBe(500)
			const json = (await res.json()) as { error: { code: string } }
			expect(json.error.code).toBe("WRITE_EVENTS_FAILED")
		})
	})

	it("rejects invalid scope values before calling the bridge", async () => {
		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "scoped launch note",
				scope: "project",
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "scope must be session|user|agent|workspace|tenant|global",
			},
		})
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("rejects invalid search-detailed scope values before calling the bridge", async () => {
		const res = await createApp().request("/v1/search-detailed", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "scoped launch note",
				scope: "project",
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "scope must be session|user|agent|workspace|tenant|global",
			},
		})
		expect(bridgeMocks.memongoBridgeSearchDetailed).not.toHaveBeenCalled()
	})

	it("rejects user and tenant scopes without scopeRef", async () => {
		const res = await createApp().request("/v1/add", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "remember this for a tenant",
				scope: "tenant",
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "tenant scope requires scopeRef",
			},
		})
		expect(bridgeMocks.memongoBridgeAdd).not.toHaveBeenCalled()
	})

	it("rejects state user scope without scopeRef", async () => {
		const res = await createApp().request("/v1/state?scope=user")

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "user scope requires scopeRef",
			},
		})
		expect(bridgeMocks.memongoBridgeGetState).not.toHaveBeenCalled()
	})

	it("forwards profile scope when provided", async () => {
		const res = await createApp().request("/v1/profile", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				scope: "session",
				scopeRef: "session:demo",
				maxEpisodes: 3,
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeProfile).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "session",
				scopeRef: "session:demo",
				maxEpisodes: 3,
			}),
		)
	})

	it("forwards hydrate-active-slate requests with explicit scope", async () => {
		bridgeMocks.memongoBridgeHydrateActiveSlate.mockResolvedValue({
			agentId: "agent-42",
			scope: "workspace",
			scopeRef: "workspace:demo",
			items: [
				{
					kind: "active-critical",
					title: "blocker-db-migration",
					summary: "Database migration is blocked on rollout approval.",
					path: "structured:todo:blocker-db-migration?scope=workspace&scopeRef=workspace%3Ademo",
					source: "structured",
					scope: "workspace",
					scopeRef: "workspace:demo",
				},
			],
			metadata: {
				maxItems: 4,
				truncated: false,
				partial: false,
				countsByKind: { "active-critical": 1 },
				sourceCounts: { structured: 1 },
			},
			hydratedAt: "2026-04-05T12:00:00.000Z",
		})

		const res = await createApp().request("/v1/hydrate-active-slate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				scope: "workspace",
				scopeRef: "workspace:demo",
				maxItems: 4,
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({
			agentId: "agent-42",
			scope: "workspace",
			scopeRef: "workspace:demo",
			items: [
				expect.objectContaining({
					kind: "active-critical",
					source: "structured",
				}),
			],
			metadata: expect.objectContaining({
				maxItems: 4,
			}),
			hydratedAt: "2026-04-05T12:00:00.000Z",
		})
		expect(bridgeMocks.memongoBridgeHydrateActiveSlate).toHaveBeenCalledWith({
			agentId: "agent-42",
			scope: "workspace",
			scopeRef: "workspace:demo",
			maxItems: 4,
		})
	})

	it("forwards discovery projection requests and returns projection metadata", async () => {
		bridgeMocks.memongoBridgeBuildDiscoveryProjection.mockResolvedValue({
			kind: "what-changed",
			query: "routing",
			title: "What changed for routing",
			summary: "Two durable updates were recorded in the last 7 days.",
			scope: "workspace",
			scopeRef: "workspace:demo",
			sections: [
				{
					title: "Structured changes",
					summary: "One superseded decision was found.",
					evidence: [
						{
							title: "routing-policy",
							summary: "Old routing policy",
							path: "structured:decision:routing-policy?scope=workspace&scopeRef=workspace%3Ademo",
							source: "structured",
						},
					],
				},
			],
			metadata: {
				partial: false,
				evidenceCount: 1,
				sourceCounts: { structured: 1 },
				timeRange: {
					label: "last-7d",
					start: "2026-03-29T12:00:00.000Z",
					end: "2026-04-05T12:00:00.000Z",
				},
			},
			builtAt: "2026-04-05T12:00:00.000Z",
		})

		const res = await createApp().request("/v1/discovery-projection", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				kind: "what-changed",
				query: "routing",
				scope: "workspace",
				scopeRef: "workspace:demo",
				maxItems: 4,
				timeRange: { preset: "last-7d" },
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({
			kind: "what-changed",
			query: "routing",
			title: "What changed for routing",
			summary: "Two durable updates were recorded in the last 7 days.",
			scope: "workspace",
			scopeRef: "workspace:demo",
			sections: expect.any(Array),
			metadata: expect.objectContaining({
				evidenceCount: 1,
			}),
			builtAt: "2026-04-05T12:00:00.000Z",
		})
		expect(
			bridgeMocks.memongoBridgeBuildDiscoveryProjection,
		).toHaveBeenCalledWith({
			agentId: "agent-42",
			kind: "what-changed",
			query: "routing",
			scope: "workspace",
			scopeRef: "workspace:demo",
			maxItems: 4,
			timeRange: { preset: "last-7d" },
		})
	})

	it("forwards context bundle requests and returns bundle metadata", async () => {
		bridgeMocks.memongoBridgeBuildContextBundle.mockResolvedValue({
			agentId: "agent-42",
			query: "Phoenix handoff",
			scope: "agent",
			scopeRef: "agent:main",
			sessionId: "session-main",
			rendered: "## Active Slate\n- blocker",
			sections: [
				{
					kind: "active-slate",
					title: "Active Slate",
					items: [
						{
							title: "blocker-db-migration",
							summary: "Database migration is blocked on rollout approval.",
							source: "structured",
						},
					],
					estimatedTokens: 18,
					truncated: false,
					partial: false,
				},
			],
			metadata: {
				tokenBudget: 320,
				estimatedTokensUsed: 18,
				partial: false,
				truncated: false,
				pathsExecuted: ["active-slate", "structured"],
				sectionsIncluded: ["active-slate"],
			},
			builtAt: "2026-04-05T12:00:00.000Z",
		})

		const res = await createApp().request("/v1/context-bundle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				query: "Phoenix handoff",
				scope: "agent",
				scopeRef: "agent:main",
				sessionId: "session-main",
				tokenBudget: 320,
				maxEvidenceItems: 3,
				includeDiscoveryProjection: true,
				discoveryKind: "topic-brief",
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({
			agentId: "agent-42",
			query: "Phoenix handoff",
			scope: "agent",
			scopeRef: "agent:main",
			sessionId: "session-main",
			rendered: "## Active Slate\n- blocker",
			sections: expect.any(Array),
			metadata: expect.objectContaining({
				tokenBudget: 320,
				pathsExecuted: ["active-slate", "structured"],
			}),
			builtAt: "2026-04-05T12:00:00.000Z",
		})
		expect(bridgeMocks.memongoBridgeBuildContextBundle).toHaveBeenCalledWith({
			agentId: "agent-42",
			query: "Phoenix handoff",
			scope: "agent",
			scopeRef: "agent:main",
			sessionId: "session-main",
			tokenBudget: 320,
			maxActiveItems: undefined,
			maxEvidenceItems: 3,
			maxRecentEvents: undefined,
			includeDiscoveryProjection: true,
			discoveryKind: "topic-brief",
			includeProfile: undefined,
			timeRange: undefined,
			mode: undefined,
		})
	})

	it("forwards wake-up mode for context bundle requests", async () => {
		const res = await createApp().request("/v1/context-bundle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				scope: "workspace",
				scopeRef: "workspace:demo",
				mode: "wake-up",
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeBuildContextBundle).toHaveBeenCalledWith({
			agentId: "agent-42",
			query: undefined,
			scope: "workspace",
			scopeRef: "workspace:demo",
			sessionId: undefined,
			tokenBudget: undefined,
			maxActiveItems: undefined,
			maxEvidenceItems: undefined,
			maxRecentEvents: undefined,
			includeDiscoveryProjection: undefined,
			discoveryKind: undefined,
			includeProfile: undefined,
			timeRange: undefined,
			mode: "wake-up",
		})
	})

	it("forwards state route requests to the canonical bridge method", async () => {
		bridgeMocks.memongoBridgeGetState.mockResolvedValue({
			profile: { profile: [] },
			blocks: {
				blocks: [
					{
						label: "working-memory",
						title: "Current work",
						content: "Finish packaging alignment",
						tokenBudget: 120,
						actualTokens: 24,
						sourcePaths: ["structured:task:packaging-alignment"],
					},
				],
				totalTokenBudget: 120,
				totalActualTokens: 24,
			},
			bundle: {
				agentId: "agent-42",
				scope: "workspace",
				scopeRef: "workspace:demo",
				rendered: "## Wake-up\nContinue packaging alignment.",
				sections: [],
				metadata: {
					tokenBudget: 320,
					estimatedTokensUsed: 24,
					partial: false,
					truncated: false,
					pathsExecuted: ["active-slate"],
					sectionsIncluded: ["active-slate"],
				},
				builtAt: "2026-04-05T12:00:00.000Z",
			},
		})

		const res = await createApp().request(
			"/v1/state?agentId=agent-42&scope=workspace&scopeRef=workspace%3Ademo",
		)

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({
				blocks: expect.objectContaining({
					blocks: expect.arrayContaining([
						expect.objectContaining({
							label: "working-memory",
						}),
					]),
				}),
			}),
		)
		expect(bridgeMocks.memongoBridgeGetState).toHaveBeenCalledWith({
			agentId: "agent-42",
			scope: "workspace",
			scopeRef: "workspace:demo",
		})
	})

	it("traces reasoning chain for a fact via chain-trace", async () => {
		bridgeMocks.memongoBridgeTraceChain.mockResolvedValue({
			factId: "fact-1",
			collection: "structured_mem",
			chain: [
				{ id: "fact-1", content: "root fact", depth: 0, sourceIds: ["fact-0"] },
			],
			depth: 1,
		})

		const res = await createApp().request("/v1/chain-trace", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				factId: "fact-1",
				collection: "structured_mem",
				agentId: "agent-42",
				maxDepth: 3,
			}),
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json).toEqual(
			expect.objectContaining({
				factId: "fact-1",
				collection: "structured_mem",
			}),
		)
		expect(bridgeMocks.memongoBridgeTraceChain).toHaveBeenCalledWith({
			agentId: "agent-42",
			factId: "fact-1",
			collection: "structured_mem",
			maxDepth: 3,
		})
	})

	it("lists recall traces via admin route", async () => {
		bridgeMocks.memongoBridgeListRecallTraces.mockResolvedValue([
			{
				traceId: "trace-1",
				agentId: "agent-42",
				query: "phoenix",
				timestamp: "2026-04-09T12:00:00.000Z",
				lanesUsed: ["structured"],
			},
		])

		const res = await createApp().request(
			"/v1/admin/traces?agentId=agent-42&limit=5",
		)

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual([
			expect.objectContaining({ traceId: "trace-1" }),
		])
		expect(bridgeMocks.memongoBridgeListRecallTraces).toHaveBeenCalledWith({
			agentId: "agent-42",
			limit: 5,
		})
	})

	it("clamps recall trace list limit to 100", async () => {
		await createApp().request(
			"/v1/admin/traces?agentId=agent-42&limit=999999999",
		)

		expect(bridgeMocks.memongoBridgeListRecallTraces).toHaveBeenCalledWith({
			agentId: "agent-42",
			limit: 100,
		})
	})

	it("gets one recall trace via admin route", async () => {
		bridgeMocks.memongoBridgeGetRecallTrace.mockResolvedValue({
			traceId: "trace-1",
			agentId: "agent-42",
			query: "phoenix",
			timestamp: "2026-04-09T12:00:00.000Z",
		})

		const res = await createApp().request(
			"/v1/admin/traces/trace-1?agentId=agent-42",
		)

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({ traceId: "trace-1" }),
		)
		expect(bridgeMocks.memongoBridgeGetRecallTrace).toHaveBeenCalledWith({
			agentId: "agent-42",
			traceId: "trace-1",
		})
	})

	it("erases a tenant via admin route and returns the per-collection receipt", async () => {
		bridgeMocks.memongoBridgeDeleteAllForAgent.mockResolvedValue({
			agentId: "agent-42",
			status: "complete",
			receipts: [
				{ collection: "events", deleted: 12 },
				{ collection: "chunks", deleted: 30 },
			],
			mutationId: "mut-1",
			completedAt: "2026-08-15T00:00:00.000Z",
		})

		const res = await createApp().request("/v1/admin/erase", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirm: "erase", agentId: "agent-42" }),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({ agentId: "agent-42", status: "complete" }),
		)
		expect(bridgeMocks.memongoBridgeDeleteAllForAgent).toHaveBeenCalledWith({
			agentId: "agent-42",
		})
	})

	it("rejects tenant erasure without the literal confirm string", async () => {
		for (const body of [{}, { confirm: true }, { confirm: "yes" }]) {
			const res = await createApp().request("/v1/admin/erase", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			})
			expect(res.status).toBe(400)
			const json = (await res.json()) as { error: { code: string } }
			expect(json.error.code).toBe("VALIDATION_ERROR")
		}
		expect(bridgeMocks.memongoBridgeDeleteAllForAgent).not.toHaveBeenCalled()
	})

	it("returns ERASE_FAILED when the bridge throws", async () => {
		bridgeMocks.memongoBridgeDeleteAllForAgent.mockRejectedValue(
			new Error("wipe failed"),
		)

		const res = await createApp().request("/v1/admin/erase", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirm: "erase" }),
		})

		expect(res.status).toBe(500)
		const json = (await res.json()) as { error: { code: string } }
		expect(json.error.code).toBe("ERASE_FAILED")
	})

	it("rejects a scoped API key from the admin-only erase route", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-42"] },
		])
		bridgeMocks.memongoBridgeDeleteAllForAgent.mockResolvedValue({
			agentId: "agent-42",
			status: "complete",
			receipts: [],
			completedAt: "2026-08-15T00:00:00.000Z",
		})

		const res = await createApp().request("/v1/admin/erase", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ confirm: "erase", agentId: "agent-42" }),
		})

		expect(res.status).toBe(403)
		const json = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(json.error.code).toBe("FORBIDDEN")
		expect(json.error.message).toBe(
			"scoped API key cannot access an admin-only route",
		)
		expect(bridgeMocks.memongoBridgeDeleteAllForAgent).not.toHaveBeenCalled()
	})

	it("lists the quarantine review queue with status and limit filters", async () => {
		bridgeMocks.memongoBridgeListQuarantined.mockResolvedValue([
			{
				quarantineId: "q-1",
				agentId: "agent-42",
				content: "I prefer tabs over spaces",
				status: "pending-review",
				matchedPatterns: ["instruction-override"],
				createdAt: "2026-08-15T00:00:00.000Z",
			},
		])
		const res = await createApp().request(
			"/v1/admin/quarantine?agentId=agent-42&status=pending-review&limit=25",
		)
		expect(res.status).toBe(200)
		const json = (await res.json()) as Array<Record<string, unknown>>
		expect(json).toHaveLength(1)
		expect(json[0]).toMatchObject({
			quarantineId: "q-1",
			status: "pending-review",
		})
		expect(bridgeMocks.memongoBridgeListQuarantined).toHaveBeenCalledWith({
			agentId: "agent-42",
			status: "pending-review",
			limit: 25,
		})
	})

	it("drops an invalid quarantine status filter instead of erroring", async () => {
		bridgeMocks.memongoBridgeListQuarantined.mockResolvedValue([])
		const res = await createApp().request("/v1/admin/quarantine?status=garbage")
		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeListQuarantined).toHaveBeenCalledWith({
			agentId: undefined,
			status: undefined,
			limit: undefined,
		})
	})

	it("returns QUARANTINE_LIST_FAILED when the bridge throws", async () => {
		bridgeMocks.memongoBridgeListQuarantined.mockRejectedValue(
			new Error("queue read failed"),
		)
		const res = await createApp().request("/v1/admin/quarantine")
		expect(res.status).toBe(500)
		const json = (await res.json()) as { error: { code: string } }
		expect(json.error.code).toBe("QUARANTINE_LIST_FAILED")
	})

	it("promotes a quarantined memory with reviewer metadata", async () => {
		bridgeMocks.memongoBridgePromoteQuarantined.mockResolvedValue({
			quarantineId: "q-1",
			agentId: "agent-42",
			status: "promoted",
			reviewedAt: "2026-08-15T01:00:00.000Z",
			memoryId: "mem-1",
			mutationId: "mut-1",
		})
		const res = await createApp().request("/v1/admin/quarantine/promote", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				quarantineId: "q-1",
				agentId: "agent-42",
				reviewerId: "reviewer-7",
				reviewNotes: "false positive",
			}),
		})
		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({ status: "promoted", memoryId: "mem-1" }),
		)
		expect(bridgeMocks.memongoBridgePromoteQuarantined).toHaveBeenCalledWith({
			agentId: "agent-42",
			quarantineId: "q-1",
			reviewerId: "reviewer-7",
			reviewNotes: "false positive",
		})
	})

	it("rejects a quarantined memory with reviewer metadata", async () => {
		bridgeMocks.memongoBridgeRejectQuarantined.mockResolvedValue({
			quarantineId: "q-2",
			agentId: "agent-42",
			status: "rejected",
			reviewedAt: "2026-08-15T01:00:00.000Z",
			mutationId: "mut-2",
		})
		const res = await createApp().request("/v1/admin/quarantine/reject", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				quarantineId: "q-2",
				agentId: "agent-42",
				reviewerId: "reviewer-7",
				reviewNotes: "confirmed injection",
			}),
		})
		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({ status: "rejected", mutationId: "mut-2" }),
		)
		expect(bridgeMocks.memongoBridgeRejectQuarantined).toHaveBeenCalledWith({
			agentId: "agent-42",
			quarantineId: "q-2",
			reviewerId: "reviewer-7",
			reviewNotes: "confirmed injection",
		})
	})

	it("requires quarantineId on promote and reject", async () => {
		for (const path of [
			"/v1/admin/quarantine/promote",
			"/v1/admin/quarantine/reject",
		]) {
			for (const body of [{}, { quarantineId: "" }, { quarantineId: 42 }]) {
				const res = await createApp().request(path, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				})
				expect(res.status).toBe(400)
				const json = (await res.json()) as { error: { code: string } }
				expect(json.error.code).toBe("VALIDATION_ERROR")
			}
		}
		expect(bridgeMocks.memongoBridgePromoteQuarantined).not.toHaveBeenCalled()
		expect(bridgeMocks.memongoBridgeRejectQuarantined).not.toHaveBeenCalled()
	})

	it("maps promote and reject bridge failures to distinct error codes", async () => {
		bridgeMocks.memongoBridgePromoteQuarantined.mockRejectedValue(
			new Error("already reviewed (status=promoted)"),
		)
		bridgeMocks.memongoBridgeRejectQuarantined.mockRejectedValue(
			new Error("quarantine entry not found"),
		)

		const promoteRes = await createApp().request(
			"/v1/admin/quarantine/promote",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ quarantineId: "q-1" }),
			},
		)
		expect(promoteRes.status).toBe(500)
		await expect(promoteRes.json()).resolves.toEqual(
			expect.objectContaining({
				error: expect.objectContaining({ code: "QUARANTINE_PROMOTE_FAILED" }),
			}),
		)

		const rejectRes = await createApp().request("/v1/admin/quarantine/reject", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ quarantineId: "q-1" }),
		})
		expect(rejectRes.status).toBe(500)
		await expect(rejectRes.json()).resolves.toEqual(
			expect.objectContaining({
				error: expect.objectContaining({ code: "QUARANTINE_REJECT_FAILED" }),
			}),
		)
	})

	it("rejects scoped AND agent-scoped API keys from the admin-only quarantine routes", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-42"] },
		])
		bridgeMocks.memongoBridgeListQuarantined.mockResolvedValue([])
		bridgeMocks.memongoBridgePromoteQuarantined.mockResolvedValue({
			quarantineId: "q-1",
			status: "promoted",
		})

		for (const request of [
			() =>
				createApp().request("/v1/admin/quarantine?agentId=agent-42", {
					headers: { Authorization: "Bearer scoped-A" },
				}),
			() =>
				createApp().request("/v1/admin/quarantine/promote", {
					method: "POST",
					headers: {
						Authorization: "Bearer scoped-A",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						quarantineId: "q-1",
						agentId: "agent-42",
					}),
				}),
			() =>
				createApp().request("/v1/admin/quarantine/reject", {
					method: "POST",
					headers: {
						Authorization: "Bearer scoped-A",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						quarantineId: "q-1",
						agentId: "agent-42",
					}),
				}),
		]) {
			const res = await request()
			expect(res.status).toBe(403)
			const json = (await res.json()) as {
				error: { code: string; message: string }
			}
			expect(json.error.code).toBe("FORBIDDEN")
			expect(json.error.message).toBe(
				"scoped API key cannot access an admin-only route",
			)
		}
		// No quarantine payload ever reached the bridge under a scoped key.
		expect(bridgeMocks.memongoBridgeListQuarantined).not.toHaveBeenCalled()
		expect(bridgeMocks.memongoBridgePromoteQuarantined).not.toHaveBeenCalled()
		expect(bridgeMocks.memongoBridgeRejectQuarantined).not.toHaveBeenCalled()
	})

	it("returns access trends via admin route", async () => {
		bridgeMocks.memongoBridgeAccessTrends.mockResolvedValue([
			{
				collection: "events",
				memoryId: "evt-1",
				day: "2026-04-09T00:00:00.000Z",
				count: 3,
				rolling7dCount: 9,
				lastAccessedAt: "2026-04-09T10:00:00.000Z",
			},
		])

		const res = await createApp().request(
			"/v1/admin/access-trends?agentId=agent-42&collection=events&memoryIds=evt-1,evt-2&windowDays=14&limit=8",
		)

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual([
			expect.objectContaining({ memoryId: "evt-1" }),
		])
		expect(bridgeMocks.memongoBridgeAccessTrends).toHaveBeenCalledWith({
			agentId: "agent-42",
			collection: "events",
			memoryIds: ["evt-1", "evt-2"],
			windowDays: 14,
			limit: 8,
		})
	})

	it("returns access summaries via admin route", async () => {
		bridgeMocks.memongoBridgeAccessSummaries.mockResolvedValue([
			{
				collection: "events",
				memoryId: "evt-1",
				accessCount: 7,
				lastAccessedAt: "2026-04-09T10:00:00.000Z",
			},
		])

		const res = await createApp().request(
			"/v1/admin/access-summaries?agentId=agent-42&collection=events&memoryIds=evt-1,evt-2&windowDays=14",
		)

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual([
			expect.objectContaining({ memoryId: "evt-1", accessCount: 7 }),
		])
		expect(bridgeMocks.memongoBridgeAccessSummaries).toHaveBeenCalledWith({
			agentId: "agent-42",
			collection: "events",
			memoryIds: ["evt-1", "evt-2"],
			windowDays: 14,
		})
	})

	it("imports conversations through the canonical public route", async () => {
		const res = await createApp().request("/v1/import/conversations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				datasetPath: "/tmp/history.json",
				scope: "workspace",
				scopeRef: "workspace:acme",
				limitConversations: 2,
				limitTurnsPerConversation: 4,
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({
				datasetPath: "/tmp/history.json",
				datasetKind: "generic",
				conversationsImported: 1,
			}),
		)
		expect(bridgeMocks.memongoBridgeImportConversations).toHaveBeenCalledWith({
			agentId: "agent-42",
			datasetPath: "/tmp/history.json",
			scope: "workspace",
			scopeRef: "workspace:acme",
			limitConversations: 2,
			limitTurnsPerConversation: 4,
		})
	})

	it("rejects conversation import when datasetPath is missing", async () => {
		const res = await createApp().request("/v1/import/conversations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: { code: "VALIDATION_ERROR", message: "datasetPath is required" },
		})
	})

	it("rejects conversation import when datasetPath escapes the allowed roots", async () => {
		bridgeMocks.memongoBridgeImportConversations.mockRejectedValue(
			new Error(
				"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
			),
		)

		const res = await createApp().request("/v1/import/conversations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				datasetPath: "/etc/passwd.json",
			}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message:
					"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
			},
		})
	})
})

describe("WS-08 request validation 400s (C-012/C-013)", () => {
	const prevEnv = { ...process.env }

	beforeEach(() => {
		process.env = { ...prevEnv }
		delete process.env.MEMONGO_API_KEY
		delete process.env.MEMONGO_API_SCOPED_KEYS
		process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH = "true"
		bridgeMocks.memongoBridgeBuildContextBundle.mockReset()
		bridgeMocks.memongoBridgeBuildDiscoveryProjection.mockReset()
		bridgeMocks.memongoBridgeSearchDetailed.mockReset()
	})

	afterEach(() => {
		process.env = prevEnv
	})

	it("rejects an invalid context-bundle mode with 400 instead of silently defaulting", async () => {
		const res = await createApp().request("/v1/context-bundle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "wakeup" }),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("VALIDATION_ERROR")
		expect(body.error.message).toContain("mode")
		expect(bridgeMocks.memongoBridgeBuildContextBundle).not.toHaveBeenCalled()
	})

	it("rejects a context-bundle timeRange with an unknown preset", async () => {
		const res = await createApp().request("/v1/context-bundle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ timeRange: { preset: "last-year" } }),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("VALIDATION_ERROR")
		expect(body.error.message).toContain("timeRange")
		expect(bridgeMocks.memongoBridgeBuildContextBundle).not.toHaveBeenCalled()
	})

	it("rejects a context-bundle timeRange with neither preset nor start/end", async () => {
		const res = await createApp().request("/v1/context-bundle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ timeRange: {} }),
		})
		expect(res.status).toBe(400)
		expect(bridgeMocks.memongoBridgeBuildContextBundle).not.toHaveBeenCalled()
	})

	it("forwards a valid context-bundle timeRange preset", async () => {
		bridgeMocks.memongoBridgeBuildContextBundle.mockResolvedValue({
			rendered: "bundle",
			sections: [],
			metadata: { partial: false },
			builtAt: "2026-04-05T12:00:00.000Z",
		})
		const res = await createApp().request("/v1/context-bundle", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ timeRange: { preset: "last-7d" } }),
		})
		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeBuildContextBundle).toHaveBeenCalledWith(
			expect.objectContaining({ timeRange: { preset: "last-7d" } }),
		)
	})

	it("rejects a discovery-projection timeRange with an unknown preset", async () => {
		const res = await createApp().request("/v1/discovery-projection", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				kind: "what-changed",
				timeRange: { preset: "all-time" },
			}),
		})
		expect(res.status).toBe(400)
		expect(
			bridgeMocks.memongoBridgeBuildDiscoveryProjection,
		).not.toHaveBeenCalled()
	})

	it("rejects an invalid search-detailed searchMode with 400", async () => {
		const res = await createApp().request("/v1/search-detailed", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "q", searchMode: "fast" }),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("VALIDATION_ERROR")
		expect(body.error.message).toContain("searchMode")
		expect(bridgeMocks.memongoBridgeSearchDetailed).not.toHaveBeenCalled()
	})

	it("rejects an invalid search-detailed searchConfig field with 400", async () => {
		const res = await createApp().request("/v1/search-detailed", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "q",
				searchConfig: { maxPasses: -1 },
			}),
		})
		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { code: string; message: string }
		}
		expect(body.error.code).toBe("VALIDATION_ERROR")
		expect(body.error.message).toContain("searchConfig")
		expect(bridgeMocks.memongoBridgeSearchDetailed).not.toHaveBeenCalled()
	})

	it("rejects an invalid search-detailed timeRange with 400", async () => {
		const res = await createApp().request("/v1/search-detailed", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "q",
				timeRange: { preset: "sometime" },
			}),
		})
		expect(res.status).toBe(400)
		expect(bridgeMocks.memongoBridgeSearchDetailed).not.toHaveBeenCalled()
	})
})
