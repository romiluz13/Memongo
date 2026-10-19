import type { Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	getBestEffortFailureCounts,
	resetBestEffortFailureCounts,
} from "./best-effort.js"
import { checkAutoEpisodeTriggers } from "./mongodb-episodes.js"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { EnrichmentConfigError } from "./mongodb-llm-enrichment.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { claimMemoryJob } from "./mongodb-memory-jobs.js"
import {
	consumeSearchWorkOrThrow,
	getSearchBudgetSnapshot,
} from "./mongodb-search-budget.js"
import {
	ErasureGateConflictError,
	captureAdmissionToken,
} from "./mongodb-write-fence.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"
import type { ClaimedMemoryJob } from "./types.js"

vi.mock("./mongodb-graph.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-graph.js")>()),
	extractAndUpsertEntities: vi.fn(async () => ({
		entities: [],
		relationsCreated: 0,
	})),
}))
vi.mock("./mongodb-episodes.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-episodes.js")>()),
	checkAutoEpisodeTriggers: vi.fn(),
}))
vi.mock("./mongodb-consolidator.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-consolidator.js")>()),
	consolidateMemory: vi.fn(),
}))
vi.mock("./mongodb-memory-jobs.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-memory-jobs.js")>()),
	claimMemoryJob: vi.fn(async () => null),
}))

const AGENT = "agent1"
const SCOPE_REF = `agent:${AGENT}`

type Fake = ReturnType<typeof createStatefulMongoFake>

function jobRow(overrides: Partial<ClaimedMemoryJob> = {}): ClaimedMemoryJob {
	return {
		jobId: "extraction-evt-1",
		agentId: AGENT,
		jobType: "extraction",
		status: "running",
		createdAt: new Date(),
		attempts: 1,
		leaseOwner: "worker",
		leaseToken: "lease",
		heartbeatAt: new Date(),
		leaseExpiresAt: new Date(Date.now() + 60_000),
		admissionEpoch: 0,
		payload: { eventId: "evt-1", scope: "agent", scopeRef: SCOPE_REF },
		metadata: { eventId: "evt-1" },
		...overrides,
	} as ClaimedMemoryJob
}

async function seedJob(fake: Fake, job: ClaimedMemoryJob) {
	await fake.collection("memory_jobs").insertOne(job)
	return job
}

async function seedEvent(fake: Fake, eventId = "evt-1", sessionId?: string) {
	await fake.collection("events").insertOne({
		eventId,
		agentId: AGENT,
		role: "user",
		body: "ok sounds good",
		scope: "agent",
		scopeRef: SCOPE_REF,
		timestamp: new Date("2026-08-03T10:00:00.000Z"),
		...(sessionId ? { sessionId } : {}),
	})
}

function jobDoc(fake: Fake, jobId: string) {
	return fake.findDoc("memory_jobs", { jobId })
}

function makeHost(fake: Fake, overrides: Record<string, unknown> = {}) {
	const host = {
		db: fake.db,
		prefix: "test_",
		agentId: AGENT,
		workspaceDir: "/owned/test",
		config: {
			mongodb: {
				embeddingMode: "automated",
				episodes: { enabled: true, minEventsForEpisode: 5 },
			},
		},
		memoryJobWorkerId: "worker",
		memoryJobWorkerStopped: false,
		memoryJobOperationContexts: new Map(),
		derivationQueue: Promise.resolve(),
		shouldRunPostWriteDerivedWork: () => true,
		isDuplicateKeyError: (error: unknown) =>
			error instanceof Error && "code" in error && error.code === 11000,
		repairExtractionOutbox: vi.fn(async () => ({
			eventsProcessed: 0,
			jobsCreated: 0,
			jobsReleased: 0,
			eventsFailed: 0,
		})),
		repairEventProjections: vi.fn(async () => ({})),
		pruneIdempotencyFingerprints: vi.fn(async () => ({ pruned: 0 })),
		runClaimedBackgroundExtractionJob: vi.fn(async () => undefined),
		prefetchExtractionSessionFacts: vi.fn(async () => new Map()),
		...overrides,
	}
	return host as unknown as MongoDBManagerHost & typeof host
}

