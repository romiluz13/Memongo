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
	computeEvidenceCoverage,
	executeMongoSearchPlan,
	identifyRelaxableConstraint,
	inferSearchResultLane,
	normalizeMemorySearchRequest,
	resolveSearchConfig,
	requestHasHardConstraints,
	resolveExecutorTimeRange,
	resolveExecutorTimeRangeAt,
	resultHasExactEvidence,
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
				fusionMethod: "scoreFusion",
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

describe("resolveExecutorTimeRangeAt (RET-02)", () => {
	const NOW = new Date("2026-09-06T12:00:00.000Z")

	it("resolves a preset against the injected clock, ignoring explicit bounds", () => {
		const resolved = resolveExecutorTimeRangeAt(
			{
				preset: "last-24h",
				start: new Date("2026-01-01T00:00:00.000Z"),
				end: new Date("2026-01-02T00:00:00.000Z"),
			},
			NOW,
		)
		// The preset wins over any explicit bounds and derives its window
		// from the B14 reference clock, not the wall clock.
		expect(resolved).toEqual({
			start: new Date("2026-09-05T12:00:00.000Z"),
			end: NOW,
		})
	})

	it("normalizes full explicit bounds into Dates", () => {
		const resolved = resolveExecutorTimeRangeAt(
			{
				start: "2026-08-01T00:00:00.000Z",
				end: "2026-08-31T00:00:00.000Z",
			},
			NOW,
		)
		expect(resolved).toEqual({
			start: new Date("2026-08-01T00:00:00.000Z"),
			end: new Date("2026-08-31T00:00:00.000Z"),
		})
	})

	it("treats a partial explicit range as no range", () => {
		expect(resolveExecutorTimeRangeAt({ start: NOW }, NOW)).toBeUndefined()
		expect(resolveExecutorTimeRangeAt({ end: NOW }, NOW)).toBeUndefined()
	})

	it("treats an unparseable explicit bound as no range", () => {
		expect(
			resolveExecutorTimeRangeAt({ start: "not-a-date", end: NOW }, NOW),
		).toBeUndefined()
		expect(
			resolveExecutorTimeRangeAt({ start: NOW, end: "not-a-date" }, NOW),
		).toBeUndefined()
	})

	it("returns undefined when the request carries no range", () => {
		expect(resolveExecutorTimeRangeAt(undefined, NOW)).toBeUndefined()
	})

	it("forwards the wall-clock wrapper for preset-less requests", () => {
		// The wrapper exists for callers without a reference clock; with
		// explicit bounds it never reads the clock, so the round trip is
		// identity regardless of when it runs.
		const resolved = resolveExecutorTimeRange({
			query: "deployment history",
			timeRange: {
				start: new Date("2026-08-01T00:00:00.000Z"),
				end: new Date("2026-08-31T00:00:00.000Z"),
			},
		})
		expect(resolved).toEqual({
			start: new Date("2026-08-01T00:00:00.000Z"),
			end: new Date("2026-08-31T00:00:00.000Z"),
		})
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
					derivation: "user-extracted",
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
					derivation: "user-extracted",
				},
			],
		})
		expect(result.accepted).toHaveLength(1)
		expect(result.rejected).toHaveLength(0)
	})
})

