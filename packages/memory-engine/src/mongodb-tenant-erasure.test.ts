// C-003: tenant-level erasure. deleteAllForAgent deletes every document one
// agent owns across every collection — 27 top-level agentId-keyed (including
// the C-017 spend ledger), 2 time-series keyed by meta.agentId, and
// relevance_artifacts via the agentId arm (new rows) plus the runId join
// (legacy rows) — while leaving global `meta` state and OTHER tenants'
// documents untouched. Failures become per-collection receipts instead of
// aborting the sweep, and a critical-severity audit record written AFTER the
// deletes survives as proof-of-erasure.
// W02 (2026-09-05 independent audit): artifacts are swept BEFORE their
// relevance_runs parents, and the parents are RETAINED whenever artifact
// ownership is unresolved or the artifact delete fails — a retry can never
// report complete with artifacts still present (the audit's reproduced
// firstStatus partial / secondStatus complete / artifactExists true shape).
// W03: the sweep is fenced by a per-agent erasure epoch (bumped first; a
// failed bump aborts) and verified after (residual tenant documents force
// partial).
// The stateful fake IS the database; the facade test wires the real
// prototype without any module mocks.
import { describe, expect, it } from "vitest"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import type { TenantErasureReceipt } from "./mongodb-erasure.js"
import {
	bumpTenantErasureEpoch,
	getTenantErasureEpoch,
} from "./mongodb-erasure-epoch.js"
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
	// Legacy relevance artifact: no agentId, reachable only through its run.
	await fake.collection("relevance_artifacts").insertOne({
		runId: "run-agent-1",
		kind: "raw-explain",
	})
	// W02 new-style artifact: carries its own agentId — swept directly even
	// though its parent run row does not exist (the pre-fix orphan case).
	await fake.collection("relevance_artifacts").insertOne({
		runId: "run-orphaned",
		agentId: AGENT,
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
		// W03: the sweep was fenced by a fresh epoch and verified clean.
		expect(receipt.epoch).toBe(1)
		expect(receipt.verification).toEqual({ checked: 30, residual: [] })
		// 27 direct + 2 meta-keyed + relevance_artifacts (both arms).
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
		const artifactsReceipt = receipt.receipts.find(
			(entry) => entry.collection === "relevance_artifacts",
		)
		expect(artifactsReceipt?.deleted).toBe(2)

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
		// Both the legacy (runId join) and new-style (agentId arm) artifacts
		// are gone; agent-2's survives.
		const artifacts = fake.all("relevance_artifacts")
		expect(artifacts.map((doc) => doc.runId)).toEqual(["run-agent-2"])
		// Other tenants survive everywhere they were seeded.
		expect(fake.all("events").map((doc) => doc.agentId)).toEqual([OTHER])
		expect(fake.all("relevance_runs").map((doc) => doc.agentId)).toEqual([
			OTHER,
		])
		// Global operational state: the schema marker survives, plus the
		// per-agent erasure epoch document (W03 fence, deliberately outside
		// the sweep).
		const metaDocs = fake.all("meta")
		expect(metaDocs.length).toBe(2)
		expect(metaDocs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "schema_version", value: 4 }),
				expect.objectContaining({
					_id: `tenant-erasure-epoch:${AGENT}`,
					agentId: AGENT,
					epoch: 1,
				}),
			]),
		)
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
			epoch: 1,
			collections: 30,
			// 30 swept documents (both artifacts) + the agent's pre-existing
			// audit history.
			deletedTotal: 32,
			failedCollections: [],
			residualCollections: [],
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
		// W03: the post-sweep verification CONFIRMS the residual on the
		// receipt instead of leaving it implied by the failed delete.
		expect(receipt.verification?.residual).toEqual([
			{ collection: "chunks", count: 1 },
		])
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
			residualCollections: ["chunks"],
		})
	})

	it("W02: retains relevance_runs when the artifact sweep fails, so the retry sweeps children first", async () => {
		// The audit's reproduced shape: artifact deletion fails while the
		// parent delete would succeed. Pre-fix, the retry found no parents,
		// skipped the artifact delete, and reported complete with the
		// artifact retained. Post-fix, attempt 1 retains the parents; the
		// retry re-resolves the children, sweeps them, THEN the parents.
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await seedSurvivors(fake)
		fake.injectFailure({
			collection: "relevance_artifacts",
			method: "deleteMany",
			error: new Error("artifact delete failed"),
			times: 1,
		})

		const first = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// Attempt 1: partial — the artifact delete failed, so the parents are
		// RETAINED (they are the only way to reach the legacy artifact on the
		// next attempt).
		expect(first.status).toBe("partial")
		expect(first.epoch).toBe(1)
		const artifactsReceipt = first.receipts.find(
			(entry) => entry.collection === "relevance_artifacts",
		)
		expect(artifactsReceipt?.error).toBe("artifact delete failed")
		const runsReceipt = first.receipts.find(
			(entry) => entry.collection === "relevance_runs",
		)
		expect(runsReceipt?.deleted).toBe(0)
		expect(runsReceipt?.error).toContain("retained for artifact retry")
		// Both the agent's runs and BOTH artifacts survive attempt 1.
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBeTruthy()
		expect(
			fake.findDoc("relevance_artifacts", { runId: "run-agent-1" }),
		).toBeTruthy()
		expect(
			fake.findDoc("relevance_artifacts", { runId: "run-orphaned" }),
		).toBeTruthy()
		// Everything else was swept.
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)

		// Retry (failure cleared): artifacts swept BEFORE the parents, then
		// the parents — complete, with no artifact retained.
		const second = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})
		expect(second.status).toBe("complete")
		expect(second.epoch).toBe(2)
		expect(second.verification?.residual).toEqual([])
		expect(fake.all("relevance_artifacts").map((doc) => doc.runId)).toEqual([
			"run-agent-2",
		])
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBe(null)
	})

	it("W02: retains relevance_runs when the phase-1 run lookup fails", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await seedSurvivors(fake)
		fake.injectFailure({
			collection: "relevance_runs",
			method: "find",
			error: new Error("runs read failed"),
			times: 1,
		})

		const receipt = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("partial")
		// Phase 1 failed: the runId arm is unavailable, so the legacy
		// artifact (no agentId) is unreachable — the parents are retained so
		// the retry can re-resolve them.
		const runsReceipt = receipt.receipts.find(
			(entry) => entry.collection === "relevance_runs",
		)
		expect(runsReceipt?.error).toContain("retained for artifact retry")
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBeTruthy()
		// The new-style agentId artifact IS swept (agentId arm needs no join).
		expect(fake.findDoc("relevance_artifacts", { runId: "run-orphaned" })).toBe(
			null,
		)
		// The legacy artifact survives — reported via the retained parents,
		// not silently dropped.
		expect(
			fake.findDoc("relevance_artifacts", { runId: "run-agent-1" }),
		).toBeTruthy()
		// Every other collection was still swept.
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)
		// Other tenants' artifacts still survive.
		expect(
			fake.findDoc("relevance_artifacts", { runId: "run-agent-2" }),
		).toBeTruthy()

		// The retry (read failure cleared) resolves the parents, sweeps both
		// artifacts, then the parents — complete.
		const second = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})
		expect(second.status).toBe("complete")
		expect(fake.all("relevance_artifacts").map((doc) => doc.runId)).toEqual([
			"run-agent-2",
		])
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBe(null)
	})

	it("W03: refuses to sweep unfenced when the epoch bump fails", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		fake.injectFailure({
			collection: "meta",
			method: "findOneAndUpdate",
			error: new Error("epoch bump failed"),
		})

		const receipt = await deleteAllForAgent({
			db: fake.db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// No deletes ran at all; the receipt explains why.
		expect(receipt.status).toBe("partial")
		expect(receipt.epochError).toBe("epoch bump failed")
		expect(receipt.epoch).toBeUndefined()
		expect(receipt.receipts).toEqual([])
		expect(fake.findDoc("events", { agentId: AGENT })).toBeTruthy()
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBeTruthy()
		// No proof-of-erasure audit was written; the seeded mutation row
		// (part of the un-swept tenant data) survives untouched.
		expect(
			fake.findDoc("memory_mutations", { "meta.kind": "tenant-erasure" }),
		).toBeNull()
		expect(fake.all("memory_mutations").length).toBe(1)
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
		// The artifact sweep still ran (agentId arm; nothing matched).
		const artifactsReceipt = receipt.receipts.find(
			(entry) => entry.collection === "relevance_artifacts",
		)
		expect(artifactsReceipt?.deleted).toBe(0)
		expect(artifactsReceipt?.error).toBeUndefined()
		expect(receipt.receipts.every((entry) => entry.deleted === 0)).toBe(true)
		expect(fake.all("events").length).toBe(1)
		expect(fake.all("relevance_artifacts").length).toBe(1)
	})
})

describe("tenant erasure epoch (W03 fence primitive)", () => {
	it("starts at 0 and advances monotonically", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		expect(await getTenantErasureEpoch(fake.db, PREFIX, AGENT)).toBe(0)
		expect(await bumpTenantErasureEpoch(fake.db, PREFIX, AGENT)).toBe(1)
		expect(await getTenantErasureEpoch(fake.db, PREFIX, AGENT)).toBe(1)
		expect(await bumpTenantErasureEpoch(fake.db, PREFIX, AGENT)).toBe(2)
		expect(await getTenantErasureEpoch(fake.db, PREFIX, AGENT)).toBe(2)
		// Per-agent: another tenant's epoch is untouched.
		expect(await getTenantErasureEpoch(fake.db, PREFIX, OTHER)).toBe(0)
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
