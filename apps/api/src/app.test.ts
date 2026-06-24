import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import contractFixtures from "./__fixtures__/contract-fixtures.js"

const bridgeMocks = vi.hoisted(() => ({
	memongoBridgeAdd: vi.fn(),
	memongoBridgeAccessSummaries: vi.fn(),
	memongoBridgeAccessTrends: vi.fn(),
	memongoBridgeBenchmarkIngest: vi.fn(),
	memongoBridgeImportConversations: vi.fn(),
	memongoBridgeBuildContextBundle: vi.fn(),
	memongoBridgeBuildDiscoveryProjection: vi.fn(),
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
	memongoBridgeProfile: vi.fn(),
	memongoBridgeRecallConversation: vi.fn(),
	memongoBridgeReadFile: vi.fn(),
	memongoBridgeRelevanceBenchmark: vi.fn(),
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
	memongoBridgeWriteProcedure: vi.fn(),
	memongoBridgeWriteStructuredMemory: vi.fn(),
	memongoBridgeTraceChain: vi.fn(),
	memongoBridgeScanNovelty: vi.fn(),
	memongoBridgeConsolidate: vi.fn(),
	memongoBridgeSelfEdit: vi.fn(),
}))

vi.mock("@memongo/memory-bridge", () => bridgeMocks)

import { createApp } from "./app.js"

