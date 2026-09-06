/**
 * Wave 1b live probe — W02/W03/W12 against the recovered memongo-preview
 * MongoDB, using PRODUCTION deleteAllForAgent / bumpTenantErasureEpoch /
 * promoteQuarantined on a disposable scratch database.
 *
 * W02: a real (injected-once) relevance_artifacts deleteMany failure must
 * yield a partial receipt with relevance_runs RETAINED; the retry (failure
 * cleared) sweeps artifacts BEFORE the parents and completes with no
 * artifact left — the audit's reproduced false-complete shape is gone.
 * W03: receipts carry the fencing epoch; a failed delete shows up in the
 * post-sweep verification as residual; a clean sweep verifies empty.
 * W12: a crashed promote (row manually left "promoting" with an expired
 * lease) is recovered by re-promotion; a stored structuredCandidate is
 * promoted verbatim (no matchPatterns reinterpretation).
 *
 * Exit 0 = all assertions pass; any failure prints and exits 1.
 */

import { randomUUID } from "node:crypto"
import type { Collection, Db, Document } from "mongodb"
import { MongoClient } from "mongodb"
import { deleteAllForAgent } from "../../../packages/memory-engine/src/mongodb-erasure.ts"
import {
	bumpTenantErasureEpoch,
	getTenantErasureEpoch,
} from "../../../packages/memory-engine/src/mongodb-erasure-epoch.ts"
import {
	insertQuarantinedForReview,
	promoteQuarantined,
} from "../../../packages/memory-engine/src/mongodb-quarantine-review.ts"

const database = `ddd_w1b_${randomUUID().replaceAll("-", "")}`
const PREFIX = "probe_"
const AGENT = "B"
const client = new MongoClient(
	"mongodb://127.0.0.1:27017/?directConnection=true",
	{ serverSelectionTimeoutMS: 5000 },
)

