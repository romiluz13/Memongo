import type { Collection, Db } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import {
	evolveProcedure,
	recordProcedureOutcome,
} from "./mongodb-procedures.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockCollection(
	overrides: Partial<{
		findOne: ReturnType<typeof vi.fn>
		findOneAndUpdate: ReturnType<typeof vi.fn>
		insertOne: ReturnType<typeof vi.fn>
		updateOne: ReturnType<typeof vi.fn>
	}> = {},
): Collection {
	return {
		findOne: overrides.findOne ?? vi.fn(async () => null),
		findOneAndUpdate: overrides.findOneAndUpdate ?? vi.fn(async () => null),
		insertOne:
			overrides.insertOne ??
			vi.fn(async () => ({
				acknowledged: true,
				insertedId: "mutation-1",
			})),
		updateOne:
			overrides.updateOne ??
			vi.fn(async () => ({
				acknowledged: true,
				modifiedCount: 1,
				matchedCount: 1,
				upsertedCount: 0,
				upsertedId: null,
			})),
	} as unknown as Collection
}

function mockDb(collections: Record<string, Collection> = {}): Db {
	return {
		collection: vi.fn(
			(name: string) => collections[name] ?? createMockCollection(),
		),
	} as unknown as Db
}

// ---------------------------------------------------------------------------
// recordProcedureOutcome tests
// ---------------------------------------------------------------------------

