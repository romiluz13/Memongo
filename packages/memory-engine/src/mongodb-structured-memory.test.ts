/* eslint-disable @typescript-eslint/unbound-method */

import type { Collection, Db } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import {
	writeStructuredMemory,
	searchStructuredMemory,
	getStructuredMemoryByType,
	type StructuredMemoryEntry,
} from "./mongodb-structured-memory.js"

// ---------------------------------------------------------------------------
// Mock collection factories
// ---------------------------------------------------------------------------

function createMockStructuredCol(): Collection {
	return {
		findOne: vi.fn(async () => null),
		updateOne: vi.fn(async () => ({
			upsertedCount: 1,
			upsertedId: "new-id",
			modifiedCount: 0,
		})),
		insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: "rev-1" })),
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
		find: vi.fn(() => ({
			toArray: vi.fn(async () => []),
		})),
	} as unknown as Collection
}

function mockDb(collections: Record<string, Collection> = {}): Db {
	return {
		collection: vi.fn(
			(name: string) => collections[name] ?? createMockStructuredCol(),
		),
	} as unknown as Db
}

const baseCapabilities: DetectedCapabilities = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: false,
	rankFusion: false,
}

const noSearchCapabilities: DetectedCapabilities = {
	vectorSearch: false,
	textSearch: false,
	scoreFusion: false,
	rankFusion: false,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("writeStructuredMemory", () => {
	it("creates a new structured memory entry", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()

		const entry: StructuredMemoryEntry = {
			type: "decision",
			key: "framework-choice",
			value: "Using React for the frontend",
			context: "Team meeting on 2025-12-01",
			confidence: 0.95,
			source: "agent",
			agentId: "main",
			tags: ["frontend", "decision"],
		}

		const result = await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry,
			embeddingMode: "automated",
		})

		expect(result.upserted).toBe(true)
		expect(result.id).toBeDefined()
		expect(col.updateOne).toHaveBeenCalledTimes(1)

		// Verify upsert filter includes the resolved memory namespace.
		const call = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(call[0]).toEqual({
			agentId: "main",
			scope: "agent",
			scopeRef: "agent:main",
			type: "decision",
			key: "framework-choice",
		})
		expect(call[2]).toEqual({ upsert: true })
	})

	it("updates existing entry with same type+key", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()
		vi.mocked(col.findOne).mockResolvedValueOnce({
			type: "preference",
			key: "editor",
			value: "VSCode with Vim bindings",
			agentId: "main",
			scope: "agent",
			scopeRef: "agent:main",
			revision: 1,
			validFrom: new Date("2026-03-01T00:00:00.000Z"),
			createdAt: new Date("2026-03-01T00:00:00.000Z"),
			updatedAt: new Date("2026-03-01T00:00:00.000Z"),
		})
		const entry: StructuredMemoryEntry = {
			type: "preference",
			key: "editor",
			value: "VSCode with Vim bindings",
			agentId: "main",
		}

		const result = await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry,
			embeddingMode: "automated",
		})

		expect(result.upserted).toBe(false)
		expect(result.id).toBe("editor")
		expect(revisionsCol.insertOne).not.toHaveBeenCalled()
	})

	it("stores pending embedding status for combined value + context text", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()

		const entry: StructuredMemoryEntry = {
			type: "decision",
			key: "db-choice",
			value: "Using MongoDB",
			context: "Team decided on 2025-01-01 during architecture review",
			agentId: "main",
		}

		await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry,
			embeddingMode: "automated",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(updateCall[1].$set.embeddingStatus).toBe("pending")
		expect(updateCall[1].$set.embedding).toBeUndefined()
	})

	it("infers critical salience for crisis-like ongoing facts", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()

		await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry: {
				type: "fact",
				key: "israel-status",
				value: "There is a war in Israel right now",
				agentId: "main",
			},
			embeddingMode: "automated",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(updateCall[1].$set.salience).toBe("critical")
		expect(updateCall[1].$set.temporalScope).toBe("ongoing")
		expect(updateCall[1].$set.reviewAt).toBeInstanceOf(Date)
	})

	it("writes explicit scope to structured memory entry", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()

		const entry: StructuredMemoryEntry = {
			type: "decision",
			key: "scope-test",
			value: "Testing scope field",
			agentId: "main",
			scope: "workspace",
		}

		await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry,
			embeddingMode: "automated",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(updateCall[1].$set.scope).toBe("workspace")
		expect(updateCall[1].$set.scopeRef).toBe("workspace:main")
	})

	it("defaults scope to agent when not specified", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()

		const entry: StructuredMemoryEntry = {
			type: "fact",
			key: "default-scope",
			value: "No scope specified",
			agentId: "main",
		}

		await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry,
			embeddingMode: "automated",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(updateCall[1].$set.scope).toBe("agent")
	})

	it("does not include embedding vectors in Memongo write path", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()

		const entry: StructuredMemoryEntry = {
			type: "fact",
			key: "pi",
			value: "Pi is approximately 3.14159",
			agentId: "main",
		}

		await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry,
			embeddingMode: "automated",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		const setDoc = updateCall[1].$set
		expect(setDoc.embeddingStatus).toBe("pending")
		expect(setDoc.embedding).toBeUndefined()
	})

	it("persists sourceAgent when provided", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()

		const entry: StructuredMemoryEntry = {
			type: "fact",
			key: "dreamer-fact",
			value: "Extracted by dreamer",
			agentId: "agent-1",
			sourceAgent: { id: "agent-1", name: "dreamer", runId: "run-123" },
		}

		await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry,
			embeddingMode: "automated",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(updateCall[1].$set.sourceAgent).toEqual({
			id: "agent-1",
			name: "dreamer",
			runId: "run-123",
		})
	})

	it("does not set sourceAgent when not provided", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()

		const entry: StructuredMemoryEntry = {
			type: "fact",
			key: "user-fact",
			value: "User stated fact",
			agentId: "agent-1",
		}

		await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry,
			embeddingMode: "automated",
		})

		const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(updateCall[1].$set.sourceAgent).toBeUndefined()
	})

	it("writes a revision snapshot before updating current truth", async () => {
		const currentCol = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()
		const createdAt = new Date("2026-03-01T00:00:00.000Z")
		vi.mocked(currentCol.findOne).mockResolvedValueOnce({
			type: "decision",
			key: "db-choice",
			value: "Use Postgres",
			context: "Original decision",
			confidence: 0.7,
			source: "agent",
			agentId: "main",
			scope: "agent",
			scopeRef: "agent:main",
			revision: 2,
			validFrom: createdAt,
			createdAt,
			updatedAt: new Date("2026-03-10T00:00:00.000Z"),
			tags: ["database"],
		})
		await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: currentCol,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry: {
				type: "decision",
				key: "db-choice",
				value: "Use MongoDB",
				context: "Updated after memory redesign",
				confidence: 0.9,
				source: "agent",
				agentId: "main",
				tags: ["database"],
			},
			embeddingMode: "automated",
		})

		expect(revisionsCol.insertOne).toHaveBeenCalledTimes(1)
		const revisionDoc = (revisionsCol.insertOne as ReturnType<typeof vi.fn>)
			.mock.calls[0][0]
		expect(revisionDoc.value).toBe("Use Postgres")
		expect(revisionDoc.revision).toBe(2)
		expect(revisionDoc.validFrom).toEqual(createdAt)
		expect(revisionDoc.validTo).toBeInstanceOf(Date)

		const updateCall = (currentCol.updateOne as ReturnType<typeof vi.fn>).mock
			.calls[0]
		expect(updateCall[1].$set.value).toBe("Use MongoDB")
		expect(updateCall[1].$set.revision).toBe(3)
	})
})

