// Live-MongoDB regressions for the consolidation retry path: failed gate
// reclaim, caller-option preservation across failure, and tracking-row
// adoption. Each scenario exercises the real chain — createMemoryJob /
// public consolidate() → claimMemoryJob →
// MongoDBManagerJobsOps.runClaimedConsolidationJob → consolidateMemory and
// the consolidation gate. Graph/gate failures are genuine captured
// MongoBulkWriteError instances (immutable-_id modification, code 66, never
// a duplicate key) injected through a db.collection Proxy, the same harness
// as mongodb-graph-durability.e2e.test.ts. Retry backoff is fast-forwarded
// by stamping retryAt into the past. Unique disposable database, dropped
// and verified in afterAll.

import { randomUUID } from "node:crypto"
import {
	MongoClient,
	type Collection,
	type Db,
	MongoBulkWriteError,
	ObjectId,
} from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { writeEvent } from "./mongodb-events.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import { claimMemoryJob, createMemoryJob } from "./mongodb-memory-jobs.js"
import {
	consolidationRunsCollection,
	eventsCollection,
	memoryJobsCollection,
} from "./mongodb-schema-collections.js"
import { ensureGraphStandardIndexes } from "./mongodb-schema-standard-indexes-graph.js"
import { ensureOperationalStandardIndexes } from "./mongodb-schema-standard-indexes-operations.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"
import type { ClaimedMemoryJob } from "./types.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27017/?directConnection=true",
)
const TEST_DB = `memongo_consolidation_retry_${randomUUID().slice(0, 8)}`
const PREFIX = ""
const WORKER = "b1-retry-e2e-worker"
const LEASE_MS = 30_000
const TIMEOUT = 60_000

let client: MongoClient
let db: Db

/** Proxy one named collection's methods; everything else passes through. */
function dbWithCollectionOverride(
	base: Db,
	collectionName: string,
	override: (real: Collection) => Record<string, unknown>,
): Db {
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop !== "collection") {
				const value = Reflect.get(target, prop, receiver)
				return typeof value === "function" ? value.bind(target) : value
			}
			return (name: string) => {
				const real = target.collection(name)
				if (name !== collectionName) {
					return real
				}
				const fns = override(real)
				return new Proxy(real, {
					get(colTarget, colProp, colReceiver) {
						if (typeof colProp === "string" && colProp in fns) {
							return fns[colProp]
						}
						const value = Reflect.get(colTarget, colProp, colReceiver)
						return typeof value === "function" ? value.bind(colTarget) : value
					},
				})
			}
		},
	})
}

function dbWithFailingEntitiesBulkWrite(base: Db, err: Error): Db {
	return dbWithCollectionOverride(base, `${PREFIX}entities`, () => ({
		bulkWrite: async () => {
			throw err
		},
	})) as Db
}

function dbWithFailingGateClaim(base: Db, err: Error): Db {
	return dbWithCollectionOverride(base, `${PREFIX}consolidation_runs`, () => ({
		findOneAndUpdate: async () => {
			throw err
		},
	})) as Db
}

/** Genuine non-duplicate MongoBulkWriteError: immutable-_id modification. */
async function captureRealNonDuplicateBulkError(
	col: Collection,
): Promise<Error> {
	const name = `immutable-probe-${randomUUID()}`
	await col.insertOne({
		name,
		entityId: `probe-${randomUUID()}`,
		agentId: `probe-${randomUUID()}`,
		scope: "probe",
		scopeRef: `probe-${randomUUID()}`,
		probeId: randomUUID(),
		createdAt: new Date(),
	})
	const err = await col
		.bulkWrite(
			[
				{
					updateOne: {
						filter: { name },
						update: { $set: { _id: new ObjectId() } },
						upsert: false,
					},
				},
			],
			{ ordered: false },
		)
		.then(
			() => null,
			(caught) => caught as Error & { writeErrors?: Array<{ code?: number }> },
		)
	if (!err || !(err instanceof MongoBulkWriteError)) {
		throw new Error("expected genuine MongoBulkWriteError")
	}
	if (err.writeErrors?.[0]?.code === 11000) {
		throw new Error("captured error must NOT be a duplicate key")
	}
	return err
}

/** Minimal host stub: only the fields the consolidation runner touches. */
function hostStub(
	clientArg: MongoClient,
	dbArg: Db,
	agentId: string,
): MongoDBManagerHost {
	return {
		client: clientArg,
		db: dbArg,
		prefix: PREFIX,
		agentId,
		workspaceDir: "/tmp/b1-retry-e2e",
		agentScopeRef: agentId,
		workspaceScopeRef: "ws",
		extraMemoryPaths: [],
		memoryJobWorkerId: WORKER,
		isDuplicateKeyError: (err: unknown) =>
			typeof err === "object" &&
			err !== null &&
			(err as { code?: number }).code === 11000,
	} as unknown as MongoDBManagerHost
}

