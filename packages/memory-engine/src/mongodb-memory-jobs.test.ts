import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Collection, Db, UpdateResult } from "mongodb"

function mockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		insertOne: vi.fn(async () => ({ insertedId: "job-1" })),
		updateOne: vi.fn(async () => ({ matchedCount: 1 }) as UpdateResult),
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

vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}))

describe("mongodb-memory-jobs", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("clamps list limits to a maximum of 100", async () => {
		const { listMemoryJobs } = await import("./mongodb-memory-jobs.js")
		const limitSpy = vi.fn(() => ({
			toArray: vi.fn(async () => []),
		}))
		const db = mockDb({
			test_memory_jobs: mockCollection({
				find: vi.fn(() => ({
					sort: vi.fn(() => ({
						limit: limitSpy,
					})),
				})),
			}),
		})

		await listMemoryJobs({
			db,
			prefix: "test_",
			agentId: "agent-1",
			limit: 999999999,
		})

		expect(limitSpy).toHaveBeenCalledWith(100)
	})

	it("prevents invalid terminal-to-running transitions", async () => {
		const { updateMemoryJob } = await import("./mongodb-memory-jobs.js")
		const updateOne = vi.fn(async () => ({ matchedCount: 0 }) as UpdateResult)
		const db = mockDb({
			test_memory_jobs: mockCollection({ updateOne }),
		})

		await updateMemoryJob({
			db,
			prefix: "test_",
			jobId: "job-1",
			agentId: "agent-1",
			status: "running",
		})

		expect(updateOne).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "job-1",
				agentId: "agent-1",
				status: { $in: ["pending", "running"] },
			}),
			expect.any(Object),
		)
	})
})
