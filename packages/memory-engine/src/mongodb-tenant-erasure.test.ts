// C-003: tenant-level erasure. deleteAllForAgent deletes every document one
// agent owns across every collection — 27 top-level agentId-keyed (including
// the C-017 spend ledger), 2 time-series keyed by meta.agentId, and
// relevance_artifacts (no agentId) via the two-phase relevance_runs runId
// join — while leaving global `meta` state and OTHER tenants' documents
// untouched. Failures become per-collection receipts instead of aborting the
// sweep, and a critical-severity audit record written AFTER the deletes
// survives as proof-of-erasure.
// The stateful fake IS the database; the facade test wires the real
// prototype without any module mocks.
import { describe, expect, it } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import type { TenantErasureReceipt } from "./mongodb-erasure.js"
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

/** The 27 top-level agentId-keyed collections the sweep must cover. */
const AGENT_KEYED = [
	"events",
	"chunks",
	"structured_mem",
	"structured_mem_revisions",
	"procedures",
	"procedure_revisions",
	"knowledge_base",
	"kb_chunks",
	"entities",
	"relations",
	"entity_links",
	"episodes",
	"query_cache",
	"memory_quarantine",
	"memory_evidence",
	"files",
	"relevance_runs",
	"relevance_regressions",
	"memory_mutations",
	"ingest_runs",
	"projection_runs",
	"recall_traces",
	"memory_jobs",
	"lane_coverage",
	"consolidation_runs",
	"session_chunks",
	"memory_cost_ledger",
] as const

/** Time-series collections where the tenant identity is meta.agentId. */
const META_KEYED = ["memory_telemetry", "access_events"] as const

async function seedTenant(fake: ReturnType<typeof createStatefulMongoFake>) {
	for (const suffix of AGENT_KEYED) {
		await fake.collection(suffix).insertOne({
			id: `${suffix}-agent-1`,
			agentId: AGENT,
			...(suffix === "relevance_runs" ? { runId: "run-agent-1" } : {}),
		})
	}
	for (const suffix of META_KEYED) {
		await fake.collection(suffix).insertOne({
			ts: new Date("2026-09-02T10:00:00.000Z"),
			meta: {
				agentId: AGENT,
				...(suffix === "memory_telemetry"
					? { operation: "context-bundle" }
					: { collection: "events" }),
			},
		})
	}
	// relevance_artifacts carries no agentId — reachable only through its run.
	await fake.collection("relevance_artifacts").insertOne({
		runId: "run-agent-1",
		kind: "raw-explain",
	})
}

/** Other-tenant + global fixtures that must SURVIVE the agent-1 erase. */
async function seedSurvivors(fake: ReturnType<typeof createStatefulMongoFake>) {
	await fake
		.collection("events")
		.insertOne({ eventId: "e-other", agentId: OTHER })
	await fake.collection("chunks").insertOne({
		path: "events/e-other",
		agentId: OTHER,
	})
	await fake.collection("relevance_runs").insertOne({
		runId: "run-agent-2",
		agentId: OTHER,
	})
	await fake.collection("relevance_artifacts").insertOne({
		runId: "run-agent-2",
		kind: "raw-explain",
	})
	await fake.collection("memory_telemetry").insertOne({
		ts: new Date("2026-09-02T10:00:00.000Z"),
		meta: { agentId: OTHER, operation: "rerank" },
	})
	await fake.collection("access_events").insertOne({
		ts: new Date("2026-09-02T10:00:00.000Z"),
		meta: { agentId: OTHER, collection: "events" },
	})
	await fake.collection("meta").insertOne({ key: "schema_version", value: 4 })
}

function erasedCollectionNames(receipt: TenantErasureReceipt): string[] {
	return receipt.receipts.map((entry) => entry.collection)
}

