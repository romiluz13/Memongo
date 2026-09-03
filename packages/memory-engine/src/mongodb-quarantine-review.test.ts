// C-004: quarantine review lifecycle. Injection-classified candidates are
// dead-ended into memory_quarantine with no review path — classifier false
// positives were silent permanent data loss. These tests pin the three
// review operations: listQuarantined (agent-isolated, oldest-first queue),
// promoteQuarantined (claim-first status flip, consolidator-identical
// extraction, provenance back-reference, compensating revert on write
// failure), and rejectQuarantined (decision metadata + durable audit).
// The stateful fake IS the database; the facade test wires the real
// prototype without any module mocks.
import { describe, expect, it } from "vitest"
import {
	insertQuarantinedForReview,
	listQuarantined,
	promoteQuarantined,
	rejectQuarantined,
} from "./mongodb-quarantine-review.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	buildMockManager,
	captureManagerPrototype,
} from "./test-helpers/manager-test-kit.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

captureManagerPrototype(MongoDBMemoryManager)

const PREFIX = "test_"
const AGENT = "agent-1"
const OTHER = "agent-2"

/** Content that the consolidator's pattern matcher extracts as a preference. */
const PREFER_CONTENT = "I prefer tabs over spaces in TypeScript files"
/** Content with no CATEGORY_PATTERNS match: no derivable memory shape. */
const NO_PATTERN_CONTENT = "hello there, general weather today"

async function seedPending(
	fake: ReturnType<typeof createStatefulMongoFake>,
	overrides: Record<string, unknown> = {},
) {
	const { quarantineId } = await insertQuarantinedForReview({
		db: fake.db,
		prefix: PREFIX,
		agentId: AGENT,
		content: PREFER_CONTENT,
		matchedPatterns: ["instruction-override"],
		sourceEventIds: ["event-1"],
		scope: "user",
		scopeRef: "user-42",
		...overrides,
	})
	return quarantineId
}

describe("listQuarantined — review queue listing (C-004)", () => {
	it("lists an agent's entries oldest-first and isolates other tenants", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const older = await seedPending(fake, {
			content: "I like coffee more than tea",
			createdAt: new Date("2026-09-01T10:00:00.000Z"),
		})
		const newer = await seedPending(fake, {
			createdAt: new Date("2026-09-02T10:00:00.000Z"),
		})
		// Other tenant's row: invisible to agent-1's review queue.
		await insertQuarantinedForReview({
			db: fake.db,
			prefix: PREFIX,
			agentId: OTHER,
			content: PREFER_CONTENT,
		})

		const entries = await listQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(entries.map((entry) => entry.quarantineId)).toEqual([older, newer])
		expect(entries.every((entry) => entry.agentId === AGENT)).toBe(true)
		expect(entries[0]).toMatchObject({
			content: "I like coffee more than tea",
			status: "pending-review",
			matchedPatterns: ["instruction-override"],
		})
	})

	it("filters by status and clamps the limit", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedPending(fake)
		await seedPending(fake)
		const rejected = await seedPending(fake)
		await rejectQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			quarantineId: rejected,
		})

		const pendingOnly = await listQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			status: "pending-review",
		})
		expect(pendingOnly.length).toBe(2)
		expect(
			pendingOnly.every((entry) => entry.status === "pending-review"),
		).toBe(true)

		const rejectedOnly = await listQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			status: "rejected",
		})
		expect(rejectedOnly.map((entry) => entry.quarantineId)).toEqual([rejected])

		const limited = await listQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			limit: 1,
		})
		expect(limited.length).toBe(1)
	})
})

