import { describe, expect, it, vi } from "vitest"
import {
	applySearchConfig,
	analyzeCorrectionNeeded,
	applyHardConstraintRejections,
	applyLaneAwareResultControls,
	applyMMRReranking,
	buildExecutorPasses,
	buildMemorySearchRequestSignature,
	classifyExecutorSearch,
	executeMongoSearchPlan,
	identifyRelaxableConstraint,
	inferSearchResultLane,
	normalizeMemorySearchRequest,
	resolveSearchConfig,
	requestHasHardConstraints,
	resolveExecutorTimeRange,
} from "./mongodb-search-executor.js"
import type { MemorySearchResult } from "./types.js"

describe("normalizeMemorySearchRequest", () => {
	it("applies bounded defaults for mode, passes, and source order", () => {
		const normalized = normalizeMemorySearchRequest({ query: " hello " })
		expect(normalized.query).toBe(" hello ")
		expect(normalized.searchMode).toBe("auto")
		expect(normalized.maxPasses).toBe(2)
		expect(normalized.sourcePreference).toEqual([
			"conversation",
			"structured",
			"procedural",
			"reference",
			"episodic",
			"graph",
		])
	})

	it("clamps maxPasses to the supported range", () => {
		const normalized = normalizeMemorySearchRequest({
			query: "hello",
			searchMode: "agentic",
			maxPasses: 99,
		})
		expect(normalized.maxPasses).toBe(4)
	})

	it("applies recipe defaults before executor normalization", () => {
		const normalized = normalizeMemorySearchRequest({
			query: "hello",
			searchConfig: { recipe: "chain-of-thought" },
		})
		expect(normalized.searchMode).toBe("agentic")
		expect(normalized.maxPasses).toBe(4)
		expect(normalized.searchConfig).toEqual(
			expect.objectContaining({
				recipe: "chain-of-thought",
				fusionMethod: "rankFusion",
			}),
		)
	})
})

describe("search recipes", () => {
	it("resolves the fast recipe to vector-first bounded execution", () => {
		const resolved = resolveSearchConfig({
			query: "phoenix",
			searchConfig: { recipe: "fast" },
		})
		expect(resolved).toEqual(
			expect.objectContaining({
				recipe: "fast",
				maxResults: 5,
				searchMode: "direct",
				maxPasses: 1,
				numCandidates: 20,
				hybridMode: "vector-only",
				allowHybridBackstop: false,
			}),
		)
	})

	it("enforces MongoDB high-recall numCandidates in proof profile", () => {
		const resolved = resolveSearchConfig({
			query: "phoenix",
			maxResults: 200,
			searchConfig: {
				recallProfile: "proof",
				numCandidates: 200,
			},
		})
		expect(resolved).toEqual(
			expect.objectContaining({
				recallProfile: "proof",
				maxResults: 200,
				numCandidates: 4000,
			}),
		)
	})

	it("lets proof profile keep explicit candidates above the MongoDB floor", () => {
		const resolved = resolveSearchConfig({
			query: "phoenix",
			maxResults: 50,
			searchConfig: {
				recallProfile: "proof",
				numCandidates: 2500,
			},
		})
		expect(resolved.numCandidates).toBe(2500)
	})

	it("does not inject balanced recall profile into normalized requests", () => {
		const applied = applySearchConfig({
			query: "phoenix",
			maxResults: 50,
		})
		expect(applied.searchConfig?.recallProfile).toBeUndefined()
	})

	it("keeps explicit proof recall profile in normalized requests", () => {
		const applied = applySearchConfig({
			query: "phoenix",
			maxResults: 50,
			searchConfig: { recallProfile: "proof" },
		})
		expect(applied.searchConfig?.recallProfile).toBe("proof")
		expect(applied.searchConfig?.numCandidates).toBe(1000)
	})

	it("lets explicit top-level fields override recipe defaults", () => {
		const applied = applySearchConfig({
			query: "phoenix",
			maxPasses: 2,
			searchConfig: { recipe: "chain-of-thought" },
		})
		expect(applied.maxPasses).toBe(2)
		expect(applied.searchMode).toBe("agentic")
	})
})

describe("classifyExecutorSearch", () => {
	it("detects family-style queries", () => {
		expect(
			classifyExecutorSearch({
				query: "open source eval tools family",
			}),
		).toBe("family")
	})

	it("detects scoped searches when explicit scopes are present", () => {
		expect(
			classifyExecutorSearch({
				query: "find the decision",
				structuredScope: { type: "decision" },
			}),
		).toBe("scoped")
	})
})

describe("buildExecutorPasses", () => {
	it("keeps direct auto queries single-pass", () => {
		const passes = buildExecutorPasses(
			normalizeMemorySearchRequest({ query: "what is Bloom" }),
			"direct",
		)
		expect(passes).toHaveLength(1)
		expect(passes[0]?.variant).toBe("original")
	})

	it("expands family queries in agentic mode", () => {
		const passes = buildExecutorPasses(
			normalizeMemorySearchRequest({
				query: "open source eval tools",
				searchMode: "agentic",
			}),
			"family",
		)
		expect(passes.map((pass) => pass.query)).toEqual(["open source eval tools"])
	})
})

