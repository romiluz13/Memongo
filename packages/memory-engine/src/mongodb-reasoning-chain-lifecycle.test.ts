// M2 review fix R9: the chain hydrates leaf events under the store's full event
// lifecycle (retention, validAt and invalidAt at the trace's clock), not expiry
// alone. The events collection is the stateful fake, so the filter the engine
// sends is evaluated against real documents instead of asserted by shape.
import type { Db, Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const PREFIX = "test_"
const TENANT = {
	agentId: "agent-1",
	scope: "workspace",
	scopeRef: "workspace:mine",
} as const
const HOUR_MS = 60 * 60 * 1000

function leafEvent(eventId: string, overrides: Document = {}): Document {
	return {
		eventId,
		...TENANT,
		body: `body of ${eventId}`,
		role: "user",
		timestamp: new Date(Date.now() - 24 * HOUR_MS),
		validAt: new Date(Date.now() - 24 * HOUR_MS),
		...overrides,
	}
}

function chainDb(leafEvents: Document[], leafIds: string[]): Db {
	const fake = createStatefulMongoFake({ prefix: PREFIX })
	fake.collection("events").docs.push(...leafEvents)
	return {
		collection: (name: string) =>
			name === `${PREFIX}structured_mem`
				? {
						aggregate: vi.fn().mockReturnValue({
							toArray: vi.fn().mockResolvedValue([
								{
									key: "fact-1",
									...TENANT,
									value: "a derived fact",
									sourceEventIds: leafIds,
									premises: [],
								},
							]),
						}),
					}
				: fake.db.collection(name),
	} as unknown as Db
}

async function trace(leafEvents: Document[], leafIds: string[]) {
	return traceReasoningChain({
		db: chainDb(leafEvents, leafIds),
		prefix: PREFIX,
		factId: "fact-1",
		collection: "structured_mem",
		...TENANT,
	})
}

describe("traceReasoningChain leaf event lifecycle (R9)", () => {
	it("returns a live leaf and a leaf with an explicit open validity window", async () => {
		const result = await trace(
			[leafEvent("evt-live"), leafEvent("evt-open", { invalidAt: null })],
			["evt-live", "evt-open"],
		)

		const eventIds = result.nodes
			.filter((node) => node.type === "event")
			.map((node) => node.id)
		expect(eventIds.sort()).toEqual(["evt-live", "evt-open"])
		expect(result.chainComplete).toBe(true)
	})

	it("excludes an expired leaf and reports it as a gap, not a body", async () => {
		const result = await trace(
			[leafEvent("evt-expired", { expiresAt: new Date(Date.now() - HOUR_MS) })],
			["evt-expired"],
		)

		expect(result.nodes.filter((node) => node.type === "event")).toEqual([])
		expect(
			result.nodes.find((node) => node.id === "evt-expired"),
		).toMatchObject({ type: "gap" })
		expect(result.chainComplete).toBe(false)
		expect(JSON.stringify(result)).not.toContain("body of evt-expired")
	})

	it("excludes a retracted leaf whose invalidAt has passed", async () => {
		const result = await trace(
			[
				leafEvent("evt-retracted", {
					invalidAt: new Date(Date.now() - HOUR_MS),
				}),
			],
			["evt-retracted"],
		)

		expect(result.nodes.filter((node) => node.type === "event")).toEqual([])
		expect(
			result.nodes.find((node) => node.id === "evt-retracted"),
		).toMatchObject({ type: "gap" })
		expect(result.chainComplete).toBe(false)
		expect(JSON.stringify(result)).not.toContain("body of evt-retracted")
	})

	it("excludes a future-valid leaf whose validAt has not arrived", async () => {
		const result = await trace(
			[leafEvent("evt-future", { validAt: new Date(Date.now() + HOUR_MS) })],
			["evt-future"],
		)

		expect(result.nodes.filter((node) => node.type === "event")).toEqual([])
		expect(result.nodes.find((node) => node.id === "evt-future")).toMatchObject(
			{
				type: "gap",
			},
		)
		expect(result.chainComplete).toBe(false)
		expect(JSON.stringify(result)).not.toContain("body of evt-future")
	})

	it("keeps the live leaf while excluding its lifecycle-ended siblings", async () => {
		const result = await trace(
			[
				leafEvent("evt-live"),
				leafEvent("evt-retracted", {
					invalidAt: new Date(Date.now() - HOUR_MS),
				}),
				leafEvent("evt-future", { validAt: new Date(Date.now() + HOUR_MS) }),
			],
			["evt-live", "evt-retracted", "evt-future"],
		)

		expect(
			result.nodes.filter((node) => node.type === "event").map((n) => n.id),
		).toEqual(["evt-live"])
		expect(
			result.nodes
				.filter((node) => node.type === "gap")
				.map((n) => n.id)
				.sort(),
		).toEqual(["evt-future", "evt-retracted"])
	})
})