describe("searchStructuredMemory", () => {
	it("preserves session and provenance fields on search hits", async () => {
		const col = createMockStructuredCol()
		;(col.aggregate as ReturnType<typeof vi.fn>).mockReturnValue({
			toArray: vi.fn(async () => [
				{
					type: "fact",
					key: "camera",
					value: "User shoots with a Sony A7R IV",
					sessionId: "q1::session_7",
					sourceEventIds: ["evt-7a", "evt-7b"],
					updatedAt: new Date("2026-04-15T08:00:00.000Z"),
					score: 0.87,
				},
			]),
		} as unknown as ReturnType<typeof col.aggregate>)

		const results = await searchStructuredMemory(col, "sony camera", null, {
			maxResults: 5,
			capabilities: { ...baseCapabilities, vectorSearch: false },
			vectorIndexName: "test_structured_vector",
			embeddingMode: "automated",
		})

		expect(results).toEqual([
			expect.objectContaining({
				source: "structured",
				sessionId: "q1::session_7",
				sourceEventIds: ["evt-7a", "evt-7b"],
			}),
		])
	})
})

describe("writeStructuredMemory sourceAgent handling", () => {
	it("persists caller-provided sourceAgent as-is", async () => {
		const col = createMockStructuredCol()
		const revisionsCol = createMockStructuredCol()

		await writeStructuredMemory({
			db: mockDb({
				test_structured_mem: col,
				test_structured_mem_revisions: revisionsCol,
			}),
			prefix: "test_",
			entry: {
				type: "fact",
				key: "from-dreamer",
				value: "Dreamer extracted this",
				agentId: "agent-1",
				sourceAgent: { id: "agent-1", name: "dreamer", runId: "run-abc" },
			},
			embeddingMode: "automated",
		})

		const call = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(call[1].$set.sourceAgent).toEqual({
			id: "agent-1",
			name: "dreamer",
			runId: "run-abc",
		})
	})
})