describe("applyHardConstraintRejections", () => {
	const timeRange = resolveExecutorTimeRange({
		query: "what happened today",
		timeRange: { preset: "today" },
	})

	it("rejects results outside the requested time range", () => {
		if (!timeRange) {
			throw new Error("time range missing")
		}
		const result = applyHardConstraintRejections({
			request: {
				query: "what happened today",
				timeRange: { preset: "today" },
			},
			timeRange,
			results: [
				{
					path: "events/old",
					startLine: 0,
					endLine: 0,
					score: 0.7,
					snippet: "old",
					source: "conversation",
					timestamp: new Date("2001-01-01T00:00:00.000Z"),
				},
			],
		})
		expect(result.accepted).toHaveLength(0)
		expect(result.rejected[0]?.reason).toBe("outside requested time range")
	})

	it("rejects results without exact evidence when required", () => {
		const result = applyHardConstraintRejections({
			request: { query: "exact", needExactEvidence: true },
			results: [
				{
					path: "",
					startLine: 0,
					endLine: 0,
					score: 0.7,
					snippet: "no locator",
					source: "conversation",
				},
			],
		})
		expect(result.accepted).toHaveLength(0)
		expect(result.rejected[0]?.reason).toBe("missing exact evidence locator")
	})

	it("rejects results outside the requested conversation scope", () => {
		const result = applyHardConstraintRejections({
			request: {
				query: "Who owns the Phoenix rollback in this thread?",
				conversationScope: { sessionKey: "session-main" },
			},
			results: [
				{
					path: "events/main",
					startLine: 0,
					endLine: 0,
					score: 0.8,
					snippet: "Marcus owns the Phoenix rollback.",
					source: "conversation",
					scope: "session",
					scopeRef: "session:session-main",
				},
				{
					path: "events/side",
					startLine: 0,
					endLine: 0,
					score: 0.79,
					snippet: "Sarah owns the Phoenix rollback.",
					source: "conversation",
					scope: "session",
					scopeRef: "session:session-side",
				},
			],
		})
		expect(result.accepted).toHaveLength(1)
		expect(result.accepted[0]?.path).toBe("events/main")
		expect(result.rejected[0]?.reason).toBe(
			"outside requested conversation scope",
		)
	})

	it("rejects exact-evidence hits that miss the requested anchor", () => {
		const result = applyHardConstraintRejections({
			request: {
				query: "What is the Red Kite launch codeword?",
				needExactEvidence: true,
			},
			results: [
				{
					path: "events/blue-finch",
					startLine: 0,
					endLine: 0,
					score: 0.91,
					snippet: "Stored. The launch codeword is Blue Finch.",
					source: "conversation",
				},
			],
		})
		expect(result.accepted).toHaveLength(0)
		expect(result.rejected[0]?.reason).toBe(
			"missing requested entity/value anchor",
		)
	})

	it("keeps exact-evidence hits that mention the requested anchor", () => {
		const result = applyHardConstraintRejections({
			request: {
				query: "What is the current Phoenix release window?",
				needExactEvidence: true,
			},
			results: [
				{
					path: "structured:decision:phoenix-release-window",
					startLine: 0,
					endLine: 0,
					score: 0.91,
					snippet: "Phoenix deploys on Monday afternoon after validation.",
					source: "structured",
				},
			],
		})
		expect(result.accepted).toHaveLength(1)
		expect(result.rejected).toHaveLength(0)
	})
})

describe("requestHasHardConstraints", () => {
	it("treats conversation scope as a hard constraint", () => {
		expect(
			requestHasHardConstraints({
				query: "hello",
				conversationScope: { sessionKey: "session-1" },
			}),
		).toBe(true)
	})

	it("treats explicit scoped filters as hard constraints", () => {
		expect(
			requestHasHardConstraints({
				query: "decision",
				structuredScope: { type: "decision" },
			}),
		).toBe(true)
	})
})

