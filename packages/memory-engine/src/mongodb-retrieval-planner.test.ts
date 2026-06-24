import { describe, it, expect, vi, afterEach } from "vitest"
import {
	extractTemporalWindow,
	planRetrieval,
	resolveNumCandidates,
	resolveTimeRangePreset,
	type RetrievalPath,
	type RetrievalContext,
} from "./mongodb-retrieval-planner.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_PATHS: Set<RetrievalPath> = new Set([
	"active-critical",
	"structured",
	"raw-window",
	"graph",
	"hybrid",
	"kb",
	"episodic",
	"procedural",
])

function makeContext(
	overrides: Partial<RetrievalContext> = {},
): RetrievalContext {
	return {
		availablePaths: ALL_PATHS,
		...overrides,
	}
}

afterEach(() => {
	vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-retrieval-planner", () => {
	it("routes 'remember that I prefer dark mode' to structured first", () => {
		const plan = planRetrieval(
			"remember that I prefer dark mode",
			makeContext(),
		)
		expect(plan.paths[0]).toBe("structured")
	})

	it("routes 'what happened today' to raw-window first", () => {
		const plan = planRetrieval("what happened today", makeContext())
		expect(plan.paths[0]).toBe("raw-window")
	})

	it("routes current-situation queries to active-critical first", () => {
		const plan = planRetrieval(
			"what's the situation in Israel right now",
			makeContext(),
		)
		expect(plan.paths[0]).toBe("active-critical")
		expect(plan.constraints?.activeCritical?.salience).toEqual([
			"critical",
			"high",
		])
	})

	it("routes query with known entity name to graph first", () => {
		const ctx = makeContext({ knownEntityNames: ["Alice"] })
		const plan = planRetrieval("what does Alice work on", ctx)
		expect(plan.paths[0]).toBe("graph")
	})

	it("routes generic recall query to hybrid first (no strong signal)", () => {
		const plan = planRetrieval("tell me about the project", makeContext())
		expect(plan.paths[0]).toBe("hybrid")
	})

	it("routes 'give me a recap of the deployment' to episodic first", () => {
		const plan = planRetrieval(
			"give me a recap of the deployment",
			makeContext(),
		)
		expect(plan.paths[0]).toBe("episodic")
	})

	it("routes workflow queries to procedural first", () => {
		const plan = planRetrieval(
			"what is the runbook for rotating auth keys",
			makeContext(),
		)
		expect(plan.paths[0]).toBe("procedural")
	})

	it("routes previous-conversation recall to conversation evidence first", () => {
		const plan = planRetrieval(
			"remind me what we discussed in our previous conversation",
			makeContext(),
		)
		expect(plan.paths[0]).toBe("hybrid")
		expect(plan.paths.slice(0, 3)).toContain("raw-window")
		expect(plan.reasoning).toContain("conversation evidence recall")
	})

	it("keeps count-style personal recall on conversation evidence lanes", () => {
		const plan = planRetrieval(
			"how many doctor's appointments did I go to in March?",
			makeContext(),
		)
		expect(plan.paths[0]).toBe("hybrid")
		expect(plan.paths.slice(0, 3)).toContain("raw-window")
	})

	it("boosts structured retrieval when explicit structured scope is provided", () => {
		const plan = planRetrieval("what should I know about bloom", {
			...makeContext(),
			intent: {
				structuredScope: { type: "fact" },
			},
		} as unknown as RetrievalContext)
		expect(plan.paths[0]).toBe("structured")
		expect(plan.reasoning).toContain("structured scope")
	})

	it("boosts procedural retrieval when explicit procedural scope is provided", () => {
		const plan = planRetrieval("deploy secrets", {
			...makeContext(),
			intent: {
				proceduralScope: { state: "active" },
			},
		} as unknown as RetrievalContext)
		expect(plan.paths[0]).toBe("procedural")
		expect(plan.reasoning).toContain("procedural scope")
	})

	it("routes 'what's in the docs about authentication' to kb first", () => {
		const plan = planRetrieval(
			"what's in the docs about authentication",
			makeContext(),
		)
		expect(plan.paths[0]).toBe("kb")
	})

	it("returns confidence and reasoning fields", () => {
		const plan = planRetrieval(
			"remember that I prefer dark mode",
			makeContext(),
		)
		expect(plan.confidence).toBeDefined()
		expect(["high", "medium", "low"]).toContain(plan.confidence)
		expect(typeof plan.reasoning).toBe("string")
		expect(plan.reasoning.length).toBeGreaterThan(0)
	})

	it("extracts a hard time constraint for yesterday queries", () => {
		const plan = planRetrieval("what did we decide yesterday", makeContext())
		expect(plan.constraints?.timeRange?.preset).toBe("yesterday")
		expect(plan.constraints?.timeRange?.hard).toBe(true)
	})

	it("extracts a structured type constraint for decision queries", () => {
		const plan = planRetrieval(
			"what was the decision about auth rollout",
			makeContext(),
		)
		expect(plan.constraints?.structured?.type).toBe("decision")
		expect(plan.paths[0]).toBe("structured")
	})

	it("extracts a KB category constraint for API docs queries", () => {
		const plan = planRetrieval(
			"what does the API docs say about auth",
			makeContext(),
		)
		expect(plan.constraints?.kb?.category).toBe("api")
		expect(plan.paths[0]).toBe("kb")
	})

	it("extracts entity constraints from known names", () => {
		const plan = planRetrieval(
			"what does Alice own",
			makeContext({ knownEntityNames: ["Alice"] }),
		)
		expect(plan.constraints?.entities?.names).toEqual(["Alice"])
		expect(plan.paths[0]).toBe("graph")
	})

	it("excludes disabled sources from plan", () => {
		const limited = new Set<RetrievalPath>([
			"structured",
			"hybrid",
			"raw-window",
		])
		const plan = planRetrieval("what's in the docs about authentication", {
			availablePaths: limited,
		})
		// kb is not in availablePaths, so it must not appear
		expect(plan.paths).not.toContain("kb")
		// All returned paths must be in the available set
		for (const p of plan.paths) {
			expect(limited.has(p)).toBe(true)
		}
	})

	it("handles multiple signals with correct priority order", () => {
		// "remember that" (+3 structured) + "today" (+3 raw-window) + hybrid baseline (+1)
		const plan = planRetrieval(
			"remember that today we decided on dark mode",
			makeContext(),
		)
		// Both structured and raw-window score 3
		// structured keywords: "remember that", "decided" -> structured gets +3 (one match is enough)
		// time keywords: "today" -> raw-window gets +3
		// The order between equal-score paths is implementation-defined,
		// but both must appear before hybrid (score 1)
		const structuredIdx = plan.paths.indexOf("structured")
		const rawWindowIdx = plan.paths.indexOf("raw-window")
		const hybridIdx = plan.paths.indexOf("hybrid")
		expect(structuredIdx).toBeLessThan(hybridIdx)
		expect(rawWindowIdx).toBeLessThan(hybridIdx)
	})

	// -------------------------------------------------------------------
	// REM-FIX: Additional tests for hunter-found issues
	// -------------------------------------------------------------------

	it("returns low confidence for empty query string", () => {
		const plan = planRetrieval("", makeContext())
		expect(plan.confidence).toBe("low")
		expect(plan.reasoning).toBe("empty query")
		// Should include hybrid if available
		if (plan.paths.length > 0) {
			expect(plan.paths).toContain("hybrid")
		}
	})

	it("returns low confidence for whitespace-only query", () => {
		const plan = planRetrieval("   ", makeContext())
		expect(plan.confidence).toBe("low")
		expect(plan.reasoning).toBe("empty query")
	})

	it("empty query without hybrid available returns empty paths", () => {
		const noHybrid = new Set<RetrievalPath>(["structured", "raw-window"])
		const plan = planRetrieval("", { availablePaths: noHybrid })
		expect(plan.paths).toEqual([])
		expect(plan.confidence).toBe("low")
	})

	it("does NOT trigger structured for substring match like 'whenever'", () => {
		// "whenever" contains "never" — word-boundary matching should prevent false positive
		const plan = planRetrieval("whenever I do something", makeContext())
		expect(plan.paths[0]).not.toBe("structured")
	})

	it("does NOT trigger graph for empty entity names", () => {
		const ctx = makeContext({ knownEntityNames: [""] })
		const plan = planRetrieval("tell me about the project", ctx)
		// Empty entity name should not match — graph should not be first
		expect(plan.paths[0]).not.toBe("graph")
	})

	it("produces deterministic order for tied scores", () => {
		// Run multiple times to ensure determinism
		const results: string[][] = []
		for (let i = 0; i < 10; i++) {
			const plan = planRetrieval("tell me about the project", makeContext())
			results.push([...plan.paths])
		}
		// All results should be identical
		for (const r of results) {
			expect(r).toEqual(results[0])
		}
	})

	it("routes 'WHAT HAPPENED TODAY' (uppercase) to raw-window first", () => {
		const plan = planRetrieval("WHAT HAPPENED TODAY", makeContext())
		expect(plan.paths[0]).toBe("raw-window")
	})

	it("empty availablePaths returns empty paths with low confidence", () => {
		const plan = planRetrieval("tell me something", {
			availablePaths: new Set(),
		})
		expect(plan.paths).toEqual([])
		expect(plan.confidence).toBe("low")
	})

	describe("planRetrieval with lane coverage", () => {
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

		it("skips empty lanes when coverage data provided", () => {
			const plan = planRetrieval("what is the project status", {
				availablePaths: allPaths,
				laneCoverage: {
					"active-critical": {
						hasData: false,
						count: 0,
						lastUpdated: null,
					},
					structured: { hasData: true, count: 5, lastUpdated: new Date() },
					"raw-window": { hasData: true, count: 10, lastUpdated: new Date() },
					graph: { hasData: false, count: 0, lastUpdated: null },
					hybrid: { hasData: true, count: 10, lastUpdated: new Date() },
					kb: { hasData: false, count: 0, lastUpdated: null },
					episodic: { hasData: false, count: 0, lastUpdated: null },
					procedural: { hasData: false, count: 0, lastUpdated: null },
				},
			})
			// graph, episodic, procedural, active-critical should be skipped
			expect(plan.paths).not.toContain("graph")
			expect(plan.paths).not.toContain("episodic")
			expect(plan.paths).not.toContain("procedural")
			expect(plan.paths).not.toContain("active-critical")
			expect(plan.skippedLanes).toBeDefined()
			expect(plan.skippedLanes!.length).toBeGreaterThan(0)
		})

		it("never skips hybrid, raw-window, or kb even when empty", () => {
			const plan = planRetrieval("find something", {
				availablePaths: allPaths,
				laneCoverage: {
					"active-critical": {
						hasData: false,
						count: 0,
						lastUpdated: null,
					},
					structured: { hasData: false, count: 0, lastUpdated: null },
					"raw-window": { hasData: false, count: 0, lastUpdated: null },
					graph: { hasData: false, count: 0, lastUpdated: null },
					hybrid: { hasData: false, count: 0, lastUpdated: null },
					kb: { hasData: false, count: 0, lastUpdated: null },
					episodic: { hasData: false, count: 0, lastUpdated: null },
					procedural: { hasData: false, count: 0, lastUpdated: null },
				},
			})
			expect(plan.paths).toContain("hybrid")
			expect(plan.paths).toContain("raw-window")
			expect(plan.paths).toContain("kb")
			// skippedLanes should NOT include NEVER_SKIP lanes
			if (plan.skippedLanes) {
				expect(plan.skippedLanes).not.toContain("hybrid")
				expect(plan.skippedLanes).not.toContain("raw-window")
				expect(plan.skippedLanes).not.toContain("kb")
			}
		})

		it("includes reasoning about skipped lanes", () => {
			const plan = planRetrieval("tell me about the project", {
				availablePaths: allPaths,
				laneCoverage: {
					"active-critical": {
						hasData: false,
						count: 0,
						lastUpdated: null,
					},
					structured: { hasData: true, count: 3, lastUpdated: new Date() },
					"raw-window": { hasData: true, count: 5, lastUpdated: new Date() },
					graph: { hasData: false, count: 0, lastUpdated: null },
					hybrid: { hasData: true, count: 5, lastUpdated: new Date() },
					kb: { hasData: true, count: 1, lastUpdated: new Date() },
					episodic: { hasData: false, count: 0, lastUpdated: null },
					procedural: { hasData: false, count: 0, lastUpdated: null },
				},
			})
			expect(plan.reasoning).toContain("skipped empty lanes")
		})

		it("does not skip lanes when no coverage data provided", () => {
			const plan = planRetrieval("what is the project status", {
				availablePaths: allPaths,
			})
			// Without coverage data, all available paths should be included
			expect(plan.skippedLanes).toBeUndefined()
		})

		it("keeps lanes with data in the plan", () => {
			const plan = planRetrieval("what did we decide about the API", {
				availablePaths: allPaths,
				laneCoverage: {
					"active-critical": {
						hasData: true,
						count: 3,
						lastUpdated: new Date(),
					},
					structured: { hasData: true, count: 10, lastUpdated: new Date() },
					"raw-window": { hasData: true, count: 20, lastUpdated: new Date() },
					graph: { hasData: true, count: 5, lastUpdated: new Date() },
					hybrid: { hasData: true, count: 20, lastUpdated: new Date() },
					kb: { hasData: true, count: 2, lastUpdated: new Date() },
					episodic: { hasData: true, count: 3, lastUpdated: new Date() },
					procedural: { hasData: true, count: 1, lastUpdated: new Date() },
				},
			})
			// All lanes have data — nothing skipped
			expect(plan.skippedLanes).toBeUndefined()
		})
	})

	it("resolves last-7d time preset against a fixed clock", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-03-20T12:00:00Z"))

		const range = resolveTimeRangePreset("last-7d")
		expect(range.start.toISOString()).toBe("2026-03-13T12:00:00.000Z")
		expect(range.end.toISOString()).toBe("2026-03-20T12:00:00.000Z")
	})

	describe("resolveNumCandidates (Task 2.R2 Sub-path A)", () => {
		// User-approved table (Phase 0 Task 0.5 Recommended Default #1):
		// limit=5 → 200, limit=10 → 200, limit=20 → 400, limit=30 → 600.
		// Cites MongoDB MCP Finding #2: numCandidates ≥ 20 × limit baseline,
		// mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage.
		it("returns 200 for limit=5 (20x floor bumped to 200 minimum)", () => {
			expect(resolveNumCandidates(5)).toBe(200)
		})
		it("returns 200 for limit=10", () => {
			expect(resolveNumCandidates(10)).toBe(200)
		})
		it("returns 400 for limit=20", () => {
			expect(resolveNumCandidates(20)).toBe(400)
		})
		it("returns 600 for limit=30", () => {
			expect(resolveNumCandidates(30)).toBe(600)
		})
		it("respects override via second argument (Gate 5 experimentation)", () => {
			expect(resolveNumCandidates(10, 888)).toBe(888)
		})
		it("interpolates for intermediate limit values via 20x rule", () => {
			// limit=15 → 15*20=300, above the 200 floor, below the 20-bucket 400.
			expect(resolveNumCandidates(15)).toBe(300)
		})
		it("clamps invalid (non-positive or non-finite) limits to the 200 floor", () => {
			expect(resolveNumCandidates(0)).toBe(200)
			expect(resolveNumCandidates(-5)).toBe(200)
			expect(resolveNumCandidates(Number.NaN)).toBe(200)
		})
	})

	// -------------------------------------------------------------------
	// Task 35 — extractTemporalWindow (root fix for 00ca467f)
	//
	// Returns ONE temporal window (origin Date + scaleDays) when the query
	// contains a natural-language time token. Feeds the Atlas Search `near`
	// operator injected into the text lane of $rankFusion. Most-specific
	// match wins: explicit-date > relative-week > explicit-month >
	// explicit-year. The source design notes are intentionally not shipped in
	// the public launch tree.
	// -------------------------------------------------------------------
	describe("extractTemporalWindow", () => {
		it("extracts full month name (March) — resolves to most recent past March when current date is May", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0)) // 2026-05-12
			const result = extractTemporalWindow(
				"How many doctor's appointments in March?",
				now,
			)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("explicit-month")
			expect(result!.scaleDays).toBe(15)
			expect(result!.origin.toISOString()).toBe("2026-03-01T00:00:00.000Z")
			expect(result!.matchedToken.toLowerCase()).toContain("march")
		})

		it("extracts abbreviated month name (Mar) with explicit year preceding", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0))
			const result = extractTemporalWindow("what did I do in Mar 2024", now)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("explicit-month")
			expect(result!.origin.toISOString()).toBe("2024-03-01T00:00:00.000Z")
			expect(result!.scaleDays).toBe(15)
		})

		it("extracts 'last month' relative window (scaleDays=15)", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0)) // May 2026
			const result = extractTemporalWindow("what happened last month", now)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("relative-month")
			expect(result!.origin.toISOString()).toBe("2026-04-01T00:00:00.000Z")
			expect(result!.scaleDays).toBe(15)
		})

		it("extracts 'this month' relative window (scaleDays=15)", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0))
			const result = extractTemporalWindow("meetings this month", now)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("relative-month")
			expect(result!.origin.toISOString()).toBe("2026-05-01T00:00:00.000Z")
			expect(result!.scaleDays).toBe(15)
		})

		it("extracts 'last week' with scaleDays=3 (most-specific wins over month tokens)", () => {
			// 2026-05-12 is a Tuesday; ISO week starts Monday 2026-05-11.
			// Last ISO week started 2026-05-04.
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0))
			const result = extractTemporalWindow("what did we discuss last week", now)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("relative-week")
			expect(result!.scaleDays).toBe(3)
			expect(result!.origin.toISOString()).toBe("2026-05-04T00:00:00.000Z")
		})

		it("extracts 'today' with scaleDays=1", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 15, 30, 0))
			const result = extractTemporalWindow("what happened today", now)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("explicit-date")
			expect(result!.scaleDays).toBe(1)
			expect(result!.origin.toISOString()).toBe("2026-05-12T00:00:00.000Z")
		})

		it("extracts explicit YYYY-MM-DD date with scaleDays=3", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0))
			const result = extractTemporalWindow("show me notes from 2024-03-20", now)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("explicit-date")
			expect(result!.scaleDays).toBe(3)
			expect(result!.origin.toISOString()).toBe("2024-03-20T00:00:00.000Z")
		})

		it("extracts explicit year-only with scaleDays=180 (mid-year origin)", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0))
			const result = extractTemporalWindow("activities during 2022", now)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("explicit-year")
			expect(result!.scaleDays).toBe(180)
			// Mid-year = July 1 at UTC midnight.
			expect(result!.origin.toISOString()).toBe("2022-07-01T00:00:00.000Z")
		})

		it("is case-insensitive (MARCH, march, March all match)", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0))
			const upper = extractTemporalWindow("meetings in MARCH", now)
			const lower = extractTemporalWindow("meetings in march", now)
			expect(upper?.origin.toISOString()).toBe("2026-03-01T00:00:00.000Z")
			expect(lower?.origin.toISOString()).toBe("2026-03-01T00:00:00.000Z")
		})

		it("returns null when no temporal token is present", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0))
			const result = extractTemporalWindow("tell me about the project", now)
			expect(result).toBeNull()
		})

		it("returns null for invalid month/date strings (no silent fallback)", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0))
			// 'Marchy' is not a valid month; word-boundary regex should avoid match.
			const result = extractTemporalWindow("I did Marchy things", now)
			expect(result).toBeNull()
		})

		it("most-specific match wins: explicit-date beats explicit-month when both present", () => {
			const now = new Date(Date.UTC(2026, 4, 12, 0, 0, 0))
			const result = extractTemporalWindow(
				"appointments in March, specifically 2024-03-15",
				now,
			)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("explicit-date")
			expect(result!.origin.toISOString()).toBe("2024-03-15T00:00:00.000Z")
		})

		it("resolves 'March' to previous year when the current month is January (future-month guard)", () => {
			// In January 2026, 'March' should resolve to March 2025 (most recent
			// past March), not March 2026 (future).
			const now = new Date(Date.UTC(2026, 0, 15, 0, 0, 0)) // 2026-01-15
			const result = extractTemporalWindow("appointments in March", now)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("explicit-month")
			expect(result!.origin.toISOString()).toBe("2025-03-01T00:00:00.000Z")
		})

		it("month with explicit year overrides future-month guard", () => {
			const now = new Date(Date.UTC(2026, 0, 15, 0, 0, 0))
			// Explicit 2026 means March 2026 even though it's in the future.
			const result = extractTemporalWindow("in March 2026", now)
			expect(result).not.toBeNull()
			expect(result!.source).toBe("explicit-month")
			expect(result!.origin.toISOString()).toBe("2026-03-01T00:00:00.000Z")
		})
	})
})
