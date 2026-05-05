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
}

describe("mongodb-procedures", () => {
	it("creates a procedure entry with derived search text", async () => {
		const col = createMockProcedureCol()
		const revisions = createMockProcedureCol()
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