describe("lane-aware result controls", () => {
	it("infers graph and session-evidence lanes from path/provenance", () => {
		expect(
			inferSearchResultLane(
				makeResult({
					path: "relation:a-b",
					provenance: { lane: "graph" },
				}),
			),
		).toBe("graph")
		expect(
			inferSearchResultLane(
				makeResult({
					path: "session-chunk/session-1",
					canonicalId: "session-chunk/session-1",
				}),
			),
		).toBe("session-evidence")
		expect(
			inferSearchResultLane(
				makeResult({
					path: "memory-evidence/preference:session-1:abc",
					canonicalId: "memory-evidence/preference:session-1:abc",
					provenance: {
						lane: "memory-evidence",
						evidenceUnit: "preference",
					},
				}),
			),
		).toBe("session-evidence")
	})

	it("boosts session evidence and caps graph/procedure dominance for personal recall", () => {
		const graph = Array.from({ length: 4 }, (_, index) =>
			makeResult({
				path: `relation:a-${index}`,
				canonicalId: `relation:a-${index}`,
				score: 0.9 - index * 0.01,
				provenance: { lane: "graph" },
			}),
		)
		const procedure = makeResult({
			path: "procedure:deploy",
			canonicalId: "procedure:deploy",
			score: 0.86,
			source: "structured",
			provenance: { lane: "procedural" },
		})
		const session = makeResult({
			path: "events/evt-1",
			canonicalId: "event:evt-1",
			score: 0.78,
			sessionId: "session-1",
			sourceEventIds: ["evt-1"],
		})

		const controlled = applyLaneAwareResultControls({
			query: "What did I say I prefer in the last conversation?",
			results: [...graph, procedure, session],
			classification: "direct",
			planPaths: ["hybrid", "raw-window", "graph"],
			topK: 3,
		})

		expect(controlled.summary.applied).toBe(true)
		expect(controlled.summary.boosted).toBe(1)
		expect(controlled.summary.demoted).toBeGreaterThan(0)
		expect(controlled.summary.capped).toBeGreaterThan(0)
		expect(controlled.results.slice(0, 3).map(inferSearchResultLane)).toContain(
			"conversation",
		)
		expect(
			controlled.results
				.slice(0, 3)
				.filter((result) => inferSearchResultLane(result) === "graph"),
		).toHaveLength(1)
	})

	it("boosts newer session evidence for current personal setup queries", () => {
		const oldSession = makeResult({
			path: "",
			canonicalId: "session-chunk/old",
			score: 0.8,
			sessionId: "old",
			timestamp: new Date("2023-05-21T00:00:00.000Z"),
			provenance: { lane: "session-evidence" },
		})
		const currentSession = makeResult({
			path: "",
			canonicalId: "session-chunk/current",
			score: 0.62,
			sessionId: "current",
			timestamp: new Date("2023-05-27T00:00:00.000Z"),
			provenance: { lane: "session-evidence" },
		})

		const controlled = applyLaneAwareResultControls({
			query: "Can you suggest accessories for my current photography setup?",
			results: [oldSession, currentSession],
			classification: "direct",
			planPaths: ["hybrid"],
			topK: 2,
		})

		expect(controlled.summary.recencyBoosted).toBeGreaterThan(0)
		expect(controlled.results[0]?.canonicalId).toBe("session-chunk/current")
	})

	it("limits duplicate sessions from flooding personal-memory top results", () => {
		const repeatedSession = Array.from({ length: 5 }, (_, index) =>
			makeResult({
				path: `events/a-${index}`,
				canonicalId: `event:a-${index}`,
				score: 1 - index * 0.01,
				sessionId: "session-a",
				sourceEventIds: [`a-${index}`],
			}),
		)
		const otherSessions = ["b", "c", "d"].map((id, index) =>
			makeResult({
				path: `events/${id}-1`,
				canonicalId: `event:${id}-1`,
				score: 0.94 - index * 0.01,
				sessionId: `session-${id}`,
				sourceEventIds: [`${id}-1`],
			}),
		)

		const controlled = applyLaneAwareResultControls({
			query: "Any tips based on what I mentioned before?",
			results: [...repeatedSession, ...otherSessions],
			classification: "direct",
			planPaths: ["hybrid"],
			topK: 5,
		})

		expect(controlled.summary.sessionCapped).toBeGreaterThan(0)
		expect(
			controlled.results.slice(0, 5).map((result) => result.sessionId),
		).toContain("session-b")
		expect(
			controlled.results.slice(0, 5).map((result) => result.sessionId),
		).toContain("session-c")
		expect(
			controlled.results
				.slice(0, 5)
				.filter((result) => result.sessionId === "session-a"),
		).toHaveLength(2)
	})

	it("exhausts distinct session coverage before repeated turns for temporal queries", () => {
		const repeatedSession = Array.from({ length: 5 }, (_, index) =>
			makeResult({
				path: `events/a-${index}`,
				canonicalId: `event:a-${index}`,
				score: 1 - index * 0.01,
				sessionId: "session-a",
				sourceEventIds: [`a-${index}`],
			}),
		)
		const otherSessions = ["b", "c", "d", "e", "f"].map((id, index) =>
			makeResult({
				path: `events/${id}-1`,
				canonicalId: `event:${id}-1`,
				score: 0.93 - index * 0.01,
				sessionId: `session-${id}`,
				sourceEventIds: [`${id}-1`],
			}),
		)

		const controlled = applyLaneAwareResultControls({
			query: "What changed across sessions before the latest update?",
			results: [...repeatedSession, ...otherSessions],
			classification: "temporal",
			planPaths: ["hybrid"],
			topK: 5,
		})

		expect(controlled.summary.sessionCapped).toBeGreaterThan(0)
		expect(
			controlled.results
				.slice(0, 5)
				.filter((result) => result.sessionId === "session-a"),
		).toHaveLength(1)
		expect(
			new Set(controlled.results.slice(0, 5).map((r) => r.sessionId)).size,
		).toBe(5)
	})

	it("boosts preference evidence above generic turn hits for advice queries", () => {
		const turn = makeResult({
			path: "events/turn-1",
			canonicalId: "event:turn-1",
			score: 0.91,
			sessionId: "session-a",
			sourceEventIds: ["turn-1"],
		})
		const preference = makeResult({
			path: "memory-evidence/preference:session-b:pref",
			canonicalId: "memory-evidence/preference:session-b:pref",
			score: 0.72,
			sessionId: "session-b",
			sourceEventIds: ["turn-2"],
			provenance: {
				lane: "memory-evidence",
				evidenceUnit: "preference",
			},
		})

		const controlled = applyLaneAwareResultControls({
			query: "What advice fits my food preferences?",
			results: [turn, preference],
			classification: "direct",
			planPaths: ["hybrid"],
			topK: 2,
		})

		expect(controlled.summary.boosted).toBe(2)
		expect(controlled.results[0]?.canonicalId).toBe(
			"memory-evidence/preference:session-b:pref",
		)
	})

	it("leaves explicit graph queries free to return graph-heavy top results", () => {
		const graph = Array.from({ length: 3 }, (_, index) =>
			makeResult({
				path: `relation:a-${index}`,
				canonicalId: `relation:a-${index}`,
				score: 0.9 - index * 0.01,
				provenance: { lane: "graph" },
			}),
		)
		const controlled = applyLaneAwareResultControls({
			query: "Who is Alice connected to?",
			results: graph,
			classification: "multi-hop",
			planPaths: ["graph", "hybrid"],
			topK: 3,
		})

		expect(controlled.summary.capped).toBe(0)
		expect(controlled.results.slice(0, 3).map(inferSearchResultLane)).toEqual([
			"graph",
			"graph",
			"graph",
		])
	})
})

