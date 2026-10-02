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
// W03/gate: the sweep runs behind the erasure gate — beginErasure (or a
// recovery request's DIRECT takeoverErasure dispatch) fences the attempt,
// every batch runs in withFencedWrite, and only finalizeErasure can grant
// "complete" (recount + audit + reopen coupled in one transaction).
// C-1: `gateState:"erasing"` on a partial receipt cites the fenced partial
// audit's ACKNOWLEDGMENT — never begin success or an unobserved conflict —
// so an audit that errored without confirming ownership omits gateState
// (no invented ownershipLost, no finalizeIndeterminate).
// Unit-harness boundary (lead ruling): the stateful fake stays the database
// for sweep semantics but is NOT widened — the gate core's session client
// and listCollections needs are provided by the file-local seam below, and
// these tests verify receipt/control-flow branches only; transaction and
// ownership behavior is established by the granted Atlas e2e suite (where
// the C-1 native discriminator lives). The facade test wires the real
// prototype without any module mocks.
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClientSession, Db, Document } from "mongodb"
import { deleteAllForAgent } from "./mongodb-erasure.js"
import type { TenantErasureReceipt } from "./mongodb-erasure.js"
import {
	bumpTenantErasureEpoch,
	ErasureGateConflictError,
	getTenantErasureEpoch,
	takeoverErasure,
} from "./mongodb-erasure-epoch.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	buildMockManager,
	captureManagerPrototype,
} from "./test-helpers/manager-test-kit.js"
import {
	createStatefulMongoFake,
	type StatefulMongoFake,
} from "./test-helpers/stateful-mongo-fake.js"

captureManagerPrototype(MongoDBMemoryManager)

const PREFIX = "test_"
const AGENT = "agent-1"
const OTHER = "agent-2"

// ---------------------------------------------------------------------------
// S3 finalize seam (plan e5ec10dc §4.4, U7)
// ---------------------------------------------------------------------------
// finalizeErasure is mocked file-wide but PASSES THROUGH to the real
// primitive unless a test opts into capture mode, so every other test keeps
// the granted native flow byte-for-byte. U7 captures the writeAudit callback
// because the gate reopen belongs to finalizeErasure (C7), not to the
// callback under test — the captured callback is replayed in isolation
// against the fake's meta state.
const finalizeSeam = vi.hoisted(() => {
	const state = {
		capture: false,
		capturedWriteAudit: undefined as
			| ((session: ClientSession) => Promise<void>)
			| undefined,
		reset: () => {
			state.capture = false
			state.capturedWriteAudit = undefined
		},
	}
	return state
})

vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-write-fence.js")>()
	return {
		...actual,
		finalizeErasure: async (
			params: Parameters<typeof actual.finalizeErasure>[0],
		) => {
			if (finalizeSeam.capture) {
				finalizeSeam.capturedWriteAudit = params.writeAudit
				return undefined
			}
			return actual.finalizeErasure(params)
		},
	}
})

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

