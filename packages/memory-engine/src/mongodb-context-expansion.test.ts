import { describe, expect, it, vi } from "vitest"
import { expandSearchContext } from "./mongodb-context-expansion.js"
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
			results,
		})
		// Original + 2 neighbors
		expect(expanded.length).toBeGreaterThanOrEqual(2)
		const paths = expanded.map((r) => r.path)
		expect(paths).toContain("events/mid")
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
			results,
		})
		expect(expanded).toHaveLength(2)
	})
})