async function withAdmission(fake: Fake) {
	await captureAdmissionToken({ db: fake.db, prefix: "test_", agentId: AGENT })
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(claimMemoryJob).mockImplementation(async () => null)
	resetBestEffortFailureCounts()
})
afterEach(() => {
	vi.unstubAllEnvs()
})

describe("extraction job failures are durable, with retry state", () => {
	it("dead-letters a job with no event id instead of leaving it running", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		const host = makeHost(fake)
		const job = await seedJob(
			fake,
			jobRow({ payload: {} as never, metadata: {} }),
		)
		await new MongoDBManagerJobsOps(host).runClaimedBackgroundExtractionJob(job)
		expect(jobDoc(fake, job.jobId)).toMatchObject({
			status: "failed",
			error: expect.stringContaining("no event id"),
			deadLetterAt: expect.any(Date),
		})
		expect(jobDoc(fake, job.jobId)?.retryAt).toBeUndefined()
	})

	it("dead-letters a job whose stored admission epoch is corrupt", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		const host = makeHost(fake)
		const job = await seedJob(fake, jobRow({ admissionEpoch: -1 }))
		await new MongoDBManagerJobsOps(host).runClaimedBackgroundExtractionJob(job)
		expect(jobDoc(fake, job.jobId)).toMatchObject({
			status: "failed",
			error: expect.stringContaining("invalid admission epoch"),
			deadLetterAt: expect.any(Date),
		})
	})

	it("fails the job with retry state when the configured provider cannot be resolved", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		await seedEvent(fake)
		const host = makeHost(fake)
		const job = await seedJob(fake, jobRow())
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "key")
		vi.stubEnv("MEMONGO_ENRICHMENT_BASE_URL", "")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "")
		await new MongoDBManagerJobsOps(host).runClaimedBackgroundExtractionJob(job)
		const row = jobDoc(fake, job.jobId)
		expect(row).toMatchObject({
			status: "failed",
			attempts: 1,
			error: expect.stringContaining("MEMONGO_ENRICHMENT_BASE_URL"),
			retryAt: expect.any(Date),
		})
		expect(row?.deadLetterAt).toBeUndefined()
		expect(row?.completedAt).toBeInstanceOf(Date)
		expect(fake.all("structured_mem")).toHaveLength(0)
	})

	it("records the job ledger snapshot with the failure", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		await seedEvent(fake)
		const host = makeHost(fake)
		const job = await seedJob(fake, jobRow())
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "key")
		vi.stubEnv("MEMONGO_ENRICHMENT_BASE_URL", "")
		await new MongoDBManagerJobsOps(host).runClaimedBackgroundExtractionJob(job)
		expect(jobDoc(fake, job.jobId)?.metadata).toMatchObject({
			eventId: "evt-1",
			searchBudget: { accounting: "engine-query-work", aggregations: 0 },
		})
	})

	it("fails the job, not silently completes it, when the completion write fails", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		await seedEvent(fake)
		const host = makeHost(fake)
		const job = await seedJob(fake, jobRow())
		const jobs = fake.collection("memory_jobs")
		const original = jobs.updateOne.bind(jobs)
		vi.spyOn(jobs, "updateOne").mockImplementation(((
			filter: Document,
			update: Document,
			options?: Document,
		) => {
			if (update?.$set?.status === "completed") {
				throw new Error("completion write unavailable")
			}
			return original(filter, update, options as never)
		}) as never)
		await new MongoDBManagerJobsOps(host).runClaimedBackgroundExtractionJob(job)
		expect(jobDoc(fake, job.jobId)).toMatchObject({
			status: "failed",
			error: "completion write unavailable",
			retryAt: expect.any(Date),
		})
	})

	it("completes with the ledger snapshot on the job row when nothing fails", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		await seedEvent(fake)
		const host = makeHost(fake)
		const job = await seedJob(fake, jobRow())
		await new MongoDBManagerJobsOps(host).runClaimedBackgroundExtractionJob(job)
		expect(jobDoc(fake, job.jobId)).toMatchObject({
			status: "completed",
			metadata: {
				eventId: "evt-1",
				searchBudget: { accounting: "engine-query-work" },
			},
		})
	})

	it("logs and counts a failure-record write that itself fails, leaving the row to its lease", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		const host = makeHost(fake)
		const job = await seedJob(
			fake,
			jobRow({ payload: {} as never, metadata: {} }),
		)
		fake.injectFailure({
			collection: "memory_jobs",
			method: "updateOne",
			error: new Error("jobs store down"),
		})
		await new MongoDBManagerJobsOps(host).runClaimedBackgroundExtractionJob(job)
		expect(getBestEffortFailureCounts()).toMatchObject({
			"memory-job-failure-record": 1,
		})
		expect(jobDoc(fake, job.jobId)?.status).toBe("running")
	})
})

