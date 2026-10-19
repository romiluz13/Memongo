import type { Collection, Db } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	bestEffort,
	getBestEffortFailureCounts,
	resetBestEffortFailureCounts,
} from "./best-effort.js"

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

describe("bestEffort", () => {
	beforeEach(() => resetBestEffortFailureCounts())

	it("counts a failure under its label and does not throw", async () => {
		await expect(
			bestEffort("audit", async () => {
				throw new Error("audit store down")
			}),
		).resolves.toBeUndefined()
		await bestEffort("audit", async () => {
			throw new Error("again")
		})
		expect(getBestEffortFailureCounts()).toEqual({ audit: 2 })
	})

	it("leaves the counter alone when the work succeeds", async () => {
		await bestEffort("telemetry", async () => {})
		expect(getBestEffortFailureCounts()).toEqual({})
	})
})

describe("bookkeeping at the engine seam", () => {
	beforeEach(() => resetBestEffortFailureCounts())

	it("a failed mutation audit is counted and does not fail the relation write", async () => {
		const { upsertRelation } = await import("./mongodb-graph.js")
		const make = (reject: boolean) =>
			({
				findOne: vi.fn(async () => null),
				updateOne: vi.fn(async () => ({
					upsertedCount: 1,
					matchedCount: 0,
					modifiedCount: 0,
				})),
				insertOne: vi.fn(async () => {
					if (reject) throw new Error("audit store down")
					return { acknowledged: true }
				}),
			}) as unknown as Collection
		const db = {
			collection: vi.fn((name: string) =>
				make(name.endsWith("memory_mutations")),
			),
		} as unknown as Db

		await expect(
			upsertRelation({
				db,
				prefix: "t_",
				relation: {
					fromEntityId: "a",
					toEntityId: "b",
					type: "works_on",
					agentId: "main",
					scope: "agent",
					updatedAt: new Date("2026-01-01"),
				},
			}),
		).resolves.toEqual({ upserted: true })
		await vi.waitFor(() =>
			expect(getBestEffortFailureCounts()).toEqual({ "relation-audit": 1 }),
		)
	})
})
