// W03 (2026-09-05 independent audit): durable per-agent erasure epoch.
// Erasure must be fenced against active work: a worker that claimed a job
// or holds an event in memory before an erasure must not keep writing that
// tenant's data after the sweep. The fence is a monotonic per-agent epoch
// stored in the GLOBAL `meta` collection — global operational state is
// deliberately outside the erasure sweep (see mongodb-erasure.ts), so the
// epoch survives every erasure of its own tenant.
//
// Contract:
//   - getTenantErasureEpoch: current epoch; 0 when no erasure ever ran.
//   - bumpTenantErasureEpoch: atomically increments and returns the new
//     epoch. Workers capture the epoch when they claim work and abandon at
//     their next fence check when it advances.
//
// Grounding: updateOne/upsert semantics with a uniquely-indexed filter
// (the epoch document's `_id`) cannot multi-insert under concurrency
// (MongoDB manual, db.collection.updateOne; EL-013).
import type { Db, ObjectId } from "mongodb"
import { metaCollection } from "./mongodb-schema.js"

const EPOCH_DOC_PREFIX = "tenant-erasure-epoch:"

type EpochDoc = {
	_id: string | ObjectId
	agentId: string
	epoch: number
	updatedAt: Date
}

function epochDocId(agentId: string): string {
	return `${EPOCH_DOC_PREFIX}${agentId}`
}

/**
 * The driver types `Collection<Document>`'s `_id` as ObjectId, but the epoch
 * document deliberately uses a deterministic STRING `_id`
 * (`tenant-erasure-epoch:<agentId>`) — unique by construction, so the
 * upsert below can never multi-insert. The cast reconciles the type-level
 * assumption with the string-keyed convention.
 */
function epochFilter(agentId: string): { _id: ObjectId } {
	return { _id: epochDocId(agentId) as unknown as ObjectId }
}

/**
 * Current erasure epoch for one agent. 0 when no erasure has ever run for
 * the agent (workers then proceed without an epoch constraint).
 */
export async function getTenantErasureEpoch(
	db: Db,
	prefix: string,
	agentId: string,
): Promise<number> {
	const doc = (await metaCollection(db, prefix).findOne(
		epochFilter(agentId),
	)) as EpochDoc | null
	if (!doc || typeof doc.epoch !== "number" || !Number.isFinite(doc.epoch)) {
		return 0
	}
	return doc.epoch
}

/**
 * Atomically advance the agent's erasure epoch and return the new value.
 * Every pre-existing claim on this tenant's data becomes stale the moment
 * this returns; workers that re-read the epoch at their fence checks
 * abandon instead of resurrecting erased data.
 */
export async function bumpTenantErasureEpoch(
	db: Db,
	prefix: string,
	agentId: string,
): Promise<number> {
	const result = await metaCollection(db, prefix).findOneAndUpdate(
		epochFilter(agentId),
		{
			$inc: { epoch: 1 },
			$set: { agentId, updatedAt: new Date() },
		},
		{ upsert: true, returnDocument: "after" },
	)
	const doc = result as unknown as EpochDoc | null
	if (!doc || typeof doc.epoch !== "number" || !Number.isFinite(doc.epoch)) {
		throw new Error("tenant erasure epoch bump returned no usable epoch")
	}
	return doc.epoch
}