describe("consolidation job failures are durable, with retry state", () => {
	it("fails the job with retry state when the consolidation run throws", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		const host = makeHost(fake)
		const job = await seedJob(
			fake,
			jobRow({
				jobId: "consolidation-auto-agent1-1",
				jobType: "consolidation",
				payload: undefined,
				metadata: { auto: true, maxEvents: 7 },
			}),
		)
		vi.mocked(consolidateMemory).mockRejectedValue(
			new Error("consolidate boom"),
		)
		await (
			new MongoDBManagerJobsOps(host) as unknown as {
				runClaimedConsolidationJob(
					job: ClaimedMemoryJob,
					epoch: number,
				): Promise<void>
			}
		).runClaimedConsolidationJob(job, 0)
		expect(jobDoc(fake, job.jobId)).toMatchObject({
			status: "failed",
			error: "consolidate boom",
			retryAt: expect.any(Date),
			metadata: { auto: true, maxEvents: 7 },
		})
	})

	it("fails the job with retry state, never running lease-only, when the epoch read fails", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		const host = makeHost(fake)
		const job = await seedJob(
			fake,
			jobRow({
				jobId: "consolidation-auto-agent1-2",
				jobType: "consolidation",
				payload: undefined,
				metadata: { auto: true },
			}),
		)
		vi.spyOn(fake.collection("meta"), "findOne").mockRejectedValue(
			new Error("meta read failed"),
		)
		await (
			new MongoDBManagerJobsOps(host) as unknown as {
				runClaimedConsolidationJob(
					job: ClaimedMemoryJob,
					epoch: number,
				): Promise<void>
			}
		).runClaimedConsolidationJob(job, 0)
		expect(consolidateMemory).not.toHaveBeenCalled()
		expect(jobDoc(fake, job.jobId)).toMatchObject({
			status: "failed",
			error: "meta read failed",
			retryAt: expect.any(Date),
		})
	})

	it("runs the consolidation on the job's one ledger and records its snapshot on the job row", async () => {
		const fake = createStatefulMongoFake()
		await withAdmission(fake)
		const host = makeHost(fake)
		const job = await seedJob(
			fake,
			jobRow({
				jobId: "consolidation-auto-agent1-3",
				jobType: "consolidation",
				payload: undefined,
				metadata: { auto: true, maxEvents: 7 },
			}),
		)
		const seen: unknown[] = []
		vi.mocked(consolidateMemory).mockImplementation((async () => {
			consumeSearchWorkOrThrow("atlas-search", { aggregations: 1, embeds: 0 })
			seen.push(getSearchBudgetSnapshot())
			return {
				runId: "run-1",
				agentId: AGENT,
				eventsProcessed: 0,
				factsPromoted: 0,
				factsPruned: 0,
				conflictsResolved: 0,
				durationMs: 1,
				candidates: [],
			}
		}) as never)
		await (
			new MongoDBManagerJobsOps(host) as unknown as {
				runClaimedConsolidationJob(
					job: ClaimedMemoryJob,
					epoch: number,
				): Promise<void>
			}
		).runClaimedConsolidationJob(job, 0)
		expect(seen).toHaveLength(1)
		expect(jobDoc(fake, job.jobId)).toMatchObject({
			status: "completed",
			metadata: {
				runId: "run-1",
				searchBudget: {
					accounting: "engine-query-work",
					aggregations: 1,
					embeds: 0,
					maxAggregations: 207,
					maxEmbeds: 207,
				},
			},
		})
	})
})