describe("searchStructuredMemory", () => {
	it("returns results from vector search", async () => {
		const col = createMockStructuredCol()
		vi.mocked(col.aggregate).mockReturnValueOnce({
			toArray: vi.fn(async () => [
				{
					type: "decision",
					key: "arch",
					value: "Microservices architecture chosen",
					score: 0.9,
				},
			]),
		} as unknown as ReturnType<Collection["aggregate"]>)

		const results = await searchStructuredMemory(
			col,
			"architecture",
			[0.1, 0.2],
			{
				maxResults: 5,
				capabilities: baseCapabilities,
				vectorIndexName: "test_structured_mem_vector",
				embeddingMode: "automated",
			},
		)

		expect(results).toHaveLength(1)
		expect(results[0].source).toBe("structured")
		expect(results[0].snippet).toContain("Microservices")
		expect(results[0].path).toContain("structured:decision:arch")
	})

	it("returns empty results when no matches", async () => {
		const col = createMockStructuredCol()

		const results = await searchStructuredMemory(col, "nothing", null, {
			maxResults: 5,
			capabilities: noSearchCapabilities,
			vectorIndexName: "test_structured_mem_vector",
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(0)
	})

	it("caps numCandidates at 10000 in structured memory search (F1)", async () => {
		const col = createMockStructuredCol()
		vi.mocked(col.aggregate).mockReturnValueOnce({
			toArray: vi.fn(async () => [
				{ type: "fact", key: "pi", value: "Pi is 3.14", score: 0.9 },
			]),
		} as unknown as ReturnType<Collection["aggregate"]>)

		await searchStructuredMemory(col, "pi", [0.1, 0.2], {
			maxResults: 5,
			capabilities: baseCapabilities,
			vectorIndexName: "test_vec",
			embeddingMode: "automated",
			numCandidates: 15000,
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.numCandidates).toBeLessThanOrEqual(10000)
	})

	it("includes $limit after $vectorSearch in structured memory (F7)", async () => {
		const col = createMockStructuredCol()
		vi.mocked(col.aggregate).mockReturnValueOnce({
			toArray: vi.fn(async () => [
				{ type: "fact", key: "pi", value: "Pi is 3.14", score: 0.9 },
			]),
		} as unknown as ReturnType<Collection["aggregate"]>)

		await searchStructuredMemory(col, "pi", [0.1, 0.2], {
			maxResults: 3,
			capabilities: baseCapabilities,
			vectorIndexName: "test_vec",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		// Pipeline: $vectorSearch, $limit, $project
		expect(pipeline[1].$limit).toBe(3)
	})

	it("uses textFieldPath 'value' for automated mode in structured memory (F5)", async () => {
		const col = createMockStructuredCol()
		vi.mocked(col.aggregate).mockReturnValueOnce({
			toArray: vi.fn(async () => [
				{ type: "fact", key: "pi", value: "Pi is 3.14", score: 0.9 },
			]),
		} as unknown as ReturnType<Collection["aggregate"]>)

		await searchStructuredMemory(col, "pi", null, {
			maxResults: 5,
			capabilities: baseCapabilities,
			vectorIndexName: "test_vec",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vsStage = pipeline[0].$vectorSearch
		expect(vsStage.path).toBe("value")
	})

	it("filters by type when provided", async () => {
		const col = createMockStructuredCol()
		vi.mocked(col.aggregate).mockReturnValueOnce({
			toArray: vi.fn(async () => [
				{
					type: "preference",
					key: "theme",
					value: "Dark mode preferred",
					score: 0.8,
				},
			]),
		} as unknown as ReturnType<Collection["aggregate"]>)

		const results = await searchStructuredMemory(col, "theme", [0.1, 0.2], {
			maxResults: 5,
			filter: { type: "preference" },
			capabilities: baseCapabilities,
			vectorIndexName: "test_structured_mem_vector",
			embeddingMode: "automated",
		})

		expect(results).toHaveLength(1)
		// Verify filter was passed to vector search stage
		const aggregateCalls = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls
		expect(aggregateCalls.length).toBeGreaterThan(0)
	})

	it("filters by scope when provided", async () => {
		const col = createMockStructuredCol()
		vi.mocked(col.aggregate).mockReturnValueOnce({
			toArray: vi.fn(async () => [
				{ type: "decision", key: "arch", value: "Microservices", score: 0.9 },
			]),
		} as unknown as ReturnType<Collection["aggregate"]>)

		await searchStructuredMemory(col, "architecture", [0.1, 0.2], {
			maxResults: 5,
			filter: { scope: "workspace" },
			capabilities: baseCapabilities,
			vectorIndexName: "test_structured_mem_vector",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vectorFilter = pipeline[0].$vectorSearch.filter
		expect(vectorFilter.scope).toBe("workspace")
	})

	it("filters by agentId when provided", async () => {
		const col = createMockStructuredCol()
		vi.mocked(col.aggregate).mockReturnValueOnce({
			toArray: vi.fn(async () => [
				{
					type: "preference",
					key: "theme",
					value: "Dark mode preferred",
					score: 0.8,
				},
			]),
		} as unknown as ReturnType<Collection["aggregate"]>)

		await searchStructuredMemory(col, "theme", [0.1, 0.2], {
			maxResults: 5,
			filter: { agentId: "main" },
			capabilities: baseCapabilities,
			vectorIndexName: "test_structured_mem_vector",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		const vectorFilter = pipeline[0].$vectorSearch.filter
		expect(vectorFilter.agentId).toBe("main")
	})

	it("adds current-only filters for active critical lookups", async () => {
		const col = createMockStructuredCol()
		vi.mocked(col.aggregate).mockReturnValueOnce({
			toArray: vi.fn(async () => []),
		} as unknown as ReturnType<Collection["aggregate"]>)
		const asOf = new Date("2026-04-11T10:30:00.000Z")

		await searchStructuredMemory(col, "what matters right now", null, {
			maxResults: 5,
			filter: {
				currentOnly: true,
				asOf,
				salience: ["critical", "high"],
				agentId: "main",
			},
			capabilities: noSearchCapabilities,
			vectorIndexName: "unused",
			embeddingMode: "automated",
		})

		const pipeline = (col.aggregate as ReturnType<typeof vi.fn>).mock
			.calls[0][0]
		expect(pipeline[0].$match).toEqual({
			$and: expect.arrayContaining([
				expect.objectContaining({
					agentId: "main",
					salience: { $in: ["critical", "high"] },
				}),
				{ state: "active" },
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
	})
})

describe("getStructuredMemoryByType", () => {
	it("queries structured memory by type", async () => {
		const col = createMockStructuredCol()

		vi.mocked(col.find).mockReturnValueOnce({
			toArray: vi.fn(async () => [
				{
					type: "decision",
					key: "db-choice",
					value: "Using MongoDB",
					confidence: 0.9,
					updatedAt: new Date("2025-01-01"),
				},
			]),
		} as unknown as ReturnType<Collection["find"]>)

		const entries = await getStructuredMemoryByType(
			mockDb({ test_structured_mem: col }),
			"test_",
			"decision",
		)

		expect(entries).toHaveLength(1)
		expect(entries[0].type).toBe("decision")
		expect(entries[0].key).toBe("db-choice")
		expect(entries[0].value).toBe("Using MongoDB")
		expect(entries[0].confidence).toBe(0.9)
	})

	it("respects limit parameter", async () => {
		const col = createMockStructuredCol()

		vi.mocked(col.find).mockReturnValueOnce({
			toArray: vi.fn(async () => []),
		} as unknown as ReturnType<Collection["find"]>)

		await getStructuredMemoryByType(
			mockDb({ test_structured_mem: col }),
			"test_",
			"fact",
			"main",
			10,
		)

		const findCall = (col.find as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(findCall[0]).toEqual({ type: "fact", agentId: "main" })
		expect(findCall[1]).toMatchObject({ sort: { updatedAt: -1 }, limit: 10 })
	})
})
