import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Collection, Db } from "mongodb"

function mockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		insertOne: vi.fn(async () => ({ insertedId: "trace-1" })),
		find: vi.fn(() => ({
			sort: vi.fn(() => ({
				limit: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		})),
		findOne: vi.fn(async () => null),
		...overrides,
	} as unknown as Collection
}

function mockDb(collectionMap: Record<string, Collection> = {}): Db {
	return {
		collection: vi.fn(
			(name: string) => collectionMap[name] ?? mockCollection(),
		),
	} as unknown as Db
}

describe("mongodb-recall-traces", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("clamps list limits to a maximum of 100", async () => {
		const { listRecallTraces } = await import("./mongodb-recall-traces.js")
		const limitSpy = vi.fn(() => ({
			toArray: vi.fn(async () => []),
		}))
		const db = mockDb({
			test_recall_traces: mockCollection({
				find: vi.fn(() => ({
					sort: vi.fn(() => ({
						limit: limitSpy,
					})),
				})),
			}),
		})

		await listRecallTraces({
			db,
			prefix: "test_",
			agentId: "agent-1",
			limit: 999999999,
		})

		expect(limitSpy).toHaveBeenCalledWith(100)
	})
})