describe("promoteQuarantined — classifier overrule (C-004)", () => {
	it("writes structured memory via the consolidator's extraction and records the decision", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const quarantineId = await seedPending(fake)

		const receipt = await promoteQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			quarantineId,
			embeddingMode: "automated",
			reviewerId: "reviewer-7",
			reviewNotes: "false positive: legitimate preference",
		})

		expect(receipt).toMatchObject({
			quarantineId,
			agentId: AGENT,
			status: "promoted",
			reviewerId: "reviewer-7",
			reviewNotes: "false positive: legitimate preference",
		})
		expect(receipt.memoryId).toBeTruthy()
		expect(receipt.reviewedAt).toBeInstanceOf(Date)

		// The quarantine row carries the decision metadata.
		const row = fake.findDoc("memory_quarantine", { quarantineId })
		expect(row).toMatchObject({
			status: "promoted",
			reviewerId: "reviewer-7",
			reviewNotes: "false positive: legitimate preference",
		})
		expect(row?.reviewedAt).toBeInstanceOf(Date)

		// The promoted memory mirrors the consolidator's write shape: same
		// extraction (preference type), scope/scopeRef inherited from the
		// candidate, provenance pointing back at the quarantine row.
		const memory = fake.findDoc("structured_mem", {
			agentId: AGENT,
			type: "preference",
		})
		expect(memory).toMatchObject({
			key: "tabs over spaces in TypeScript files",
			value: PREFER_CONTENT,
			agentId: AGENT,
			scope: "user",
			scopeRef: "user-42",
			source: "agent",
			sourceEventIds: ["event-1"],
			sourceAgent: { id: AGENT, name: "quarantine-review" },
			provenance: {
				quarantineId,
				originalClassification: "injection-likely",
				matchedPatterns: ["instruction-override"],
				promotedByReview: true,
			},
		})

		// The decision is audited, with the reviewer metadata in the audit
		// row so it is a self-contained record of who decided what and when.
		const audit = fake.findDoc("memory_mutations", {
			collectionName: "memory_quarantine",
			documentId: quarantineId,
		})
		expect(audit).toMatchObject({
			severity: "warning",
			operation: "update",
			meta: {
				decision: "promoted",
				quarantineId,
				reviewerId: "reviewer-7",
				reviewNotes: "false positive: legitimate preference",
			},
		})
		expect(audit?.meta?.reviewedAt).toEqual(receipt.reviewedAt)
		expect(audit?.mutationId).toBe(receipt.mutationId)
	})

	it("fails loudly when the content matches no memory pattern", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const quarantineId = await seedPending(fake, {
			content: NO_PATTERN_CONTENT,
		})

		await expect(
			promoteQuarantined({
				db: fake.db,
				prefix: PREFIX,
				agentId: AGENT,
				quarantineId,
				embeddingMode: "automated",
			}),
		).rejects.toThrow(/matches no memory pattern/)

		// No decision was recorded: the row stays in the queue.
		const row = fake.findDoc("memory_quarantine", { quarantineId })
		expect(row?.status).toBe("pending-review")
		expect(fake.all("structured_mem")).toEqual([])
	})

	it("rejects unknown ids and already-reviewed rows without side effects", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const quarantineId = await seedPending(fake)

		await expect(
			promoteQuarantined({
				db: fake.db,
				prefix: PREFIX,
				agentId: AGENT,
				quarantineId: "no-such-entry",
				embeddingMode: "automated",
			}),
		).rejects.toThrow(/not found/)

		// Other tenant's row: invisible to agent-1 (tenant isolation on read).
		await expect(
			promoteQuarantined({
				db: fake.db,
				prefix: PREFIX,
				agentId: OTHER,
				quarantineId,
				embeddingMode: "automated",
			}),
		).rejects.toThrow(/not found/)

		await rejectQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			quarantineId,
		})
		await expect(
			promoteQuarantined({
				db: fake.db,
				prefix: PREFIX,
				agentId: AGENT,
				quarantineId,
				embeddingMode: "automated",
			}),
		).rejects.toThrow(/already reviewed/)
	})

	it("reverts the status claim when the structured write fails", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const quarantineId = await seedPending(fake)
		fake.injectFailure({
			collection: "structured_mem",
			method: "updateOne",
			error: new Error("structured write failed"),
		})

		await expect(
			promoteQuarantined({
				db: fake.db,
				prefix: PREFIX,
				agentId: AGENT,
				quarantineId,
				embeddingMode: "automated",
			}),
		).rejects.toThrow(/structured write failed/)

		// Compensating revert: the row is back in the queue, decision metadata
		// cleared, so the operator can retry after the write path recovers.
		const row = fake.findDoc("memory_quarantine", { quarantineId })
		expect(row?.status).toBe("pending-review")
		expect(row?.reviewedAt).toBeUndefined()
		expect(row?.reviewerId).toBeUndefined()
	})

	it("surfaces a failed audit write as auditError without undoing the promotion", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const quarantineId = await seedPending(fake)
		// The memory write succeeds; the audit ledger is down for the whole
		// operation. times must cover writeStructuredMemory's own internal
		// structured_mem audit (swallowed there via allSettled) so the
		// failure also strikes the quarantine decision audit.
		fake.injectFailure({
			collection: "memory_mutations",
			method: "insertOne",
			error: new Error("audit insert failed"),
			times: 99,
		})

		const receipt = await promoteQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			quarantineId,
			embeddingMode: "automated",
			reviewerId: "reviewer-7",
		})

		// The promotion stands (row + structured memory); the ledger copy
		// failed and the receipt says so instead of swallowing the gap.
		expect(receipt.status).toBe("promoted")
		expect(receipt.memoryId).toBeTruthy()
		expect(receipt.auditError).toBe("audit insert failed")
		expect(receipt.mutationId).toBeUndefined()
		const row = fake.findDoc("memory_quarantine", { quarantineId })
		expect(row).toMatchObject({ status: "promoted", reviewerId: "reviewer-7" })
		expect(
			fake.findDoc("structured_mem", { agentId: AGENT, type: "preference" }),
		).toBeTruthy()
		// No audit record exists for the decision.
		expect(
			fake.findDoc("memory_mutations", { collectionName: "memory_quarantine" }),
		).toBeNull()
	})
})

