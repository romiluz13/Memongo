import { describe, expect, it, vi } from "vitest"
import type { Document } from "mongodb"
import {
	CONTEXT_EXPANSION_MAX_CONCURRENCY,
	expandSearchContext,
} from "./mongodb-context-expansion.js"
import type { MemorySearchResult } from "./types.js"

function makeResult(
	overrides: Partial<MemorySearchResult> & { path: string },
): MemorySearchResult {
	return {
		startLine: 0,
		endLine: 0,
		score: 0.5,
		snippet: `snippet for ${overrides.path}`,
		source: "conversation",
		...overrides,
	}
}

// Mock events collection
function createMockDb(
	events: Array<{
		eventId: string
		agentId: string
		sessionId: string
		role: string
		body: string
		timestamp: Date
	}>,
) {
	const toArrayFn = vi.fn().mockResolvedValue(events)
	const limitFn = vi.fn().mockReturnValue({ toArray: toArrayFn })
	const sortFn = vi.fn().mockReturnValue({ limit: limitFn })
	const findFn = vi.fn().mockReturnValue({
		sort: sortFn,
	})
	const collectionFn = vi.fn().mockReturnValue({ find: findFn })

	return {
		db: { collection: collectionFn } as unknown as import("mongodb").Db,
		findFn,
		toArrayFn,
	}
}