describe("worker sweep failures are declared, counted and never zero results", () => {
	it("counts a failed repair and prune and still drains the queue", async () => {
		const fake = createStatefulMongoFake()
		const host = makeHost(fake, {
			repairEventProjections: vi.fn(async () => {
				throw new Error("repair down")
			}),
			pruneIdempotencyFingerprints: vi.fn(async () => {
				throw new Error("prune down")
			}),
		})
		await new MongoDBManagerJobsOps(host).drainMemoryJobQueue()
		expect(getBestEffortFailureCounts()).toMatchObject({
			"worker-chunk-projection-repair": 1,
			"worker-fingerprint-prune": 1,
		})
		expect(claimMemoryJob).toHaveBeenCalled()
	})

	it("still aborts the sweep on an erasure-gate conflict", async () => {
		const fake = createStatefulMongoFake()
		const host = makeHost(fake, {
			repairEventProjections: vi.fn(async () => {
				throw new ErasureGateConflictError(AGENT)
			}),
		})
		await expect(
			new MongoDBManagerJobsOps(host).drainMemoryJobQueue(),
		).rejects.toBeInstanceOf(ErasureGateConflictError)
	})

	it("counts a failed backlog gauge read and runs the round at base concurrency", async () => {
		const fake = createStatefulMongoFake()
		vi.spyOn(
			fake.collection("memory_jobs"),
			"countDocuments",
		).mockRejectedValue(new Error("count down"))
		const host = makeHost(fake)
		await new MongoDBManagerJobsOps(host).drainMemoryJobQueue()
		expect(getBestEffortFailureCounts()).toMatchObject({
			"memory-job-backlog-gauge": 1,
		})
		expect(claimMemoryJob).toHaveBeenCalled()
	})

	it("throws before claiming a consolidation job when the tenant epoch cannot be read", async () => {
		const fake = createStatefulMongoFake()
		const host = makeHost(fake)
		const ops = new MongoDBManagerJobsOps(host)
		await withAdmission(fake)
		// Arm the failure once the extraction claim loop has run, so the first
		// meta read after it is the consolidation block's epoch read.
		let armed = false
		vi.mocked(claimMemoryJob).mockImplementation((async () => {
			armed = true
			return null
		}) as never)
		const metaCollection = fake.collection("meta")
		const original = metaCollection.findOne.bind(metaCollection)
		vi.spyOn(metaCollection, "findOne").mockImplementation(((
			...args: Parameters<typeof original>
		) => {
			if (armed) throw new Error("meta read failed")
			return original(...args)
		}) as never)
		await expect(ops.drainMemoryJobQueue()).rejects.toThrow("meta read failed")
		expect(
			vi
				.mocked(claimMemoryJob)
				.mock.calls.some(
					(call) =>
						(call[0] as { jobType?: string }).jobType === "consolidation",
				),
		).toBe(false)
	})

	it("counts a failed auto-consolidation staging and retries it next round", async () => {
		vi.stubEnv("MEMONGO_AUTO_CONSOLIDATION_MS", "1000")
		const fake = createStatefulMongoFake()
		const host = makeHost(fake)
		const jobs = fake.collection("memory_jobs")
		const insert = vi.spyOn(jobs, "insertOne")
		insert.mockRejectedValueOnce(new Error("staging store down"))
		const ops = new MongoDBManagerJobsOps(host)
		await ops.drainMemoryJobQueue()
		expect(getBestEffortFailureCounts()).toMatchObject({
			"auto-consolidation-staging": 1,
		})
		await ops.drainMemoryJobQueue()
		expect(
			fake.all("memory_jobs").some((row) => row.jobType === "consolidation"),
		).toBe(true)
	})
})