describe("deleteAllForAgent — full tenant sweep (C-003)", () => {
	it("deletes the agent's documents from every tenant collection", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await seedSurvivors(fake)

		const receipt = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("complete")
		// 27 direct + 2 meta-keyed + relevance_artifacts (two-phase).
		expect(erasedCollectionNames(receipt)).toEqual(
			expect.arrayContaining([
				...AGENT_KEYED,
				...META_KEYED,
				"relevance_artifacts",
			]),
		)
		expect(receipt.receipts.length).toBe(30)
		expect(receipt.receipts.every((entry) => entry.error === undefined)).toBe(
			true,
		)

		// Every agentId-keyed collection holds only the other tenant. The one
		// deliberate exception: memory_mutations, where the proof-of-erasure
		// audit record (written AFTER the deletes) survives — asserted below.
		for (const suffix of AGENT_KEYED) {
			if (suffix === "memory_mutations") continue
			const remaining = fake.all(suffix)
			expect(
				remaining.filter((doc) => doc.agentId === AGENT),
				`${suffix} still holds agent-1 data`,
			).toEqual([])
		}
		// memory_mutations holds exactly the surviving erasure audit record.
		const mutations = fake.all("memory_mutations")
		expect(mutations.length).toBe(1)
		expect(mutations[0].agentId).toBe(AGENT)
		expect(mutations[0].severity).toBe("critical")
		// Time-series: erased through meta.agentId, other tenant survives.
		for (const suffix of META_KEYED) {
			const remaining = fake.all(suffix)
			expect(
				remaining.filter((doc) => doc.meta?.agentId === AGENT),
				`${suffix} still holds agent-1 data`,
			).toEqual([])
			expect(remaining.length).toBe(1)
		}
		// Two-phase join: agent-1's artifact is gone, agent-2's survives.
		const artifacts = fake.all("relevance_artifacts")
		expect(artifacts.map((doc) => doc.runId)).toEqual(["run-agent-2"])
		// Other tenants survive everywhere they were seeded.
		expect(fake.all("events").map((doc) => doc.agentId)).toEqual([OTHER])
		expect(fake.all("relevance_runs").map((doc) => doc.agentId)).toEqual([
			OTHER,
		])
		// Global operational state is untouched.
		const metaDocs = fake.all("meta")
		expect(metaDocs.length).toBe(1)
		expect(metaDocs[0]).toMatchObject({ key: "schema_version", value: 4 })
	})

	it("writes a critical audit record that survives the memory_mutations erase", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		// Pre-existing audit history for this agent — must be erased too.
		await fake.collection("memory_mutations").insertOne({
			mutationId: "old-audit",
			agentId: AGENT,
			severity: "info",
		})

		const receipt = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		const mutations = fake.all("memory_mutations")
		// The agent's prior history is gone; exactly the erasure audit remains.
		expect(mutations.length).toBe(1)
		const audit = mutations[0]
		expect(audit.mutationId).toBe(receipt.mutationId)
		expect(audit.severity).toBe("critical")
		expect(audit.operation).toBe("delete")
		expect(audit.documentId).toBe(AGENT)
		expect(audit.agentId).toBe(AGENT)
		expect(audit.meta).toMatchObject({
			kind: "tenant-erasure",
			status: "complete",
			collections: 30,
			// 30 swept documents + the agent's pre-existing audit history.
			deletedTotal: 31,
			failedCollections: [],
		})
	})

	it("reports per-collection failures instead of aborting the sweep", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		fake.injectFailure({
			collection: "chunks",
			method: "deleteMany",
			error: new Error("chunks delete failed"),
		})

		const receipt = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("partial")
		const chunksReceipt = receipt.receipts.find(
			(entry) => entry.collection === "chunks",
		)
		expect(chunksReceipt?.error).toBe("chunks delete failed")
		expect(chunksReceipt?.deleted).toBe(0)
		// The failed collection still holds agent-1 data (reported, not hidden).
		expect(fake.findDoc("chunks", { agentId: AGENT })).toBeTruthy()
		// Every other collection was still swept.
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)
		expect(fake.findDoc("structured_mem", { agentId: AGENT })).toBe(null)
		// The audit record reports the partial status and the failed name.
		const audit = fake.findDoc("memory_mutations", {
			"meta.kind": "tenant-erasure",
		})
		expect(audit?.meta).toMatchObject({
			status: "partial",
			failedCollections: ["chunks"],
		})
	})

	it("reports a phase-1 relevance join failure as a partial receipt, not silent completeness", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await seedSurvivors(fake)
		// Phase 1 reads relevance_runs BEFORE any delete; failing that read
		// leaves the agent's artifacts unreachable for this sweep.
		fake.injectFailure({
			collection: "relevance_runs",
			method: "find",
			error: new Error("runs read failed"),
		})

		const receipt = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("partial")
		const artifactsReceipt = receipt.receipts.find(
			(entry) => entry.collection === "relevance_artifacts",
		)
		expect(artifactsReceipt?.deleted).toBe(0)
		expect(artifactsReceipt?.error).toContain("runs read failed")
		// The agent's artifact survived — reported on the receipt, not hidden.
		expect(
			fake.findDoc("relevance_artifacts", { runId: "run-agent-1" }),
		).toBeTruthy()
		// Every other collection (including relevance_runs itself) was swept.
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBe(null)
		// Other tenants' artifacts still survive.
		expect(
			fake.findDoc("relevance_artifacts", { runId: "run-agent-2" }),
		).toBeTruthy()
		// The audit record reports partial with relevance_artifacts failed.
		const audit = fake.findDoc("memory_mutations", {
			"meta.kind": "tenant-erasure",
		})
		expect(audit?.meta).toMatchObject({
			status: "partial",
			failedCollections: ["relevance_artifacts"],
		})
	})

	it("surfaces a failed proof-of-erasure audit write as partial with auditError", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		// Fail ONLY the audit insertOne — the memory_mutations deleteMany in
		// the sweep itself still succeeds.
		fake.injectFailure({
			collection: "memory_mutations",
			method: "insertOne",
			error: new Error("audit write failed"),
		})

		const receipt = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// All deletes succeeded, but the receipt must not claim "complete"
		// without the durable proof-of-erasure audit record.
		expect(receipt.status).toBe("partial")
		expect(receipt.auditError).toBe("audit write failed")
		expect(receipt.mutationId).toBeUndefined()
		expect(receipt.receipts.every((entry) => entry.error === undefined)).toBe(
			true,
		)
		// The sweep itself still ran to completion.
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)
		expect(fake.findDoc("relevance_artifacts", { runId: "run-agent-1" })).toBe(
			null,
		)
		// No audit record exists (the write failed; the swept history is gone).
		expect(fake.all("memory_mutations").length).toBe(0)
	})

	it("erases an agent with no data without touching other tenants", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedSurvivors(fake)

		const receipt = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("complete")
		expect(receipt.receipts.every((entry) => entry.deleted === 0)).toBe(true)
		// relevance_artifacts was not even targeted (no runs to join through).
		expect(erasedCollectionNames(receipt)).not.toContain("relevance_artifacts")
		expect(fake.all("events").length).toBe(1)
		expect(fake.all("relevance_artifacts").length).toBe(1)
	})
})

describe("MongoDBMemoryManager.deleteAllForAgent — facade wiring (C-003)", () => {
	it("delegates through AdminOps to the seam against the stateful fake", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		const manager = buildMockManager({ db: fake.db, prefix: PREFIX })

		const receipt = await manager.deleteAllForAgent()

		expect(receipt.status).toBe("complete")
		expect(receipt.agentId).toBe(AGENT)
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)
		expect(fake.findDoc("relevance_artifacts", { runId: "run-agent-1" })).toBe(
			null,
		)
		const audit = fake.findDoc("memory_mutations", {
			agentId: AGENT,
			severity: "critical",
		})
		expect(audit?.mutationId).toBe(receipt.mutationId)
	})
})
