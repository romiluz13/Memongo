/**
 * Wave 1c live probe — W05/W18/W19 job-queue safety against the live
 * memongo-preview MongoDB, using PRODUCTION claimMemoryJob /
 * deadLetterExpiredMemoryJobs / renewMemoryJobLease /
 * MEMORY_JOB_MAX_ATTEMPTS on a disposable scratch database.
 *
 * W05: a running row marked `tracking: true` (a live explicit-consolidation
 * run's audit row, no lease) is NOT claimable — the worker cannot steal a
 * synchronous run. Legacy pre-lease running rows (no tracking field) stay
 * reclaimable.
 * W18: a running row whose retry budget is spent (attempts >= MAX) is NOT
 * claimable; the dead-letter sweep transitions exactly those rows to
 * failed + deadLetterAt (lease fields cleared, no completedAt), is
 * idempotent on re-run, and excludes tracking rows.
 * W19: the lease renewal that the fence forces is a CONDITIONAL server-side
 * ownership proof — wrong token or expired lease does not match.
 *
 * Exit 0 = all assertions pass; any failure prints and exits 1.
 */

import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import { memoryJobsCollection } from "../../../packages/memory-engine/src/mongodb-schema-collections.ts"
import {
	claimMemoryJob,
	deadLetterExpiredMemoryJobs,
	MEMORY_JOB_MAX_ATTEMPTS,
	renewMemoryJobLease,
} from "../../../packages/memory-engine/src/mongodb-memory-jobs.ts"

const database = `ddd_w1c_${randomUUID().replaceAll("-", "")}`
const PREFIX = "probe_"
const URI = "mongodb://127.0.0.1:27019/?directConnection=true"
const WORKER = "probe-worker"
const LEASE_MS = 60_000
const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 })