describe("resultHasExactEvidence (RET-09 derivation-narrowed)", () => {
	const base = {
		path: "events/turn-1",
		startLine: 0,
		endLine: 0,
		score: 0.9,
		snippet: "deploy on Monday",
		source: "conversation" as const,
	}

	it("accepts user-authored turns with a locator", () => {
		expect(
			resultHasExactEvidence({ ...base, role: "user", derivation: "user" }),
		).toBe(true)
	})

	it("accepts user-extracted facts with a locator", () => {
		expect(
			resultHasExactEvidence({
				...base,
				derivation: "user-extracted",
			}),
		).toBe(true)
	})

	it("accepts verbatim reference spans with a locator", () => {
		expect(resultHasExactEvidence({ ...base, derivation: "reference" })).toBe(
			true,
		)
	})

	it("rejects agent-authored turns even with a locator", () => {
		expect(
			resultHasExactEvidence({
				...base,
				role: "assistant",
				derivation: "agent",
			}),
		).toBe(false)
	})

	it("rejects inferred graph relations even with a locator", () => {
		expect(resultHasExactEvidence({ ...base, derivation: "inferred" })).toBe(
			false,
		)
	})

	it("rejects derived summaries even with a locator", () => {
		expect(resultHasExactEvidence({ ...base, derivation: "derived" })).toBe(
			false,
		)
	})

	it("rejects locator-less results regardless of derivation", () => {
		expect(
			resultHasExactEvidence({
				...base,
				path: "",
				role: "user",
				derivation: "user",
			}),
		).toBe(false)
	})

	it("rejects legacy rows with no provenance metadata", () => {
		expect(resultHasExactEvidence({ ...base })).toBe(false)
	})

	it("rejects with a derivation-specific reason under needExactEvidence", () => {
		const result = applyHardConstraintRejections({
			request: { query: "exact", needExactEvidence: true },
			results: [
				{
					...base,
					role: "assistant",
					derivation: "agent",
				},
			],
		})
		expect(result.accepted).toHaveLength(0)
		expect(result.rejected[0]?.reason).toBe(
			"exact evidence requires user-authored or reference span",
		)
	})

	it("keeps the locator reason for locator-less results", () => {
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

	it("treats all-user evidence as direct and mixed sets as partial/indirect", () => {
		const userHit = {
			...base,
			role: "user" as const,
			derivation: "user" as const,
		}
		const agentHit = {
			...base,
			path: "events/turn-2",
			role: "assistant" as const,
			derivation: "agent" as const,
		}
		expect(computeEvidenceCoverage([userHit])).toBe("direct")
		expect(computeEvidenceCoverage([userHit, agentHit])).toBe("partial")
		expect(computeEvidenceCoverage([agentHit])).toBe("indirect")
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

	it("sorts segment-stable so unreranked overflow cannot displace CE-ranked results (RET-08)", () => {
		// Audit proof: cross-encoder scored .2/.1 on the reranked partition,
		// while untouched overflow keeps a high retrieval score. A global
		// score sort puts overflow first; the partition boundary keeps the
		// CE-ranked results ahead even though their scores are lower.
		const ceRanked = [
			makeResult({
				path: "events/evt-ce1",
				canonicalId: "event:evt-ce1",
				score: 0.2,
				sessionId: "session-ce1",
				sourceEventIds: ["evt-ce1"],
			}),
			makeResult({
				path: "events/evt-ce2",
				canonicalId: "event:evt-ce2",
				score: 0.1,
				sessionId: "session-ce2",
				sourceEventIds: ["evt-ce2"],
			}),
		]
		const overflowGraph = makeResult({
			path: "relation:overflow",
			canonicalId: "relation:overflow",
			score: 0.9,
			source: "structured",
			provenance: { lane: "graph" },
		})
		const results = [...ceRanked, overflowGraph]

		const controlled = applyLaneAwareResultControls({
			query: "What did I say I prefer in the last conversation?",
			results,
			classification: "direct",
			planPaths: ["hybrid", "raw-window", "graph"],
			topK: 3,
			rerankPartitionCount: 2,
		})

		expect(controlled.summary.applied).toBe(true)
		expect(controlled.results.map((result) => result.path)).toEqual([
			"events/evt-ce1",
			"events/evt-ce2",
			"relation:overflow",
		])
		// The CE-ranked head stays ahead DESPITE the overflow item's higher
		// (uncalibrated) retrieval score.
		expect(controlled.results[0].score).toBeLessThan(
			controlled.results[2].score,
		)

		// Without a partition boundary the default global sort applies
		// (pre-rerank and non-reranked callers) — overflow first.
		const globalSorted = applyLaneAwareResultControls({
			query: "What did I say I prefer in the last conversation?",
			results,
			classification: "direct",
			planPaths: ["hybrid", "raw-window", "graph"],
			topK: 3,
		})
		expect(globalSorted.results[0].path).toBe("relation:overflow")
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
		// B10: non-multi-session queries allow 3 per session — the query's
		// "before" is a broad time word, not multi-session phrasing, so it
		// no longer forces the breadth cap of 1.
		expect(
			controlled.results
				.slice(0, 5)
				.filter((result) => result.sessionId === "session-a"),
		).toHaveLength(3)
	})

	it("keeps three turns of the best session for single-session questions (B10)", () => {
		// First-person phrasing with no multi-session words: the old
		// conversation-evidence detector forced a cap of 1 here, cutting the
		// assistant turn of the very session the answer lives in.
		const sameSession = Array.from({ length: 4 }, (_, index) =>
			makeResult({
				path: `events/a-${index}`,
				canonicalId: `event:a-${index}`,
				score: 1 - index * 0.01,
				sessionId: "session-a",
				sourceEventIds: [`a-${index}`],
			}),
		)
		const otherSessions = ["b", "c"].map((id, index) =>
			makeResult({
				path: `events/${id}-1`,
				canonicalId: `event:${id}-1`,
				score: 0.94 - index * 0.01,
				sessionId: `session-${id}`,
				sourceEventIds: [`${id}-1`],
			}),
		)

		const controlled = applyLaneAwareResultControls({
			query: "What did I tell you about my apartment lease?",
			results: [...sameSession, ...otherSessions],
			classification: "direct",
			planPaths: ["hybrid"],
			topK: 5,
		})

		expect(
			controlled.results
				.slice(0, 5)
				.filter((result) => result.sessionId === "session-a"),
		).toHaveLength(3)
		expect(
			controlled.results.slice(0, 5).map((result) => result.sessionId),
		).toContain("session-b")
	})

	it("never re-applies the per-session cap after the reranker (B10)", () => {
		// Multi-session phrasing ("how many", "across sessions") earns the
		// breadth cap of 1 pre-rerank — but never post-rerank, where it would
		// override the cross-encoder's ordering of same-session turns.
		const ceRankedSameSession = Array.from({ length: 3 }, (_, index) =>
			makeResult({
				path: `events/ce-${index}`,
				canonicalId: `event:ce-${index}`,
				score: 0.5 - index * 0.01,
				sessionId: "session-a",
				sourceEventIds: [`ce-${index}`],
			}),
		)
		const otherSessions = ["b", "c", "d", "e"].map((id, index) =>
			makeResult({
				path: `events/${id}-1`,
				canonicalId: `event:${id}-1`,
				score: 0.9 - index * 0.01,
				sessionId: `session-${id}`,
				sourceEventIds: [`${id}-1`],
			}),
		)
		const query = "How many times did we discuss the apartment across sessions?"

		const postRerank = applyLaneAwareResultControls({
			query,
			results: [...ceRankedSameSession, ...otherSessions],
			classification: "direct",
			planPaths: ["hybrid"],
			topK: 5,
			rerankPartitionCount: 3,
		})
		expect(postRerank.summary.sessionCapped).toBe(0)
		expect(
			postRerank.results.slice(0, 3).map((result) => result.sessionId),
		).toEqual(["session-a", "session-a", "session-a"])
		expect(
			postRerank.results
				.slice(0, 5)
				.filter((result) => result.sessionId === "session-a"),
		).toHaveLength(3)

		// Pre-rerank, the same query keeps the breadth cap of 1.
		const preRerank = applyLaneAwareResultControls({
			query,
			results: [...ceRankedSameSession, ...otherSessions],
			classification: "direct",
			planPaths: ["hybrid"],
			topK: 5,
		})
		expect(
			preRerank.results
				.slice(0, 5)
				.filter((result) => result.sessionId === "session-a"),
		).toHaveLength(1)
	})

	it("exhausts distinct session coverage before repeated turns for temporal queries", () => {
		// B10: "across sessions" is explicit multi-session phrasing, so the
		// breadth cap of 1 still applies here.
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

	it("distinguishes requests with different KB authorization", () => {
		const unrestricted = buildMemorySearchRequestSignature({
			query: "shared reference",
		})
		const restricted = buildMemorySearchRequestSignature({
			query: "shared reference",
			kbRestricted: true,
		})

		expect(restricted).not.toBe(unrestricted)
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

	it("considers every preferred source's lanes in the first pass", async () => {
		// RET-03: source ordering is a ranking signal, not an exclusion
		// filter. The default first pass must be eligible for all available
		// lanes — not just the first preferred source's conversation lanes.
		const mock = makeMockExecutePass([[makeResult({ canonicalId: "r1" })]])

		await executeMongoSearchPlan({
			request: { query: "what is Bloom" },
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(mock).toHaveBeenCalledTimes(1)
		expect([...(mock.mock.calls[0]?.[0]?.availablePaths ?? [])].sort()).toEqual(
			[...allPaths].sort(),
		)
	})

	it("restricts first-pass lanes to time-capable paths under an explicit time range", async () => {
		const mock = makeMockExecutePass([
			[makeResult({ canonicalId: "r1", timestamp: new Date() })],
		])

		await executeMongoSearchPlan({
			request: {
				query: "what is Bloom",
				timeRange: { preset: "today" },
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect([...(mock.mock.calls[0]?.[0]?.availablePaths ?? [])].sort()).toEqual(
			["episodic", "hybrid", "raw-window"],
		)
	})

	it("honors sourcePreference as an exclusion list in the first pass", async () => {
		const mock = makeMockExecutePass([[makeResult({ canonicalId: "r1" })]])

		await executeMongoSearchPlan({
			request: {
				query: "what is Bloom",
				sourcePreference: ["conversation"],
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect([...(mock.mock.calls[0]?.[0]?.availablePaths ?? [])].sort()).toEqual(
			["hybrid", "raw-window"],
		)
	})

	it("caps the served multipass response at maxResults", async () => {
		// RET-04: passes may accumulate more unique results than maxResults;
		// the served response is sliced after final reranking, and the
		// metadata describes the served slice.
		const r1 = makeResult({ canonicalId: "r1" })
		const r2 = makeResult({ canonicalId: "r2" })
		const r3 = makeResult({ canonicalId: "r3" })
		const mock = makeMockExecutePass([[r1], [r2, r3]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "eval tools family",
				searchMode: "agentic",
				maxPasses: 3,
				maxResults: 2,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(mock).toHaveBeenCalledTimes(2)
		expect(response.results).toHaveLength(2)
		expect(new Set(response.results.map((r) => r.canonicalId)).size).toBe(2)
	})

	it("caps the served response at maxResults even when later passes return duplicates plus new hits", async () => {
		const r1 = makeResult({ canonicalId: "r1" })
		const r2 = makeResult({ canonicalId: "r2" })
		const r3 = makeResult({ canonicalId: "r3" })
		const mock = makeMockExecutePass([[r1], [{ ...r1 }, r2, r3]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "eval tools family",
				searchMode: "agentic",
				maxPasses: 3,
				maxResults: 2,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(response.results).toHaveLength(2)
		expect(new Set(response.results.map((r) => r.canonicalId)).size).toBe(2)
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
		// RET-01: the dominant rejection is temporal, so the honest empty
		// names the time range (not the secondary exact-evidence flag).
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"the requested time range",
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
		// RET-01: the exact-evidence requirement is the constraint that
		// rejected every candidate, so the reason names it (and the opt-in
		// that would permit a relaxed retry).
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"the exact-evidence requirement",
		)
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"allowConstraintRelaxation",
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
		expect(correctivePasses[0]?.correctionApplied).toBe("time-range-widened-3x")
	})

	it("does not relax caller time constraints without opt-in", async () => {
		// RET-01: explicit constraints are hard by default. The relaxation
		// fallback must not run (and must not remove the caller's time
		// range) unless the caller opted in via allowConstraintRelaxation.
		const oldResult = makeResult({
			canonicalId: "old",
			timestamp: new Date("2001-01-01T00:00:00.000Z"),
		})
		const mock = makeMockExecutePass([[oldResult]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "some query",
				searchMode: "direct",
				timeRange: { preset: "today" },
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(mock).toHaveBeenCalledTimes(1)
		expect(response.results).toHaveLength(0)
		expect(response.metadata.constraintRelaxations).toBeUndefined()
		expect(response.metadata.resultsRejected[0]?.reason).toBe(
			"outside requested time range",
		)
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"the requested time range",
		)
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"allowConstraintRelaxation",
		)
	})

	it("keeps an explicit time range hard under direct mode with a single-pass budget", async () => {
		// RET-01 audit trigger: explicit start/end range, direct mode,
		// maxPasses 1. The out-of-range result must be rejected, no second
		// pass may run, and the empty answer must say why.
		const marchResult = makeResult({
			canonicalId: "march",
			timestamp: new Date("2024-03-01T12:00:00.000Z"),
		})
		const mock = makeMockExecutePass([[marchResult]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "deploy timeline",
				searchMode: "direct",
				maxPasses: 1,
				timeRange: {
					start: "2024-01-01T00:00:00.000Z",
					end: "2024-01-31T23:59:59.000Z",
				},
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(mock).toHaveBeenCalledTimes(1)
		expect(response.results).toHaveLength(0)
		expect(response.metadata.constraintRelaxations).toBeUndefined()
		expect(response.metadata.resultsRejected[0]?.reason).toBe(
			"outside requested time range",
		)
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"the requested time range",
		)
	})

	it("relaxes the dominant constraint only when opted in, counting every pass against maxPasses", async () => {
		const oldResult = makeResult({
			canonicalId: "old",
			timestamp: new Date("2001-01-01T00:00:00.000Z"),
		})
		const anyResult = makeResult({ canonicalId: "any" })
		// Pass 1 rejects against the original range. Relaxation is armed
		// (opt-in + spare budget + relaxable dominant constraint), so the
		// corrective widening pass is skipped — it re-validates against the
		// ORIGINAL range and could not serve — and the relaxation pass 2
		// serves the unconstrained result.
		const mock = makeMockExecutePass([[oldResult], [anyResult]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "some query",
				searchMode: "direct",
				maxPasses: 3,
				timeRange: { preset: "today" },
				allowConstraintRelaxation: true,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(mock).toHaveBeenCalledTimes(2)
		expect(response.metadata.constraintRelaxations).toEqual([
			{ constraint: "timeRange", action: "removed-time-range" },
		])
		expect(response.results.map((r) => r.canonicalId)).toEqual(["any"])
		expect(response.metadata.passes[1]?.correctionApplied).toBe(
			"relaxation:removed-time-range",
		)
	})

	it("skips the corrective widening pass when relaxation is armed", async () => {
		// RET-01 live-probe regression: at maxPasses 2 with opt-in, the
		// corrective widening used to consume pass 2 and starve the
		// relaxation fallback (its fetch is re-validated against the ORIGINAL
		// range, so it can never admit out-of-range results). Relaxation
		// takes the budget instead and serves.
		const oldResult = makeResult({
			canonicalId: "old",
			timestamp: new Date("2001-01-01T00:00:00.000Z"),
		})
		const anyResult = makeResult({ canonicalId: "any" })
		const mock = makeMockExecutePass([[oldResult], [anyResult]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "some query",
				searchMode: "direct",
				maxPasses: 2,
				timeRange: { preset: "today" },
				allowConstraintRelaxation: true,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(mock).toHaveBeenCalledTimes(2)
		expect(
			response.metadata.passes.some(
				(p) => p.correctionApplied === "time-range-widened-3x",
			),
		).toBe(false)
		expect(response.metadata.constraintRelaxations).toEqual([
			{ constraint: "timeRange", action: "removed-time-range" },
		])
		expect(response.results.map((r) => r.canonicalId)).toEqual(["any"])
	})

	it("withholds the relaxation pass when the maxPasses budget is exhausted even with opt-in", async () => {
		const oldResult = makeResult({
			canonicalId: "old",
			timestamp: new Date("2001-01-01T00:00:00.000Z"),
		})
		// maxPasses 1 leaves no budget after the original pass, so the
		// opted-in relaxation cannot run: the answer stays empty and the
		// reason says the pass budget, not the opt-in, is what withheld it.
		const mock = makeMockExecutePass([[oldResult]])

		const response = await executeMongoSearchPlan({
			request: {
				query: "some query",
				searchMode: "direct",
				maxPasses: 1,
				timeRange: { preset: "today" },
				allowConstraintRelaxation: true,
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		expect(mock).toHaveBeenCalledTimes(1)
		expect(response.results).toHaveLength(0)
		expect(response.metadata.constraintRelaxations).toBeUndefined()
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"the requested time range",
		)
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"pass budget (maxPasses) was already exhausted",
		)
	})

	it("keeps corrective time widening a retrieval aid that cannot admit out-of-range results", async () => {
		// RET-01: the corrective pass fetches a widened window, but its
		// outputs are re-validated against the ORIGINAL caller range. A
		// March result fetched under a January query can never be served.
		const marchResult = makeResult({
			canonicalId: "march",
			timestamp: new Date("2024-03-01T12:00:00.000Z"),
		})
		const mock = makeMockExecutePass([
			[marchResult],
			[marchResult],
			[marchResult],
		])

		const response = await executeMongoSearchPlan({
			request: {
				query: "what happened recently",
				searchMode: "agentic",
				maxPasses: 3,
				timeRange: {
					start: "2024-01-01T00:00:00.000Z",
					end: "2024-01-31T23:59:59.000Z",
				},
			},
			availablePaths: allPaths,
			executePass: mock,
		})

		const correctivePasses = response.metadata.passes.filter(
			(p) => p.correctionApplied,
		)
		expect(correctivePasses[0]?.correctionApplied).toBe("time-range-widened-3x")
		// The corrective pass fetched results but validated them against the
		// original January range: nothing was admitted.
		expect(correctivePasses[0]?.resultCount).toBe(0)
		expect(response.results).toHaveLength(0)
		expect(response.metadata.noDirectEvidenceReason).toContain(
			"the requested time range",
		)
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
		expect(result.correction).toBe("time-range-widened-3x")
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

	it("arms relaxation for the provenance-based exact-evidence rejection (RET-09)", () => {
		// A dominant "locators exist but nothing is exact-capable" rejection
		// is the same binding constraint (needExactEvidence) as the
		// locator-missing one — opt-in relaxation must recognize both or
		// agent-derived hits become un-relaxable.
		const result = identifyRelaxableConstraint([
			{ reason: "exact evidence requires user-authored or reference span" },
			{ reason: "exact evidence requires user-authored or reference span" },
		])
		expect(result).toEqual({
			constraint: "needExactEvidence",
			action: "disabled-exact-evidence",
		})
	})
})

// ---------------------------------------------------------------------------
// Scoring ablation switches (#40)
// ---------------------------------------------------------------------------

describe("scoring ablation", () => {
	const withAblation = async (value: string, run: () => Promise<void>) => {
		const previous = process.env.MEMONGO_SCORING_ABLATION
		process.env.MEMONGO_SCORING_ABLATION = value
		try {
			await run()
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_SCORING_ABLATION
			} else {
				process.env.MEMONGO_SCORING_ABLATION = previous
			}
		}
	}

	it("disables the session-evidence lane boost when ablated", async () => {
		const session = makeResult({
			path: "events/evt-1",
			canonicalId: "event:evt-1",
			score: 0.78,
			sessionId: "session-1",
			sourceEventIds: ["evt-1"],
		})
		await withAblation("session-evidence-boost", async () => {
			const controlled = applyLaneAwareResultControls({
				query: "What did I say I prefer in the last conversation?",
				results: [session],
				classification: "direct",
				planPaths: ["hybrid"],
				topK: 3,
			})
			expect(controlled.summary.boosted).toBe(0)
			expect(controlled.results[0]?.score).toBe(0.78)
		})
	})

	it("flattens classification-keyed MMR lambdas when ablated", async () => {
		const results: MemorySearchResult[] = [
			makeResult({ snippet: "alpha beta gamma", score: 0.9 }),
			makeResult({ snippet: "alpha beta delta", score: 0.85 }),
			makeResult({ snippet: "epsilon zeta eta", score: 0.8 }),
		]
		await withAblation("classification-mmr", async () => {
			const { mmrLambda } = applyMMRReranking({
				results,
				classification: "family",
			})
			expect(mmrLambda).toBe(0.5)
		})
	})

	it("keeps shipped behavior when the ablation list names something else", async () => {
		await withAblation("some-other-heuristic", async () => {
			const { mmrLambda } = applyMMRReranking({
				results: [
					makeResult({ snippet: "a b c", score: 0.9 }),
					makeResult({ snippet: "a b d", score: 0.85 }),
					makeResult({ snippet: "x y z", score: 0.8 }),
				],
				classification: "family",
			})
			expect(mmrLambda).toBe(0.3)
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

// ---------------------------------------------------------------------------
// WS-11: admission-throttled passes through the executor
// ---------------------------------------------------------------------------

describe("executeMongoSearchPlan throttled-pass propagation (WS-11)", () => {
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

	function makeThrottledPass() {
		return {
			results: [] as MemorySearchResult[],
			metadata: {
				plan: {
					paths: ["hybrid"],
					confidence: "low" as const,
					reasoning: "throttled before lanes ran",
				},
				pathsExecuted: [] as string[],
				resultsByPath: {} as Record<string, number>,
				reranked: false,
				queryRewritten: false,
				throttled: { retryAfterMs: 3000 },
			},
		}
	}

	it("surfaces the throttle marker and retry hint in the merged response metadata", async () => {
		const response = await executeMongoSearchPlan({
			request: {
				query: "what is Bloom",
				searchMode: "direct",
			},
			availablePaths: allPaths,
			executePass: vi.fn().mockResolvedValue(makeThrottledPass()),
		})

		// The executor layer must not drop the admission outcome: a denied
		// pass stays distinguishable from a healthy empty one at the
		// searchDetailed boundary.
		expect(response.results).toEqual([])
		expect(response.metadata.throttled).toEqual({ retryAfterMs: 3000 })
		expect(response.metadata.pathsExecuted).toEqual([])
	})

	it("ends the pass loop on a throttled first pass — no follow-up attempts", async () => {
		const secondPass = {
			results: [makeResult({ canonicalId: "late" })],
			metadata: {
				plan: {
					paths: ["kb"],
					confidence: "medium" as const,
					reasoning: "follow-up that must never run",
				},
				pathsExecuted: ["kb"],
				resultsByPath: { kb: 1 },
				reranked: false,
				queryRewritten: false,
			},
		}
		const executePass = vi
			.fn()
			.mockResolvedValueOnce(makeThrottledPass())
			.mockResolvedValueOnce(secondPass)

		const response = await executeMongoSearchPlan({
			request: {
				query: "eval tools family",
				searchMode: "agentic",
				maxPasses: 3,
			},
			availablePaths: allPaths,
			executePass,
		})

		// A throttled pass retrieved nothing by design; follow-up passes
		// would only stack more denied attempts on the same dry bucket.
		expect(executePass).toHaveBeenCalledTimes(1)
		expect(response.metadata.throttled).toEqual({ retryAfterMs: 3000 })
		expect(response.results).toEqual([])
	})

	it("never marks a healthy empty search as throttled", async () => {
		const response = await executeMongoSearchPlan({
			request: {
				query: "what is Bloom",
				searchMode: "direct",
			},
			availablePaths: allPaths,
			executePass: makeMockExecutePass([[]]),
		})

		expect(response.results).toEqual([])
		expect(response.metadata.throttled).toBeUndefined()
	})
})
