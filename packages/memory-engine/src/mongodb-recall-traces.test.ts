import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ClientSession, Collection, Db } from "mongodb"

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

	it("RET-21: stores no query fields at all in none mode", async () => {
		const { recordRecallTrace } = await import("./mongodb-recall-traces.js")
		const insertOne = vi.fn(async (_doc: unknown) => ({
			insertedId: "trace-1",
		}))
		const db = mockDb({
			test_recall_traces: mockCollection({ insertOne }),
		})

		await recordRecallTrace({
			db,
			prefix: "test_",
			privacyMode: "none",
			trace: {
				agentId: "agent-1",
				query: "סוד ההשקה של המערכת",
				lanesUsed: ["hybrid"],
				totalHits: 3,
			},
		})

		const doc = insertOne.mock.calls[0]?.[0] as Record<string, unknown>
		expect(doc).not.toHaveProperty("query")
		expect(doc).not.toHaveProperty("queryHash")
		expect(doc).not.toMatchObject({ query: expect.anything() })
	})

	it("RET-21: stores redacted text plus hash in redacted-hash mode", async () => {
		const { recordRecallTrace } = await import("./mongodb-recall-traces.js")
		const insertOne = vi.fn(async (_doc: unknown) => ({
			insertedId: "trace-1",
		}))
		const db = mockDb({
			test_recall_traces: mockCollection({ insertOne }),
		})

		await recordRecallTrace({
			db,
			prefix: "test_",
			privacyMode: "redacted-hash",
			trace: {
				agentId: "agent-1",
				query: "סוד ההשקה של המערכת",
				scope: "user",
				scopeRef: "user:u1",
				lanesUsed: ["hybrid"],
				totalHits: 3,
			},
		})

		const doc = insertOne.mock.calls[0]?.[0] as Record<string, unknown>
		// Hebrew redacted (the audit's ASCII-only leak), shape preserved.
		expect(doc.query).toBe("xxx xxxxx xx xxxxxx")
		expect(doc.queryHash).toMatch(/^[a-f0-9]{64}$/)
		// Scope retention fields ride along on every trace.
		expect(doc.scope).toBe("user")
		expect(doc.scopeRef).toBe("user:u1")
	})

	it("RET-21: stores the verbatim query plus hash in raw mode", async () => {
		const { recordRecallTrace } = await import("./mongodb-recall-traces.js")
		const insertOne = vi.fn(async (_doc: unknown) => ({
			insertedId: "trace-1",
		}))
		const db = mockDb({
			test_recall_traces: mockCollection({ insertOne }),
		})

		await recordRecallTrace({
			db,
			prefix: "test_",
			privacyMode: "raw",
			trace: {
				agentId: "agent-1",
				query: "secret build 123",
				lanesUsed: ["hybrid"],
				totalHits: 0,
			},
		})

		const doc = insertOne.mock.calls[0]?.[0] as Record<string, unknown>
		expect(doc.query).toBe("secret build 123")
		expect(doc.queryHash).toMatch(/^[a-f0-9]{64}$/)
	})
})

vi.mock("./mongodb-write-fence.js", () => ({
	captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
		kind: "admission",
		agentId,
		epoch: 0,
	})),
	withFencedWrite: vi.fn(
		async ({ fn }: { fn: (session: ClientSession) => Promise<unknown> }) =>
			fn({} as ClientSession),
	),
	ErasureGateConflictError: class extends Error {
		readonly code = "ERASURE_GATE_CONFLICT"
	},
}))
