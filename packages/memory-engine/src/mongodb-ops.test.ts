/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection } from "mongodb"
import { describe, it, expect, vi } from "vitest"
vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import {
	recordIngestRun,
	recordProjectionRun,
	getRecentIngestRuns,
	getRecentProjectionRuns,
	getProjectionLag,
	type IngestRun,
	type ProjectionRun,
} from "./mongodb-ops.js"
import { emitTelemetry } from "./mongodb-telemetry.js"

// ---------------------------------------------------------------------------
// Helpers: stub MongoDB collection
// ---------------------------------------------------------------------------

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		insertOne: vi.fn().mockResolvedValue({ insertedId: "mock-id" }),
		find: vi.fn().mockReturnValue({
			sort: vi.fn().mockReturnValue({
				limit: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue([]),
				}),
			}),
		}),
		findOne: vi.fn().mockResolvedValue(null),
		...overrides,
	} as unknown as Collection
}

function createMockDb(collections: Record<string, Collection>): Db {
	return {
		collection: vi.fn((name: string) => {
			return collections[name] ?? createMockCollection()
		}),
	} as unknown as Db
}

const PREFIX = "test_"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mongodb-ops", () => {
	describe("recordIngestRun", () => {
		it("inserts an ingest run document with generated runId and ts", async () => {
			const ingestCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}ingest_runs`]: ingestCol })

			const runId = await recordIngestRun({
				db,
				prefix: PREFIX,
				run: {
					agentId: "agent-1",
					source: "file-sync",
					status: "ok",
					itemsProcessed: 10,
					itemsFailed: 0,
					durationMs: 1500,
				},
			})

			expect(typeof runId).toBe("string")
			expect(runId.length).toBeGreaterThan(0)
			expect(ingestCol.insertOne).toHaveBeenCalledOnce()
			const [doc] = (ingestCol.insertOne as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(doc.runId).toBe(runId)
			expect(doc.agentId).toBe("agent-1")
			expect(doc.source).toBe("file-sync")
			expect(doc.status).toBe("ok")
			expect(doc.itemsProcessed).toBe(10)
			expect(doc.itemsFailed).toBe(0)
			expect(doc.durationMs).toBe(1500)
			expect(doc.ts).toBeInstanceOf(Date)
		})
	})

	describe("recordProjectionRun", () => {
		it("inserts a projection run document with generated runId and ts", async () => {
			const projCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}projection_runs`]: projCol })

			const runId = await recordProjectionRun({
				db,
				prefix: PREFIX,
				run: {
					agentId: "agent-1",
					projectionType: "chunks",
					status: "ok",
					lag: 5,
					itemsProjected: 20,
					durationMs: 3000,
				},
			})

			expect(typeof runId).toBe("string")
			expect(runId.length).toBeGreaterThan(0)
			expect(projCol.insertOne).toHaveBeenCalledOnce()
			const [doc] = (projCol.insertOne as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(doc.runId).toBe(runId)
			expect(doc.agentId).toBe("agent-1")
			expect(doc.projectionType).toBe("chunks")
			expect(doc.status).toBe("ok")
			expect(doc.lag).toBe(5)
			expect(doc.itemsProjected).toBe(20)
			expect(doc.durationMs).toBe(3000)
			expect(doc.ts).toBeInstanceOf(Date)
		})
	})

	describe("getRecentIngestRuns", () => {
		it("returns runs sorted by ts descending", async () => {
			const now = new Date()
			const earlier = new Date(now.getTime() - 60_000)
			const docs: IngestRun[] = [
				{
					runId: "run-2",
					agentId: "agent-1",
					source: "session-sync",
					status: "ok",
					itemsProcessed: 5,
					itemsFailed: 0,
					durationMs: 800,
					ts: now,
				},
				{
					runId: "run-1",
					agentId: "agent-1",
					source: "file-sync",
					status: "partial",
					itemsProcessed: 3,
					itemsFailed: 1,
					durationMs: 1200,
					ts: earlier,
				},
			]

			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue(docs),
					}),
				}),
			}
			const ingestCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}ingest_runs`]: ingestCol })

			const results = await getRecentIngestRuns({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				limit: 10,
			})

			expect(results).toHaveLength(2)
			expect(results[0].runId).toBe("run-2")
			expect(results[1].runId).toBe("run-1")
			// Verify query filter includes agentId
			const [filter] = (ingestCol.find as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter).toEqual({ agentId: "agent-1" })
			// Verify sort by ts descending
			expect(findResult.sort).toHaveBeenCalledWith({ ts: -1 })
			// Verify limit
			expect(
				vi.mocked(findResult.sort).mock.results[0].value.limit,
			).toHaveBeenCalledWith(10)
		})
	})

	describe("getRecentProjectionRuns", () => {
		it("filters by projectionType when provided", async () => {
			const docs: ProjectionRun[] = [
				{
					runId: "run-3",
					agentId: "agent-1",
					projectionType: "entities",
					status: "ok",
					itemsProjected: 15,
					durationMs: 2000,
					ts: new Date(),
				},
			]

			const findResult = {
				sort: vi.fn().mockReturnValue({
					limit: vi.fn().mockReturnValue({
						toArray: vi.fn().mockResolvedValue(docs),
					}),
				}),
			}
			const projCol = createMockCollection({
				find: vi.fn().mockReturnValue(findResult),
			})
			const db = createMockDb({ [`${PREFIX}projection_runs`]: projCol })

			const results = await getRecentProjectionRuns({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				projectionType: "entities",
				limit: 5,
			})

			expect(results).toHaveLength(1)
			expect(results[0].projectionType).toBe("entities")
			// Verify query filter includes agentId AND projectionType
			const [filter] = (projCol.find as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(filter).toEqual({ agentId: "agent-1", projectionType: "entities" })
			// Verify sort by ts descending
			expect(findResult.sort).toHaveBeenCalledWith({ ts: -1 })
		})
	})

	describe("getProjectionLag", () => {
		it("returns seconds since last successful projection of a given type", async () => {
			const pastTs = new Date(Date.now() - 120_000) // 120 seconds ago
			const projCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue({
					runId: "run-ok",
					agentId: "agent-1",
					projectionType: "chunks",
					status: "ok",
					itemsProjected: 10,
					durationMs: 500,
					ts: pastTs,
				}),
			})
			const db = createMockDb({ [`${PREFIX}projection_runs`]: projCol })

			const lag = await getProjectionLag({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				projectionType: "chunks",
			})

			expect(lag).not.toBeNull()
			// Should be approximately 120 seconds (allow some tolerance for test execution time)
			expect(lag!).toBeGreaterThanOrEqual(119)
			expect(lag!).toBeLessThanOrEqual(125)
			// Verify query filter
			const [filter, opts] = (projCol.findOne as ReturnType<typeof vi.fn>).mock
				.calls[0]
			expect(filter).toEqual({
				agentId: "agent-1",
				projectionType: "chunks",
				status: "ok",
			})
			expect(opts).toEqual({ sort: { ts: -1 } })
		})

		it("returns null when no successful run exists", async () => {
			const projCol = createMockCollection({
				findOne: vi.fn().mockResolvedValue(null),
			})
			const db = createMockDb({ [`${PREFIX}projection_runs`]: projCol })

			const lag = await getProjectionLag({
				db,
				prefix: PREFIX,
				agentId: "agent-1",
				projectionType: "episodes",
			})

			expect(lag).toBeNull()
		})
	})

	describe("recordProjectionRun telemetry emission", () => {
		it("emits projection-run telemetry after insertOne", async () => {
			vi.clearAllMocks()
			const projCol = createMockCollection()
			const db = createMockDb({ [`${PREFIX}projection_runs`]: projCol })

			await recordProjectionRun({
				db,
				prefix: PREFIX,
				run: {
					agentId: "agent-1",
					projectionType: "chunks",
					status: "ok",
					itemsProjected: 20,
					durationMs: 3000,
				},
			})

			expect(emitTelemetry).toHaveBeenCalledWith(
				db,
				PREFIX,
				expect.objectContaining({
					meta: { agentId: "agent-1", operation: "projection-run" },
					durationMs: 3000,
					ok: true,
					itemCount: 20,
				}),
			)
		})

		it("does not emit telemetry when insertOne fails", async () => {
			vi.clearAllMocks()
			const projCol = createMockCollection({
				insertOne: vi.fn().mockRejectedValue(new Error("DB error")),
			})
			const db = createMockDb({ [`${PREFIX}projection_runs`]: projCol })

			await expect(
				recordProjectionRun({
					db,
					prefix: PREFIX,
					run: {
						agentId: "agent-1",
						projectionType: "chunks",
						status: "ok",
						itemsProjected: 10,
						durationMs: 100,
					},
				}),
			).rejects.toThrow("DB error")

			expect(emitTelemetry).not.toHaveBeenCalled()
		})
	})
})