let failures = 0
let total = 0
function stable(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stable).join(",")}]`
	}
	if (value instanceof Date) {
		return `date:${value.getTime()}`
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
	total++
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

type SeedRow = {
	jobId: string
	agentId: string
	status: "running" | "pending"
	attempts: number
	tracking?: boolean
	leaseExpiresAt?: Date
	leaseOwner?: string
	leaseToken?: string
}

async function seedRow(db: import("mongodb").Db, row: SeedRow) {
	await memoryJobsCollection(db, PREFIX).insertOne({
		jobId: row.jobId,
		agentId: row.agentId,
		jobType: "extraction",
		status: row.status,
		createdAt: new Date(Date.now() - 60_000),
		startedAt: new Date(Date.now() - 60_000),
		attempts: row.attempts,
		payload: { eventId: `evt-${row.jobId}` },
		metadata: { note: "w1c probe seed" },
		...(row.tracking ? { tracking: true } : {}),
		...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
		...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
		...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
	})
}

try {
	await client.connect()
	const db = client.db(database)
	const past = () => new Date(Date.now() - 5_000)

	// One agent per scenario so every claim call is isolated by its filter.
	const A = "w1c-a-control" // pending row, claim works (control)
	const B = "w1c-b-tracking" // running + tracking:true, no lease (W05)
	const C = "w1c-c-legacy" // running, no tracking, no lease (legacy reclaim)
	const D = "w1c-d-spent" // running, expired lease, attempts at MAX (W18)
	const E = "w1c-e-deadletter" // running, expired lease, attempts at MAX (W18 sweep)
	const F = "w1c-f-tracking" // running + tracking, expired lease, MAX (W18 sweep exclusion)

	await seedRow(db, {
		jobId: "job-a",
		agentId: A,
		status: "pending",
		attempts: 0,
	})
	await seedRow(db, {
		jobId: "job-b",
		agentId: B,
		status: "running",
		attempts: 1,
		tracking: true,
	})
	await seedRow(db, {
		jobId: "job-c",
		agentId: C,
		status: "running",
		attempts: 1,
	})
	await seedRow(db, {
		jobId: "job-d",
		agentId: D,
		status: "running",
		attempts: MEMORY_JOB_MAX_ATTEMPTS,
		leaseExpiresAt: past(),
		leaseOwner: "worker-old",
		leaseToken: "token-old",
	})
	await seedRow(db, {
		jobId: "job-e",
		agentId: E,
		status: "running",
		attempts: MEMORY_JOB_MAX_ATTEMPTS,
		leaseExpiresAt: past(),
		leaseOwner: "worker-old",
		leaseToken: "token-old",
	})
	await seedRow(db, {
		jobId: "job-f",
		agentId: F,
		status: "running",
		attempts: MEMORY_JOB_MAX_ATTEMPTS,
		tracking: true,
		leaseExpiresAt: past(),
		leaseOwner: "worker-old",
		leaseToken: "token-old",
	})

	// --- control: a pending row claims normally -----------------------
	const claimedA = await claimMemoryJob({
		db,
		prefix: PREFIX,
		agentId: A,
		jobType: "extraction",
		workerId: WORKER,
		leaseMs: LEASE_MS,
	})
	check("control pending row is claimed", claimedA?.jobId ?? null, "job-a")
	check("claim stamps the lease token", (claimedA?.leaseToken ?? null) !== null, true)
	check(
		"claim sets a future lease expiry",
		(claimedA?.leaseExpiresAt ?? past()).getTime() > Date.now(),
		true,
	)

	// --- W05: tracking rows are not claimable -------------------------
	const claimedB = await claimMemoryJob({
		db,
		prefix: PREFIX,
		agentId: B,
		jobType: "extraction",
		workerId: WORKER,
		leaseMs: LEASE_MS,
	})
	check("W05 tracking row is NOT claimable", claimedB, null)

	// --- legacy lease-less running rows stay reclaimable --------------
	const claimedC = await claimMemoryJob({
		db,
		prefix: PREFIX,
		agentId: C,
		jobType: "extraction",
		workerId: WORKER,
		leaseMs: LEASE_MS,
	})
	check("legacy lease-less running row is reclaimed", claimedC?.jobId ?? null, "job-c")
	check("reclaim spends one more attempt", claimedC?.attempts ?? 0, 2)

	// --- W18: spent budget is not claimable ---------------------------
	const claimedD = await claimMemoryJob({
		db,
		prefix: PREFIX,
		agentId: D,
		jobType: "extraction",
		workerId: WORKER,
		leaseMs: LEASE_MS,
	})
	check("W18 spent-budget running row is NOT claimable", claimedD, null)

	// --- W18: dead-letter sweep ---------------------------------------
	const swept = await deadLetterExpiredMemoryJobs({ db, prefix: PREFIX, agentId: E })
	check("W18 sweep transitions the spent row", swept, 1)
	const afterSweep = await memoryJobsCollection(db, PREFIX).findOne({ jobId: "job-e" })
	check("swept row status", afterSweep?.status, "failed")
	check("swept row has deadLetterAt", (afterSweep?.deadLetterAt ?? null) !== null, true)
	check(
		"swept row error names the reason",
		afterSweep?.error,
		"lease-expiry retry budget exhausted",
	)
	check("swept row has no completedAt", afterSweep?.completedAt, undefined)
	check("swept row has no retryAt", afterSweep?.retryAt, undefined)
	check("swept row has no leaseOwner", afterSweep?.leaseOwner, undefined)
	check("swept row has no leaseToken", afterSweep?.leaseToken, undefined)
	check("swept row has no leaseExpiresAt", afterSweep?.leaseExpiresAt, undefined)
	check("swept row has no heartbeatAt", afterSweep?.heartbeatAt, undefined)
	const reswept = await deadLetterExpiredMemoryJobs({ db, prefix: PREFIX, agentId: E })
	check("W18 sweep is idempotent on re-run", reswept, 0)

	// --- W18: sweep excludes tracking rows ----------------------------
	const sweptF = await deadLetterExpiredMemoryJobs({ db, prefix: PREFIX, agentId: F })
	check("W18 sweep excludes the tracking row", sweptF, 0)
	const rowF = await memoryJobsCollection(db, PREFIX).findOne({ jobId: "job-f" })
	check("tracking row still running after sweep", rowF?.status, "running")
	check("tracking row not dead-lettered", rowF?.deadLetterAt, undefined)

	// --- W18: the dead letter itself stays unclaimable ----------------
	const claimedE = await claimMemoryJob({
		db,
		prefix: PREFIX,
		agentId: E,
		jobType: "extraction",
		workerId: WORKER,
		leaseMs: LEASE_MS,
	})
	check("dead-lettered row is NOT claimable", claimedE, null)

	// --- W19: renewal is a conditional ownership proof ----------------
	const renewedWrongToken = await renewMemoryJobLease({
		db,
		prefix: PREFIX,
		jobId: "job-a",
		agentId: A,
		leaseOwner: WORKER,
		leaseToken: "not-the-token",
		leaseMs: LEASE_MS,
	})
	check("W19 renew rejects a wrong lease token", renewedWrongToken, false)
	const renewedRight = await renewMemoryJobLease({
		db,
		prefix: PREFIX,
		jobId: "job-a",
		agentId: A,
		leaseOwner: WORKER,
		leaseToken: claimedA?.leaseToken ?? "",
		leaseMs: LEASE_MS,
	})
	check("W19 renew accepts the current lease", renewedRight, true)
	await memoryJobsCollection(db, PREFIX).updateOne(
		{ jobId: "job-a" },
		{ $set: { leaseExpiresAt: past() } },
	)
	const renewedExpired = await renewMemoryJobLease({
		db,
		prefix: PREFIX,
		jobId: "job-a",
		agentId: A,
		leaseOwner: WORKER,
		leaseToken: claimedA?.leaseToken ?? "",
		leaseMs: LEASE_MS,
	})
	check("W19 renew rejects an expired lease", renewedExpired, false)

	console.log(
		`w1c probe: ${total - failures}/${total} assertions pass on ${database} (MongoDB ${URI})`,
	)
} finally {
	if (client.topology?.isConnected?.() ?? true) {
		try {
			await client.db(database).dropDatabase()
			console.log(`cleanup: dropped scratch database ${database}`)
		} catch {
			/* connection already gone */
		}
	}
	await client.close()
}

if (failures > 0) {
	process.exitCode = 1
}