describe("recordProcedureOutcome", () => {
	it("increments successCount on success", async () => {
		const existingDoc = {
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			successCount: 2,
			failCount: 1,
		}
		const col = createMockCollection({
			findOneAndUpdate: vi.fn(async () => existingDoc),
		})
		const db = mockDb({ test_procedures: col })

		const result = await recordProcedureOutcome({
			db,
			prefix: "test_",
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			success: true,
		})

		expect(result).toBe(true)
		const updateCall = (col.findOneAndUpdate as ReturnType<typeof vi.fn>).mock
			.calls[0]
		// Filter should match procedure identity
		expect(updateCall[0]).toEqual({
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
		})
		// Should use $inc for successCount
		expect(updateCall[1].$inc).toEqual({ successCount: 1 })
		// Should set lastSuccessAt
		expect(updateCall[1].$set.lastSuccessAt).toBeInstanceOf(Date)
		// Should NOT set lastFailureAt
		expect(updateCall[1].$set.lastFailureAt).toBeUndefined()
	})

	it("increments failCount on failure", async () => {
		const existingDoc = {
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			successCount: 2,
			failCount: 1,
		}
		const col = createMockCollection({
			findOneAndUpdate: vi.fn(async () => existingDoc),
		})
		const db = mockDb({ test_procedures: col })

		await recordProcedureOutcome({
			db,
			prefix: "test_",
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			success: false,
		})

		const updateCall = (col.findOneAndUpdate as ReturnType<typeof vi.fn>).mock
			.calls[0]
		expect(updateCall[1].$inc).toEqual({ failCount: 1 })
		expect(updateCall[1].$set.lastFailureAt).toBeInstanceOf(Date)
		expect(updateCall[1].$set.lastSuccessAt).toBeUndefined()
	})

	it("sets lastSuccessAt/lastFailureAt timestamps", async () => {
		const existingDoc = {
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			successCount: 0,
			failCount: 0,
		}
		const col = createMockCollection({
			findOneAndUpdate: vi.fn(async () => existingDoc),
		})
		const db = mockDb({ test_procedures: col })

		const beforeCall = new Date()
		await recordProcedureOutcome({
			db,
			prefix: "test_",
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			success: true,
		})
		const afterCall = new Date()

		const updateCall = (col.findOneAndUpdate as ReturnType<typeof vi.fn>).mock
			.calls[0]
		const ts = updateCall[1].$set.lastSuccessAt as Date
		expect(ts.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime())
		expect(ts.getTime()).toBeLessThanOrEqual(afterCall.getTime())
	})

	it("returns false when procedure not found (matchedCount=0)", async () => {
		const col = createMockCollection({
			findOneAndUpdate: vi.fn(async () => null),
		})
		const db = mockDb({ test_procedures: col })

		const result = await recordProcedureOutcome({
			db,
			prefix: "test_",
			procedureId: "nonexistent",
			agentId: "agent-1",
			scope: "agent",
			success: true,
		})

		expect(result).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// evolveProcedure tests
// ---------------------------------------------------------------------------

describe("evolveProcedure", () => {
	it("increments version", async () => {
		const existingDoc = {
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			version: 3,
			steps: ["old step"],
			evolutionHistory: [],
		}
		const col = createMockCollection({
			findOne: vi.fn(async () => existingDoc),
			updateOne: vi.fn(async () => ({
				acknowledged: true,
				modifiedCount: 1,
				matchedCount: 1,
				upsertedCount: 0,
				upsertedId: null,
			})),
		})
		const db = mockDb({ test_procedures: col })

		const result = await evolveProcedure({
			db,
			prefix: "test_",
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			newSteps: ["new step 1", "new step 2"],
			changeType: "refinement",
			changeDescription: "Improved step clarity",
		})

		expect(result.newVersion).toBe(4)
		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(updateCall[1].$inc).toEqual({ version: 1 })
	})

	it("updates steps", async () => {
		const existingDoc = {
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			version: 1,
			steps: ["old step"],
			evolutionHistory: [],
		}
		const col = createMockCollection({
			findOne: vi.fn(async () => existingDoc),
			updateOne: vi.fn(async () => ({
				acknowledged: true,
				modifiedCount: 1,
				matchedCount: 1,
				upsertedCount: 0,
				upsertedId: null,
			})),
		})
		const db = mockDb({ test_procedures: col })

		await evolveProcedure({
			db,
			prefix: "test_",
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			newSteps: ["new step 1", "new step 2"],
			changeType: "refinement",
			changeDescription: "Improved step clarity",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(updateCall[1].$set.steps).toEqual(["new step 1", "new step 2"])
		expect(updateCall[1].$set.updatedAt).toBeInstanceOf(Date)
	})

	it("appends to evolutionHistory", async () => {
		const existingDoc = {
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			version: 2,
			steps: ["old step"],
			evolutionHistory: [
				{
					version: 1,
					changeType: "initial",
					changeDescription: "First version",
					timestamp: new Date(),
				},
			],
		}
		const col = createMockCollection({
			findOne: vi.fn(async () => existingDoc),
			updateOne: vi.fn(async () => ({
				acknowledged: true,
				modifiedCount: 1,
				matchedCount: 1,
				upsertedCount: 0,
				upsertedId: null,
			})),
		})
		const db = mockDb({ test_procedures: col })

		await evolveProcedure({
			db,
			prefix: "test_",
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			newSteps: ["step a", "step b"],
			changeType: "overhaul",
			changeDescription: "Complete rewrite",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		const pushOp = updateCall[1].$push
		expect(pushOp.evolutionHistory.$each).toHaveLength(1)
		expect(pushOp.evolutionHistory.$each[0].version).toBe(2)
		expect(pushOp.evolutionHistory.$each[0].changeType).toBe("overhaul")
		expect(pushOp.evolutionHistory.$each[0].changeDescription).toBe(
			"Complete rewrite",
		)
		expect(pushOp.evolutionHistory.$each[0].timestamp).toBeInstanceOf(Date)
	})

	it("caps evolutionHistory at 20 via $slice", async () => {
		const existingDoc = {
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			version: 5,
			steps: ["old step"],
			evolutionHistory: [],
		}
		const col = createMockCollection({
			findOne: vi.fn(async () => existingDoc),
			updateOne: vi.fn(async () => ({
				acknowledged: true,
				modifiedCount: 1,
				matchedCount: 1,
				upsertedCount: 0,
				upsertedId: null,
			})),
		})
		const db = mockDb({ test_procedures: col })

		await evolveProcedure({
			db,
			prefix: "test_",
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			newSteps: ["new step"],
			changeType: "tweak",
			changeDescription: "Minor fix",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		const pushOp = updateCall[1].$push
		expect(pushOp.evolutionHistory.$slice).toBe(-20)
	})

	it("throws when procedure not found", async () => {
		const col = createMockCollection({
			findOne: vi.fn(async () => null),
		})
		const db = mockDb({ test_procedures: col })

		await expect(
			evolveProcedure({
				db,
				prefix: "test_",
				procedureId: "nonexistent",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				newSteps: ["step"],
				changeType: "fix",
				changeDescription: "Fix",
			}),
		).rejects.toThrow("Procedure not found")
	})

	it("defaults version to 1 when existing doc has no version field", async () => {
		const existingDoc = {
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			steps: ["old step"],
			// no version field
		}
		const col = createMockCollection({
			findOne: vi.fn(async () => existingDoc),
			updateOne: vi.fn(async () => ({
				acknowledged: true,
				modifiedCount: 1,
				matchedCount: 1,
				upsertedCount: 0,
				upsertedId: null,
			})),
		})
		const db = mockDb({ test_procedures: col })

		const result = await evolveProcedure({
			db,
			prefix: "test_",
			procedureId: "proc-1",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			newSteps: ["new step"],
			changeType: "fix",
			changeDescription: "Fix",
		})

		// Should treat missing version as 1, so new version is 2
		expect(result.newVersion).toBe(2)
		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		// The evolution history entry records the *current* version before increment
		const pushOp = updateCall[1].$push
		expect(pushOp.evolutionHistory.$each[0].version).toBe(1)
	})
})

// ---------------------------------------------------------------------------
// Schema defaults for new procedures
// ---------------------------------------------------------------------------

describe("new procedure defaults", () => {
	it("new procedures get version: 1, successCount: 0, failCount: 0 via $setOnInsert", async () => {
		// This test verifies the schema contract: when recordProcedureOutcome is called
		// on a non-existent procedure, it should NOT upsert (returns false).
		// The initial defaults (version: 1, successCount: 0, failCount: 0) are set
		// by writeProcedure which uses $setOnInsert.
		// We verify that writeProcedure sets the correct initial evolution fields.
		const { writeProcedure } = await import("./mongodb-procedures.js")
		const col = createMockCollection({
			findOne: vi.fn(async () => null), // new procedure
			updateOne: vi.fn(async () => ({
				acknowledged: true,
				modifiedCount: 0,
				matchedCount: 0,
				upsertedCount: 1,
				upsertedId: "new-id",
			})),
		})
		const revisions = createMockCollection()
		const db = mockDb({
			test_procedures: col,
			test_procedure_revisions: revisions,
		})

		await writeProcedure({
			db,
			prefix: "test_",
			entry: {
				procedureId: "proc-new",
				name: "New procedure",
				steps: ["step 1"],
				agentId: "agent-1",
			},
			embeddingMode: "automated",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		// $setOnInsert should include evolution defaults
		const setOnInsert = updateCall[1].$setOnInsert
		expect(setOnInsert.version).toBe(1)
		expect(setOnInsert.successCount).toBe(0)
		expect(setOnInsert.failCount).toBe(0)
		expect(setOnInsert.evolutionHistory).toEqual([])
	})
})