type Runner = (
	job: ClaimedMemoryJob,
	epochAtClaim: number | null,
) => Promise<void>

function runnerOf(ops: MongoDBManagerJobsOps): Runner {
	// TS-private method, real implementation — runtime access only.
	return (
		ops as unknown as { runClaimedConsolidationJob: Runner }
	).runClaimedConsolidationJob.bind(ops)
}

function restoredOptions(
	metadata: Record<string, unknown> | undefined,
): { scope?: string; scopeRef?: string; maxEvents?: number } | undefined {
	return (
		MongoDBManagerJobsOps as unknown as {
			consolidationOptionsFromMetadata: (
				m: Record<string, unknown> | undefined,
			) => { scope?: string; scopeRef?: string; maxEvents?: number } | undefined
		}
	).consolidationOptionsFromMetadata(metadata)
}

async function claim(agentId: string): Promise<ClaimedMemoryJob> {
	const job = await claimMemoryJob({
		db,
		prefix: PREFIX,
		agentId,
		jobType: "consolidation",
		workerId: WORKER,
		leaseMs: LEASE_MS,
	})
	if (!job) {
		throw new Error(`no claimable consolidation job for ${agentId}`)
	}
	return job
}

async function skipBackoff(jobId: string): Promise<void> {
	// Test-only: move the retry backoff deadline into the past instead of
	// sleeping out the 60s first-attempt delay.
	await memoryJobsCollection(db, PREFIX).updateOne(
		{ jobId },
		{ $set: { retryAt: new Date(0) } },
	)
}

beforeAll(async () => {
	client = new MongoClient(TEST_URI, {
		serverSelectionTimeoutMS: 10_000,
		connectTimeoutMS: 10_000,
	})
	await client.connect()
	db = client.db(TEST_DB)
	await ensureGraphStandardIndexes(db, PREFIX)
	await ensureOperationalStandardIndexes(db, PREFIX)
}, TIMEOUT)

afterAll(async () => {
	try {
		if (db) {
			await db.dropDatabase()
			const listed = await client
				.db("admin")
				.admin()
				.listDatabases({ nameOnly: true, filter: { name: TEST_DB } })
			expect(
				listed.databases.length,
				"disposable database must be absent after teardown",
			).toBe(0)
		}
	} finally {
		await client?.close()
	}
}, TIMEOUT)