let failures = 0
function stable(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stable).join(",")}]`
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`
	}
	return JSON.stringify(value)
}
function check(label: string, actual: unknown, expected: unknown) {
	const ok = stable(actual) === stable(expected)
	if (!ok) {
		failures++
		console.error(
			`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		)
	} else {
		console.log(`ok   ${label} === ${JSON.stringify(expected)}`)
	}
}

/** Db handle whose relevance_artifacts deleteMany fails exactly once. */
function dbWithArtifactDeleteFailure(real: Db): Db {
	let failedOnce = false
	const wrap = (realColl: Collection<Document>): Collection<Document> =>
		new Proxy(realColl, {
			get(target, prop, receiver) {
				if (prop === "deleteMany" && !failedOnce) {
					failedOnce = true
					return async () => {
						throw new Error("injected artifact delete failure")
					}
				}
				return Reflect.get(target, prop, receiver)
			},
		}) as Collection<Document>
	return {
		collection: (name: string) =>
			name === `${PREFIX}relevance_artifacts`
				? wrap(real.collection(name))
				: real.collection(name),
	} as unknown as Db
}

/** Db handle whose events deleteMany fails exactly once. */
function dbWithEventsDeleteFailure(real: Db): Db {
	let failedOnce = false
	const wrap = (realColl: Collection<Document>): Collection<Document> =>
		new Proxy(realColl, {
			get(target, prop, receiver) {
				if (prop === "deleteMany" && !failedOnce) {
					failedOnce = true
					return async () => {
						throw new Error("injected events delete failure")
					}
				}
				return Reflect.get(target, prop, receiver)
			},
		}) as Collection<Document>
	return {
		collection: (name: string) =>
			name === `${PREFIX}events`
				? wrap(real.collection(name))
				: real.collection(name),
	} as unknown as Db
}

try {
	await client.connect()
	const db = client.db(database)

	// ---------------------------------------------------------------
	// Seed: one event, one run, one legacy artifact (runId only), one
	// new-style artifact (own agentId, parentless — the pre-fix orphan).
	// ---------------------------------------------------------------
	await db.collection(`${PREFIX}events`).insertOne({
		eventId: "evt-1",
		agentId: AGENT,
		body: "tenant data",
	})
	await db.collection(`${PREFIX}relevance_runs`).insertOne({
		runId: "R1",
		agentId: AGENT,
		status: "ok",
	})
	await db.collection(`${PREFIX}relevance_artifacts`).insertOne({
		runId: "R1",
		artifactType: "searchExplain",
	})
	await db.collection(`${PREFIX}relevance_artifacts`).insertOne({
		runId: "R2-orphan",
		agentId: AGENT,
		artifactType: "searchExplain",
	})

	// ---------------------------------------------------------------
	// W02 attempt 1: artifact delete fails once -> parents retained.
	// ---------------------------------------------------------------
	const first = await deleteAllForAgent({
		db: dbWithArtifactDeleteFailure(db),
		prefix: PREFIX,
		agentId: AGENT,
	})
	const runsReceipt1 = first.receipts.find(
		(r) => r.collection === "relevance_runs",
	)
	const artifactsReceipt1 = first.receipts.find(
		(r) => r.collection === "relevance_artifacts",
	)
	check("W02 attempt1 status partial", first.status, "partial")
	check("W02 attempt1 epoch 1", first.epoch, 1)
	check(
		"W02 attempt1 artifact delete error surfaced",
		artifactsReceipt1?.error,
		"injected artifact delete failure",
	)
	check(
		"W02 attempt1 relevance_runs retained with reason",
		typeof runsReceipt1?.error === "string" &&
			runsReceipt1.error.includes("retained for artifact retry"),
		true,
	)
	check(
		"W02 attempt1 runs row survives",
		await db.collection(`${PREFIX}relevance_runs`).countDocuments({ agentId: AGENT }),
		1,
	)
	check(
		"W02 attempt1 both artifacts survive",
		await db.collection(`${PREFIX}relevance_artifacts`).countDocuments({}),
		2,
	)
	check(
		"W02 attempt1 events swept",
		await db.collection(`${PREFIX}events`).countDocuments({ agentId: AGENT }),
		0,
	)

	// ---------------------------------------------------------------
	// W02 attempt 2: failure cleared -> artifacts before parents,
	// complete, nothing retained.
	// ---------------------------------------------------------------
	const second = await deleteAllForAgent({ db, prefix: PREFIX, agentId: AGENT })
	check("W02 attempt2 status complete", second.status, "complete")
	check("W02 attempt2 epoch 2", second.epoch, 2)
	check("W02 attempt2 verification clean", second.verification, {
		checked: 30,
		residual: [],
	})
	check(
		"W02 attempt2 no artifacts remain",
		await db.collection(`${PREFIX}relevance_artifacts`).countDocuments({}),
		0,
	)
	check(
		"W02 attempt2 runs gone",
		await db.collection(`${PREFIX}relevance_runs`).countDocuments({}),
		0,
	)

	// ---------------------------------------------------------------
	// W03: a failed delete is CONFIRMED by the verification pass as a
	// residual; the retry completes.
	// ---------------------------------------------------------------
	await db.collection(`${PREFIX}events`).insertOne({
		eventId: "evt-2",
		agentId: AGENT,
		body: "resurrection check",
	})
	const third = await deleteAllForAgent({
		db: dbWithEventsDeleteFailure(db),
		prefix: PREFIX,
		agentId: AGENT,
	})
	check("W03 failed-delete status partial", third.status, "partial")
	check(
		"W03 residual confirmed by verification",
		third.verification?.residual,
		[{ collection: "events", count: 1 }],
	)
	const fourth = await deleteAllForAgent({ db, prefix: PREFIX, agentId: AGENT })
	check("W03 retry complete", fourth.status, "complete")
	check("W03 retry epoch 4", fourth.epoch, 4)
	check(
		"W03 epoch primitive monotonic",
		await getTenantErasureEpoch(db, PREFIX, AGENT),
		4,
	)
	check(
		"W03 epoch bump returns next value",
		await bumpTenantErasureEpoch(db, PREFIX, AGENT),
		5,
	)

	// ---------------------------------------------------------------
	// W12: crashed promote recovered; candidate roundtrip verbatim.
	// ---------------------------------------------------------------
	const { quarantineId } = await insertQuarantinedForReview({
		db,
		prefix: PREFIX,
		agentId: AGENT,
		content: "I prefer tabs over spaces in TypeScript files",
		matchedPatterns: ["instruction-override"],
		scope: "user",
		scopeRef: "user-42",
	})
	// Simulate the crash: claimed into "promoting", lease long expired.
	await db.collection(`${PREFIX}memory_quarantine`).updateOne(
		{ quarantineId },
		{
			$set: {
				status: "promoting",
				promoteClaimedAt: new Date(Date.now() - 3600_000),
				promoteLeaseExpiresAt: new Date(Date.now() - 3400_000),
			},
		},
	)
	const promoted = await promoteQuarantined({
		db,
		prefix: PREFIX,
		agentId: AGENT,
		quarantineId,
		embeddingMode: "automated",
		reviewerId: "reviewer-7",
	})
	check("W12 recovered promote status", promoted.status, "promoted")
	check("W12 recovered promote finalize clean", promoted.finalizeError, undefined)
	check("W12 recovered promote memory written", typeof promoted.memoryId, "string")
	const quarantinedRow = await db
		.collection(`${PREFIX}memory_quarantine`)
		.findOne({ quarantineId })
	check("W12 row finalized promoted", quarantinedRow?.status, "promoted")
	check("W12 row carries memoryId", quarantinedRow?.memoryId, promoted.memoryId)

	// Candidate roundtrip: original type/key/value preserved verbatim, NOT
	// re-derived from the rendered text (which matchPatterns would map to a
	// preference about tabs).
	const candId = "cand-1"
	await db.collection(`${PREFIX}memory_quarantine`).insertOne({
		quarantineId: candId,
		agentId: AGENT,
		scope: "user",
		scopeRef: "user-42",
		content: "I prefer tabs over spaces in TypeScript files",
		structuredCandidate: {
			type: "fact",
			key: "home_city",
			value: "Berlin",
			confidence: 0.9,
		},
		classification: "injection-likely",
		tier: "pattern",
		matchedPatterns: ["instruction-override"],
		status: "pending-review",
		createdAt: new Date(),
	})
	const restored = await promoteQuarantined({
		db,
		prefix: PREFIX,
		agentId: AGENT,
		quarantineId: candId,
		embeddingMode: "automated",
	})
	const restoredDoc = await db.collection(`${PREFIX}structured_mem`).findOne({
		agentId: AGENT,
		type: "fact",
		key: "home_city",
	})
	check("W12 restored promote status", restored.status, "promoted")
	check("W12 candidate type verbatim", restoredDoc?.type, "fact")
	check("W12 candidate key verbatim", restoredDoc?.key, "home_city")
	check("W12 candidate value verbatim", restoredDoc?.value, "Berlin")
	check("W12 candidate confidence verbatim", restoredDoc?.confidence, 0.9)
	check(
		"W12 provenance marks restoredCandidate",
		restoredDoc?.provenance?.restoredCandidate,
		true,
	)

	if (failures > 0) {
		console.error(`\nWave 1b probe: ${failures} assertion(s) FAILED`)
		process.exitCode = 1
	} else {
		console.log("\nWave 1b probe: all assertions passed")
	}
} finally {
	if (client) {
		await client.db(database).dropDatabase()
		console.log(
			JSON.stringify({ cleanup: "dropped disposable probe database", database }),
		)
		await client.close()
	}
}