describe("session-batched prefetch failures fail the affected jobs durably", () => {
	async function twoJobs(fake: Fake) {
		await seedEvent(fake, "evt-1", "s1")
		await seedEvent(fake, "evt-2", "s1")
		const first = await seedJob(fake, jobRow())
		const second = await seedJob(
			fake,
			jobRow({
				jobId: "extraction-evt-2",
				payload: { eventId: "evt-2", scope: "agent", scopeRef: SCOPE_REF },
				metadata: { eventId: "evt-2" },
			}),
		)
		return [first, second]
	}

	it("attaches the typed provider-resolution failure to every job in the round", async () => {
		const fake = createStatefulMongoFake()
		const host = makeHost(fake)
		const ops = new MongoDBManagerJobsOps(host)
		const jobs = await twoJobs(fake)
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "key")
		vi.stubEnv("MEMONGO_ENRICHMENT_BASE_URL", "")
		const facts = await ops.prefetchExtractionSessionFacts(jobs)
		const failures = (facts as unknown as Record<symbol, Map<string, unknown>>)[
			Object.getOwnPropertySymbols(facts).find(
				(symbol) => symbol.description === "prefetchFailures",
			) as symbol
		]
		expect([...failures.keys()].sort()).toEqual(["evt-1", "evt-2"])
		for (const error of failures.values()) {
			expect(error).toBeInstanceOf(EnrichmentConfigError)
		}
		expect(facts.size).toBe(0)
	})

	it("drain fails those jobs with retry state and never runs them per event", async () => {
		const fake = createStatefulMongoFake()
		const host = makeHost(fake)
		const ops = new MongoDBManagerJobsOps(host)
		await withAdmission(fake)
		const jobs = await twoJobs(fake)
		host.prefetchExtractionSessionFacts = (batch: ClaimedMemoryJob[]) =>
			ops.prefetchExtractionSessionFacts(batch)
		let claimed = 0
		vi.mocked(claimMemoryJob).mockImplementation((async (params: {
			jobType: string
		}) => {
			if (params.jobType !== "extraction") return null
			return jobs[claimed++] ?? null
		}) as never)
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "key")
		vi.stubEnv("MEMONGO_ENRICHMENT_BASE_URL", "")
		await ops.drainMemoryJobQueue()
		expect(host.runClaimedBackgroundExtractionJob).not.toHaveBeenCalled()
		for (const job of jobs) {
			expect(jobDoc(fake, job.jobId)).toMatchObject({
				status: "failed",
				error: expect.stringContaining("MEMONGO_ENRICHMENT_BASE_URL"),
				retryAt: expect.any(Date),
			})
		}
	})

	it("fails the session group's jobs when the batched provider call fails, never per-event extraction", async () => {
		const fake = createStatefulMongoFake()
		const host = makeHost(fake)
		const ops = new MongoDBManagerJobsOps(host)
		await withAdmission(fake)
		const jobs = await twoJobs(fake)
		host.prefetchExtractionSessionFacts = (batch: ClaimedMemoryJob[]) =>
			ops.prefetchExtractionSessionFacts(batch)
		let claimed = 0
		vi.mocked(claimMemoryJob).mockImplementation((async (params: {
			jobType: string
		}) => {
			if (params.jobType !== "extraction") return null
			return jobs[claimed++] ?? null
		}) as never)
		vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "key")
		vi.stubEnv("MEMONGO_ENRICHMENT_BASE_URL", "http://127.0.0.1:1/v1")
		vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "m")
		vi.stubEnv("MEMONGO_ENRICHMENT_ALLOW_PRIVATE_NETWORK", "true")
		vi.stubGlobal("fetch", async () => {
			throw new Error("provider unreachable")
		})
		try {
			await ops.drainMemoryJobQueue()
		} finally {
			vi.unstubAllGlobals()
		}
		expect(host.runClaimedBackgroundExtractionJob).not.toHaveBeenCalled()
		for (const job of jobs) {
			expect(jobDoc(fake, job.jobId)?.status).toBe("failed")
			expect(jobDoc(fake, job.jobId)?.retryAt).toBeInstanceOf(Date)
		}
	})
})

describe("auto-episode trigger failures are durable", () => {
	it("records a failed episodes projection run and counts the failed derived task", async () => {
		const fake = createStatefulMongoFake()
		const host = makeHost(fake)
		vi.mocked(checkAutoEpisodeTriggers).mockRejectedValue(
			new Error("episode trigger boom"),
		)
		const ops = new MongoDBManagerJobsOps(host)
		host.enqueueDerivedWork = (task: () => Promise<void>) =>
			ops.enqueueDerivedWork(task)
		await ops.schedulePostWriteDerivations({
			eventId: "evt-1",
			role: "user",
			body: "hello",
			timestamp: new Date(),
			scope: "agent",
			scopeRef: SCOPE_REF,
		})
		await host.derivationQueue
		expect(fake.all("projection_runs")).toEqual([
			expect.objectContaining({
				agentId: AGENT,
				projectionType: "episodes",
				status: "failed",
				itemsProjected: 0,
			}),
		])
		expect(getBestEffortFailureCounts()).toMatchObject({
			"derived-memory-work": 1,
		})
	})
})