describe("consolidation failed-then-retry (live MongoDB, disposable database)", () => {
	it(
		"a retry reclaims the failed gate run and processes + acknowledges the intended event",
		async () => {
			const agentId = `b1f1-${randomUUID().slice(0, 8)}`
			const jobId = `cons-${agentId}`
			const jobs = memoryJobsCollection(db, PREFIX)
			const runs = consolidationRunsCollection(db, PREFIX)
			const events = eventsCollection(db, PREFIX)
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					agentId,
					role: "user",
					body: "Talked to @mongodb about the @dreamer pipeline",
					scope: "agent",
				},
			})
			await createMemoryJob({
				db,
				prefix: PREFIX,
				job: {
					jobId,
					jobType: "consolidation",
					agentId,
					status: "pending",
					metadata: { auto: true, window: 1 },
				},
			})

			// Attempt 1: real runner, the entities bulkWrite genuinely fails.
			const graphError = await captureRealNonDuplicateBulkError(
				db.collection(`${PREFIX}entities`),
			)
			let injected = false
			const proxiedOnce = dbWithCollectionOverride(
				db,
				`${PREFIX}entities`,
				(real) => ({
					bulkWrite: async (...args: unknown[]) => {
						if (!injected) {
							injected = true
							throw graphError
						}
						return (real.bulkWrite as (...a: unknown[]) => unknown)(...args)
					},
				}),
			) as Db
			const claimed1 = await claim(agentId)
			expect(claimed1.attempts).toBe(1)
			await runnerOf(
				new MongoDBManagerJobsOps(hostStub(client, proxiedOnce, agentId)),
			)(claimed1, null)

			const jobAfter1 = await jobs.findOne({ jobId })
			const runAfter1 = await runs.findOne({ agentId })
			const eventAfter1 = await events.findOne({ agentId })
			expect(jobAfter1?.status).toBe("failed")
			// Bounded retry behavior preserved: first failure backs off ~60s.
			const retryDelayMs =
				(jobAfter1?.retryAt as Date | undefined)?.getTime() ?? Number.NaN
			expect(retryDelayMs - Date.now()).toBeGreaterThan(50_000)
			expect(retryDelayMs - Date.now()).toBeLessThan(70_000)
			expect(runAfter1?.status).toBe("failed")
			expect(eventAfter1?.dreamerProcessedAt).toBeUndefined()

			// Attempt 2 (retry): same real runner, healthy db. P1: the failed
			// gate run is reclaimable — the SAME gate doc is re-claimed and
			// terminally written by this execution.
			await skipBackoff(jobId)
			const claimed2 = await claim(agentId)
			expect(claimed2.attempts).toBe(2)
			await runnerOf(new MongoDBManagerJobsOps(hostStub(client, db, agentId)))(
				claimed2,
				null,
			)

			const jobAfter2 = await jobs.findOne({ jobId })
			const runDocs = await runs.find({ agentId }).toArray()
			const eventAfter2 = await events.findOne({ agentId })
			expect(jobAfter2?.status).toBe("completed")
			// One gate doc, reclaimed in place: same gateKey, now terminally
			// completed with real counts — not a gate-swallowed empty success.
			expect(runDocs).toHaveLength(1)
			expect(runDocs[0]?.gateKey).toBe(runAfter1?.gateKey)
			expect(runDocs[0]?.status).toBe("completed")
			expect(runDocs[0]?.eventsProcessed).toBe(1)
			// The event was actually processed and acknowledged.
			expect(eventAfter2?.dreamerProcessedAt).toBeInstanceOf(Date)
			expect(eventAfter2?.dreamerRunId).toBe(runDocs[0]?.runId)
			// No phantom runId: the completed job's metadata.runId is the
			// runId the gate doc actually carries.
			expect(
				(jobAfter2?.metadata as Record<string, unknown> | undefined)?.runId,
			).toBe(runDocs[0]?.runId)
		},
		TIMEOUT,
	)

	it(
		"a failure preserves the caller options and the scoped retry leaves unrelated events untouched",
		async () => {
			const agentId = `b1f2-${randomUUID().slice(0, 8)}`
			const jobId = `cons-${agentId}`
			const jobs = memoryJobsCollection(db, PREFIX)
			const runs = consolidationRunsCollection(db, PREFIX)
			const events = eventsCollection(db, PREFIX)
			const wsEventId = `evt-ws-${randomUUID().slice(0, 8)}`
			const agentEventId = `evt-agent-${randomUUID().slice(0, 8)}`
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: wsEventId,
					agentId,
					role: "user",
					body: "Workspace note about @acme and @billing",
					scope: "workspace",
					scopeRef: "ws-1",
				},
			})
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: agentEventId,
					agentId,
					role: "user",
					body: "Agent-wide note about @globex and @roadmap",
					scope: "agent",
				},
			})
			const originalMetadata = {
				scope: "workspace",
				scopeRef: "ws-1",
				maxEvents: 5,
				minCombinedScore: 0,
			}
			await createMemoryJob({
				db,
				prefix: PREFIX,
				job: {
					jobId,
					jobType: "consolidation",
					agentId,
					status: "pending",
					metadata: originalMetadata,
				},
			})

			// Attempt 1: workspace-scoped run, graph write always fails.
			const graphError = await captureRealNonDuplicateBulkError(
				db.collection(`${PREFIX}entities`),
			)
			const proxiedAlways = dbWithFailingEntitiesBulkWrite(db, graphError)
			const claimed1 = await claim(agentId)
			await runnerOf(
				new MongoDBManagerJobsOps(hostStub(client, proxiedAlways, agentId)),
			)(claimed1, null)

			// P2: the failure left the original caller options in place — no
			// {auto:true} replacement — so the retry restores the caller's scope.
			const jobAfterFail = await jobs.findOne({ jobId })
			expect(jobAfterFail?.status).toBe("failed")
			expect(jobAfterFail?.metadata).toEqual(originalMetadata)
			expect(
				restoredOptions(
					jobAfterFail?.metadata as Record<string, unknown> | undefined,
				),
			).toMatchObject({ scope: "workspace", scopeRef: "ws-1", maxEvents: 5 })

			// Attempt 2 (retry): healthy db; the retry re-runs the SAME scoped
			// gate and never touches the unrelated agent-scope event.
			await skipBackoff(jobId)
			const claimed2 = await claim(agentId)
			expect(claimed2.attempts).toBe(2)
			await runnerOf(new MongoDBManagerJobsOps(hostStub(client, db, agentId)))(
				claimed2,
				null,
			)

			const jobAfter2 = await jobs.findOne({ jobId })
			const runDocs = await runs.find({ agentId }).toArray()
			const wsEvent = await events.findOne({ eventId: wsEventId })
			const agentEvent = await events.findOne({ eventId: agentEventId })
			expect(jobAfter2?.status).toBe("completed")
			expect(runDocs).toHaveLength(1)
			expect(String(runDocs[0]?.gateKey)).toContain("ws-1")
			expect(runDocs[0]?.status).toBe("completed")
			expect(wsEvent?.dreamerProcessedAt).toBeInstanceOf(Date)
			expect(agentEvent?.dreamerProcessedAt).toBeUndefined()
		},
		TIMEOUT,
	)

	it(
		"a failed synchronous tracking row is claimed with tracking cleared and re-runs the caller scope",
		async () => {
			const agentId = `b1sync-${randomUUID().slice(0, 8)}`
			const jobs = memoryJobsCollection(db, PREFIX)
			const runs = consolidationRunsCollection(db, PREFIX)
			const events = eventsCollection(db, PREFIX)
			const wsEventId = `evt-ws-${randomUUID().slice(0, 8)}`
			const agentEventId = `evt-agent-${randomUUID().slice(0, 8)}`
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: wsEventId,
					agentId,
					role: "user",
					body: "Workspace note about @acme and @billing",
					scope: "workspace",
					scopeRef: "ws-1",
				},
			})
			await writeEvent({
				db,
				prefix: PREFIX,
				event: {
					eventId: agentEventId,
					agentId,
					role: "user",
					body: "Agent-wide note about @globex and @roadmap",
					scope: "agent",
				},
			})
			const callerOptions = {
				scope: "workspace" as const,
				scopeRef: "ws-1",
				maxEvents: 5,
			}

			// Pre-claim seam failure: the gate-claim findOneAndUpdate is the
			// only pre-claim DB op inside consolidateMemory; a genuine
			// non-duplicate driver error there fails the sync run BEFORE any
			// run doc exists.
			const gateError = await captureRealNonDuplicateBulkError(
				db.collection(`${PREFIX}entities`),
			)
			const proxiedGate = dbWithFailingGateClaim(db, gateError)
			await expect(
				new MongoDBManagerLifecycleOps(
					hostStub(client, proxiedGate, agentId),
				).consolidate(callerOptions),
			).rejects.toThrow()

			const syncRow = await jobs.findOne({ agentId })
			expect(syncRow).toMatchObject({
				status: "failed",
				tracking: true,
				attempts: 0,
			})
			expect(syncRow).not.toHaveProperty("retryAt")
			expect(syncRow?.metadata).toMatchObject({
				scope: "workspace",
				scopeRef: "ws-1",
			})
			// Pre-claim proof: no consolidation run doc exists yet.
			expect(await runs.countDocuments({ agentId })).toBe(0)

			// The standing worker claims the failed tracking row on its next
			// tick (failed branch has no tracking exclusion). P4: the SAME
			// atomic claim clears the tracking marker — ownership transfers to
			// the claiming worker.
			const claimed = await claim(agentId)
			expect(claimed.attempts).toBe(1)
			const claimedRow = await jobs.findOne({ agentId })
			expect(claimedRow?.status).toBe("running")
			expect(claimedRow).not.toHaveProperty("tracking")
			expect(
				restoredOptions(
					claimed.metadata as Record<string, unknown> | undefined,
				),
			).toMatchObject({ scope: "workspace", scopeRef: "ws-1", maxEvents: 5 })

			// The retry re-executes fully with the restored caller scope
			// (no gate doc to swallow it) — the unrelated agent-scope event
			// stays untouched.
			await runnerOf(new MongoDBManagerJobsOps(hostStub(client, db, agentId)))(
				claimed,
				null,
			)
			const jobFinal = await jobs.findOne({ agentId })
			const runDocs = await runs.find({ agentId }).toArray()
			expect(jobFinal?.status).toBe("completed")
			expect(runDocs).toHaveLength(1)
			expect(String(runDocs[0]?.gateKey)).toContain("ws-1")
			expect(runDocs[0]?.status).toBe("completed")
			expect(
				(await events.findOne({ eventId: wsEventId }))?.dreamerProcessedAt,
			).toBeInstanceOf(Date)
			expect(
				(await events.findOne({ eventId: agentEventId }))?.dreamerProcessedAt,
			).toBeUndefined()
		},
		TIMEOUT,
	)
})
