import { describe, expect, it } from "vitest"
import { mergeContiguousChunks } from "./mongodb-contiguous-merge.js"
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

describe("mergeContiguousChunks", () => {
	it("returns empty array for empty input", () => {
		expect(mergeContiguousChunks([])).toEqual([])
	})

	it("returns single result unchanged", () => {
		const results = [
			makeResult({
				path: "events/a",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:00:00Z"),
			}),
		]
		const merged = mergeContiguousChunks(results)
		expect(merged).toHaveLength(1)
		expect(merged[0].path).toBe("events/a")
	})

	it("merges two adjacent chunks from same session", () => {
		const results = [
			makeResult({
				path: "events/a",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:01:00Z"),
				score: 0.8,
				snippet: "first",
			}),
			makeResult({
				path: "events/b",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:02:00Z"),
				score: 0.6,
				snippet: "second",
			}),
		]
		const merged = mergeContiguousChunks(results)
		expect(merged).toHaveLength(1)
		expect(merged[0].snippet).toContain("first")
		expect(merged[0].snippet).toContain("second")
	})

	it("preserves max score of merged chunks", () => {
		const results = [
			makeResult({
				path: "events/a",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:01:00Z"),
				score: 0.4,
			}),
			makeResult({
				path: "events/b",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:02:00Z"),
				score: 0.9,
			}),
		]
		const merged = mergeContiguousChunks(results)
		expect(merged).toHaveLength(1)
		expect(merged[0].score).toBe(0.9)
	})

	it("does not merge chunks from different sessions", () => {
		const results = [
			makeResult({
				path: "events/a",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:01:00Z"),
				score: 0.8,
			}),
			makeResult({
				path: "events/b",
				sessionId: "s2",
				timestamp: new Date("2026-01-01T00:02:00Z"),
				score: 0.6,
			}),
		]
		const merged = mergeContiguousChunks(results)
		expect(merged).toHaveLength(2)
	})

	it("does not merge non-conversation results (episodes, kb, structured)", () => {
		const results = [
			makeResult({
				path: "episode/a",
				source: "reference",
				score: 0.8,
				snippet: "ep1",
			}),
			makeResult({
				path: "episode/b",
				source: "reference",
				score: 0.6,
				snippet: "ep2",
			}),
		]
		const merged = mergeContiguousChunks(results)
		expect(merged).toHaveLength(2)
	})

	it("does not merge results without sessionId (passes through unchanged)", () => {
		const results = [
			makeResult({
				path: "events/a",
				timestamp: new Date("2026-01-01T00:01:00Z"),
				score: 0.8,
			}),
			makeResult({
				path: "events/b",
				timestamp: new Date("2026-01-01T00:02:00Z"),
				score: 0.6,
			}),
		]
		const merged = mergeContiguousChunks(results)
		expect(merged).toHaveLength(2)
	})

	it("concatenates snippets with newline separator", () => {
		const results = [
			makeResult({
				path: "events/a",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:01:00Z"),
				snippet: "Hello",
			}),
			makeResult({
				path: "events/b",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:02:00Z"),
				snippet: "World",
			}),
		]
		const merged = mergeContiguousChunks(results)
		expect(merged[0].snippet).toBe("Hello\nWorld")
	})

	it("handles mixed conversation and non-conversation results", () => {
		const results = [
			makeResult({
				path: "events/a",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:01:00Z"),
				score: 0.9,
				snippet: "conv1",
			}),
			makeResult({
				path: "events/b",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:02:00Z"),
				score: 0.8,
				snippet: "conv2",
			}),
			makeResult({
				path: "kb/doc1",
				source: "reference",
				score: 0.7,
				snippet: "kb result",
			}),
		]
		const merged = mergeContiguousChunks(results)
		// 1 merged conversation block + 1 kb result
		expect(merged).toHaveLength(2)
		expect(merged[0].snippet).toContain("conv1")
		expect(merged[0].snippet).toContain("conv2")
	})

	it("preserves original order when no merges possible", () => {
		const results = [
			makeResult({
				path: "events/a",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:01:00Z"),
				score: 0.9,
			}),
			makeResult({
				path: "events/b",
				sessionId: "s2",
				timestamp: new Date("2026-01-01T00:02:00Z"),
				score: 0.7,
			}),
			makeResult({
				path: "events/c",
				sessionId: "s3",
				timestamp: new Date("2026-01-01T00:03:00Z"),
				score: 0.5,
			}),
		]
		const merged = mergeContiguousChunks(results)
		expect(merged).toHaveLength(3)
		// Results sorted by score descending
		expect(merged[0].score).toBeGreaterThanOrEqual(merged[1].score)
		expect(merged[1].score).toBeGreaterThanOrEqual(merged[2].score)
	})

	it("merges multiple groups independently", () => {
		const results = [
			makeResult({
				path: "events/a",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:01:00Z"),
				score: 0.9,
				snippet: "s1-a",
			}),
			makeResult({
				path: "events/b",
				sessionId: "s1",
				timestamp: new Date("2026-01-01T00:02:00Z"),
				score: 0.8,
				snippet: "s1-b",
			}),
			makeResult({
				path: "events/c",
				sessionId: "s2",
				timestamp: new Date("2026-01-01T00:01:00Z"),
				score: 0.7,
				snippet: "s2-a",
			}),
			makeResult({
				path: "events/d",
				sessionId: "s2",
				timestamp: new Date("2026-01-01T00:02:00Z"),
				score: 0.6,
				snippet: "s2-b",
			}),
		]
		const merged = mergeContiguousChunks(results)
		// 2 merged blocks: one per session
		expect(merged).toHaveLength(2)
		const s1Block = merged.find((r) => r.snippet.includes("s1-a"))
		const s2Block = merged.find((r) => r.snippet.includes("s2-a"))
		expect(s1Block?.snippet).toContain("s1-b")
		expect(s2Block?.snippet).toContain("s2-b")
		expect(s1Block?.score).toBe(0.9)
		expect(s2Block?.score).toBe(0.7)
	})
})