async function seedTenant(fake: StatefulMongoFake) {
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
async function seedSurvivors(fake: StatefulMongoFake) {
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

/** The agent's gate document in the fake's meta collection (clone). */
function gateDoc(fake: StatefulMongoFake): Document | null {
	return fake.findDoc("meta", { _id: `tenant-erasure-epoch:${AGENT}` })
}

// ---------------------------------------------------------------------------
// File-local gate/fence seam (unit-harness boundary, lead ruling)
// ---------------------------------------------------------------------------
// The shared stateful fake is NOT widened: it has no session client and no
// listCollections, and it stays that way. The seam wraps the fake's
// collections with exactly the operations the gate core calls, plus
// explicit per-test outcomes:
//   - passthrough session: withTransaction runs the body ONCE (no retries,
//     no snapshot isolation, no rollback — transaction/ownership semantics
//     belong to the Atlas e2e suite, not here);
//   - listCollections: every sink is an ordinary collection by default;
//     tests force a time-series instance or a thrown read per sink;
//   - onFenceBump: fires after each applyGateFence serial bump — the
//     mid-flight hook where a REAL takeoverErasure can steal the gate so
//     ownership loss arises from actual gate state, not a thrown prop;
//   - failMetaFindOneAndUpdateOnCall: meta.findOneAndUpdate call #1 is
//     beginErasure and call #2 is finalizeErasure on the clean path, so a
//     call-indexed plan yields explicit finalize conflict /
//     commit-ambiguous outcomes.
//   - failMetaDeleteOne / onMetaDeleteOne: the S3 marker deleteOne (§4.4).
//     The fake has no deleteOne (not widened, lead ruling), so the seam
//     provides it shaped over the fake's deleteMany, with an explicit
//     failure knob and a per-call filter recorder.
// The fake's own injectFailure covers everything else (batch deletes, the
// audit insertOne, the begin upsert).
type PassthroughSession = {
	withTransaction: (
		fn: (session: PassthroughSession) => Promise<unknown>,
	) => Promise<unknown>
	inTransaction: () => boolean
	endSession: () => Promise<void>
}

type GateSeamOptions = {
	/** Per-name diagnostic-sink type-check outcome (full collection name). */
	listCollectionsBehavior?: (collectionName: string) => Array<Document>
	/** Runs after each fenced serial bump on the meta collection. */
	onFenceBump?: () => void | Promise<void>
	/** Fail a meta.findOneAndUpdate call by 1-based index (1=begin, 2=finalize). */
	failMetaFindOneAndUpdateOnCall?: { call: number; error: Error }
	/** Fail every meta.deleteOne call (the S3 marker delete in writeAudit). */
	failMetaDeleteOne?: Error
	/** Records each meta.deleteOne filter (the S3 marker delete in writeAudit). */
	onMetaDeleteOne?: (filter: Document) => void
}

/** The fake's collection handle (the class itself is not exported). */
type FakeCollectionHandle = ReturnType<StatefulMongoFake["collection"]>

/** A session whose withTransaction runs the body ONCE (see seam header). */
function passthroughSession(): PassthroughSession {
	const session: PassthroughSession = {
		withTransaction: (fn) => fn(session),
		inTransaction: () => false,
		endSession: async () => {},
	}
	return session
}

function wrapForGateCore(
	fake: StatefulMongoFake,
	seam: GateSeamOptions = {},
): Db {
	const metaName = `${PREFIX}meta`
	let metaFindOneAndUpdateCalls = 0
	const session = passthroughSession()
	const listCollections = (filter: Document) => ({
		toArray: async (): Array<Document> => {
			const name = typeof filter.name === "string" ? filter.name : ""
			if (seam.listCollectionsBehavior) {
				return seam.listCollectionsBehavior(name)
			}
			return [{ name, type: "collection" }]
		},
	})
	const wrapMeta = (): FakeCollectionHandle => {
		const target = fake.collection("meta")
		return new Proxy(target, {
			get(t: FakeCollectionHandle, prop: string | symbol): unknown {
				if (prop === "findOneAndUpdate") {
					return async (
						filter: Document,
						update: Document | Document[],
						options?: Document,
					) => {
						metaFindOneAndUpdateCalls += 1
						const plan = seam.failMetaFindOneAndUpdateOnCall
						if (plan && metaFindOneAndUpdateCalls === plan.call) {
							throw plan.error
						}
						return t.findOneAndUpdate(filter, update, options)
					}
				}
				if (prop === "updateOne" && seam.onFenceBump) {
					return async (
						filter: Document,
						update: Document | Document[],
						options?: Document,
					) => {
						const result = await t.updateOne(filter, update, options)
						await seam.onFenceBump()
						return result
					}
				}
				if (prop === "deleteOne") {
					return async (filter: Document) => {
						if (seam.failMetaDeleteOne) {
							throw seam.failMetaDeleteOne
						}
						// Not a widening of the fake: deleteOne is provided by
						// the seam, shaped over the fake's deleteMany with the
						// exact-_id filter passed through verbatim.
						const result = await t.deleteMany(filter)
						seam.onMetaDeleteOne?.(filter)
						return {
							acknowledged: true as const,
							deletedCount: result.deletedCount,
						}
					}
				}
				const value = Reflect.get(t, prop, t)
				return typeof value === "function" ? value.bind(t) : value
			},
		})
	}
	return {
		collection: (name: string): unknown =>
			name === metaName ? wrapMeta() : fake.db.collection(name),
		client: { startSession: () => session },
		listCollections,
	} as unknown as Db
}

describe("deleteAllForAgent — full tenant sweep (C-003)", () => {
	it("deletes the agent's documents from every tenant collection", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await seedSurvivors(fake)

		const receipt = await deleteAllForAgent({
			db: wrapForGateCore(fake),
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("complete")
		// Gate semantics: this attempt's own finalize reopened the gate.
		expect(receipt.epoch).toBe(1)
		expect(receipt.gateState).toBe("open")
		expect(typeof receipt.runId).toBe("string")
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
		expect(mutations[0].mutationId).toBe(receipt.mutationId)
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
		// per-agent gate document (deliberately outside the sweep) —
		// finalized OPEN with the erase record unset.
		const metaDocs = fake.all("meta")
		expect(metaDocs.length).toBe(2)
		expect(metaDocs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "schema_version", value: 4 }),
				expect.objectContaining({
					_id: `tenant-erasure-epoch:${AGENT}`,
					agentId: AGENT,
					epoch: 1,
					state: "open",
				}),
			]),
		)
		expect(gateDoc(fake)?.erase).toBeUndefined()
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
			db: wrapForGateCore(fake),
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("complete")
		expect(receipt.gateState).toBe("open")
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
			runId: receipt.runId,
			epoch: 1,
			collections: 30,
			// 30 swept documents (both artifacts) + the agent's pre-existing
			// audit history.
			deletedTotal: 32,
			failedCollections: [],
			residualCollections: [],
		})
	})

	it("reports per-collection failures instead of aborting the sweep (acknowledged partial audit → erasing)", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		fake.injectFailure({
			collection: "chunks",
			method: "deleteMany",
			error: new Error("chunks delete failed"),
		})

		const receipt = await deleteAllForAgent({
			db: wrapForGateCore(fake),
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("partial")
		expect(receipt.epoch).toBe(1)
		expect(typeof receipt.runId).toBe("string")
		// C-1 positive control (site 2): the fenced partial audit ACKNOWLEDGED,
		// so its fence re-validation is the ownership evidence for erasing.
		expect(receipt.gateState).toBe("erasing")
		expect(receipt.ownershipLost).toBeUndefined()
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
		expect(audit?.mutationId).toBe(receipt.mutationId)
		expect(audit?.meta).toMatchObject({
			status: "partial",
			runId: receipt.runId,
			failedCollections: ["chunks"],
			residualCollections: ["chunks"],
			gateLeftErasing: true,
		})
		// The gate itself is still erasing under this attempt's run.
		expect(gateDoc(fake)).toMatchObject({
			state: "erasing",
			erase: { runId: receipt.runId },
		})
	})

	it("W02: retains relevance_runs when the artifact sweep fails; the retry needs deliberate recovery", async () => {
		// The audit's reproduced shape: artifact deletion fails while the
		// parent delete would succeed. Pre-fix, the retry found no parents,
		// skipped the artifact delete, and reported complete with the
		// artifact retained. Post-fix, attempt 1 retains the parents; under
		// gate semantics the retry cannot begin fresh (the gate is still
		// erasing) — the operator retries through deliberate recovery, which
		// dispatches DIRECTLY to the takeover primitive.
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await seedSurvivors(fake)
		fake.injectFailure({
			collection: "relevance_artifacts",
			method: "deleteMany",
			error: new Error("artifact delete failed"),
			times: 1,
		})
		const db = wrapForGateCore(fake)

		const first = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// Attempt 1: partial — the artifact delete failed, so the parents are
		// RETAINED (they are the only way to reach the legacy artifact on the
		// next attempt). The partial audit acknowledged → erasing.
		expect(first.status).toBe("partial")
		expect(first.epoch).toBe(1)
		expect(first.gateState).toBe("erasing")
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

		// A plain retry cannot begin: an owner (this attempt) still holds the
		// gate, so beginErasure conflicts — the typed admin 409 propagates.
		await expect(
			deleteAllForAgent({ db, prefix: PREFIX, agentId: AGENT }),
		).rejects.toThrow(ErasureGateConflictError)

		// Retry through deliberate recovery (failure cleared): takeover
		// replaces the paused owner, artifacts are swept BEFORE the parents,
		// then the parents — complete, with no artifact retained.
		const second = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
			recovery: "takeover",
		})
		expect(second.status).toBe("complete")
		// Takeover INHERITS the epoch (only beginErasure advances it).
		expect(second.epoch).toBe(1)
		expect(second.gateState).toBe("open")
		expect(second.recovery).toBe("takeover")
		expect(second.runId).not.toBe(first.runId)
		expect(second.verification?.residual).toEqual([])
		expect(fake.all("relevance_artifacts").map((doc) => doc.runId)).toEqual([
			"run-agent-2",
		])
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBe(null)
		expect(gateDoc(fake)).toMatchObject({ state: "open", epoch: 1 })
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
		const db = wrapForGateCore(fake)

		const receipt = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("partial")
		expect(receipt.gateState).toBe("erasing")
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
		// artifacts, then the parents — complete through deliberate recovery.
		const second = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
			recovery: "takeover",
		})
		expect(second.status).toBe("complete")
		expect(second.gateState).toBe("open")
		expect(second.recovery).toBe("takeover")
		expect(fake.all("relevance_artifacts").map((doc) => doc.runId)).toEqual([
			"run-agent-2",
		])
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBe(null)
	})

	it("W03: refuses to sweep unfenced when gate entry fails", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		fake.injectFailure({
			collection: "meta",
			method: "findOneAndUpdate",
			error: new Error("begin failed"),
		})

		const receipt = await deleteAllForAgent({
			db: wrapForGateCore(fake),
			prefix: PREFIX,
			agentId: AGENT,
		})

		// No deletes ran at all; the receipt explains why. No token exists, so
		// runId and gateState are both omitted — nothing is proven.
		expect(receipt.status).toBe("partial")
		expect(receipt.epochError).toBe("begin failed")
		expect(receipt.epoch).toBeUndefined()
		expect(receipt.runId).toBeUndefined()
		expect(receipt.gateState).toBeUndefined()
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

	it("surfaces a failed proof-of-erasure audit write as partial with auditError (finalize failed, partial audit acknowledged)", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		// Fail ONLY the finalize audit insertOne — the memory_mutations
		// deleteMany in the sweep itself, and the partial audit's own
		// insertOne afterwards, still succeed.
		fake.injectFailure({
			collection: "memory_mutations",
			method: "insertOne",
			error: new Error("audit write failed"),
		})

		const receipt = await deleteAllForAgent({
			db: wrapForGateCore(fake),
			prefix: PREFIX,
			agentId: AGENT,
		})

		// All deletes succeeded, but the receipt must not claim "complete"
		// without the durable proof-of-erasure audit record: the finalize
		// transaction aborted on the audit write.
		expect(receipt.status).toBe("partial")
		expect(receipt.auditError).toBe(
			"proof-of-erasure audit write failed: audit write failed",
		)
		// The partial audit (a separate fenced write) DID land: its
		// acknowledgment re-validated ownership, so the receipt cites it for
		// erasing and carries its mutationId — C-1's discriminator is the
		// partial audit's OWN outcome, not the combined auditError.
		expect(receipt.gateState).toBe("erasing")
		expect(typeof receipt.mutationId).toBe("string")
		expect(receipt.receipts.every((entry) => entry.error === undefined)).toBe(
			true,
		)
		// The sweep itself still ran to completion.
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)
		expect(fake.findDoc("relevance_artifacts", { runId: "run-agent-1" })).toBe(
			null,
		)
		// Exactly the partial audit record exists, tagged with the failure.
		const mutations = fake.all("memory_mutations")
		expect(mutations.length).toBe(1)
		expect(mutations[0].mutationId).toBe(receipt.mutationId)
		expect(mutations[0].meta).toMatchObject({
			status: "partial",
			runId: receipt.runId,
			gateLeftErasing: true,
		})
		expect(gateDoc(fake)).toMatchObject({ state: "erasing" })
	})

	it("erases an agent with no data without touching other tenants", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedSurvivors(fake)

		const receipt = await deleteAllForAgent({
			db: wrapForGateCore(fake),
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("complete")
		expect(receipt.gateState).toBe("open")
		expect(typeof receipt.mutationId).toBe("string")
		// The artifact sweep still ran (agentId arm; nothing matched).
		const artifactsReceipt = receipt.receipts.find(
			(entry) => entry.collection === "relevance_artifacts",
		)
		expect(artifactsReceipt?.deleted).toBe(0)
		expect(artifactsReceipt?.error).toBeUndefined()
		expect(receipt.receipts.every((entry) => entry.deleted === 0)).toBe(true)
		expect(fake.all("events").length).toBe(1)
		expect(fake.all("relevance_artifacts").length).toBe(1)
		// The proof-of-erasure audit survives (written after the sweep).
		expect(
			fake.findDoc("memory_mutations", { "meta.kind": "tenant-erasure" }),
		).toMatchObject({ mutationId: receipt.mutationId })
	})
})