describe("buildMemorySearchRequestSignature", () => {
	it("is stable across object key ordering", () => {
		const left = buildMemorySearchRequestSignature({
			query: "hello",
			referenceScope: { category: "docs", tags: ["a", "b"] },
		})
		const right = buildMemorySearchRequestSignature({
			query: "hello",
			referenceScope: { tags: ["a", "b"], category: "docs" },
		})
		expect(left).toBe(right)
	})
})

// ---------------------------------------------------------------------------
// executeMongoSearchPlan orchestration tests
// ---------------------------------------------------------------------------

function makeResult(
	overrides: Partial<MemorySearchResult> = {},
): MemorySearchResult {
	return {
		path: overrides.path ?? "chunks/abc",
		startLine: 0,
		endLine: 0,
		score: overrides.score ?? 0.8,
		snippet: overrides.snippet ?? "test snippet",
		source: overrides.source ?? "conversation",
		canonicalId:
			overrides.canonicalId ?? `id-${Math.random().toString(36).slice(2, 8)}`,
		...(overrides.timestamp ? { timestamp: overrides.timestamp } : {}),
		...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}),
		...(overrides.scope ? { scope: overrides.scope } : {}),
		...(overrides.scopeRef ? { scopeRef: overrides.scopeRef } : {}),
		...(overrides.state ? { state: overrides.state } : {}),
		...(overrides.provenance ? { provenance: overrides.provenance } : {}),
		...(overrides.sourceEventIds
			? { sourceEventIds: overrides.sourceEventIds }
			: {}),
		...(overrides.sourceReliability !== undefined
			? { sourceReliability: overrides.sourceReliability }
			: {}),
		...(overrides.reinforcementCount !== undefined
			? { reinforcementCount: overrides.reinforcementCount }
			: {}),
		...(overrides.validFrom ? { validFrom: overrides.validFrom } : {}),
		...(overrides.validTo ? { validTo: overrides.validTo } : {}),
		...(overrides.reviewAt ? { reviewAt: overrides.reviewAt } : {}),
		...(overrides.lastConfirmedAt
			? { lastConfirmedAt: overrides.lastConfirmedAt }
			: {}),
	}
}

function makeMockExecutePass(passResults: MemorySearchResult[][]) {
	let callIdx = 0
	return vi.fn().mockImplementation(async () => {
		const results = passResults[callIdx] ?? []
		callIdx++
		return {
			results,
			metadata: {
				plan: {
					paths: ["hybrid"],
					confidence: "high" as const,
					reasoning: "test",
				},
				pathsExecuted: ["hybrid"],
				resultsByPath: { hybrid: results.length },
				reranked: false,
				queryRewritten: false,
			},
		}
	})
}