describe("createApp", () => {
	const prevEnv = { ...process.env }

	beforeEach(() => {
		process.env = { ...prevEnv }
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearchDetailed.mockReset()
		bridgeMocks.memongoBridgeAdd.mockReset()
		bridgeMocks.memongoBridgeAccessSummaries.mockReset()
		bridgeMocks.memongoBridgeAccessTrends.mockReset()
		bridgeMocks.memongoBridgeBenchmarkIngest.mockReset()
		bridgeMocks.memongoBridgeImportConversations.mockReset()
		bridgeMocks.memongoBridgeBuildContextBundle.mockReset()
		bridgeMocks.memongoBridgeBuildDiscoveryProjection.mockReset()
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
		bridgeMocks.memongoBridgeRelevanceBenchmark.mockReset()
		bridgeMocks.memongoBridgeStatus.mockReset()
		bridgeMocks.memongoBridgeTraceChain.mockReset()
		bridgeMocks.memongoBridgeScanNovelty.mockReset()
		bridgeMocks.memongoBridgeConsolidate.mockReset()
		bridgeMocks.memongoBridgeSelfEdit.mockReset()
		bridgeMocks.memongoBridgeUpdateLifecycleItem.mockReset()
		bridgeMocks.memongoBridgeReportProcedureOutcome.mockReset()
		bridgeMocks.memongoBridgeWriteConversationEvent.mockReset()
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
		bridgeMocks.memongoBridgeBenchmarkIngest.mockResolvedValue({
			datasetPath: "/tmp/benchmark.json",
			datasetName: "benchmark.json",
			conversationsIngested: 1,
			turnsIngested: 2,
			skippedConversations: 0,
			startedAt: "2026-04-09T12:00:00.000Z",
			completedAt: "2026-04-09T12:00:01.000Z",
		})
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
		bridgeMocks.memongoBridgeRelevanceBenchmark.mockResolvedValue({
			datasetVersion: "bench-v1",
			datasetName: "longmemeval.json",
			datasetKind: "longmemeval",
			scenarios: 2,
			cases: 4,
			scoredCases: 4,
			skippedCases: 0,
			hitRate: 0.75,
			emptyRate: 0.25,
			avgTopScore: 0.82,
			p95LatencyMs: 44,
			rAt5: 0.88,
			rAt10: 0.91,
			ndcgAt10: 0.86,
			questionTypeBreakdown: [],
			officialMetrics: {
				longMemEval: {
					retrievalCases: 4,
					abstentionCases: 0,
					session: {
						recallAnyAt1: 0.75,
						recallAllAt1: 0.5,
						ndcgAnyAt1: 0.75,
						recallAnyAt3: 0.88,
						recallAllAt3: 0.75,
						ndcgAnyAt3: 0.82,
						recallAnyAt5: 0.9,
						recallAllAt5: 0.88,
						ndcgAnyAt5: 0.86,
						recallAnyAt10: 0.95,
						recallAllAt10: 0.91,
						ndcgAnyAt10: 0.9,
						recallAnyAt30: 0.95,
						recallAllAt30: 0.91,
						ndcgAnyAt30: 0.9,
						recallAnyAt50: 0.95,
						recallAllAt50: 0.91,
						ndcgAnyAt50: 0.9,
					},
				},
			},
			regressions: [],
			benchmarkReport: {
				generatedAt: new Date("2026-04-10T12:00:00.000Z"),
				build: {
					source: "env",
					commitSha: "abc123",
				},
				corpus: {
					datasetVersion: "bench-v1",
					datasetName: "longmemeval.json",
					datasetKind: "longmemeval",
					scenarios: 2,
					cases: 4,
					scoredCases: 4,
					skippedCases: 0,
				},
				metrics: {
					internal: {
						hitRate: 0.75,
						emptyRate: 0.25,
						avgTopScore: 0.82,
						p95LatencyMs: 44,
						rAt5: 0.88,
						rAt10: 0.91,
						ndcgAt10: 0.86,
					},
				},
				releaseGates: [
					{
						gate: "official-retrieval",
						status: "passed",
						evidence: "officialMetrics present in benchmark response",
					},
					{
						gate: "query-governance",
						status: "advisory-only",
						evidence: "queryGovernance candidates are advisory-only",
					},
				],
				warnings: [],
				degradations: [],
			},
		})
		bridgeMocks.memongoBridgeListRecallTraces.mockResolvedValue([])
		bridgeMocks.memongoBridgeListMemoryJobs.mockResolvedValue([])
	})

	afterEach(() => {
		process.env = { ...prevEnv }
	})

	it("returns the public health payload", async () => {
		const res = await createApp().request("/health")

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({
			ok: true,
			service: "memongo-api",
		})
	})

	it("serves the OpenAPI document without auth", async () => {
		const res = await createApp().request("/openapi.json")
		const json = (await res.json()) as { paths?: Record<string, unknown> }

		expect(res.status).toBe(200)
		for (const path of contractFixtures.corePaths) {
			expect(json.paths).toHaveProperty(path)
		}
		const benchmarkPath = json.paths?.["/v1/admin/relevance/benchmark"] as {
			post?: {
				responses?: Record<
					string,
					{
						content?: {
							"application/json"?: {
								schema?: {
									properties?: Record<string, { required?: string[] }>
								}
							}
						}
					}
				>
			}
		}
		const benchmarkReport =
			benchmarkPath.post?.responses?.["200"]?.content?.["application/json"]
				?.schema?.properties?.benchmarkReport
		expect(benchmarkReport?.required).toEqual(
			expect.arrayContaining(["releaseGates", "warnings", "degradations"]),
		)
	})

	it("validates missing search queries", async () => {
		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: { code: "VALIDATION_ERROR", message: "query is required" },
		})
	})

	it("forwards scoped search options", async () => {
		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "workspace checkpoint",
				agentId: "codex",
				scope: "workspace",
				scopeRef: "/workspace/memongo",
				limit: 3,
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledWith({
			query: "workspace checkpoint",
			agentId: "codex",
			maxResults: 3,
			minScore: undefined,
			sessionKey: undefined,
			scope: "workspace",
			scopeRef: "/workspace/memongo",
		})
	})

	for (const aliasCase of contractFixtures.aliasCases) {
		it(`preserves ${aliasCase.name}`, async () => {
			const res = await createApp().request(aliasCase.path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(aliasCase.body),
			})

			expect(res.status).toBe(200)
			expect(
				bridgeMocks[aliasCase.bridgeMock as keyof typeof bridgeMocks],
			).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: undefined,
					...aliasCase.expected,
				}),
			)
		})
	}

	it("marks deprecated request properties in the OpenAPI document", async () => {
		const res = await createApp().request("/openapi.json")
		const json = (await res.json()) as {
			paths?: Record<
				string,
				{
					post?: {
						requestBody?: {
							content?: {
								"application/json"?: {
									schema?: {
										properties?: Record<string, { deprecated?: boolean }>
									}
								}
							}
						}
					}
				}
			>
		}

		expect(res.status).toBe(200)
		for (const [path, propertyNames] of Object.entries(
			contractFixtures.deprecatedRequestProperties,
		)) {
			const properties =
				json.paths?.[path]?.post?.requestBody?.content?.["application/json"]
					?.schema?.properties ?? {}
			for (const propertyName of propertyNames) {
				expect(properties[propertyName]?.deprecated).toBe(true)
			}
		}
	})

	it("documents state, recall, and lifecycle routes in OpenAPI", async () => {
		const res = await createApp().request("/openapi.json")
		const json = (await res.json()) as {
			paths?: Record<
				string,
				{
					summary?: string
					get?: {
						parameters?: Array<{ name?: string }>
					}
					post?: {
						summary?: string
						requestBody?: {
							content?: {
								"application/json"?: {
									schema?: {
										properties?: Record<
											string,
											{ enum?: string[]; items?: { enum?: string[] } }
										>
									}
								}
							}
						}
					}
				}
			>
		}

		expect(json.paths?.["/v1/state"]?.get?.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "agentId" }),
				expect.objectContaining({ name: "scope" }),
				expect.objectContaining({ name: "scopeRef" }),
			]),
		)
		expect(
			json.paths?.["/v1/context-bundle"]?.post?.requestBody?.content?.[
				"application/json"
			]?.schema?.properties?.mode?.enum,
		).toEqual(["full", "wake-up"])
		expect(
			json.paths?.["/v1/recall-conversation"]?.post?.requestBody?.content?.[
				"application/json"
			]?.schema?.properties?.roles?.items?.enum,
		).toEqual(["user", "assistant", "system", "tool"])
		expect(json.paths?.["/v1/lifecycle/get"]?.post).toBeDefined()
		expect(json.paths?.["/v1/lifecycle/update"]?.post).toBeDefined()
		expect(json.paths?.["/v1/lifecycle/delete"]?.post?.summary).toContain(
			"invalidate",
		)
		expect(json.paths?.["/v1/lifecycle/history"]?.post).toBeDefined()
	})

	it("protects v1 routes when MEMONGO_API_KEY is set", async () => {
		process.env.MEMONGO_API_KEY = "secret"

		const unauthorized = await createApp().request("/v1/status")
		expect(unauthorized.status).toBe(401)

		const authorized = await createApp().request("/v1/status", {
			headers: { Authorization: "Bearer secret" },
		})
		expect(authorized.status).toBe(200)
		expect(bridgeMocks.memongoBridgeStatus).toHaveBeenCalledOnce()
	})

	it("logs a prominent warning once when API auth is disabled", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { resetUnauthenticatedApiWarningForTests } = await import(
				"./app.js"
			)
			resetUnauthenticatedApiWarningForTests()

			createApp()
			createApp()

			expect(warn).toHaveBeenCalledTimes(1)
			expect(warn.mock.calls[0]?.[0]).toContain("MEMONGO_API_KEY is not set")
		} finally {
			warn.mockRestore()
		}
	})

	it("does not warn when admin or scoped API auth is configured", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { resetUnauthenticatedApiWarningForTests } = await import(
				"./app.js"
			)
			resetUnauthenticatedApiWarningForTests()

			process.env.MEMONGO_API_KEY = "secret"
			createApp()
			process.env.MEMONGO_API_KEY = ""
			process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
				{ token: "scoped-secret", agentIds: ["agent"] },
			])
			createApp()

			expect(warn).not.toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	it("registers a graceful shutdown handler that runs bridge close on SIGTERM/SIGINT (bridge shutdown part 2)", async () => {
		const { registerGracefulShutdown } = await import("./app.js")
		expect(typeof registerGracefulShutdown).toBe("function")

		const emitter = new (await import("node:events")).EventEmitter()
		const shutdownCalls: string[] = []
		const closeBridge = vi.fn(async () => {
			shutdownCalls.push("bridge-closed")
		})
		const closeServer = vi.fn(async () => {
			shutdownCalls.push("server-closed")
		})
		const exit = vi.fn()

		registerGracefulShutdown({
			signals: ["SIGTERM", "SIGINT"],
			process: emitter as unknown as NodeJS.Process,
			closeBridge,
			closeServer,
			exit,
			timeoutMs: 50,
		})

		// Emit SIGTERM — expect closeBridge and closeServer both called, process.exit(0).
		emitter.emit("SIGTERM")
		// Handler is async; give it a tick to run.
		await new Promise((r) => setTimeout(r, 10))
		expect(closeBridge).toHaveBeenCalledOnce()
		expect(closeServer).toHaveBeenCalledOnce()
		expect(exit).toHaveBeenCalledWith(0)
		expect(shutdownCalls).toEqual(["server-closed", "bridge-closed"])
	})

	it("shutdown forces exit(1) when close handlers exceed the timeout (bridge shutdown part 2)", async () => {
		const { registerGracefulShutdown } = await import("./app.js")
		const emitter = new (await import("node:events")).EventEmitter()

		// closeBridge hangs past the timeout.
		const closeBridge = vi.fn(
			() => new Promise<void>((resolve) => setTimeout(resolve, 500)),
		)
		const closeServer = vi.fn(async () => {})
		const exit = vi.fn()

		registerGracefulShutdown({
			signals: ["SIGTERM"],
			process: emitter as unknown as NodeJS.Process,
			closeBridge,
			closeServer,
			exit,
			timeoutMs: 20,
		})

		emitter.emit("SIGTERM")
		// Wait past the timeout.
		await new Promise((r) => setTimeout(r, 60))
		expect(exit).toHaveBeenCalledWith(1)
	})

	it("compares bearer tokens in constant time (MED timing-safe)", async () => {
		// Behavioral regression: rejection must hold for tokens of the same length
		// AND different length; the implementation must not short-circuit on length
		// alone (which would leak length via timing). Both must reject with 401.
		const { timingSafeBearerEquals } = await import("./app.js")
		expect(typeof timingSafeBearerEquals).toBe("function")

		// Exact match.
		expect(
			timingSafeBearerEquals("supersecret-token", "supersecret-token"),
		).toBe(true)

		// Same length, one char off — rejects.
		expect(
			timingSafeBearerEquals("supersecret-token", "supersecret-tokeX"),
		).toBe(false)

		// Different length — rejects without throwing.
		expect(timingSafeBearerEquals("short", "supersecret-token")).toBe(false)
		expect(timingSafeBearerEquals("supersecret-token", "short")).toBe(false)

		// Empty inputs — rejects (never accept empty bearer).
		expect(timingSafeBearerEquals("", "any")).toBe(false)
		expect(timingSafeBearerEquals("any", "")).toBe(false)
		expect(timingSafeBearerEquals("", "")).toBe(false)
	})

	it("fails closed when scoped API key policy JSON is invalid", () => {
		process.env.MEMONGO_API_SCOPED_KEYS = "not-json"

		expect(() => createApp()).toThrow(
			"MEMONGO_API_SCOPED_KEYS must be valid JSON",
		)
	})

	it("fails closed when scoped API key policies are unconstrained", () => {
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-secret" },
		])

		expect(() => createApp()).toThrow(
			"MEMONGO_API_SCOPED_KEYS policy for token scoped-secret must constrain agentIds, scopes, or scopeRefs",
		)
	})

	it("allows scoped API keys only inside their agent and scope policy", async () => {
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/memongo"],
			},
		])

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "scoped gates",
				agentId: "codex",
				scope: "workspace",
				scopeRef: "/workspace/memongo",
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				scope: "workspace",
				scopeRef: "/workspace/memongo",
			}),
		)
	})

	it("rejects scoped API keys outside their allowed scopeRef", async () => {
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/memongo"],
			},
		])

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "scoped gates",
				agentId: "codex",
				scope: "workspace",
				scopeRef: "/workspace/other",
			}),
		})

		expect(res.status).toBe(403)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "FORBIDDEN",
				message: "scopeRef is not allowed for this API key",
			},
		})
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("requires explicit scoped fields for scoped API keys", async () => {
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/memongo"],
			},
		])

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "scoped gates",
				agentId: "codex",
			}),
		})

		expect(res.status).toBe(403)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "FORBIDDEN",
				message: "scope is required for this API key",
			},
		})
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("keeps MEMONGO_API_KEY as the admin key when scoped keys are configured", async () => {
		process.env.MEMONGO_API_KEY = "admin-secret"
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/memongo"],
			},
		])

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer admin-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "admin can inspect another scope",
				agentId: "other-agent",
				scope: "global",
				scopeRef: "global",
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "other-agent",
				scope: "global",
				scopeRef: "global",
			}),
		)
	})

	it("forwards add scope and scopeRef when provided", async () => {
		const res = await createApp().request("/v1/add", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "remember the scoped thing",
				agentId: "codex",
				sessionId: "session-9",
				scope: "session",
				scopeRef: "session:session-9",
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeAdd).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "remember the scoped thing",
				agentId: "codex",
				sessionId: "session-9",
				scope: "session",
				scopeRef: "session:session-9",
			}),
		)
	})

	it("forwards write-event scopeRef when provided", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "assistant",
				body: "scoped assistant memory",
				agentId: "codex",
				sessionId: "session-9",
				scope: "session",
				scopeRef: "session:session-9",
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "assistant",
				body: "scoped assistant memory",
				agentId: "codex",
				sessionId: "session-9",
				scope: "session",
				scopeRef: "session:session-9",
			}),
		)
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
			collection: "structured",
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
				collection: "structured",
				agentId: "agent-42",
				maxDepth: 3,
			}),
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json).toEqual(
			expect.objectContaining({
				factId: "fact-1",
				collection: "structured",
			}),
		)
		expect(bridgeMocks.memongoBridgeTraceChain).toHaveBeenCalledWith({
			agentId: "agent-42",
			factId: "fact-1",
			collection: "structured",
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

	it("ingests benchmark datasets via admin route", async () => {
		const res = await createApp().request("/v1/admin/benchmarks/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				datasetPath: "/tmp/benchmark.json",
				scope: "workspace",
				limitConversations: 2,
				limitTurnsPerConversation: 4,
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({
				datasetPath: "/tmp/benchmark.json",
				conversationsIngested: 1,
			}),
		)
		expect(bridgeMocks.memongoBridgeBenchmarkIngest).toHaveBeenCalledWith({
			agentId: "agent-42",
			datasetPath: "/tmp/benchmark.json",
			scope: "workspace",
			limitConversations: 2,
			limitTurnsPerConversation: 4,
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
			limitConversations: 2,
			limitTurnsPerConversation: 4,
		})
	})

	it("returns publishable benchmark metrics via admin route", async () => {
		const res = await createApp().request("/v1/admin/relevance/benchmark", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				datasetPath: "/tmp/longmemeval.json",
				maxResults: 10,
				minScore: 0.1,
			}),
		})

		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual(
			expect.objectContaining({
				datasetVersion: "bench-v1",
				datasetKind: "longmemeval",
				rAt5: 0.88,
				rAt10: 0.91,
				ndcgAt10: 0.86,
				officialMetrics: expect.objectContaining({
					longMemEval: expect.objectContaining({
						retrievalCases: 4,
						session: expect.objectContaining({
							recallAllAt5: 0.88,
							ndcgAnyAt10: 0.9,
						}),
					}),
				}),
				benchmarkReport: expect.objectContaining({
					generatedAt: "2026-04-10T12:00:00.000Z",
					build: expect.objectContaining({
						commitSha: "abc123",
					}),
					corpus: expect.objectContaining({
						datasetVersion: "bench-v1",
						cases: 4,
					}),
					releaseGates: expect.arrayContaining([
						expect.objectContaining({
							gate: "query-governance",
							status: "advisory-only",
						}),
					]),
				}),
			}),
		)
		expect(bridgeMocks.memongoBridgeRelevanceBenchmark).toHaveBeenCalledWith({
			agentId: "agent-42",
			datasetPath: "/tmp/longmemeval.json",
			maxResults: 10,
			minScore: 0.1,
		})
	})

	it("accepts datasetSha256, embeddingConfig, and rerankerConfig in benchmark body (Task 1.A)", async () => {
		const res = await createApp().request("/v1/admin/relevance/benchmark", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				datasetPath: "/tmp/longmemeval.json",
				maxResults: 10,
				datasetSha256: "a".repeat(64),
				embeddingConfig: {
					model: "voyage-3",
					dimensions: 1024,
					quantization: "float32",
				},
				rerankerConfig: {
					model: "rerank-2",
					version: null,
					stage: "post-fusion",
				},
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeRelevanceBenchmark).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-42",
				datasetPath: "/tmp/longmemeval.json",
				maxResults: 10,
				datasetSha256: "a".repeat(64),
				embeddingConfig: {
					model: "voyage-3",
					dimensions: 1024,
					quantization: "float32",
				},
				rerankerConfig: {
					model: "rerank-2",
					version: null,
					stage: "post-fusion",
				},
			}),
		)
	})

	it("rejects benchmark ingest when datasetPath is missing", async () => {
		const res = await createApp().request("/v1/admin/benchmarks/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})

		expect(res.status).toBe(400)
		await expect(res.json()).resolves.toEqual({
			error: { code: "VALIDATION_ERROR", message: "datasetPath is required" },
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
			scope: "workspace",
		})
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
			query: "phoenix",
			sessionId: "session-9",
			roles: ["assistant"],
			startTime: "2026-04-08",
			endTime: "2026-04-08",
			timezone: "America/New_York",
			includeToolMessages: true,
			limit: 3,
		})
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
})
