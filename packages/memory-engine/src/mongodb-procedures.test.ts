/* eslint-disable @typescript-eslint/unbound-method */

import type { Collection, Db } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import {
	findExactProcedureMatches,
	searchProcedures,
	writeProcedure,
	type ProcedureEntry,
} from "./mongodb-procedures.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"

function createMockProcedureCol(): Collection {
	return {
		findOne: vi.fn(async () => null),
		find: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
		updateOne: vi.fn(async () => ({
			upsertedCount: 1,
			upsertedId: "proc-1",
			modifiedCount: 0,
		})),
		insertOne: vi.fn(async () => ({
			acknowledged: true,
			insertedId: "proc-rev-1",
		})),
		deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
	} as unknown as Collection
}

function mockDb(collections: Record<string, Collection> = {}): Db {
	return {
		collection: vi.fn(
			(name: string) => collections[name] ?? createMockProcedureCol(),
		),
	} as unknown as Db
}

const baseCapabilities: DetectedCapabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: false,
	storedSource: false,
	vectorIndexMethod: false,
}

describe("mongodb-procedures", () => {
	it("uses majority write concern for transactional procedure writes", async () => {
		const col = createMockProcedureCol()
		const revisions = createMockProcedureCol()
		const withTransaction = vi.fn(async (fn: () => Promise<void>) => fn())
		const session = { withTransaction, endSession: vi.fn(async () => {}) }
		const client = { startSession: vi.fn(() => session) }

		await writeProcedure({
			db: mockDb({
				test_procedures: col,
				test_procedure_revisions: revisions,
			}),
			prefix: "test_",
			entry: {
				procedureId: "durable-procedure",
				name: "Durable procedure",
				intentTags: ["durability"],
				triggerQueries: ["how to persist atomically"],
				steps: ["Use a transaction"],
				successSignals: ["Majority acknowledged"],
				agentId: "main",
			},
			embeddingMode: "automated",
			client: client as unknown as import("mongodb").MongoClient,
		})

		expect(withTransaction).toHaveBeenCalledWith(expect.any(Function), {
			writeConcern: { w: "majority", wtimeout: 1000 },
		})
	})

	it("propagates transaction failures without replaying a procedure write", async () => {
		const col = createMockProcedureCol()
		const error = Object.assign(new Error("transaction exceeded cache"), {
			code: 225,
		})
		const session = {
			withTransaction: vi.fn(async () => {
				throw error
			}),
			endSession: vi.fn(async () => {}),
		}
		const client = { startSession: vi.fn(() => session) }

		await expect(
			writeProcedure({
				db: mockDb({
					test_procedures: col,
					test_procedure_revisions: createMockProcedureCol(),
				}),
				prefix: "test_",
				entry: {
					procedureId: "atomic-failure",
					name: "Atomic failure",
					intentTags: ["atomic"],
					triggerQueries: ["fail transaction"],
					steps: ["Do not replay"],
					successSignals: ["Error propagates"],
					agentId: "main",
				},
				embeddingMode: "automated",
				client: client as unknown as import("mongodb").MongoClient,
			}),
		).rejects.toBe(error)
		expect(col.updateOne).not.toHaveBeenCalled()
	})

	it("creates a procedure entry with derived search text", async () => {
		const col = createMockProcedureCol()
		const revisions = createMockProcedureCol()
		const queryCache = createMockProcedureCol()
		const entry: ProcedureEntry = {
			procedureId: "rotate-auth",
			name: "Rotate auth keys",
			intentTags: ["auth", "runbook"],
			triggerQueries: ["how do we rotate auth keys"],
			steps: ["Pause issuance", "Rotate keys", "Validate clients"],
			successSignals: ["All clients reconnect"],
			agentId: "main",
		}

		await writeProcedure({
			db: mockDb({
				test_procedures: col,
				test_procedure_revisions: revisions,
				test_query_cache: queryCache,
			}),
			prefix: "test_",
			entry,
			embeddingMode: "automated",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(updateCall[0]).toEqual({
			procedureId: "rotate-auth",
			agentId: "main",
			scope: "agent",
			scopeRef: "agent:main",
		})
		expect(updateCall[1].$set.searchText).toContain("Rotate auth keys")
		expect(updateCall[1].$set.searchText).toContain("Validate clients")
		expect(queryCache.deleteMany).toHaveBeenCalledWith({
			agentId: "main",
			scope: "agent",
			scopeRef: "agent:main",
		})
	})

	it("does not replay a procedure side effect for the same source event", async () => {
		const col = createMockProcedureCol()
		const revisions = createMockProcedureCol()
		const queryCache = createMockProcedureCol()
		vi.mocked(col.findOne).mockResolvedValueOnce({
			procedureId: "event-receipt",
			name: "Recover extraction jobs",
			steps: ["Claim the job", "Fence the lease"],
			agentId: "main",
			scope: "agent",
			scopeRef: "agent:main",
			revision: 2,
			sourceEventIds: ["evt-replayed"],
			createdAt: new Date("2026-03-01T00:00:00.000Z"),
			updatedAt: new Date("2026-03-02T00:00:00.000Z"),
		})

		const result = await writeProcedure({
			db: mockDb({
				test_procedures: col,
				test_procedure_revisions: revisions,
				test_query_cache: queryCache,
			}),
			prefix: "test_",
			entry: {
				procedureId: "event-receipt",
				name: "Recover extraction jobs",
				steps: ["Claim the job", "Fence the lease"],
				agentId: "main",
				sourceEventIds: ["evt-replayed"],
			},
			embeddingMode: "automated",
			eventReceiptIds: ["evt-replayed"],
		})

		expect(result).toEqual({ upserted: false, id: "event-receipt" })
		expect(col.updateOne).not.toHaveBeenCalled()
		expect(revisions.insertOne).not.toHaveBeenCalled()
		expect(queryCache.deleteMany).not.toHaveBeenCalled()
	})

	it("accumulates source-event evidence when a new event confirms a procedure", async () => {
		const col = createMockProcedureCol()
		const revisions = createMockProcedureCol()
		vi.mocked(col.findOne).mockResolvedValueOnce({
			procedureId: "evidence-ledger",
			name: "Recover extraction jobs",
			steps: ["Claim", "Fence"],
			agentId: "main",
			scope: "agent",
			scopeRef: "agent:main",
			revision: 1,
			sourceEventIds: ["evt-first"],
			createdAt: new Date("2026-03-01T00:00:00.000Z"),
			updatedAt: new Date("2026-03-01T00:00:00.000Z"),
		})

		await writeProcedure({
			db: mockDb({
				test_procedures: col,
				test_procedure_revisions: revisions,
			}),
			prefix: "test_",
			entry: {
				procedureId: "evidence-ledger",
				name: "Recover extraction jobs",
				steps: ["Claim", "Fence"],
				agentId: "main",
				sourceEventIds: ["evt-second"],
			},
			embeddingMode: "automated",
		})

		const update = vi.mocked(col.updateOne).mock.calls[0]?.[1]
		expect(update?.$set.sourceEventIds).toEqual(["evt-first", "evt-second"])
	})

	it("searches procedures and returns procedure locators", async () => {
		const col = createMockProcedureCol()
		;(col.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => [
				{
					procedureId: "rotate-auth",
					searchText: "Rotate auth keys",
					sessionId: "q1::session_9",
					sourceEventIds: ["evt-proc-1"],
					score: 0.92,
				},
			]),
		} as unknown as ReturnType<typeof col.aggregate>)
		const asOf = new Date("2026-04-11T10:30:00.000Z")

		const results = await searchProcedures(col, "rotate auth", null, {
			maxResults: 5,
			filter: {
				agentId: "main",
				state: "active",
				currentOnly: true,
				asOf,
			},
			capabilities: { ...baseCapabilities, vectorSearch: false },
			vectorIndexName: "test_procedures_vector",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$match).toEqual({
			$text: { $search: "rotate auth" },
			$and: expect.arrayContaining([
				expect.objectContaining({
					agentId: "main",
					state: "active",
				}),
				{
					$or: [
						{ validFrom: { $exists: false } },
						{ validFrom: { $lte: asOf } },
					],
				},
				{
					$or: [{ validTo: { $exists: false } }, { validTo: { $gt: asOf } }],
				},
			]),
		})
		expect(results).toEqual([
			expect.objectContaining({
				path: "procedure:rotate-auth",
				source: "structured",
				sessionId: "q1::session_9",
				sourceEventIds: ["evt-proc-1"],
			}),
		])
	})

	it("finds exact procedure aliases before broad search", async () => {
		const col = createMockProcedureCol()
		;(col.find as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => [
				{
					procedureId: "incident-response",
					searchText: "incident response\nCheck status page",
					sessionId: "q1::session_4",
					updatedAt: new Date("2026-04-06T14:00:00Z"),
					state: "active",
					scope: "agent",
					scopeRef: "agent:main",
					sourceEventIds: ["evt-proc-alias"],
				},
			]),
		} as unknown as ReturnType<typeof col.find>)
		const asOf = new Date("2026-04-11T10:30:00.000Z")

		const results = await findExactProcedureMatches(col, "incident response", {
			maxResults: 3,
			filter: {
				agentId: "main",
				state: "active",
				currentOnly: true,
				asOf,
			},
		})

		expect(col.find).toHaveBeenCalledWith(
			{
				$and: expect.arrayContaining([
					expect.objectContaining({
						agentId: "main",
						state: "active",
					}),
					{
						$or: [
							{ validFrom: { $exists: false } },
							{ validFrom: { $lte: asOf } },
						],
					},
					{
						$or: [{ validTo: { $exists: false } }, { validTo: { $gt: asOf } }],
					},
					{
						$or: [
							{ name: /^incident response$/i },
							{ triggerQueries: /^incident response$/i },
						],
					},
				]),
			},
			expect.objectContaining({
				limit: 3,
				sort: { updatedAt: -1 },
			}),
		)
		expect(results).toEqual([
			expect.objectContaining({
				path: "procedure:incident-response",
				score: 1,
				sessionId: "q1::session_4",
				sourceEventIds: ["evt-proc-alias"],
			}),
		])
	})
})