describe("deleteAllForAgent — C-1: gateState cites only an acknowledged partial audit", () => {
	it("site 2 (still-owned partial): an audit that errored without confirming ownership omits gateState", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		// A failed collection delete makes the attempt partial, and the
		// partial audit's own insertOne then fails with a NON-conflict
		// error: ownership was never re-validated after begin succeeded.
		fake.injectFailure({
			collection: "chunks",
			method: "deleteMany",
			error: new Error("chunks delete failed"),
		})
		fake.injectFailure({
			collection: "memory_mutations",
			method: "insertOne",
			error: new Error("partial audit failed"),
		})

		const receipt = await deleteAllForAgent({
			db: wrapForGateCore(fake),
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("partial")
		expect(receipt.epoch).toBe(1)
		expect(typeof receipt.runId).toBe("string")
		expect(receipt.auditError).toBe("partial audit failed")
		expect(receipt.mutationId).toBeUndefined()
		// C-1: begin success + an unobserved conflict prove nothing — the
		// unacknowledged audit leaves the gate state unproven from this seat.
		expect(receipt.gateState).toBeUndefined()
		// No conflict was observed, so no invented ownershipLost; this path
		// never finalized, so no finalizeIndeterminate.
		expect(receipt.ownershipLost).toBeUndefined()
		expect(receipt.finalizeIndeterminate).toBeUndefined()
		const chunksReceipt = receipt.receipts.find(
			(entry) => entry.collection === "chunks",
		)
		expect(chunksReceipt?.error).toBe("chunks delete failed")
		expect(receipt.verification?.residual).toEqual([
			{ collection: "chunks", count: 1 },
		])
		// No tenant-erasure audit record exists (the write failed).
		expect(
			fake.findDoc("memory_mutations", { "meta.kind": "tenant-erasure" }),
		).toBeNull()
		// Physical truth the receipt does not claim: the gate is still
		// erasing under this attempt's run.
		expect(gateDoc(fake)).toMatchObject({
			state: "erasing",
			erase: { runId: receipt.runId },
		})
	})

	it("site 1 (retained-sink fail-closed): a retained time-series sink partial with an acknowledged audit reports erasing and zero deletes", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await seedSurvivors(fake)
		const db = wrapForGateCore(fake, {
			listCollectionsBehavior: (name) =>
				name === `${PREFIX}memory_telemetry`
					? [{ name, type: "timeseries" }]
					: [{ name, type: "collection" }],
		})

		const receipt = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// Fail-closed BEFORE any sweep: exactly the retained sink is named,
		// nothing was deleted, and the attempt never reached verification.
		expect(receipt.status).toBe("partial")
		expect(receipt.epoch).toBe(1)
		expect(typeof receipt.runId).toBe("string")
		expect(receipt.receipts.length).toBe(1)
		expect(receipt.receipts[0].collection).toBe("memory_telemetry")
		expect(receipt.receipts[0].deleted).toBe(0)
		expect(receipt.receipts[0].error).toContain("time-series collection")
		expect(receipt.verification).toBeUndefined()
		expect(fake.findDoc("events", { agentId: AGENT })).toBeTruthy()
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBeTruthy()
		expect(
			fake.findDoc("access_events", { "meta.agentId": AGENT }),
		).toBeTruthy()
		// C-1 positive control (site 1): the partial audit acknowledged, so
		// its fence re-validation is the ownership evidence for erasing.
		expect(receipt.gateState).toBe("erasing")
		expect(receipt.ownershipLost).toBeUndefined()
		expect(typeof receipt.mutationId).toBe("string")
		expect(receipt.auditError).toBeUndefined()
		const audit = fake.findDoc("memory_mutations", {
			"meta.kind": "tenant-erasure",
		})
		expect(audit?.meta).toMatchObject({
			status: "partial",
			runId: receipt.runId,
			collections: 1,
			deletedTotal: 0,
			failedCollections: ["memory_telemetry"],
			gateLeftErasing: true,
		})
		// The gate stays erasing (admission closed) — migration + deliberate
		// recovery are the only way forward.
		expect(gateDoc(fake)).toMatchObject({
			state: "erasing",
			erase: { runId: receipt.runId },
		})
		// Other tenants were never touched.
		expect(fake.findDoc("events", { agentId: OTHER })).toBeTruthy()
	})

	it("site 1 (retained-sink fail-closed): a failed type-check read plus an unacknowledged audit omits gateState", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		const db = wrapForGateCore(fake, {
			listCollectionsBehavior: (name) => {
				if (name === `${PREFIX}memory_telemetry`) {
					throw new Error("type check read failed")
				}
				return [{ name, type: "collection" }]
			},
		})
		fake.injectFailure({
			collection: "memory_mutations",
			method: "insertOne",
			error: new Error("partial audit failed"),
		})

		const receipt = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		expect(receipt.status).toBe("partial")
		expect(receipt.epoch).toBe(1)
		expect(typeof receipt.runId).toBe("string")
		// The sink's safety was unproven, so the attempt failed closed with
		// the observed read error — zero deletes, one named receipt.
		expect(receipt.receipts.length).toBe(1)
		expect(receipt.receipts[0].collection).toBe("memory_telemetry")
		expect(receipt.receipts[0].error).toBe(
			"collection type check failed: type check read failed",
		)
		expect(fake.findDoc("events", { agentId: AGENT })).toBeTruthy()
		// C-1 (site 1 negative): the audit errored without confirming
		// ownership — gateState omitted, nothing invented.
		expect(receipt.auditError).toBe("partial audit failed")
		expect(receipt.gateState).toBeUndefined()
		expect(receipt.ownershipLost).toBeUndefined()
		expect(receipt.finalizeIndeterminate).toBeUndefined()
		expect(receipt.mutationId).toBeUndefined()
		expect(
			fake.findDoc("memory_mutations", { "meta.kind": "tenant-erasure" }),
		).toBeNull()
		expect(gateDoc(fake)).toMatchObject({ state: "erasing" })
	})
})