describe("rejectQuarantined — discard with audit trail (C-004)", () => {
	it("marks the row rejected with decision metadata and an audit record", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const quarantineId = await seedPending(fake)

		const receipt = await rejectQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			quarantineId,
			reviewerId: "reviewer-7",
			reviewNotes: "confirmed injection attempt",
		})

		expect(receipt).toMatchObject({
			quarantineId,
			agentId: AGENT,
			status: "rejected",
			reviewerId: "reviewer-7",
			reviewNotes: "confirmed injection attempt",
		})

		const row = fake.findDoc("memory_quarantine", { quarantineId })
		expect(row).toMatchObject({
			status: "rejected",
			reviewerId: "reviewer-7",
		})
		// The row is kept as audit trail — not deleted.
		expect(row).toBeTruthy()

		const audit = fake.findDoc("memory_mutations", {
			collectionName: "memory_quarantine",
			documentId: quarantineId,
		})
		expect(audit).toMatchObject({
			severity: "warning",
			meta: {
				decision: "rejected",
				quarantineId,
				reviewerId: "reviewer-7",
				reviewNotes: "confirmed injection attempt",
			},
		})
		expect(audit?.meta?.reviewedAt).toEqual(receipt.reviewedAt)
	})

	it("surfaces a failed audit write as auditError without undoing the decision", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const quarantineId = await seedPending(fake)
		// The audit ledger is down: every memory_mutations insert fails.
		fake.injectFailure({
			collection: "memory_mutations",
			method: "insertOne",
			error: new Error("audit insert failed"),
			times: 99,
		})

		const receipt = await rejectQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			quarantineId,
			reviewerId: "reviewer-7",
		})

		// The decision is durable on the row; the ledger copy failed and the
		// receipt says so instead of swallowing the gap.
		expect(receipt.status).toBe("rejected")
		expect(receipt.auditError).toBe("audit insert failed")
		expect(receipt.mutationId).toBeUndefined()
		const row = fake.findDoc("memory_quarantine", { quarantineId })
		expect(row).toMatchObject({
			status: "rejected",
			reviewerId: "reviewer-7",
		})
		// No audit record exists for the decision.
		expect(
			fake.findDoc("memory_mutations", { collectionName: "memory_quarantine" }),
		).toBeNull()
	})

	it("rejects unknown ids, cross-tenant ids, and already-reviewed rows", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const quarantineId = await seedPending(fake)

		await expect(
			rejectQuarantined({
				db: fake.db,
				prefix: PREFIX,
				agentId: AGENT,
				quarantineId: "no-such-entry",
			}),
		).rejects.toThrow(/not found/)
		await expect(
			rejectQuarantined({
				db: fake.db,
				prefix: PREFIX,
				agentId: OTHER,
				quarantineId,
			}),
		).rejects.toThrow(/not found/)

		const receipt = await rejectQuarantined({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
			quarantineId,
		})
		await expect(
			rejectQuarantined({
				db: fake.db,
				prefix: PREFIX,
				agentId: AGENT,
				quarantineId,
			}),
		).rejects.toThrow(/already reviewed/)
		expect(receipt.status).toBe("rejected")
	})
})

describe("MongoDBMemoryManager — facade wiring (C-004)", () => {
	it("delegates list/promote/reject through the ops collaborators", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const quarantineId = await seedPending(fake)
		const manager = buildMockManager({ db: fake.db, prefix: PREFIX })

		const entries = await manager.listQuarantined({ status: "pending-review" })
		expect(entries.map((entry) => entry.quarantineId)).toEqual([quarantineId])

		const promoted = await manager.promoteQuarantined({
			quarantineId,
			reviewerId: "reviewer-7",
		})
		expect(promoted.status).toBe("promoted")
		expect(fake.findDoc("structured_mem", { agentId: AGENT })).toMatchObject({
			provenance: { quarantineId },
		})

		const secondId = await seedPending(fake)
		const rejected = await manager.rejectQuarantined({ quarantineId: secondId })
		expect(rejected.status).toBe("rejected")
		const row = fake.findDoc("memory_quarantine", { quarantineId: secondId })
		expect(row?.status).toBe("rejected")
	})
})