describe("executeMongoSearchPlan", () => {
	const allPaths = new Set([
		"active-critical",
		"structured",
		"raw-window",
		"graph",
		"hybrid",
		"kb",
		"episodic",
		"procedural",
	] as const)

	it("executes a single pass for a direct query", async () => {
		const r1 = makeResult({ canonicalId: "r1" })
		const mock = makeMockExecutePass([[r1]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "what is Bloom",
				searchMode: "direct",
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(response.metadata.passes).toHaveLength(1)
		expect(response.metadata.classification).toBe("direct")
		expect(response.results).toHaveLength(1)
		expect(response.results[0]?.canonicalId).toBe("r1")
		expect(mock).toHaveBeenCalledTimes(1)
	})

	it("accumulates results across multiple passes for family queries", async () => {
		const r1 = makeResult({
			canonicalId: "r1",
			snippet: "result from pass 1",
		})
		const r2 = makeResult({
			canonicalId: "r2",
			snippet: "result from pass 2",
		})
		const mock = makeMockExecutePass([[r1], [r2]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "eval tools family",
				searchMode: "agentic",
				maxPasses: 3,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(response.metadata.classification).toBe("family")
		expect(response.metadata.passes.length).toBeGreaterThanOrEqual(2)
		expect(response.results).toHaveLength(2)
		const ids = response.results.map((r) => r.canonicalId)
		expect(ids).toContain("r1")
		expect(ids).toContain("r2")
	})

	it("opens a breadth follow-up only after the first family pass under-covers results", async () => {
		const first = makeResult({
			canonicalId: "first",
			snippet: "first result",
		})
		const second = makeResult({
			canonicalId: "second",
			snippet: "second result",
		})
		const mockPass = vi
			.fn()
			.mockResolvedValueOnce({
				results: [first],
				metadata: {
					plan: {
						paths: ["hybrid"],
						confidence: "high" as const,
						reasoning: "pass 1",
					},
					pathsExecuted: ["hybrid"],
					resultsByPath: { hybrid: 1 },
					reranked: false,
					queryRewritten: false,
				},
			})
			.mockResolvedValueOnce({
				results: [second],
				metadata: {
					plan: {
						paths: ["kb", "procedural"],
						confidence: "medium" as const,
						reasoning: "pass 2",
					},
					pathsExecuted: ["kb", "procedural"],
					resultsByPath: { kb: 1, procedural: 1 },
					reranked: false,
					queryRewritten: false,
				},
			})

		const response = await executeMongoSearchPlan({
			request: {
				query: "open source eval tools family",
				searchMode: "agentic",
				maxPasses: 3,
			},
			availablePaths: allPaths,
			executePass: mockPass,
		})

		expect(mockPass).toHaveBeenCalledTimes(2)
		expect(response.metadata.passes[1]?.reason).toContain("breadth")
		expect(response.metadata.passes[1]?.query).toBe(
			"open source eval tools family",
		)
	})

	it("opens a current-state recovery follow-up when first-pass results are stale or invalidated", async () => {
		const stale = makeResult({
			canonicalId: "stale-owner",
			path: "relation:billing-service-old-owner",
			score: 0.91,
			state: "invalidated",
			validTo: new Date("2026-03-01T00:00:00.000Z"),
		})
		const fresh = makeResult({
			canonicalId: "fresh-owner",
			path: "events/e-fresh",
			score: 0.82,
			timestamp: new Date(),
			sourceEventIds: ["e-fresh"],
		})
		const mockPass = vi
			.fn()
			.mockResolvedValueOnce({
				results: [stale],
				metadata: {
					plan: {
						paths: ["graph"],
						confidence: "high" as const,
						reasoning: "pass 1",
					},
					pathsExecuted: ["graph"],
					resultsByPath: { graph: 1 },
					reranked: false,
					queryRewritten: false,
				},
			})
			.mockResolvedValueOnce({
				results: [fresh],
				metadata: {
					plan: {
						paths: ["raw-window", "active-critical"],
						confidence: "medium" as const,
						reasoning: "pass 2",
					},
					pathsExecuted: ["raw-window", "active-critical"],
					resultsByPath: { "raw-window": 1, "active-critical": 1 },
					reranked: false,
					queryRewritten: false,
				},
			})

		const response = await executeMongoSearchPlan({
			request: {
				query: "who owns billing-service right now",
				searchMode: "agentic",
				maxPasses: 3,
			},
			availablePaths: allPaths,
			executePass: mockPass,
		})

		expect(mockPass).toHaveBeenCalledTimes(2)
		expect(mockPass.mock.calls[1]?.[0].availablePaths.has("raw-window")).toBe(
			true,
		)
		expect(response.metadata.passes[1]?.reason).toContain("current-state")
		expect(response.results[0]?.canonicalId).toBe("fresh-owner")
	})

	it("terminates early when family query accumulates enough results", async () => {
		const results = [
			makeResult({ canonicalId: "r1" }),
			makeResult({ canonicalId: "r2" }),
			makeResult({ canonicalId: "r3" }),
		]
		const mock = makeMockExecutePass([
			results,
			[makeResult({ canonicalId: "r4" })],
		])

		const response = await executeMongoSearchPlan({
			request: {
				query: "eval tools family",
				searchMode: "agentic",
				maxPasses: 3,
				maxResults: 3,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(response.results).toHaveLength(3)
		// Early termination: pass 2 should not be called because pass 1 returned >= min(maxResults, 3) = 3
		expect(mock).toHaveBeenCalledTimes(1)
	})

	it("deduplicates results with the same canonicalId across passes", async () => {
		const shared = makeResult({
			canonicalId: "shared-id",
			snippet: "same chunk",
		})
		const unique = makeResult({
			canonicalId: "unique-id",
			snippet: "different chunk",
		})
		const mock = makeMockExecutePass([[shared], [{ ...shared }, unique]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "eval tools family",
				searchMode: "agentic",
				maxPasses: 3,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		const ids = response.results.map((r) => r.canonicalId)
		expect(ids.filter((id) => id === "shared-id")).toHaveLength(1)
		expect(ids).toContain("unique-id")
	})

	it("propagates hard constraint rejections into metadata", async () => {
		const oldResult = makeResult({
			canonicalId: "old",
			timestamp: new Date("2001-01-01T00:00:00.000Z"),
		})
		const mock = makeMockExecutePass([[oldResult]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "what happened today",
				searchMode: "direct",
				timeRange: { preset: "today" },
				needExactEvidence: true,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(response.results).toHaveLength(0)
		expect(response.metadata.resultsRejected.length).toBeGreaterThan(0)
		expect(response.metadata.resultsRejected[0]?.reason).toBe(
			"outside requested time range",
		)
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"No exact-evidence results",
		)
	})

	it("returns noDirectEvidenceReason when needExactEvidence filters all results", async () => {
		// Result with no canonicalId and empty path — fails resultHasExactEvidence
		const noLocator: MemorySearchResult = {
			path: "",
			startLine: 0,
			endLine: 0,
			score: 0.8,
			snippet: "no locator snippet",
			source: "conversation",
		}
		const mock = makeMockExecutePass([[noLocator]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "find exact",
				searchMode: "direct",
				needExactEvidence: true,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(response.results).toHaveLength(0)
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"No exact-evidence results",
		)
	})

	it("merges pathsExecuted and resultsByPath across passes", async () => {
		const hybridResult = makeResult({ canonicalId: "h1" })
		const kbResult = makeResult({ canonicalId: "kb1" })
		const pass3Result = makeResult({ canonicalId: "p3" })
		const mockPass = vi
			.fn()
			.mockResolvedValueOnce({
				results: [hybridResult],
				metadata: {
					plan: {
						paths: ["hybrid"],
						confidence: "high" as const,
						reasoning: "pass 1",
					},
					pathsExecuted: ["hybrid"],
					resultsByPath: { hybrid: 1 },
					reranked: false,
					queryRewritten: false,
				},
			})
			.mockResolvedValueOnce({
				results: [kbResult],
				metadata: {
					plan: {
						paths: ["kb"],
						confidence: "high" as const,
						reasoning: "pass 2",
					},
					pathsExecuted: ["kb"],
					resultsByPath: { kb: 1 },
					reranked: true,
					queryRewritten: true,
				},
			})
			.mockResolvedValueOnce({
				results: [pass3Result],
				metadata: {
					plan: {
						paths: ["procedural"],
						confidence: "high" as const,
						reasoning: "pass 3",
					},
					pathsExecuted: ["procedural"],
					resultsByPath: { procedural: 1 },
					reranked: false,
					queryRewritten: false,
				},
			})

		const response = await executeMongoSearchPlan({
			request: {
				query: "eval tools family",
				searchMode: "agentic",
				maxPasses: 3,
			},
			availablePaths: allPaths,
			executePass: mockPass,
		})

		expect(response.metadata.pathsExecuted).toContain("hybrid")
		expect(response.metadata.pathsExecuted).toContain("kb")
		expect(response.metadata.resultsByPath.hybrid).toBe(1)
		expect(response.metadata.resultsByPath.kb).toBe(1)
		expect(response.metadata.passes.length).toBeGreaterThanOrEqual(2)
		expect(response.metadata.queriesTried.length).toBeGreaterThanOrEqual(2)
	})

	it("adds trust metadata and trust-aware ordering to final results", async () => {
		const mock = vi.fn().mockResolvedValueOnce({
			results: [
				makeResult({
					canonicalId: "invalidated",
					score: 0.98,
					path: "relation:billing-service-old-owner",
					state: "invalidated",
					validTo: new Date("2026-04-01T00:00:00.000Z"),
					sourceReliability: 0.95,
				}),
				makeResult({
					canonicalId: "stable",
					score: 0.9,
					path: "events/e-stable",
					timestamp: new Date(),
					sourceReliability: 0.9,
					sourceEventIds: ["e-stable"],
				}),
			],
			metadata: {
				plan: {
					paths: ["graph", "raw-window"],
					confidence: "high" as const,
					reasoning: "test",
				},
				pathsExecuted: ["graph", "raw-window"],
				resultsByPath: { graph: 1, "raw-window": 1 },
				reranked: false,
				queryRewritten: false,
			},
		})

		const response = await executeMongoSearchPlan({
			request: {
				query: "who owns billing-service",
				searchMode: "direct",
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(response.results[0]?.canonicalId).toBe("stable")
		expect(response.results[0]?.trust?.confidence).not.toBe("low")
		expect(response.results[1]?.trust?.contradiction).toBe("invalidated")
		expect(response.metadata.trustSummary?.distribution.low).toBe(1)
	})

	it("abstains when all surviving direct-query results remain low trust", async () => {
		const mock = vi.fn().mockResolvedValueOnce({
			results: [
				makeResult({
					path: "relation:stale-owner",
					score: 0.84,
					state: "invalidated",
					validTo: new Date("2026-03-01T00:00:00.000Z"),
					sourceReliability: 0.2,
				}),
			],
			metadata: {
				plan: {
					paths: ["graph"],
					confidence: "medium" as const,
					reasoning: "test",
				},
				pathsExecuted: ["graph"],
				resultsByPath: { graph: 1 },
				reranked: false,
				queryRewritten: false,
			},
		})

		const response = await executeMongoSearchPlan({
			request: {
				query: "who owns billing-service",
				searchMode: "direct",
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(response.results).toHaveLength(0)
		expect(response.metadata.noDirectEvidenceReason).toContain("low-trust")
		expect(response.metadata.trustSummary?.distribution.low).toBe(1)
	})

	it("triggers CRAG corrective pass when evidence coverage is none", async () => {
		// All main-loop passes return results outside time range -> rejected -> coverage "none"
		const oldResult = makeResult({
			canonicalId: "old",
			timestamp: new Date("2001-01-01T00:00:00.000Z"),
		})
		// Corrective pass: returns a valid result within widened time range
		const validResult = makeResult({
			canonicalId: "valid",
			timestamp: new Date(),
		})
		// Temporal agentic query generates 2 planned passes + 1 corrective = 3 mock calls needed
		const mock = makeMockExecutePass([[oldResult], [oldResult], [validResult]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "what happened recently",
				searchMode: "agentic",
				maxPasses: 3,
				timeRange: { preset: "today" },
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		// The corrective pass should have fired
		const correctivePasses = response.metadata.passes.filter(
			(p) => p.correctionApplied,
		)
		expect(correctivePasses.length).toBeGreaterThanOrEqual(1)
		expect(correctivePasses[0]?.correctionApplied).toBe("time-range-widened-2x")
	})

	it("triggers constraint relaxation when all results are rejected", async () => {
		// All passes return results outside time range -> all rejected -> relaxation fires
		const oldResult = makeResult({
			canonicalId: "old",
			timestamp: new Date("2001-01-01T00:00:00.000Z"),
		})
		// Relaxation pass returns result without time constraint
		const anyResult = makeResult({ canonicalId: "any" })
		const mock = vi
			.fn()
			// Pass 1 (main): returns old result
			.mockResolvedValueOnce({
				results: [oldResult],
				metadata: {
					plan: {
						paths: ["hybrid"],
						confidence: "high" as const,
						reasoning: "pass 1",
					},
					pathsExecuted: ["hybrid"],
					resultsByPath: { hybrid: 1 },
					reranked: false,
					queryRewritten: false,
				},
			})
			// Corrective pass: also returns old result
			.mockResolvedValueOnce({
				results: [oldResult],
				metadata: {
					plan: {
						paths: ["hybrid"],
						confidence: "high" as const,
						reasoning: "corrective",
					},
					pathsExecuted: ["hybrid"],
					resultsByPath: { hybrid: 1 },
					reranked: false,
					queryRewritten: false,
				},
			})
			// Relaxation pass: returns valid result
			.mockResolvedValueOnce({
				results: [anyResult],
				metadata: {
					plan: {
						paths: ["hybrid"],
						confidence: "high" as const,
						reasoning: "relaxation",
					},
					pathsExecuted: ["hybrid"],
					resultsByPath: { hybrid: 1 },
					reranked: false,
					queryRewritten: false,
				},
			})

		const response = await executeMongoSearchPlan({
			request: {
				query: "some query",
				searchMode: "direct",
				timeRange: { preset: "today" },
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(response.metadata.constraintRelaxations).toBeDefined()
		expect(response.metadata.constraintRelaxations?.[0]?.action).toBe(
			"removed-time-range",
		)
		expect(response.results.length).toBeGreaterThan(0)
	})
})

// ---------------------------------------------------------------------------
// analyzeCorrectionNeeded unit tests
// ---------------------------------------------------------------------------

describe("analyzeCorrectionNeeded", () => {
	it("returns needed:false when coverage is direct", () => {
		expect(
			analyzeCorrectionNeeded({
				evidenceCoverage: "direct",
				rejected: [{ reason: "outside requested time range" }],
				passCount: 1,
				maxPasses: 3,
			}),
		).toEqual({ needed: false })
	})

	it("identifies time-range correction when dominant rejection is temporal", () => {
		const result = analyzeCorrectionNeeded({
			evidenceCoverage: "none",
			rejected: [
				{ reason: "outside requested time range" },
				{ reason: "outside requested time range" },
				{ reason: "missing exact evidence locator" },
			],
			passCount: 1,
			maxPasses: 3,
		})
		expect(result.needed).toBe(true)
		expect(result.correction).toBe("time-range-widened-2x")
	})

	it("identifies evidence relaxation when dominant rejection is locator", () => {
		const result = analyzeCorrectionNeeded({
			evidenceCoverage: "indirect",
			rejected: [{ reason: "missing exact evidence locator" }],
			passCount: 1,
			maxPasses: 2,
		})
		expect(result.needed).toBe(true)
		expect(result.correction).toBe("hybrid-evidence-relaxed")
	})

	it("returns needed:false when all passes exhausted", () => {
		expect(
			analyzeCorrectionNeeded({
				evidenceCoverage: "none",
				rejected: [{ reason: "outside requested time range" }],
				passCount: 3,
				maxPasses: 3,
			}),
		).toEqual({ needed: false })
	})
})

// ---------------------------------------------------------------------------
// identifyRelaxableConstraint unit tests
// ---------------------------------------------------------------------------

describe("identifyRelaxableConstraint", () => {
	it("returns null for empty rejections", () => {
		expect(identifyRelaxableConstraint([])).toBeNull()
	})

	it("identifies time range as relaxable constraint", () => {
		const result = identifyRelaxableConstraint([
			{ reason: "outside requested time range" },
			{ reason: "outside requested time range" },
		])
		expect(result).toEqual({
			constraint: "timeRange",
			action: "removed-time-range",
		})
	})

	it("identifies exact evidence as relaxable constraint", () => {
		const result = identifyRelaxableConstraint([
			{ reason: "missing exact evidence locator" },
		])
		expect(result).toEqual({
			constraint: "needExactEvidence",
			action: "disabled-exact-evidence",
		})
	})
})

// ---------------------------------------------------------------------------
// applyMMRReranking unit tests
// ---------------------------------------------------------------------------

describe("applyMMRReranking", () => {
	it("returns unchanged results for fewer than 3 items", () => {
		const results: MemorySearchResult[] = [
			makeResult({ snippet: "one", score: 0.9 }),
			makeResult({ snippet: "two", score: 0.8 }),
		]
		const { results: mmrResults, mmrApplied } = applyMMRReranking({
			results,
			classification: "family",
		})
		expect(mmrApplied).toBe(false)
		expect(mmrResults).toHaveLength(2)
	})

	it("applies MMR reranking for family queries with 3+ results", () => {
		const results: MemorySearchResult[] = [
			makeResult({
				snippet: "kubernetes helm chart deployment rollback procedure",
				score: 0.9,
			}),
			makeResult({
				snippet: "kubernetes helm chart deployment rollback steps",
				score: 0.85,
			}),
			makeResult({
				snippet: "monitoring grafana dashboard alerts notification",
				score: 0.8,
			}),
		]
		const {
			results: mmrResults,
			mmrApplied,
			mmrLambda,
		} = applyMMRReranking({
			results,
			classification: "family",
		})
		expect(mmrApplied).toBe(true)
		expect(mmrLambda).toBe(0.3)
		expect(mmrResults).toHaveLength(3)
		// First result always stays (highest score)
		expect(mmrResults[0]?.snippet).toContain(
			"kubernetes helm chart deployment rollback procedure",
		)
		// MMR with lambda=0.3 (high diversity) should promote the diverse result over the similar one
		expect(mmrResults[1]?.snippet).toContain("monitoring grafana")
	})

	it("uses higher lambda for direct classification (relevance-dominant)", () => {
		const results: MemorySearchResult[] = [
			makeResult({
				snippet: "result a specific topic exact",
				score: 0.95,
			}),
			makeResult({
				snippet: "result b specific topic exact match",
				score: 0.9,
			}),
			makeResult({
				snippet: "result c completely different content",
				score: 0.85,
			}),
		]
		const { mmrLambda, mmrApplied } = applyMMRReranking({
			results,
			classification: "direct",
		})
		expect(mmrApplied).toBe(true)
		expect(mmrLambda).toBe(0.7)
	})

	it("preserves all results without losing any", () => {
		const results: MemorySearchResult[] = [
			makeResult({
				canonicalId: "a",
				snippet: "alpha beta gamma",
				score: 0.9,
			}),
			makeResult({
				canonicalId: "b",
				snippet: "delta epsilon zeta",
				score: 0.85,
			}),
			makeResult({
				canonicalId: "c",
				snippet: "eta theta iota",
				score: 0.8,
			}),
			makeResult({
				canonicalId: "d",
				snippet: "kappa lambda mu",
				score: 0.75,
			}),
		]
		const { results: mmrResults } = applyMMRReranking({
			results,
			classification: "comparison",
		})
		expect(mmrResults).toHaveLength(4)
		const ids = new Set(mmrResults.map((r) => r.canonicalId))
		expect(ids.size).toBe(4)
	})
})