describe("deleteAllForAgent — gate conflicts and finalize outcomes (F2)", () => {
	it("recovery on an open/absent gate conflicts (typed 409) without deleting", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)

		// No owner holds the gate (no document exists at all): a recovery
		// request dispatches to takeoverErasure, which refuses — the
		// operator retries the ordinary path instead.
		await expect(
			deleteAllForAgent({
				db: wrapForGateCore(fake),
				prefix: PREFIX,
				agentId: AGENT,
				recovery: "takeover",
			}),
		).rejects.toThrow(ErasureGateConflictError)

		expect(fake.findDoc("events", { agentId: AGENT })).toBeTruthy()
		expect(
			fake.findDoc("memory_mutations", { "meta.kind": "tenant-erasure" }),
		).toBeNull()
		expect(gateDoc(fake)).toBeNull()
	})

	it("loses ownership mid-sweep to a real successor takeover and aborts terminally", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		// After the FIRST fence bump (the artifact sweep's), a real successor
		// steals the gate through takeoverErasure — the displaced attempt's
		// next fence check then conflicts against actual gate state.
		let successorTaken = false
		const db = wrapForGateCore(fake, {
			onFenceBump: async () => {
				if (successorTaken) return
				successorTaken = true
				await takeoverErasure({ db: fake.db, prefix: PREFIX, agentId: AGENT })
			},
		})

		const receipt = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// Terminal abort: the one batch that already held the fence landed
		// (both artifacts), everything after it was never swept.
		expect(receipt.status).toBe("partial")
		expect(receipt.ownershipLost).toBe(true)
		expect(receipt.epoch).toBe(1)
		expect(typeof receipt.runId).toBe("string")
		// The displaced owner cannot prove the gate's true state — no
		// gateState claim, no verification claim, no post-loss scanning.
		expect(receipt.gateState).toBeUndefined()
		expect(receipt.verification).toBeUndefined()
		expect(receipt.finalizeIndeterminate).toBeUndefined()
		expect(
			fake.findDoc("relevance_artifacts", { runId: "run-agent-1" }),
		).toBeNull()
		expect(
			fake.findDoc("relevance_artifacts", { runId: "run-orphaned" }),
		).toBeNull()
		expect(fake.findDoc("events", { agentId: AGENT })).toBeTruthy()
		expect(fake.findDoc("relevance_runs", { agentId: AGENT })).toBeTruthy()
		expect(fake.findDoc("memory_mutations", { agentId: AGENT })).toBeTruthy()
		// No partial audit was written for the displaced attempt.
		expect(
			fake.findDoc("memory_mutations", { "meta.kind": "tenant-erasure" }),
		).toBeNull()
		// The successor now owns the gate.
		expect(gateDoc(fake)).toMatchObject({ state: "erasing" })
		expect(gateDoc(fake)?.erase?.runId).not.toBe(receipt.runId)
	})

	it("reports finalizeIndeterminate when the finalize commit outcome is ambiguous", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		// meta.findOneAndUpdate call #1 is beginErasure; call #2 is
		// finalizeErasure's reopen on the clean path. Fail the reopen with a
		// commit-ambiguous error: the commit may have landed.
		const db = wrapForGateCore(fake, {
			failMetaFindOneAndUpdateOnCall: {
				call: 2,
				error: Object.assign(new Error("commit outcome unknown"), {
					errorLabels: ["UnknownTransactionCommitResult"],
				}),
			},
		})

		const receipt = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// Every delete ran, but the finalize acknowledgment never arrived:
		// neither "open" nor "erasing" is provable from this seat.
		expect(receipt.status).toBe("partial")
		expect(receipt.finalizeIndeterminate).toBe(true)
		expect(receipt.gateState).toBeUndefined()
		expect(receipt.ownershipLost).toBeUndefined()
		expect(receipt.auditError).toBeUndefined()
		expect(receipt.mutationId).toBeUndefined()
		expect(typeof receipt.runId).toBe("string")
		expect(receipt.verification?.residual).toEqual([])
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)
	})

	it("reports ownershipLost when the finalize owner validation observes a successor", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		const db = wrapForGateCore(fake, {
			failMetaFindOneAndUpdateOnCall: {
				call: 2,
				error: new ErasureGateConflictError(AGENT),
			},
		})

		const receipt = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// The finalize race observed a successor: terminal abort — gateState
		// omitted because the displaced owner cannot prove the gate's state.
		expect(receipt.status).toBe("partial")
		expect(receipt.ownershipLost).toBe(true)
		expect(receipt.gateState).toBeUndefined()
		expect(receipt.finalizeIndeterminate).toBeUndefined()
		expect(typeof receipt.runId).toBe("string")
		expect(receipt.verification?.residual).toEqual([])
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)
	})
})