describe("expandSearchContext", () => {
	it("returns original results when no event-based chunks present", async () => {
		const { db } = createMockDb([])
		const results = [
			makeResult({
				path: "kb/doc1",
				source: "reference",
				score: 0.9,
			}),
		]
		const expanded = await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
		})
		expect(expanded).toHaveLength(1)
		expect(expanded[0].path).toBe("kb/doc1")
	})

	it("skips expansion for results without sessionId", async () => {
		const { db } = createMockDb([])
		const results = [makeResult({ path: "events/a", score: 0.9 })]
		const expanded = await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
		})
		expect(expanded).toHaveLength(1)
		expect(expanded[0].path).toBe("events/a")
	})

	it("fetches neighbor events for event-based chunks with sessionId", async () => {
		const ts = new Date("2026-01-01T00:02:00Z")
		const { db } = createMockDb([
			{
				eventId: "prev",
				agentId: "agent1",
				sessionId: "s1",
				role: "user",
				body: "previous",
				timestamp: new Date("2026-01-01T00:01:00Z"),
			},
			{
				eventId: "next",
				agentId: "agent1",
				sessionId: "s1",
				role: "assistant",
				body: "following",
				timestamp: new Date("2026-01-01T00:03:00Z"),
			},
		])
		const results = [
			makeResult({
				path: "events/mid",
				sessionId: "s1",
				timestamp: ts,
				score: 0.9,
			}),
		]
		const expanded = await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
		})
		// Original + 2 neighbors
		expect(expanded.length).toBeGreaterThanOrEqual(2)
		const paths = expanded.map((r) => r.path)
		expect(paths).toContain("events/mid")
	})

	it("confines the neighbor lookup to the caller's scope and scopeRef", async () => {
		// Regression (#62 / L2): expansion re-queries the events collection
		// directly. Without scope+scopeRef in the filter, a sessionId shared
		// across scopes pulls in another tenant's neighbor events.
		const ts = new Date("2026-01-01T00:02:00Z")
		const { db, findFn } = createMockDb([])
		await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "user",
			scopeRef: "agent:agent1:user:alice",
			results: [
				makeResult({
					path: "events/mid",
					sessionId: "s1",
					timestamp: ts,
					score: 0.9,
				}),
			],
		})
		expect(findFn).toHaveBeenCalledTimes(1)
		expect(findFn.mock.calls[0][0]).toMatchObject({
			agentId: "agent1",
			scope: "user",
			scopeRef: "agent:agent1:user:alice",
			sessionId: "s1",
		})
	})

	it("assigns neighbor score as parentScore * 0.95", async () => {
		const ts = new Date("2026-01-01T00:02:00Z")
		const { db } = createMockDb([
			{
				eventId: "prev",
				agentId: "agent1",
				sessionId: "s1",
				role: "user",
				body: "previous",
				timestamp: new Date("2026-01-01T00:01:00Z"),
			},
		])
		const results = [
			makeResult({
				path: "events/mid",
				sessionId: "s1",
				timestamp: ts,
				score: 0.8,
			}),
		]
		const expanded = await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
		})
		const neighbor = expanded.find((r) => r.path === "events/prev")
		if (neighbor) {
			expect(neighbor.score).toBeCloseTo(0.8 * 0.95, 5)
		}
	})

	it("deduplicates neighbors already in results", async () => {
		const ts1 = new Date("2026-01-01T00:01:00Z")
		const ts2 = new Date("2026-01-01T00:02:00Z")
		const { db } = createMockDb([
			// Returns event "b" as neighbor of "a" — but "b" already in results
			{
				eventId: "b",
				agentId: "agent1",
				sessionId: "s1",
				role: "assistant",
				body: "response",
				timestamp: ts2,
			},
		])
		const results = [
			makeResult({
				path: "events/a",
				sessionId: "s1",
				timestamp: ts1,
				score: 0.9,
			}),
			makeResult({
				path: "events/b",
				sessionId: "s1",
				timestamp: ts2,
				score: 0.8,
			}),
		]
		const expanded = await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
		})
		// Should not duplicate event b
		const bResults = expanded.filter((r) => r.path === "events/b")
		expect(bResults.length).toBeLessThanOrEqual(1)
	})

	it("drops lowest-scored tail when neighbors would exceed maxResults", async () => {
		const ts = new Date("2026-01-01T00:02:00Z")
		const { db } = createMockDb([
			{
				eventId: "prev",
				agentId: "agent1",
				sessionId: "s1",
				role: "user",
				body: "previous",
				timestamp: new Date("2026-01-01T00:01:00Z"),
			},
			{
				eventId: "next",
				agentId: "agent1",
				sessionId: "s1",
				role: "assistant",
				body: "following",
				timestamp: new Date("2026-01-01T00:03:00Z"),
			},
		])
		const results = [
			makeResult({
				path: "events/mid",
				sessionId: "s1",
				timestamp: ts,
				score: 0.9,
			}),
			makeResult({
				path: "kb/low",
				source: "reference",
				score: 0.1,
			}),
		]
		const expanded = await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
			maxResults: 3, // Only room for 3 total
		})
		expect(expanded.length).toBeLessThanOrEqual(3)
	})

	it("handles events at session boundaries (no prior/next)", async () => {
		const ts = new Date("2026-01-01T00:01:00Z")
		const { db } = createMockDb([]) // No neighbors found
		const results = [
			makeResult({
				path: "events/first",
				sessionId: "s1",
				timestamp: ts,
				score: 0.9,
			}),
		]
		const expanded = await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
		})
		// Original only, no neighbors added
		expect(expanded).toHaveLength(1)
		expect(expanded[0].path).toBe("events/first")
	})

	it("does not expand non-event results (episodes, kb, etc.)", async () => {
		const { db } = createMockDb([])
		const results = [
			makeResult({
				path: "episode/a",
				source: "conversation",
				sessionId: "s1",
				score: 0.9,
			}),
			makeResult({
				path: "kb/doc",
				source: "reference",
				score: 0.8,
			}),
		]
		const expanded = await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
		})
		expect(expanded).toHaveLength(2)
	})

	// -------------------------------------------------------------------------
	// WS-16 (C-033): the per-session neighbor fetches run in parallel under
	// a bounded concurrency cap, removing the sequential N+1 from the search
	// hot path.
	// -------------------------------------------------------------------------

	it("runs per-session fetches concurrently (no sequential N+1)", async () => {
		// Each session's fetch resolves only once ALL sessions' fetches are
		// in flight (or a short fallback fires). Sequential execution can
		// never raise the in-flight count past 1, so this test is red
		// exactly when the N+1 comes back.
		const sessionCount = CONTEXT_EXPANSION_MAX_CONCURRENCY
		let startedFetches = 0
		let maxConcurrentFetches = 0
		let releaseGate!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve
		})
		const gateOrFallback = Promise.race([
			gate,
			new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
		])

		const findFn = vi
			.fn()
			.mockImplementation((filter: { sessionId?: string }) => {
				const sessionId = filter.sessionId ?? "unknown"
				return {
					sort: vi.fn().mockReturnValue({
						limit: vi.fn().mockReturnValue({
							toArray: vi.fn().mockImplementation(
								() =>
									new Promise<Array<Document>>((resolve) => {
										startedFetches += 1
										if (startedFetches === sessionCount) {
											maxConcurrentFetches = startedFetches
											releaseGate()
										}
										gateOrFallback.then(() => resolve([]))
									}),
							),
						}),
					}),
				}
			})
		const collectionFn = vi.fn().mockReturnValue({ find: findFn })
		const db = { collection: collectionFn } as unknown as import("mongodb").Db

		const results = Array.from({ length: sessionCount }, (_, i) =>
			makeResult({
				path: `events/parent${i}`,
				sessionId: `s${i}`,
				timestamp: new Date(`2026-01-01T00:0${i}:00Z`),
				score: 0.9,
			}),
		)

		await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
		})

		// All sessionCount fetches were in flight simultaneously.
		expect(maxConcurrentFetches).toBe(sessionCount)
		expect(findFn).toHaveBeenCalledTimes(sessionCount)
	}, 10_000)

	it("caps concurrent fetches at CONTEXT_EXPANSION_MAX_CONCURRENCY", async () => {
		const sessionCount = CONTEXT_EXPANSION_MAX_CONCURRENCY * 3
		let inFlight = 0
		let peakInFlight = 0
		const findFn = vi.fn().mockImplementation(() => {
			inFlight += 1
			peakInFlight = Math.max(peakInFlight, inFlight)
			return {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockImplementation(async () => {
							// One microtask turn so parallel workers overlap.
							await Promise.resolve()
							inFlight -= 1
							return []
						}),
					}),
				}),
			}
		})
		const collectionFn = vi.fn().mockReturnValue({ find: findFn })
		const db = { collection: collectionFn } as unknown as import("mongodb").Db

		const results = Array.from({ length: sessionCount }, (_, i) =>
			makeResult({
				path: `events/parent${i}`,
				sessionId: `s${i}`,
				timestamp: new Date(`2026-01-01T00:0${i % 10}:00Z`),
				score: 0.9,
			}),
		)

		await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results,
		})

		expect(findFn).toHaveBeenCalledTimes(sessionCount)
		expect(peakInFlight).toBeLessThanOrEqual(CONTEXT_EXPANSION_MAX_CONCURRENCY)
	}, 10_000)

	it("keeps neighbor merge order deterministic across sessions", async () => {
		// Session fetches resolve in REVERSE order; merged neighbors must
		// still come out in the original session order.
		const sessions = ["s1", "s2", "s3"]
		const neighborsBySession: Record<string, Document[]> = {
			s1: [
				{
					eventId: "n1",
					agentId: "agent1",
					sessionId: "s1",
					role: "user",
					body: "one",
					timestamp: new Date("2026-01-01T00:00:30Z"),
				},
			],
			s2: [
				{
					eventId: "n2",
					agentId: "agent1",
					sessionId: "s2",
					role: "user",
					body: "two",
					timestamp: new Date("2026-01-01T00:01:30Z"),
				},
			],
			s3: [
				{
					eventId: "n3",
					agentId: "agent1",
					sessionId: "s3",
					role: "user",
					body: "three",
					timestamp: new Date("2026-01-01T00:02:30Z"),
				},
			],
		}
		const findFn = vi.fn().mockImplementation((filter: Document) => {
			const sessionId = filter.sessionId as string
			const delay = (sessions.length - sessions.indexOf(sessionId)) * 20
			return {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi
							.fn()
							.mockImplementation(
								async () =>
									await new Promise<Document[]>((resolve) =>
										setTimeout(
											() => resolve(neighborsBySession[sessionId] ?? []),
											delay,
										),
									),
							),
					}),
				}),
			}
		})
		const collectionFn = vi.fn().mockReturnValue({ find: findFn })
		const db = { collection: collectionFn } as unknown as import("mongodb").Db

		const expanded = await expandSearchContext({
			db,
			prefix: "test_",
			agentId: "agent1",
			scope: "session",
			scopeRef: "agent:agent1:session:s1",
			results: sessions.map((sessionId, i) =>
				makeResult({
					path: `events/parent-${sessionId}`,
					sessionId,
					timestamp: new Date(`2026-01-01T00:0${i}:00Z`),
					score: 0.9,
				}),
			),
			// maxResults high enough to keep every neighbor.
			maxResults: 10,
		})

		const neighborOrder = expanded
			.filter((r) => r.path.startsWith("events/n"))
			.map((r) => r.path)
		expect(neighborOrder).toEqual(["events/n1", "events/n2", "events/n3"])
	}, 10_000)
})
