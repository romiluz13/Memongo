import type { Db, Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"

import { traceReasoningChain } from "./mongodb-reasoning-chain.js"

const PREFIX = "test_"
const AGENT_ID = "agent-1"

/**
 * Create a mock DB where:
 * - collections[name].aggregate() returns the given docs (for $graphLookup)
 * - collections[name].find() returns the given docs (for leaf event fetch)
 */
function createMockDb(config: {
	aggregateResults?: Record<string, Document[]>
	findResults?: Record<string, Document[]>
}): Db {
	return {
		collection: vi.fn((name: string) => ({
			aggregate: vi.fn().mockReturnValue({
				toArray: vi
					.fn()
					.mockResolvedValue(config.aggregateResults?.[name] ?? []),
			}),
			find: vi.fn().mockReturnValue({
				sort: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue(config.findResults?.[name] ?? []),
				}),
			}),
		})),
	} as unknown as Db
}

describe("traceReasoningChain", () => {
	it("returns empty chain for unknown collection", async () => {
		const db = createMockDb({})
		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "fact-1",
			collection: "invalid_collection",
		})
		expect(result.nodes).toEqual([])
		expect(result.chainComplete).toBe(true)
	})

	it("returns empty chain when fact not found", async () => {
		const db = createMockDb({
			aggregateResults: { [`${PREFIX}structured_mem`]: [] },
		})
		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "nonexistent",
			collection: "structured_mem",
		})
		expect(result.nodes).toEqual([])
		expect(result.chainComplete).toBe(true)
	})

	it("traces single-hop chain from structured_mem to events", async () => {
		const now = new Date("2026-04-07T12:00:00.000Z")
		const earlier = new Date("2026-04-07T11:00:00.000Z")
		const db = createMockDb({
			aggregateResults: {
				[`${PREFIX}structured_mem`]: [
					{
						key: "fact-1",
						agentId: AGENT_ID,
						value: "TypeScript is preferred",
						sourceEventIds: ["evt-1", "evt-2"],
						updatedAt: now,
						premises: [], // no intermediate facts
					},
				],
			},
			findResults: {
				[`${PREFIX}events`]: [
					{
						eventId: "evt-1",
						body: "User said TypeScript",
						role: "user",
						timestamp: earlier,
					},
					{
						eventId: "evt-2",
						body: "Confirmed preference",
						role: "assistant",
						timestamp: now,
					},
				],
			},
		})

		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "fact-1",
			collection: "structured_mem",
		})

		expect(result.nodes).toHaveLength(3) // 2 events + 1 fact
		const types = result.nodes.map((n) => n.type)
		expect(types).toContain("event")
		expect(types).toContain("fact")
		expect(result.chainComplete).toBe(true)
	})

	it("orders nodes by depth ascending then timestamp ascending", async () => {
		const t1 = new Date("2026-04-07T10:00:00.000Z")
		const t2 = new Date("2026-04-07T11:00:00.000Z")
		const t3 = new Date("2026-04-07T12:00:00.000Z")
		const db = createMockDb({
			aggregateResults: {
				[`${PREFIX}structured_mem`]: [
					{
						key: "fact-1",
						agentId: AGENT_ID,
						value: "derived",
						sourceEventIds: ["evt-a", "evt-b", "evt-c"],
						updatedAt: t3,
						premises: [],
					},
				],
			},
			findResults: {
				[`${PREFIX}events`]: [
					{ eventId: "evt-a", body: "first", role: "user", timestamp: t1 },
					{ eventId: "evt-b", body: "second", role: "user", timestamp: t2 },
					{ eventId: "evt-c", body: "third", role: "user", timestamp: t3 },
				],
			},
		})

		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "fact-1",
			collection: "structured_mem",
		})

		const eventNodes = result.nodes.filter((n) => n.type === "event")
		expect(eventNodes).toHaveLength(3)
		expect(eventNodes[0].timestamp!.getTime()).toBeLessThanOrEqual(
			eventNodes[1].timestamp!.getTime(),
		)
		expect(eventNodes[1].timestamp!.getTime()).toBeLessThanOrEqual(
			eventNodes[2].timestamp!.getTime(),
		)
	})

	it("produces gap nodes for missing sourceEventIds", async () => {
		const db = createMockDb({
			aggregateResults: {
				[`${PREFIX}structured_mem`]: [
					{
						key: "fact-1",
						agentId: AGENT_ID,
						value: "test",
						sourceEventIds: ["evt-1", "missing-evt"],
						premises: [],
					},
				],
			},
			findResults: {
				[`${PREFIX}events`]: [
					{
						eventId: "evt-1",
						body: "exists",
						role: "user",
						timestamp: new Date(),
					},
				],
			},
		})

		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "fact-1",
			collection: "structured_mem",
		})

		const gapNodes = result.nodes.filter((n) => n.type === "gap")
		expect(gapNodes).toHaveLength(1)
		expect(gapNodes[0].id).toBe("missing-evt")
		expect(gapNodes[0].reason).toBe("deleted")
	})

	it("sets chainComplete=false when gaps exist", async () => {
		const db = createMockDb({
			aggregateResults: {
				[`${PREFIX}structured_mem`]: [
					{
						key: "fact-1",
						agentId: AGENT_ID,
						value: "test",
						sourceEventIds: ["evt-1", "missing-evt"],
						premises: [],
					},
				],
			},
			findResults: {
				[`${PREFIX}events`]: [
					{
						eventId: "evt-1",
						body: "exists",
						role: "user",
						timestamp: new Date(),
					},
				],
			},
		})

		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "fact-1",
			collection: "structured_mem",
		})

		expect(result.chainComplete).toBe(false)
	})

	it("handles fact with no sourceEventIds", async () => {
		const db = createMockDb({
			aggregateResults: {
				[`${PREFIX}structured_mem`]: [
					{
						key: "fact-1",
						agentId: AGENT_ID,
						value: "standalone fact",
						premises: [],
					},
				],
			},
		})

		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "fact-1",
			collection: "structured_mem",
		})

		expect(result.nodes).toHaveLength(1)
		expect(result.nodes[0].type).toBe("fact")
		expect(result.chainComplete).toBe(true)
	})

	it("includes multi-hop premises from $graphLookup", async () => {
		const t0 = new Date("2026-04-07T10:00:00.000Z")
		const t1 = new Date("2026-04-07T11:00:00.000Z")
		const t2 = new Date("2026-04-07T12:00:00.000Z")
		const db = createMockDb({
			aggregateResults: {
				[`${PREFIX}structured_mem`]: [
					{
						key: "conclusion-1",
						agentId: AGENT_ID,
						value: "final conclusion",
						sourceEventIds: ["premise-1"],
						updatedAt: t2,
						premises: [
							{
								key: "premise-1",
								value: "intermediate premise",
								sourceEventIds: ["evt-1"],
								updatedAt: t1,
								hopDistance: 0,
							},
						],
					},
				],
			},
			findResults: {
				[`${PREFIX}events`]: [
					{
						eventId: "evt-1",
						body: "original event",
						role: "user",
						timestamp: t0,
					},
				],
			},
		})

		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "conclusion-1",
			collection: "structured_mem",
		})

		expect(result.nodes).toHaveLength(3) // 1 event + 1 premise + 1 conclusion
		// Sorted by depth: event (0), premise (0 hopDistance -> fact depth), conclusion (deepest)
		const factNodes = result.nodes.filter((n) => n.type === "fact")
		expect(factNodes).toHaveLength(2)
		expect(factNodes[0].id).toBe("premise-1")
		expect(factNodes[1].id).toBe("conclusion-1")
	})

	it("sets maxDepthReached when premise at maxDepth", async () => {
		const db = createMockDb({
			aggregateResults: {
				[`${PREFIX}structured_mem`]: [
					{
						key: "fact-1",
						agentId: AGENT_ID,
						value: "derived",
						sourceEventIds: ["premise-deep"],
						premises: [
							{
								key: "premise-deep",
								value: "deep premise",
								sourceEventIds: [],
								hopDistance: 3,
							},
						],
					},
				],
			},
		})

		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "fact-1",
			collection: "structured_mem",
			options: { maxDepth: 3 },
		})

		expect(result.maxDepthReached).toBe(true)
	})

	it("traces from entities collection", async () => {
		const db = createMockDb({
			aggregateResults: {
				[`${PREFIX}entities`]: [
					{
						entityId: "entity-1",
						agentId: AGENT_ID,
						value: "entity value",
						sourceEventIds: ["evt-1"],
						premises: [],
					},
				],
			},
			findResults: {
				[`${PREFIX}events`]: [
					{
						eventId: "evt-1",
						body: "mentioned entity",
						role: "user",
						timestamp: new Date(),
					},
				],
			},
		})

		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "entity-1",
			collection: "entities",
		})

		expect(result.nodes.length).toBeGreaterThan(0)
		expect(result.collection).toBe("entities")
		expect(result.factId).toBe("entity-1")
	})

	it("traces from procedures collection", async () => {
		const db = createMockDb({
			aggregateResults: {
				[`${PREFIX}procedures`]: [
					{
						procedureId: "proc-1",
						agentId: AGENT_ID,
						value: "procedure value",
						sourceEventIds: ["evt-1"],
						premises: [],
					},
				],
			},
			findResults: {
				[`${PREFIX}events`]: [
					{
						eventId: "evt-1",
						body: "procedure event",
						role: "user",
						timestamp: new Date(),
					},
				],
			},
		})

		const result = await traceReasoningChain({
			db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			factId: "proc-1",
			collection: "procedures",
		})

		expect(result.nodes.length).toBeGreaterThan(0)
		expect(result.collection).toBe("procedures")
		expect(result.factId).toBe("proc-1")
	})
})
