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
	memongoBridgeCapabilities: vi.fn(),
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

import { createApp, parseScopedApiKeyPolicies } from "./app.js"
import {
	deriveSearchLanes,
	enforceRequiredVector,
	formatCapabilityTable,
	isRequireVectorEnabled,
	probeBootCapabilities,
	REQUIRE_VECTOR_FAILURE_MESSAGE,
} from "./lib/capabilities.js"

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

	describe("GET /ready", () => {
		beforeEach(() => {
			bridgeMocks.memongoBridgePingMongo.mockResolvedValue({ ok: true })
			bridgeMocks.memongoBridgeProbeVector.mockResolvedValue(true)
			bridgeMocks.memongoBridgeProbeEmbedding.mockResolvedValue({ ok: true })
		})

		it("returns 200 with all lanes ok when every probe passes", async () => {
			const res = await createApp().request("/ready")

			expect(res.status).toBe(200)
			await expect(res.json()).resolves.toEqual({
				ok: true,
				lanes: {
					mongo: { ok: true },
					vector: { ok: true },
					embedding: { ok: true },
				},
			})
		})

		it("returns 503 with lane detail when the vector probe fails", async () => {
			bridgeMocks.memongoBridgeProbeVector.mockResolvedValue(false)

			const res = await createApp().request("/ready")
			const json = (await res.json()) as {
				ok: boolean
				lanes: {
					mongo: { ok: boolean }
					vector: { ok: boolean; message?: string }
					embedding: { ok: boolean }
				}
			}

			expect(res.status).toBe(503)
			expect(json.ok).toBe(false)
			expect(json.lanes.mongo.ok).toBe(true)
			expect(json.lanes.embedding.ok).toBe(true)
			expect(json.lanes.vector.ok).toBe(false)
			expect(json.lanes.vector.message).toBeTruthy()
		})

		it("returns 503 when the mongo ping fails", async () => {
			bridgeMocks.memongoBridgePingMongo.mockResolvedValue({
				ok: false,
				message: "mongodb memory unavailable: connection refused",
			})

			const res = await createApp().request("/ready")
			const json = (await res.json()) as {
				ok: boolean
				lanes: { mongo: { ok: boolean; message?: string } }
			}

			expect(res.status).toBe(503)
			expect(json.ok).toBe(false)
			expect(json.lanes.mongo.ok).toBe(false)
			expect(json.lanes.mongo.message).toContain("connection refused")
		})

		it("returns 503 when a probe throws", async () => {
			bridgeMocks.memongoBridgePingMongo.mockRejectedValue(
				new Error("mongodb memory unavailable: boom"),
			)

			const res = await createApp().request("/ready")
			const json = (await res.json()) as {
				ok: boolean
				lanes: { mongo: { ok: boolean; message?: string } }
			}

			expect(res.status).toBe(503)
			expect(json.lanes.mongo.ok).toBe(false)
			expect(json.lanes.mongo.message).toContain("boom")
		})

		it("is not blocked by auth when MEMONGO_API_KEY is set", async () => {
			process.env.MEMONGO_API_KEY = "secret-key"

			const res = await createApp().request("/ready")

			expect(res.status).toBe(200)
		})
	})

	describe("validateBootEnv", () => {
		it("throws the engine message when no MongoDB URI is resolvable", async () => {
			bridgeMocks.buildMemongoConfig.mockReturnValue({
				memory: { backend: "mongodb", mongodb: {} },
			})
			const { validateBootEnv } = await import("./lib/boot-env.js")

			expect(() => validateBootEnv({})).toThrow(
				/MongoDB URI required for Memongo.*MEMONGO_MONGODB_URI/,
			)
		})

		it("passes when a MongoDB URI is resolvable", async () => {
			bridgeMocks.buildMemongoConfig.mockReturnValue({
				memory: {
					backend: "mongodb",
					mongodb: { uri: "mongodb://127.0.0.1:27017/memongo" },
				},
			})
			const { validateBootEnv } = await import("./lib/boot-env.js")

			expect(() => validateBootEnv({})).not.toThrow()
		})
	})

	describe("boot search capabilities (P1.9)", () => {
		const fullCaps = {
			vectorSearch: true,
			textSearch: true,
			scoreFusion: true,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		}

		it("derives all lanes available from full capabilities", () => {
			expect(deriveSearchLanes(fullCaps)).toEqual({
				hybrid: true,
				vector: true,
				keyword: true,
				text: true,
			})
		})

		it("degrades hybrid and vector when the vector capability is absent", () => {
			expect(deriveSearchLanes({ ...fullCaps, vectorSearch: false })).toEqual({
				hybrid: false,
				vector: false,
				keyword: true,
				text: true,
			})
		})

		it("keeps only the $text fallback when capabilities are null", () => {
			expect(deriveSearchLanes(null)).toEqual({
				hybrid: false,
				vector: false,
				keyword: false,
				text: true,
			})
		})

		it("formats a degraded table with lane statuses and a banner", () => {
			const table = formatCapabilityTable(
				deriveSearchLanes({ ...fullCaps, vectorSearch: false }),
			)
			expect(table).toContain("hybrid:  unavailable")
			expect(table).toContain("vector:  unavailable")
			expect(table).toContain("keyword: available")
			expect(table).toContain("text:    available")
			expect(table).toContain("DEGRADED")
		})

		it("formats a healthy table without the degradation banner", () => {
			const table = formatCapabilityTable(deriveSearchLanes(fullCaps))
			expect(table).toContain("all retrieval lanes available")
			expect(table).not.toContain("DEGRADED")
		})

		it("includes the probe error in the table when the probe failed", () => {
			const table = formatCapabilityTable(deriveSearchLanes(null), "boom")
			expect(table).toContain("capability probe failed: boom")
		})

		it("parses MEMONGO_REQUIRE_VECTOR only for 1/true", () => {
			expect(isRequireVectorEnabled("1")).toBe(true)
			expect(isRequireVectorEnabled("true")).toBe(true)
			expect(isRequireVectorEnabled(" TRUE ")).toBe(true)
			expect(isRequireVectorEnabled("0")).toBe(false)
			expect(isRequireVectorEnabled("yes")).toBe(false)
			expect(isRequireVectorEnabled(undefined)).toBe(false)
		})

		it("enforceRequiredVector passes when the vector lane is available", () => {
			expect(() =>
				enforceRequiredVector(deriveSearchLanes(fullCaps)),
			).not.toThrow()
		})

		it("enforceRequiredVector throws a clear message when vector is unavailable", () => {
			expect(() =>
				enforceRequiredVector(
					deriveSearchLanes({ ...fullCaps, vectorSearch: false }),
				),
			).toThrow(REQUIRE_VECTOR_FAILURE_MESSAGE)
		})

		it("enforceRequiredVector includes the probe error when present", () => {
			expect(() =>
				enforceRequiredVector(deriveSearchLanes(null), "connection refused"),
			).toThrow(/Capability probe failed: connection refused/)
		})

		it("probeBootCapabilities returns derived lanes on success", async () => {
			const report = await probeBootCapabilities(async () => fullCaps)
			expect(report.probeError).toBeUndefined()
			expect(report.lanes.vector).toBe(true)
		})

		it("probeBootCapabilities degrades lanes and captures probe failures", async () => {
			const report = await probeBootCapabilities(async () => {
				throw new Error("mongodb memory unavailable")
			})
			expect(report.probeError).toContain("mongodb memory unavailable")
			expect(report.lanes).toEqual({
				hybrid: false,
				vector: false,
				keyword: false,
				text: true,
			})
		})
	})

	it("serves the OpenAPI document without auth", async () => {
		const res = await createApp().request("/openapi.json")
		const json = (await res.json()) as {
			paths?: Record<string, unknown>
		}

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
		const reportProperties = benchmarkReport as {
			properties?: {
				corpus?: {
					properties?: { execution?: { required?: string[] } }
				}
				releaseGates?: {
					items?: { properties?: Record<string, unknown> }
				}
			}
		}
		expect(
			reportProperties.properties?.corpus?.properties?.execution?.required,
		).toEqual(
			expect.arrayContaining([
				"retrievalEligibleCases",
				"abstentionCases",
				"missingJudgmentCases",
			]),
		)
		expect(
			reportProperties.properties?.releaseGates?.items?.properties,
		).toHaveProperty("checks")

		const requestSchema = benchmarkPath.post as {
			requestBody?: {
				content?: {
					"application/json"?: {
						schema?: {
							properties?: Record<
								string,
								{ oneOf?: Array<{ required?: string[] }> }
							>
						}
					}
				}
			}
		}
		const thresholdVariants =
			requestSchema.requestBody?.content?.["application/json"]?.schema
				?.properties?.qualityThresholds?.oneOf
		expect(thresholdVariants).toHaveLength(2)
		expect(thresholdVariants?.[0]?.required).toContain(
			"minSessionRecallAnyAt10",
		)
		expect(thresholdVariants?.[1]?.required).toEqual(
			expect.arrayContaining([
				"minAnswerAccuracy",
				"maxJudgeFalsePositiveRate",
				"minAnswerCoverage",
			]),
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

	it("issue #57: nested-only agentId resolves to the SAME identity auth validated (no default-partition drift)", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"] },
		])
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockReset()
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockResolvedValue({
			id: "s1",
		})

		// agentId is present ONLY nested in `entry` (no top-level). Auth resolves
		// it via its multi-container search and allows it; the write path MUST
		// resolve the same identity, not fall back to the default "main" partition.
		const res = await createApp().request("/v1/write-structured", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				entry: {
					agentId: "agent-A",
					type: "fact",
					key: "city",
					value: "Berlin",
				},
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteStructuredMemory,
		).toHaveBeenCalledOnce()
		expect(
			bridgeMocks.memongoBridgeWriteStructuredMemory.mock.calls[0]?.[0]
				?.agentId,
		).toBe("agent-A")
	})

	it("issue #57: a key scoped to agent-A cannot write under agent-B via nested identity", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"] },
		])
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockReset()
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockResolvedValue({
			id: "s1",
		})

		const res = await createApp().request("/v1/write-structured", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				entry: {
					agentId: "agent-B",
					type: "fact",
					key: "city",
					value: "Berlin",
				},
			}),
		})

		expect(res.status).toBe(403)
		expect(
			bridgeMocks.memongoBridgeWriteStructuredMemory,
		).not.toHaveBeenCalled()
	})

	it("issue #57: scopeRef sent as a query param drives the search, not dropped (auth == execution)", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", scopeRefs: ["/workspace/memongo"] },
		])
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockResolvedValue([])

		// scopeRef is present ONLY as a query param. Auth merges query params and
		// allows the request; the search MUST run under the SAME scopeRef, never
		// fall back to undefined (which would read across tenant boundaries).
		const res = await createApp().request(
			"/v1/search?scopeRef=%2Fworkspace%2Fmemongo",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer scoped-A",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query: "hello" }),
			},
		)

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledOnce()
		expect(bridgeMocks.memongoBridgeSearch.mock.calls[0]?.[0]?.scopeRef).toBe(
			"/workspace/memongo",
		)
	})

	it("issue #57: scope/scopeRef nested in params resolve to the SAME values auth validated", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-A",
				scopes: ["tenant"],
				scopeRefs: ["/workspace/memongo"],
			},
		])
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockResolvedValue([])

		// scope + scopeRef live ONLY in a nested container. Auth's multi-container
		// resolver finds and allows them; the search path must resolve identically.
		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "hello",
				params: { scope: "tenant", scopeRef: "/workspace/memongo" },
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledOnce()
		const call = bridgeMocks.memongoBridgeSearch.mock.calls[0]?.[0]
		expect(call?.scope).toBe("tenant")
		expect(call?.scopeRef).toBe("/workspace/memongo")
	})

	it("issue #57: a scoped key cannot act on another tenant's item via a lifecycle handle (top-level decoy)", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"] },
		])
		bridgeMocks.memongoBridgeGetLifecycleItem.mockReset()
		bridgeMocks.memongoBridgeGetLifecycleItem.mockResolvedValue({
			family: "structured",
		})

		// The scoped key is authorized for agent-A via the top-level decoy, which
		// auth validates (top-level wins). The handle points at agent-B. The bridge
		// selects the partition from handle.agentId, so this MUST be rejected before
		// it can read agent-B's data.
		const res = await createApp().request("/v1/lifecycle/get", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				agentId: "agent-A",
				handle: {
					family: "structured",
					id: "structured:agent-B:agent:agent-B:decision:db",
					agentId: "agent-B",
					scope: "agent",
					scopeRef: "agent-B",
					revision: 1,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
			}),
		})

		expect(res.status).toBe(403)
		expect(bridgeMocks.memongoBridgeGetLifecycleItem).not.toHaveBeenCalled()
	})

	it("issue #57: a lifecycle handle whose identity matches the caller is allowed", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"] },
		])
		bridgeMocks.memongoBridgeGetLifecycleItem.mockReset()
		bridgeMocks.memongoBridgeGetLifecycleItem.mockResolvedValue({
			family: "structured",
		})

		const res = await createApp().request("/v1/lifecycle/get", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				handle: {
					family: "structured",
					id: "structured:agent-A:agent:agent-A:decision:db",
					agentId: "agent-A",
					scope: "agent",
					scopeRef: "agent-A",
					revision: 1,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeGetLifecycleItem).toHaveBeenCalledOnce()
	})

	it("scope isolation: a key scoped to scope/scopeRef forwards the AUTHORIZED scope to write-structured, not a nested entry.scope smuggle", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-A",
				agentIds: ["agent-A"],
				scopes: ["agent"],
				scopeRefs: ["ref-A"],
			},
		])
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockReset()
		bridgeMocks.memongoBridgeWriteStructuredMemory.mockResolvedValue({
			id: "s1",
		})

		// Top-level scope/scopeRef are the authorized values (auth validates these,
		// top-level precedence). The nested entry carries a DIFFERENT scope/scopeRef
		// — a smuggle attempt. The write MUST execute under the authorized
		// scope/scopeRef, never the nested decoy, or a key limited to (agent, ref-A)
		// could write into (tenant, ref-B).
		const res = await createApp().request("/v1/write-structured", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				agentId: "agent-A",
				scope: "agent",
				scopeRef: "ref-A",
				entry: {
					agentId: "agent-A",
					scope: "tenant",
					scopeRef: "ref-B",
					type: "fact",
					key: "city",
					value: "Berlin",
				},
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteStructuredMemory,
		).toHaveBeenCalledOnce()
		const call =
			bridgeMocks.memongoBridgeWriteStructuredMemory.mock.calls[0]?.[0]
		expect(call?.scope).toBe("agent")
		expect(call?.scopeRef).toBe("ref-A")
	})

	it("scope isolation: a scoped key forwards the AUTHORIZED scope to write-procedure, not a nested entry.scope smuggle", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-A",
				agentIds: ["agent-A"],
				scopes: ["agent"],
				scopeRefs: ["ref-A"],
			},
		])
		bridgeMocks.memongoBridgeWriteProcedure.mockReset()
		bridgeMocks.memongoBridgeWriteProcedure.mockResolvedValue({ id: "p1" })

		const res = await createApp().request("/v1/write-procedure", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				agentId: "agent-A",
				scope: "agent",
				scopeRef: "ref-A",
				entry: {
					agentId: "agent-A",
					scope: "tenant",
					scopeRef: "ref-B",
					procedureId: "proc-deploy",
					name: "deploy",
					steps: ["build", "ship"],
				},
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeWriteProcedure).toHaveBeenCalledOnce()
		const call = bridgeMocks.memongoBridgeWriteProcedure.mock.calls[0]?.[0]
		expect(call?.scope).toBe("agent")
		expect(call?.scopeRef).toBe("ref-A")
	})

	it("class-G: a scope-constrained key is rejected (403) on an agent-global route (stats)", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", scopes: ["agent"] },
		])
		bridgeMocks.memongoBridgeStats.mockReset()
		bridgeMocks.memongoBridgeStats.mockResolvedValue({ ok: true })

		// The key supplies scope=agent to satisfy auth, but /stats is agent-global
		// (aggregates across ALL scopes). A scope-constrained key must not reach it.
		const res = await createApp().request("/v1/stats?scope=agent", {
			headers: { Authorization: "Bearer scoped-A" },
		})

		expect(res.status).toBe(403)
		expect(bridgeMocks.memongoBridgeStats).not.toHaveBeenCalled()
	})

	it("class-G: a scope-constrained key is rejected (403) on self-edit (agent-global mutation)", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", scopes: ["agent"] },
		])
		bridgeMocks.memongoBridgeSelfEdit.mockReset()
		bridgeMocks.memongoBridgeSelfEdit.mockResolvedValue({ ok: true })

		const res = await createApp().request("/v1/self-edit?scope=agent", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				block: "persona",
				action: "replace",
				content: "new persona",
			}),
		})

		expect(res.status).toBe(403)
		expect(bridgeMocks.memongoBridgeSelfEdit).not.toHaveBeenCalled()
	})

	it("class-G: a FULL key reaches agent-global routes normally", async () => {
		process.env.MEMONGO_API_KEY = "secret"
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		bridgeMocks.memongoBridgeStats.mockReset()
		bridgeMocks.memongoBridgeStats.mockResolvedValue({ ok: true })

		const res = await createApp().request("/v1/stats", {
			headers: { Authorization: "Bearer secret" },
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeStats).toHaveBeenCalledOnce()
	})

	it("class-G: an agentId-only scoped key (no scope/scopeRef constraint) still reaches agent-global routes", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"] },
		])
		bridgeMocks.memongoBridgeStats.mockReset()
		bridgeMocks.memongoBridgeStats.mockResolvedValue({ ok: true })

		const res = await createApp().request("/v1/stats?agentId=agent-A", {
			headers: { Authorization: "Bearer scoped-A" },
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeStats).toHaveBeenCalledOnce()
	})

	it("server-file import: rejects every scoped API key", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"] },
		])
		bridgeMocks.memongoBridgeImportConversations.mockReset()
		bridgeMocks.memongoBridgeImportConversations.mockResolvedValue({})

		const res = await createApp().request(
			"/v1/import/conversations?agentId=agent-A",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer scoped-A",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ datasetPath: "benchmarks/private.jsonl" }),
			},
		)

		expect(res.status).toBe(403)
		expect(bridgeMocks.memongoBridgeImportConversations).not.toHaveBeenCalled()
	})

	it("class-G guard does not block scope-constrained keys on tenant-scoped routes (search)", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", scopes: ["agent"] },
		])
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockResolvedValue([])

		const res = await createApp().request("/v1/search?scope=agent", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: "hello" }),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledOnce()
	})

	it("scope isolation: rejects a scoped policy whose scope value is non-canonical (fail closed)", () => {
		// A policy scope that auth would accept as a raw string but that pickScope
		// drops (non-canonical) would silently disable write-forcing and let a
		// nested entry.scope smuggle survive. Fail closed at config load instead.
		expect(() =>
			parseScopedApiKeyPolicies(
				JSON.stringify([{ token: "k", scopes: ["Agent"] }]),
			),
		).toThrow(/scope/i)
		expect(() =>
			parseScopedApiKeyPolicies(
				JSON.stringify([{ token: "k", scopes: ["tennant"] }]),
			),
		).toThrow(/scope/i)
	})

	it("scope isolation: accepts canonical scope values in a scoped policy", () => {
		expect(() =>
			parseScopedApiKeyPolicies(
				JSON.stringify([{ token: "k", scopes: ["agent", "tenant"] }]),
			),
		).not.toThrow()
	})

	it("scope isolation: rejects malformed supplied policy dimensions instead of dropping them", () => {
		expect(() =>
			parseScopedApiKeyPolicies(
				JSON.stringify([
					{
						token: "k",
						agentIds: ["agent-A"],
						scopeRefs: "ref-A",
					},
				]),
			),
		).toThrow(/scopeRefs/i)
	})

	it("scope isolation: wildcard-only scoped policies do not count as constrained", () => {
		expect(() =>
			parseScopedApiKeyPolicies(
				JSON.stringify([
					{
						token: "k",
						agentIds: ["*"],
						scopes: ["*"],
						scopeRefs: ["*"],
					},
				]),
			),
		).toThrow(/concrete/i)
	})

	it("#28: rate-limits per identity and returns 429 with Retry-After", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({ ok: true })

		const app = createApp()
		const first = await app.request("/v1/status")
		expect(first.status).toBe(200)

		const second = await app.request("/v1/status")
		expect(second.status).toBe(429)
		expect(second.headers.get("Retry-After")).toBeTruthy()
		const body = (await second.json()) as { error: { code: string } }
		expect(body.error.code).toBe("RATE_LIMITED")
	})

	it("#28: rejects a zero-length rate window instead of disabling enforcement", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		process.env.MEMONGO_API_RATE_WINDOW_MS = "0"
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({ ok: true })

		const app = createApp()
		expect((await app.request("/v1/status")).status).toBe(200)
		expect((await app.request("/v1/status")).status).toBe(429)
	})

	it("#28: rate limiting can be disabled with MEMONGO_API_RATE_LIMIT=0", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "0"
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({ ok: true })

		const app = createApp()
		for (let i = 0; i < 5; i++) {
			expect((await app.request("/v1/status")).status).toBe(200)
		}
	})

	it("#28: ignores X-Forwarded-For for rate limiting unless MEMONGO_TRUST_PROXY is set", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		process.env.MEMONGO_TRUST_PROXY = ""
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({ ok: true })

		const app = createApp()
		// Different spoofed XFF values must NOT create separate buckets by default,
		// or an attacker could rotate the header to evade the limit.
		const first = await app.request("/v1/status", {
			headers: { "X-Forwarded-For": "1.1.1.1" },
		})
		expect(first.status).toBe(200)
		const second = await app.request("/v1/status", {
			headers: { "X-Forwarded-For": "2.2.2.2" },
		})
		expect(second.status).toBe(429)
	})

	it("#28: rotating unvalidated bearer tokens cannot evade the pre-auth rate limit", async () => {
		process.env.MEMONGO_API_KEY = "valid-admin-key"
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		process.env.MEMONGO_TRUST_PROXY = ""

		const app = createApp()
		const first = await app.request("/v1/status", {
			headers: { Authorization: "Bearer attacker-token-a" },
		})
		expect(first.status).toBe(401)
		const second = await app.request("/v1/status", {
			headers: { Authorization: "Bearer attacker-token-b" },
		})
		expect(second.status).toBe(429)
	})

	it("#28: validated credentials receive separate rate-limit buckets", async () => {
		process.env.MEMONGO_API_KEY = "admin-key"
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"] },
			{ token: "scoped-B", agentIds: ["agent-B"] },
		])
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		process.env.MEMONGO_TRUST_PROXY = ""

		const app = createApp()
		expect(
			(
				await app.request("/v1/status", {
					headers: { Authorization: "Bearer invalid-key" },
				})
			).status,
		).toBe(401)
		expect(
			(
				await app.request("/v1/status", {
					headers: { Authorization: "Bearer admin-key" },
				})
			).status,
		).toBe(200)
		for (const [key, agentId] of [
			["scoped-A", "agent-A"],
			["scoped-B", "agent-B"],
		] as const) {
			const res = await app.request("/v1/search", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ agentId, query: "hello" }),
			})
			expect(res.status).toBe(200)
		}
	})

	it("#28: keys rate limiting per forwarded IP when MEMONGO_TRUST_PROXY is enabled", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		process.env.MEMONGO_TRUST_PROXY = "true"
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({ ok: true })

		const app = createApp()
		const a = await app.request("/v1/status", {
			headers: { "X-Forwarded-For": "1.1.1.1" },
		})
		const b = await app.request("/v1/status", {
			headers: { "X-Forwarded-For": "2.2.2.2" },
		})
		expect(a.status).toBe(200)
		expect(b.status).toBe(200)
	})

	it("#28: MEMONGO_API_MAX_BODY_BYTES=0 disables the body cap", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "0"
		process.env.MEMONGO_API_MAX_BODY_BYTES = "0"

		const body = JSON.stringify({ query: "x".repeat(5000) })
		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(body.length),
			},
			body,
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledOnce()
	})

	it("#28: caps request body size and returns 413 before the handler parses it", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "0"
		process.env.MEMONGO_API_MAX_BODY_BYTES = "50"

		const body = JSON.stringify({ query: "x".repeat(5000) })
		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(body.length),
			},
			body,
		})

		expect(res.status).toBe(413)
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("#28: caps streamed request bodies without a Content-Length header", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "0"
		process.env.MEMONGO_API_MAX_BODY_BYTES = "50"

		const payload = new TextEncoder().encode(
			JSON.stringify({ query: "x".repeat(5000) }),
		)
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(payload)
				controller.close()
			},
		})
		const request = new Request("http://localhost/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" })

		const res = await createApp().request(request)

		expect(res.status).toBe(413)
		expect(await res.json()).toEqual({
			error: {
				code: "PAYLOAD_TOO_LARGE",
				message: "request body exceeds the configured size limit",
			},
		})
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("denies v1 by default when no API credentials are configured", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		delete process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "must not execute", agentId: "main" }),
		})

		expect(res.status).toBe(401)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "AUTH_NOT_CONFIGURED",
				message: "API authentication is required",
			},
		})
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("allows explicit unauthenticated local development and warns once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { resetUnauthenticatedApiWarningForTests } = await import(
				"./app.js"
			)
			resetUnauthenticatedApiWarningForTests()

			createApp()
			createApp()

			expect(warn).toHaveBeenCalledTimes(1)
			expect(warn.mock.calls[0]?.[0]).toContain(
				"MEMONGO_ALLOW_INSECURE_NO_AUTH",
			)
		} finally {
			warn.mockRestore()
		}
	})

	it("denies unlisted origins when MEMONGO_CORS_ORIGINS is unset (dev defaults apply)", async () => {
		delete process.env.MEMONGO_CORS_ORIGINS

		const res = await createApp().request("/health", {
			headers: { Origin: "https://attacker.example" },
		})

		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
	})

	it("applies dev-default CORS origins for the web console when MEMONGO_CORS_ORIGINS is unset", async () => {
		delete process.env.MEMONGO_CORS_ORIGINS
		const app = createApp()

		const localhost = await app.request("/health", {
			headers: { Origin: "http://localhost:3040" },
		})
		const loopback = await app.request("/health", {
			headers: { Origin: "http://127.0.0.1:3040" },
		})

		expect(localhost.headers.get("Access-Control-Allow-Origin")).toBe(
			"http://localhost:3040",
		)
		expect(loopback.headers.get("Access-Control-Allow-Origin")).toBe(
			"http://127.0.0.1:3040",
		)
	})

	it("emits CORS headers only for configured origins", async () => {
		process.env.MEMONGO_CORS_ORIGINS =
			"https://console.example, https://admin.example"
		const app = createApp()

		const allowed = await app.request("/health", {
			headers: { Origin: "https://console.example" },
		})
		const denied = await app.request("/health", {
			headers: { Origin: "https://attacker.example" },
		})

		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://console.example",
		)
		expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull()
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

	it("forwards write-event validity bounds when provided", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "assistant",
				body: "historically valid memory",
				validAt: "2026-04-09T12:00:00.000Z",
				invalidAt: "2026-04-10T12:00:00.000Z",
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				validAt: "2026-04-09T12:00:00.000Z",
				invalidAt: "2026-04-10T12:00:00.000Z",
			}),
		)
	})

	it.each([
		"timestamp",
		"validAt",
		"invalidAt",
	])("rejects an invalid write-event %s", async (field) => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "assistant",
				body: "invalid dated memory",
				[field]: "not-a-date",
			}),
		})

		expect(res.status).toBe(400)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).not.toHaveBeenCalled()
	})

	it("rejects a write-event validity window that does not advance", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "assistant",
				body: "invalid validity window",
				validAt: "2026-04-10T12:00:00.000Z",
				invalidAt: "2026-04-10T12:00:00.000Z",
			}),
		})

		expect(res.status).toBe(400)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).not.toHaveBeenCalled()
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

	it("accepts benchmark identity, model declarations, and quality thresholds", async () => {
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
				qualityThresholds: {
					contractId: "longmemeval-release",
					version: "1",
					datasetKind: "longmemeval",
					minHitRate: 0.8,
					maxEmptyRate: 0.2,
					minRAt5: 0.75,
					minNdcgAt10: 0.7,
					maxP95LatencyMs: 500,
					minSessionRecallAnyAt10: 0.8,
					minSessionNdcgAnyAt10: 0.8,
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
				qualityThresholds: {
					contractId: "longmemeval-release",
					version: "1",
					datasetKind: "longmemeval",
					minHitRate: 0.8,
					maxEmptyRate: 0.2,
					minRAt5: 0.75,
					minNdcgAt10: 0.7,
					maxP95LatencyMs: 500,
					minSessionRecallAnyAt10: 0.8,
					minSessionNdcgAnyAt10: 0.8,
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

	it("rejects benchmark ingest when datasetPath escapes the allowed roots", async () => {
		bridgeMocks.memongoBridgeBenchmarkIngest.mockRejectedValue(
			new Error(
				"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
			),
		)

		const res = await createApp().request("/v1/admin/benchmarks/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				datasetPath: "/etc/secrets.jsonl",
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

	it("rejects relevance benchmark when datasetPath escapes the allowed roots", async () => {
		bridgeMocks.memongoBridgeRelevanceBenchmark.mockRejectedValue(
			new Error(
				"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
			),
		)

		const res = await createApp().request("/v1/admin/relevance/benchmark", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				agentId: "agent-42",
				datasetPath: "/etc/secrets.jsonl",
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
		bridgeMocks.memongoBridgeSearchKB.mockReset()
		bridgeMocks.memongoBridgeSearchKB.mockResolvedValue([])

		const res = await createApp().request("/v1/search-kb?scopeRef=ref-A", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-A",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: "hello" }),
		})

		expect(res.status).toBe(200)
		const call = bridgeMocks.memongoBridgeSearchKB.mock.calls[0]?.[0]
		expect(call?.scopeRef).toBe("ref-A")
	})

	it("scope isolation: search-kb rejects a scope-only policy that cannot constrain its scopeRef filter", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"], scopes: ["agent"] },
		])
		bridgeMocks.memongoBridgeSearchKB.mockReset()
		bridgeMocks.memongoBridgeSearchKB.mockResolvedValue([])

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
		expect(bridgeMocks.memongoBridgeSearchKB).not.toHaveBeenCalled()
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
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockRejectedValue(mongoDown)

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
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockRejectedValue(err)

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
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockRejectedValue(err)

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "hello" }),
		})

		expect(res.status).toBe(503)
	})

	it("P1.3: a generic 500 must NOT become retriable noise — non-network errors stay 500 with the route code", async () => {
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockRejectedValue(
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
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockRejectedValue(
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
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockResolvedValue([])
		bridgeMocks.memongoBridgeSearchKB.mockReset()
		bridgeMocks.memongoBridgeSearchKB.mockResolvedValue([])
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
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
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
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledWith(
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
			bridgeMocks.memongoBridgeSearch.mock.calls.at(-1)?.[0]?.maxResults,
		).toBe(100)

		const passthrough = await postJson("/v1/search", {
			query: "hello",
			limit: 25,
		})
		expect(passthrough.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeSearch.mock.calls.at(-1)?.[0]?.maxResults,
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
		expect(bridgeMocks.memongoBridgeSearchKB).not.toHaveBeenCalled()
	})

	it("/v1/search-kb accepts a typed filter and forwards it", async () => {
		const res = await postJson("/v1/search-kb", {
			query: "architecture",
			filter: { tags: ["db"], category: "runbook" },
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearchKB).toHaveBeenCalledWith(
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
