import { describe, expect, it, vi } from "vitest"
import {
	buildConversationWindows,
	projectConversationWindows,
} from "./mongodb-conversation-windows.js"

function makeEvents(count: number, _sessionId = "s1") {
	return Array.from({ length: count }, (_, i) => ({
		eventId: `evt-${i}`,
		role: i % 2 === 0 ? "user" : "assistant",
		body: `turn ${i} content`,
		timestamp: new Date(Date.now() + i * 60_000),
	}))
}

describe("buildConversationWindows", () => {
	it("returns empty for <5 events", () => {
		const events = makeEvents(4)
		const windows = buildConversationWindows("s1", events)
		expect(windows).toHaveLength(0)
	})

	it("creates single window for exactly 5 events", () => {
		const events = makeEvents(5)
		const windows = buildConversationWindows("s1", events)
		expect(windows).toHaveLength(1)
		expect(windows[0].windowIndex).toBe(0)
		expect(windows[0].events).toHaveLength(5)
	})

	it("creates single window for 7 events", () => {
		const events = makeEvents(7)
		const windows = buildConversationWindows("s1", events)
		expect(windows).toHaveLength(1)
		expect(windows[0].events).toHaveLength(7)
	})

	it("creates overlapping windows for >7 events", () => {
		const events = makeEvents(12)
		const windows = buildConversationWindows("s1", events, 7, 2)
		expect(windows.length).toBeGreaterThan(1)
		// First window starts at index 0
		expect(windows[0].startTurnIndex).toBe(0)
		expect(windows[0].endTurnIndex).toBe(6)
		// Second window overlaps by 2
		expect(windows[1].startTurnIndex).toBe(5)
	})

	it("overlap is exactly 2 turns", () => {
		const events = makeEvents(14)
		const windows = buildConversationWindows("s1", events, 7, 2)
		for (let i = 1; i < windows.length; i++) {
			const prevEnd = windows[i - 1].endTurnIndex
			const currStart = windows[i].startTurnIndex
			// Overlap: prevEnd - currStart + 1 = 2
			expect(prevEnd - currStart + 1).toBe(2)
		}
	})

	it("last window may be smaller than windowSize", () => {
		const events = makeEvents(10)
		const windows = buildConversationWindows("s1", events, 7, 2)
		const lastWindow = windows[windows.length - 1]
		expect(lastWindow.events.length).toBeLessThanOrEqual(7)
	})

	it("preserves event order within each window", () => {
		const events = makeEvents(8)
		const windows = buildConversationWindows("s1", events, 7, 2)
		for (const win of windows) {
			for (let i = 1; i < win.events.length; i++) {
				expect(win.events[i].timestamp.getTime()).toBeGreaterThanOrEqual(
					win.events[i - 1].timestamp.getTime(),
				)
			}
		}
	})

	it("generates correct text with role labels", () => {
		const events = makeEvents(5)
		const windows = buildConversationWindows("s1", events)
		expect(windows[0].text).toContain("User: turn 0 content")
		expect(windows[0].text).toContain("Assistant: turn 1 content")
	})
})

describe("projectConversationWindows", () => {
	function createMockDb() {
		const findResults: unknown[] = []
		const toArrayFn = vi.fn().mockResolvedValue(findResults)
		const limitFn = vi.fn().mockReturnValue({ toArray: toArrayFn })
		const sortFn = vi.fn().mockReturnValue({ limit: limitFn })
		const findFn = vi.fn().mockReturnValue({
			sort: sortFn,
		})
		const updateOneFn = vi.fn().mockResolvedValue({ upsertedCount: 1 })
		const collectionFn = vi.fn().mockReturnValue({
			find: findFn,
			updateOne: updateOneFn,
		})

		return {
			db: {
				collection: collectionFn,
			} as unknown as import("mongodb").Db,
			findFn,
			toArrayFn,
			updateOneFn,
			setFindResults(results: unknown[]) {
				toArrayFn.mockResolvedValue(results)
			},
		}
	}

	it("creates window chunks in chunks collection", async () => {
		const mock = createMockDb()
		const events = makeEvents(8)
		mock.setFindResults(events)

		const result = await projectConversationWindows({
			db: mock.db,
			prefix: "test_",
			agentId: "agent1",
			sessionId: "s1",
			scope: "agent",
			scopeRef: "agent:agent1",
		})
		expect(result.windowsCreated).toBeGreaterThan(0)
		expect(mock.updateOneFn).toHaveBeenCalled()
	})

	it("uses windows/{sessionId}/{index} path format", async () => {
		const mock = createMockDb()
		const events = makeEvents(8)
		mock.setFindResults(events)

		await projectConversationWindows({
			db: mock.db,
			prefix: "test_",
			agentId: "agent1",
			sessionId: "s1",
			scope: "agent",
			scopeRef: "agent:agent1",
		})

		const calls = mock.updateOneFn.mock.calls
		expect(calls.length).toBeGreaterThan(0)
		// Check the filter of the first upsert call
		const firstCallFilter = calls[0][0]
		expect(firstCallFilter.path).toMatch(/^windows\/s1\/\d+$/)
	})

	it("is idempotent (re-projection does not duplicate)", async () => {
		const mock = createMockDb()
		const events = makeEvents(8)
		mock.setFindResults(events)

		await projectConversationWindows({
			db: mock.db,
			prefix: "test_",
			agentId: "agent1",
			sessionId: "s1",
			scope: "agent",
			scopeRef: "agent:agent1",
		})

		const firstCallCount = mock.updateOneFn.mock.calls.length

		// Re-project — same number of upserts (idempotent)
		await projectConversationWindows({
			db: mock.db,
			prefix: "test_",
			agentId: "agent1",
			sessionId: "s1",
			scope: "agent",
			scopeRef: "agent:agent1",
		})

		// Each projection writes the same number of windows
		const totalCalls = mock.updateOneFn.mock.calls.length
		expect(totalCalls).toBe(firstCallCount * 2)
	})

	it("stores sessionId and windowIndex in chunk metadata", async () => {
		const mock = createMockDb()
		const events = makeEvents(8)
		mock.setFindResults(events)

		await projectConversationWindows({
			db: mock.db,
			prefix: "test_",
			agentId: "agent1",
			sessionId: "s1",
			scope: "agent",
			scopeRef: "agent:agent1",
		})

		const firstCallUpdate = mock.updateOneFn.mock.calls[0][1]
		// The update should contain sessionId and windowIndex
		const allFields = {
			...firstCallUpdate.$set,
			...firstCallUpdate.$setOnInsert,
		}
		expect(allFields.sessionId).toBe("s1")
		expect(typeof allFields.windowIndex).toBe("number")
	})
})
