import { beforeEach, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	buildMockManager,
	captureManagerPrototype,
	fakeDb,
	fakePrefix,
} from "./test-helpers/manager-test-kit.js"
import { recordEmbeddingSpend } from "./mongodb-cost-ledger.js"
import {
	projectEventChunk,
	projectEventChunksBatch,
	writeEvent,
} from "./mongodb-events.js"
import { captureAdmissionToken } from "./mongodb-write-fence.js"

vi.mock("./mongodb-write-fence.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).writeFenceModuleMock(),
)
vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)
vi.mock("./mongodb-schema.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-schema.js")>()),
	eventsCollection: () => ({
		bsonOptions: {},
		find: () => ({ toArray: async () => [] }),
		insertMany: async () => ({ acknowledged: true, insertedCount: 1 }),
	}),
}))
vi.mock("./mongodb-cost-ledger.js", () => ({
	recordEmbeddingSpend: vi.fn(async () => {}),
}))
captureManagerPrototype(MongoDBMemoryManager)
beforeEach(() => vi.clearAllMocks())
it.each([
	false,
	true,
])("threads the original indexing admission through batch=%s and preserves receipts", async (batch) => {
	const admission = {
		kind: "admission" as const,
		agentId: "agent-1",
		epoch: 12,
	}
	vi.mocked(captureAdmissionToken).mockResolvedValueOnce(admission)
	vi.mocked(recordEmbeddingSpend).mockRejectedValueOnce(
		new Error("private ledger failure"),
	)
	vi.mocked(writeEvent).mockResolvedValue({
		eventId: "single",
		timestamp: new Date(),
		scopeRef: "agent:agent-1",
	})
	vi.mocked(projectEventChunk).mockResolvedValue({ chunkCreated: true })
	vi.mocked(projectEventChunksBatch).mockResolvedValue([{ chunkCreated: true }])
	const manager = buildMockManager({
		closed: false,
		chunkCount: 0,
		shouldRunPostWriteDerivedWork: () => false,
		bumpSourceHintVersion: () => {},
		appendLedgerEntry: () => {},
	})
	const payload = {
		role: "user" as const,
		body: "index this",
		scope: "agent" as const,
	}
	if (batch)
		await expect(
			manager.writeConversationEventsBatch([payload]),
		).resolves.toMatchObject([
			{ ok: true, eventId: expect.any(String), chunkCreated: true },
		])
	else
		await expect(manager.writeConversationEvent(payload)).resolves.toEqual({
			eventId: "single",
			chunkCreated: true,
		})
	expect(recordEmbeddingSpend).toHaveBeenCalledWith(
		fakeDb,
		fakePrefix,
		"agent-1",
		"indexing",
		1,
		{ admission },
	)
	expect(vi.mocked(recordEmbeddingSpend).mock.calls[0]?.[5]?.admission).toBe(
		admission,
	)
})
