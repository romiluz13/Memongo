import type { Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildInferredMemoryEntry } from "./mongodb-consolidation-reasoning.js"
import {
	writeStructuredMemory,
	type StructuredMemoryEntry,
} from "./mongodb-structured-memory.js"
import {
	createStatefulMongoFake,
	type StatefulMongoFake,
} from "./test-helpers/stateful-mongo-fake.js"

const effects = vi.hoisted(() => ({
	cache: vi.fn(async () => {}),
	spend: vi.fn(),
	sessionSpend: vi.fn(async () => {}),
	audit: vi.fn(async () => {}),
}))
vi.mock("./mongodb-query-cache.js", () => ({
	invalidateQueryCache: effects.cache,
}))
vi.mock("./mongodb-cost-ledger.js", () => ({
	recordEmbeddingSpend: effects.spend,
	recordEmbeddingSpendInSession: effects.sessionSpend,
}))
vi.mock("./mongodb-mutations.js", () => ({ recordMutation: effects.audit }))

const prefix = "test_"
let fake: StatefulMongoFake
function entry(runId = "second-run"): StructuredMemoryEntry {
	return buildInferredMemoryEntry({
		agentId: "agent-1",
		runId,
		reasoned: {
			kind: "deduction",
			value: "Deployment satisfies the US region requirement",
			rationale: "The deployment and requirement use US regions",
			sourceValues: ["Deployment uses us-east-1", "Compliance requires US"],
		},
	})
}
async function write(value: StructuredMemoryEntry, expectedRevision?: number) {
	return writeStructuredMemory({
		db: fake.db,
		prefix,
		entry: value,
		embeddingMode: "automated",
		...(expectedRevision === undefined ? {} : { expectedRevision }),
	})
}
async function stored(): Promise<Document | null> {
	return fake.db
		.collection(`${prefix}structured_mem`)
		.findOne({ agentId: "agent-1" })
}
beforeEach(() => {
	fake = createStatefulMongoFake({ prefix })
	vi.clearAllMocks()
})

describe("exact inferred replay", () => {
	it("preserves the stored row and skips every write side effect", async () => {
		await write(entry("first-run"))
		const before = await stored()
		vi.clearAllMocks()
		expect(await write(entry())).toMatchObject({
			upserted: false,
			changed: false,
		})
		expect(await stored()).toEqual(before)
		expect(fake.all("structured_mem_revisions")).toEqual([])
		expect(effects.cache).not.toHaveBeenCalled()
		expect(effects.spend).not.toHaveBeenCalled()
		expect(effects.sessionSpend).not.toHaveBeenCalled()
		expect(effects.audit).not.toHaveBeenCalled()
	})

	it.each([
		"rationale",
		"derivedFrom",
		"confidence",
		"origin",
	])("keeps the changed write path for a different %s", async (field) => {
		await write(entry("first-run"))
		const value = entry()
		if (field === "confidence") value.confidence = 0.8
		else
			value.provenance = {
				...value.provenance,
				[field]: field === "derivedFrom" ? ["A different source"] : "changed",
			}
		expect(await write(value)).toMatchObject({ changed: true })
		expect(await stored()).toMatchObject({ revision: 2 })
	})

	it("does not conflate reordered supporting sources", async () => {
		await write(entry("first-run"))
		const value = entry()
		value.provenance = {
			...value.provenance,
			derivedFrom: ["Compliance requires US", "Deployment uses us-east-1"],
		}
		expect(await write(value)).toMatchObject({ changed: true })
	})

	it.each([
		"invalidated",
		"expired",
	])("keeps the existing %s-row path", async (kind) => {
		await write(entry("first-run"))
		await fake.db.collection(`${prefix}structured_mem`).updateOne(
			{ agentId: "agent-1" },
			{
				$set:
					kind === "invalidated"
						? { state: "invalidated" }
						: { expiresAt: new Date(0) },
			},
		)
		expect(await write(entry())).toMatchObject({ changed: true })
	})

	it("keeps explicit expiry changes", async () => {
		await write(entry("first-run"))
		expect(
			await write({ ...entry(), expiresAt: new Date(Date.now() + 60000) }),
		).toMatchObject({ changed: true })
	})

	it("rejects a stale expected revision before considering replay", async () => {
		await write(entry("first-run"))
		await expect(write(entry(), 7)).rejects.toMatchObject({
			name: "MemoryLifecycleConflictError",
		})
	})
})