// ---------------------------------------------------------------------------
// S3 (plan e5ec10dc §4.4): the erased agent's KB auto-refresh marker
// (`kb_last_auto_refresh:<agentId>`, mongodb-manager-sync.ts §4.1) is
// removed from meta WITH COMPLETION — the only meta write in the erasure
// module, exact-_id, inside the finalize writeAudit so a failure forces
// FinalizeAuditWriteError and blocks the complete receipt (C5). B's marker
// and global meta survive; the gate transition belongs to finalizeErasure's
// reopen, not the callback (C7); a partial path retains the marker —
// completion-only deletion, no time-bound lifetime claim (C6).
// ---------------------------------------------------------------------------
describe("deleteAllForAgent — S3: KB auto-refresh marker lifecycle (§4.4)", () => {
	afterEach(() => {
		finalizeSeam.reset()
	})

	it("U7: the finalize writeAudit deletes exactly the erased agent's KB marker from meta", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await seedSurvivors(fake)
		// Meta state: both tenants' KB auto-refresh markers plus the global
		// change-stream resume token (global operational state, no agentId —
		// deliberately outside the sweep; the gate doc arrives via
		// beginErasure during the run).
		await fake.collection("meta").insertOne({
			_id: `kb_last_auto_refresh:${AGENT}`,
			timestamp: new Date("2026-09-02T10:00:00.000Z"),
		})
		await fake.collection("meta").insertOne({
			_id: `kb_last_auto_refresh:${OTHER}`,
			timestamp: new Date("2026-09-02T10:00:00.000Z"),
		})
		await fake.collection("meta").insertOne({
			_id: "change_stream_resume_token",
			token: { _data: "resume" },
		})
		const metaDeleteFilters: Array<Document> = []
		const db = wrapForGateCore(fake, {
			onMetaDeleteOne: (filter) => metaDeleteFilters.push(filter),
		})
		finalizeSeam.capture = true

		await deleteAllForAgent({ db, prefix: PREFIX, agentId: AGENT })

		// Capture mode: the sweep ran for real; the mocked finalizeErasure
		// only recorded its writeAudit, so the gate is still erasing under
		// this run and the callback has NOT yet run.
		const writeAudit = finalizeSeam.capturedWriteAudit
		expect(writeAudit).toBeTypeOf("function")
		if (!writeAudit) throw new Error("writeAudit was not captured")
		const gateBefore = gateDoc(fake)
		expect(gateBefore).toMatchObject({ state: "erasing", epoch: 1 })

		// Replay the captured callback exactly as finalizeErasure would.
		await writeAudit(passthroughSession() as unknown as ClientSession)

		// Exactly ONE meta delete, exact-_id on A's marker — the only meta
		// write in the erasure module.
		expect(metaDeleteFilters).toEqual([
			{ _id: `kb_last_auto_refresh:${AGENT}` },
		])
		// A's marker is gone; B's marker, the resume token, and the global
		// schema marker all survive.
		expect(
			fake.findDoc("meta", { _id: `kb_last_auto_refresh:${AGENT}` }),
		).toBeNull()
		expect(
			fake.findDoc("meta", { _id: `kb_last_auto_refresh:${OTHER}` }),
		).toBeTruthy()
		expect(
			fake.findDoc("meta", { _id: "change_stream_resume_token" }),
		).toBeTruthy()
		expect(fake.findDoc("meta", { key: "schema_version" })).toBeTruthy()
		// C7: the gate doc's epoch/state transition belongs to
		// finalizeErasure's reopen, not this callback — the doc is unchanged
		// by the replay.
		expect(gateDoc(fake)).toEqual(gateBefore)
	})

	it("U16: a failed marker delete forces FinalizeAuditWriteError — partial, no complete receipt", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await fake.collection("meta").insertOne({
			_id: `kb_last_auto_refresh:${AGENT}`,
			timestamp: new Date("2026-09-02T10:00:00.000Z"),
		})
		// Fail ONLY the meta marker deleteOne inside the finalize writeAudit;
		// the sweep deletes and the partial audit's insertOne still succeed.
		const db = wrapForGateCore(fake, {
			failMetaDeleteOne: new Error("marker delete failed"),
		})

		const receipt = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// Every sweep delete succeeded, but the marker deletion participates
		// in finalization: its failure aborts the finalize transaction, so
		// no complete receipt is granted without the marker removed.
		expect(receipt.status).toBe("partial")
		expect(receipt.auditError).toBe(
			"proof-of-erasure audit write failed: marker delete failed",
		)
		// The partial audit (a separate fenced write) still acknowledged, so
		// the receipt cites it for erasing (C-1's discriminator is the
		// partial audit's OWN outcome, not the combined auditError).
		expect(receipt.gateState).toBe("erasing")
		expect(typeof receipt.mutationId).toBe("string")
		expect(receipt.receipts.every((entry) => entry.error === undefined)).toBe(
			true,
		)
		// The finalize transaction aborted before the reopen.
		expect(gateDoc(fake)).toMatchObject({ state: "erasing" })
		// The marker delete did not land — retained for the recovery retry.
		expect(
			fake.findDoc("meta", { _id: `kb_last_auto_refresh:${AGENT}` }),
		).toBeTruthy()
		// The sweep itself still ran to completion.
		expect(fake.findDoc("events", { agentId: AGENT })).toBe(null)
		// No complete proof-of-erasure was written; exactly the tagged
		// partial audit remains.
		const mutations = fake.all("memory_mutations")
		expect(mutations.length).toBe(1)
		expect(mutations[0].mutationId).toBe(receipt.mutationId)
		expect(mutations[0].meta).toMatchObject({
			status: "partial",
			runId: receipt.runId,
			gateLeftErasing: true,
		})
	})

	it("U17: the marker is deleted only with completion — a partial sweep retains it", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seedTenant(fake)
		await fake.collection("meta").insertOne({
			_id: `kb_last_auto_refresh:${AGENT}`,
			timestamp: new Date("2026-09-02T10:00:00.000Z"),
		})
		fake.injectFailure({
			collection: "chunks",
			method: "deleteMany",
			error: new Error("chunks delete failed"),
			times: 1,
		})
		const db = wrapForGateCore(fake)

		const first = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
		})

		// C6: deletion is completion-only — the partial path never runs the
		// finalize writeAudit, so the marker is RETAINED (no time-bound
		// lifetime claim: it simply waits for the deliberate recovery).
		expect(first.status).toBe("partial")
		expect(first.gateState).toBe("erasing")
		expect(
			fake.findDoc("meta", { _id: `kb_last_auto_refresh:${AGENT}` }),
		).toBeTruthy()

		// The deliberate recovery retry completes: the marker goes with it.
		const second = await deleteAllForAgent({
			db,
			prefix: PREFIX,
			agentId: AGENT,
			recovery: "takeover",
		})
		expect(second.status).toBe("complete")
		expect(second.gateState).toBe("open")
		expect(
			fake.findDoc("meta", { _id: `kb_last_auto_refresh:${AGENT}` }),
		).toBeNull()
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
		const manager = buildMockManager({
			db: wrapForGateCore(fake),
			prefix: PREFIX,
		})

		const receipt = await manager.deleteAllForAgent()

		expect(receipt.status).toBe("complete")
		expect(receipt.agentId).toBe(AGENT)
		expect(receipt.gateState).toBe("open")
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
