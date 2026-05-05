import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	updateLaneCoverage,
	getLaneCoverage,
	emptyLaneCoverage,
} from "./mongodb-lane-coverage.js"

// ---------------------------------------------------------------------------
// Mock mongodb-schema to provide a fake collection
// ---------------------------------------------------------------------------

const mockUpdateOne = vi.fn()
const mockFindOne = vi.fn()
const mockCollection = {
	updateOne: mockUpdateOne,
	findOne: mockFindOne,
}

vi.mock("./mongodb-schema.js", () => ({
	laneCoverageCollection: vi.fn(() => mockCollection),
}))

const fakeDb = {} as unknown as import("mongodb").Db
const fakePrefix = "test_"

describe("updateLaneCoverage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUpdateOne.mockResolvedValue({ modifiedCount: 1 })
	})

	it("increments count for a single lane", async () => {
		await updateLaneCoverage({
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-1",
			increments: { graph: 3 },
		})

		expect(mockUpdateOne).toHaveBeenCalledOnce()
		const [filter, update, options] = mockUpdateOne.mock.calls[0]
		expect(filter).toEqual({ agentId: "agent-1" })
		expect(update.$inc).toEqual({ "lanes.graph.count": 3 })
		expect(update.$set["lanes.graph.hasData"]).toBe(true)
		expect(options.upsert).toBe(true)
	})

	it("increments multiple lanes atomically", async () => {
		await updateLaneCoverage({
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-1",
			increments: { graph: 2, structured: 5, episodic: 1 },
		})

		expect(mockUpdateOne).toHaveBeenCalledOnce()
		const [, update] = mockUpdateOne.mock.calls[0]
		expect(update.$inc).toEqual({
			"lanes.graph.count": 2,
			"lanes.structured.count": 5,
			"lanes.episodic.count": 1,
		})
		expect(update.$set["lanes.graph.hasData"]).toBe(true)
		expect(update.$set["lanes.structured.hasData"]).toBe(true)
		expect(update.$set["lanes.episodic.hasData"]).toBe(true)
	})

	it("creates document if none exists (upsert)", async () => {
		await updateLaneCoverage({
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "new-agent",
			increments: { hybrid: 1 },
		})

		const [, update, options] = mockUpdateOne.mock.calls[0]
		expect(options.upsert).toBe(true)
		expect(update.$setOnInsert).toEqual({ agentId: "new-agent" })
	})

	it("sets lastUpdated timestamp", async () => {
		const before = new Date()
		await updateLaneCoverage({
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-1",
			increments: { graph: 1 },
		})
		const after = new Date()

		const [, update] = mockUpdateOne.mock.calls[0]
		const lastUpdated = update.$set["lanes.graph.lastUpdated"] as Date
		expect(lastUpdated.getTime()).toBeGreaterThanOrEqual(before.getTime())
		expect(lastUpdated.getTime()).toBeLessThanOrEqual(after.getTime())
		const updatedAt = update.$set.updatedAt as Date
		expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
	})

	it("skips update when increments are empty", async () => {
		await updateLaneCoverage({
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-1",
			increments: {},
		})

		expect(mockUpdateOne).not.toHaveBeenCalled()
	})

	it("skips lanes with zero or negative increments", async () => {
		await updateLaneCoverage({
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-1",
			increments: { graph: 0, structured: -1, hybrid: 2 },
		})

		const [, update] = mockUpdateOne.mock.calls[0]
		expect(update.$inc).toEqual({ "lanes.hybrid.count": 2 })
		expect(update.$set["lanes.graph.hasData"]).toBeUndefined()
	})
})

describe("getLaneCoverage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns null for unknown agent", async () => {
		mockFindOne.mockResolvedValue(null)

		const result = await getLaneCoverage({
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "unknown-agent",
		})

		expect(result).toBeNull()
		expect(mockFindOne).toHaveBeenCalledWith({ agentId: "unknown-agent" })
	})

	it("returns coverage document for known agent", async () => {
		const doc = {
			agentId: "agent-1",
			lanes: {
				graph: { count: 5, lastUpdated: new Date(), hasData: true },
				structured: { count: 0, lastUpdated: null, hasData: false },
			},
			updatedAt: new Date(),
		}
		mockFindOne.mockResolvedValue(doc)

		const result = await getLaneCoverage({
			db: fakeDb,
			prefix: fakePrefix,
			agentId: "agent-1",
		})

		expect(result).not.toBeNull()
		expect(result!.agentId).toBe("agent-1")
		expect(result!.lanes.graph.hasData).toBe(true)
	})
})

describe("emptyLaneCoverage", () => {
	it("returns all 8 lanes with count 0 and hasData false", () => {
		const lanes = emptyLaneCoverage()
		const expectedLanes = [
			"active-critical",
			"structured",
			"raw-window",
			"graph",
			"hybrid",
			"kb",
			"episodic",
			"procedural",
		]

		expect(Object.keys(lanes)).toHaveLength(8)
		for (const lane of expectedLanes) {
			expect(lanes[lane]).toBeDefined()
			expect(lanes[lane].count).toBe(0)
			expect(lanes[lane].hasData).toBe(false)
			expect(lanes[lane].lastUpdated).toBeNull()
		}
	})
})
