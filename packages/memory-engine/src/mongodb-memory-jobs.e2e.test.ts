import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { MemongoConfig } from "@memongo/lib"
import {
	type Collection,
	type CollectionOptions,
	type Db,
	MongoClient,
	MongoServerError,
} from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
	claimMemoryJob,
	completeClaimedMemoryJob,
	createMemoryJob,
	deadLetterExpiredMemoryJobs,
	failClaimedMemoryJob,
	MEMORY_JOB_MAX_ATTEMPTS,
	releaseStagedMemoryJob,
	renewMemoryJobLease,
	retryFailedMemoryJob,
} from "./mongodb-memory-jobs.js"
import { extractAndUpsertEntities, upsertRelation } from "./mongodb-graph.js"
import { writeEvent, writeEventsBatch } from "./mongodb-events.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { writeProcedure } from "./mongodb-procedures.js"
import {
	chunksCollection,
	ensureCollections,
	entitiesCollection,
	entityLinksCollection,
	eventsCollection,
	memoryJobsCollection,
	mutationsCollection,
	procedureRevisionsCollection,
	proceduresCollection,
	relationsCollection,
	structuredMemCollection,
	structuredMemRevisionsCollection,
	telemetryCollection,
	projectionRunsCollection,
} from "./mongodb-schema.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"
import { MAJORITY_TRANSACTION_OPTIONS } from "./mongodb-transactions.js"
import { resolveMemoryBackendConfig } from "./backend-config.js"
import {
	bumpTenantErasureEpoch,
	captureAdmissionToken,
} from "./mongodb-erasure-epoch.js"

const TEST_URI = resolvePreviewMongoTestUri(
	"mongodb://127.0.0.1:27019/?directConnection=true",
)
const TEST_DB = `memongo_memory_jobs_${randomUUID().slice(0, 8)}`
const PREFIX = "jobs_"
const AGENT = `agent-${randomUUID().slice(0, 8)}`

let client: MongoClient

function proxyDbCollections(
	db: Db,
	resolve: (name: string, collection: Collection) => Collection,
): Db {
	return new Proxy(db, {
		get(target, property) {
			if (property === "collection") {
				return (name: string, options?: CollectionOptions) =>
					resolve(name, target.collection(name, options))
			}
			const value = Reflect.get(target, property, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

function repairManager(db: Db, agentId: string): MongoDBMemoryManager {
	return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		db,
		prefix: PREFIX,
		agentId,
		chunkCount: 0,
	}) as MongoDBMemoryManager
}

function extractionRunnerManager(
	db: Db,
	agentId: string,
): MongoDBMemoryManager {
	return Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		client,
		db,
		prefix: PREFIX,
		agentId,
		config: { mongodb: { embeddingMode: "automated" } },
		workspaceDir: "/tmp/memongo-worker-effects-e2e",
		memoryJobOperationContexts: new Map(),
	}) as MongoDBMemoryManager
}

async function runClaimedExtraction(
	manager: MongoDBMemoryManager,
	job: NonNullable<Awaited<ReturnType<typeof claimMemoryJob>>>,
): Promise<void> {
	const lifecycle = MongoDBMemoryManager.prototype as unknown as {
		runClaimedBackgroundExtractionJob: (
			this: MongoDBMemoryManager,
			claimed: typeof job,
		) => Promise<void>
	}
	await lifecycle.runClaimedBackgroundExtractionJob.call(manager, job)
}

describe("durable memory job leases (live MongoDB)", () => {
	beforeAll(async () => {
		client = new MongoClient(TEST_URI, {
			serverSelectionTimeoutMS: 10_000,
			connectTimeoutMS: 10_000,
		})
		await client.connect()
		const db = client.db(TEST_DB)
		await ensureCollections(db, PREFIX)
		await memoryJobsCollection(db, PREFIX).createIndex(
			{ jobId: 1 },
			{ name: "uq_memory_jobs_jobid", unique: true },
		)
		await memoryJobsCollection(db, PREFIX).createIndex(
			{
				agentId: 1,
				jobType: 1,
				status: 1,
				leaseExpiresAt: 1,
				createdAt: 1,
				jobId: 1,
			},
			{ name: "idx_memory_jobs_claim_v2" },
		)
		await relationsCollection(db, PREFIX).createIndex(
			{
				agentId: 1,
				scope: 1,
				scopeRef: 1,
				fromEntityId: 1,
				toEntityId: 1,
				type: 1,
			},
			{ name: "uq_relations_identity", unique: true },
		)
		await structuredMemCollection(db, PREFIX).createIndex(
			{ agentId: 1, scope: 1, scopeRef: 1, type: 1, key: 1 },
			{
				name: "uq_structured_agent_scope_scoperef_type_key",
				unique: true,
			},
		)
		await proceduresCollection(db, PREFIX).createIndex(
			{ procedureId: 1, agentId: 1, scope: 1, scopeRef: 1 },
			{ name: "uq_procedures_identity", unique: true },
		)
	})

	afterAll(async () => {
		await client
			?.db(TEST_DB)
			.dropDatabase()
			.catch(() => {})
		await client?.close()
	})

	it("grants exactly one lease when many workers race for one job", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-race`
		const jobId = `extraction-race-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-race" },
			},
		})

		const now = new Date("2026-07-23T00:00:00.000Z")
		const claims = await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				claimMemoryJob({
					db,
					prefix: PREFIX,
					agentId,
					jobType: "extraction",
					workerId: `worker-${index}`,
					leaseMs: 60_000,
					now,
				}),
			),
		)
		const winners = claims.filter((claim) => claim !== null)

		expect(winners).toHaveLength(1)
		expect(winners[0]).toMatchObject({
			jobId,
			status: "running",
			attempts: 1,
		})
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({
				jobId,
				status: "running",
			}),
		).toBe(1)
	})

	it("rejects the stale lease token after a replacement worker reclaims", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-replacement`
		const jobId = `extraction-replacement-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-replacement" },
			},
		})
		const original = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-original",
			leaseMs: 60_000,
		})
		expect(original).not.toBeNull()
		if (!original) throw new Error("expected the original extraction claim")
		await memoryJobsCollection(db, PREFIX).updateOne(
			{ jobId },
			{ $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
		)
		const replacement = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-replacement",
			leaseMs: 60_000,
		})
		expect(replacement).not.toBeNull()

		await expect(
			renewMemoryJobLease({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: original?.leaseOwner ?? "",
				leaseToken: original?.leaseToken ?? "",
				leaseMs: 60_000,
			}),
		).resolves.toBe(false)
		await expect(
			renewMemoryJobLease({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: replacement?.leaseOwner ?? "",
				leaseToken: replacement?.leaseToken ?? "",
				leaseMs: 60_000,
			}),
		).resolves.toBe(true)
	})

	it("blocks stale worker effects after a same-epoch lease reclaim", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-worker-effect-reclaim`
		const eventId = `event-worker-effect-reclaim-${randomUUID()}`
		const jobId = `extraction-${eventId}`
		const admission = await captureAdmissionToken({
			db,
			prefix: PREFIX,
			agentId,
		})
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "A provider result that belongs to a stale lease.",
				scope: "agent",
				scopeRef: `agent:${agentId}`,
			},
		})
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				admissionEpoch: admission.epoch,
				payload: {
					eventId,
					scope: "agent",
					scopeRef: `agent:${agentId}`,
				},
			},
		})
		const original = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-original",
			leaseMs: 60_000,
			admissionEpoch: admission.epoch,
		})
		expect(original).not.toBeNull()
		if (!original) throw new Error("expected the original extraction claim")

		const enrichment = await import("./mongodb-llm-enrichment.js")
		let replacement: NonNullable<
			Awaited<ReturnType<typeof claimMemoryJob>>
		> | null = null
		const provider = {
			name: "worker-effects-e2e",
			chatCompletion: vi.fn(async () => ({
				content: JSON.stringify({
					facts: ["The stale worker must not persist this provider fact."],
					qa_pairs: [],
					has_personal_content: false,
				}),
			})),
		}
		const interceptedDb = proxyDbCollections(db, (name, collection) => {
			if (name !== `${PREFIX}memory_jobs`) return collection
			return new Proxy(collection, {
				get(target, property) {
					if (property === "updateOne") {
						return async (...args: Parameters<typeof target.updateOne>) => {
							const update = args[1]
							if (
								!replacement &&
								provider.chatCompletion.mock.calls.length > 0 &&
								!Array.isArray(update) &&
								"$inc" in update &&
								"effectFenceSerial" in (update.$inc ?? {})
							) {
								await memoryJobsCollection(db, PREFIX).updateOne(
									{ jobId, leaseToken: original.leaseToken },
									{ $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
								)
								replacement = await claimMemoryJob({
									db,
									prefix: PREFIX,
									agentId,
									jobType: "extraction",
									workerId: "worker-replacement",
									leaseMs: 60_000,
									admissionEpoch: admission.epoch,
								})
							}
							return target.updateOne(...args)
						}
					}
					const value = Reflect.get(target, property, target)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})
		const providerSpy = vi
			.spyOn(enrichment, "resolveEnrichmentProvider")
			.mockReturnValue(provider)
		try {
			await runClaimedExtraction(
				extractionRunnerManager(interceptedDb, agentId),
				original,
			)
		} finally {
			providerSpy.mockRestore()
		}

		expect(provider.chatCompletion).toHaveBeenCalled()
		expect(replacement).toMatchObject({
			jobId,
			leaseOwner: "worker-replacement",
			admissionEpoch: admission.epoch,
		})
		expect(
			await structuredMemCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		expect(
			await proceduresCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		await expect(
			memoryJobsCollection(db, PREFIX).findOne({ jobId, agentId }),
		).resolves.toMatchObject({
			status: "running",
			leaseOwner: "worker-replacement",
			leaseToken: replacement?.leaseToken,
		})
	})

	it("blocks worker effects when the epoch advances after the event read", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-worker-effect-epoch`
		const eventId = `event-worker-effect-epoch-${randomUUID()}`
		const jobId = `extraction-${eventId}`
		const admission = await captureAdmissionToken({
			db,
			prefix: PREFIX,
			agentId,
		})
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "@alice remembers #stale-epoch.",
				scope: "agent",
				scopeRef: `agent:${agentId}`,
			},
		})
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				admissionEpoch: admission.epoch,
				payload: {
					eventId,
					scope: "agent",
					scopeRef: `agent:${agentId}`,
				},
			},
		})
		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-epoch",
			leaseMs: 60_000,
			admissionEpoch: admission.epoch,
		})
		expect(claimed).not.toBeNull()
		if (!claimed) throw new Error("expected the epoch extraction claim")

		let eventRead = false
		const interceptedDb = proxyDbCollections(db, (name, collection) => {
			if (name !== `${PREFIX}events`) return collection
			return new Proxy(collection, {
				get(target, property) {
					if (property === "findOne") {
						return async (...args: Parameters<typeof target.findOne>) => {
							const doc = await target.findOne(...args)
							if (!eventRead) {
								eventRead = true
								await bumpTenantErasureEpoch(db, PREFIX, agentId)
							}
							return doc
						}
					}
					const value = Reflect.get(target, property, target)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})
		const enrichment = await import("./mongodb-llm-enrichment.js")
		const providerSpy = vi
			.spyOn(enrichment, "resolveEnrichmentProvider")
			.mockReturnValue(null)
		try {
			await runClaimedExtraction(
				extractionRunnerManager(interceptedDb, agentId),
				claimed,
			)
		} finally {
			providerSpy.mockRestore()
		}

		expect(eventRead).toBe(true)
		expect(
			await entitiesCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		expect(
			await structuredMemCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		await expect(
			memoryJobsCollection(db, PREFIX).findOne({ jobId, agentId }),
		).resolves.toMatchObject({
			status: "running",
			leaseToken: claimed?.leaseToken,
			admissionEpoch: admission.epoch,
		})
	})

	it("blocks promotion when the source event is invalidated during inference", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-worker-effect-source-lifecycle`
		const eventId = `event-worker-effect-source-lifecycle-${randomUUID()}`
		const jobId = `extraction-${eventId}`
		const admission = await captureAdmissionToken({
			db,
			prefix: PREFIX,
			agentId,
		})
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "Remember this: the source-valid launch code is Red Heron.",
				scope: "agent",
				scopeRef: `agent:${agentId}`,
			},
		})
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				admissionEpoch: admission.epoch,
				payload: {
					eventId,
					scope: "agent",
					scopeRef: `agent:${agentId}`,
				},
			},
		})
		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-source-lifecycle",
			leaseMs: 60_000,
			admissionEpoch: admission.epoch,
		})
		expect(claimed).not.toBeNull()
		if (!claimed)
			throw new Error("expected the source-lifecycle extraction claim")

		const enrichment = await import("./mongodb-llm-enrichment.js")
		let invalidated = false
		const provider = {
			name: "worker-effects-e2e",
			chatCompletion: vi.fn(async () => {
				if (!invalidated) {
					invalidated = true
					await eventsCollection(db, PREFIX).updateOne(
						{ eventId, agentId },
						{ $set: { invalidAt: new Date(Date.now() - 1_000) } },
					)
				}
				return {
					content: JSON.stringify({
						facts: ["The source-valid launch code is Red Heron."],
						qa_pairs: [],
						has_personal_content: false,
					}),
				}
			}),
		}
		const providerSpy = vi
			.spyOn(enrichment, "resolveEnrichmentProvider")
			.mockReturnValue(provider)
		try {
			await runClaimedExtraction(extractionRunnerManager(db, agentId), claimed)
		} finally {
			providerSpy.mockRestore()
		}

		expect(invalidated).toBe(true)
		expect(provider.chatCompletion).toHaveBeenCalled()
		expect(
			await structuredMemCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		expect(
			await proceduresCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
	})

	it.each([
		["no correction", "none"],
		["source correction", "source"],
		["target correction", "target"],
	] as const)("revalidates contradiction revisions after %s during inference", async (_label, correction) => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-contradiction-${correction}-${randomUUID()}`
		const scopeRef = `agent:${agentId}`
		const eventId = `event-contradiction-${randomUUID()}`
		const jobId = `extraction-${eventId}`
		const sourceValue = "The user lives in London."
		const correctedSourceValue = "The user lives in Lisbon."
		const targetKey = `fact-berlin-${randomUUID()}`
		const targetValue = "The user lives in Berlin."
		const correctedTargetValue = "The user lives in Madrid."
		const admission = await captureAdmissionToken({
			db,
			prefix: PREFIX,
			agentId,
		})
		await writeStructuredMemory({
			db,
			prefix: PREFIX,
			embeddingMode: "automated",
			entry: {
				type: "fact",
				key: targetKey,
				value: targetValue,
				agentId,
				scope: "agent",
				scopeRef,
			},
		})
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: `Remember: ${sourceValue}`,
				scope: "agent",
				scopeRef,
			},
		})
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				admissionEpoch: admission.epoch,
				payload: { eventId, scope: "agent", scopeRef },
			},
		})
		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: `worker-contradiction-${correction}`,
			leaseMs: 60_000,
			admissionEpoch: admission.epoch,
		})
		expect(claimed).not.toBeNull()
		if (!claimed) throw new Error("expected the contradiction extraction claim")

		let contradictionCalls = 0
		const provider = {
			name: "worker-effects-contradiction-e2e",
			chatCompletion: vi.fn(async ({ messages }) => {
				const systemPrompt =
					messages.find((message) => message.role === "system")?.content ?? ""
				if (systemPrompt.startsWith("You detect direct contradictions")) {
					contradictionCalls += 1
					if (correction !== "none") {
						const source = await structuredMemCollection(db, PREFIX).findOne({
							agentId,
							scope: "agent",
							scopeRef,
							type: "fact",
							value: sourceValue,
							state: "active",
						})
						expect(source).not.toBeNull()
						if (!source) throw new Error("expected the promoted source fact")
						const key = correction === "source" ? String(source.key) : targetKey
						await writeStructuredMemory({
							db,
							prefix: PREFIX,
							embeddingMode: "automated",
							entry: {
								type: "fact",
								key,
								value:
									correction === "source"
										? correctedSourceValue
										: correctedTargetValue,
								agentId,
								scope: "agent",
								scopeRef,
							},
						})
					}
					return {
						content: JSON.stringify({
							contradictions: [
								{ key: targetKey, rationale: "exclusive locations" },
							],
						}),
					}
				}
				if (systemPrompt.startsWith("You extract the validity time window")) {
					return {
						content: JSON.stringify({ validFrom: null, validTo: null }),
					}
				}
				return {
					content: JSON.stringify({
						facts: [],
						qa_pairs: [],
						has_personal_content: false,
					}),
				}
			}),
		}
		const enrichment = await import("./mongodb-llm-enrichment.js")
		const providerSpy = vi
			.spyOn(enrichment, "resolveEnrichmentProvider")
			.mockReturnValue(provider)
		try {
			await runClaimedExtraction(extractionRunnerManager(db, agentId), claimed)
		} finally {
			providerSpy.mockRestore()
		}

		const source = await structuredMemCollection(db, PREFIX).findOne({
			agentId,
			scope: "agent",
			scopeRef,
			type: "fact",
			key: { $ne: targetKey },
		})
		const target = await structuredMemCollection(db, PREFIX).findOne({
			agentId,
			scope: "agent",
			scopeRef,
			type: "fact",
			key: targetKey,
		})
		const targetRevisions = await structuredMemRevisionsCollection(
			db,
			PREFIX,
		).countDocuments({
			agentId,
			scope: "agent",
			scopeRef,
			type: "fact",
			key: targetKey,
		})
		const contradictionAudits = await mutationsCollection(
			db,
			PREFIX,
		).countDocuments({
			agentId,
			collectionName: "structured_mem",
			operation: "invalidate",
			"newValue.invalidatedBy.reason": "contradiction",
		})

		expect(contradictionCalls).toBe(1)
		await expect(
			memoryJobsCollection(db, PREFIX).findOne({ jobId, agentId }),
		).resolves.toMatchObject({ status: "completed" })
		if (correction === "none") {
			expect(source).toMatchObject({
				value: sourceValue,
				revision: 1,
				state: "active",
			})
			expect(target).toMatchObject({
				value: targetValue,
				revision: 2,
				state: "invalidated",
				invalidatedBy: {
					reason: "contradiction",
					byValue: sourceValue,
				},
			})
			expect(targetRevisions).toBe(1)
			expect(contradictionAudits).toBe(1)
		} else {
			expect(source).toMatchObject({
				value: correction === "source" ? correctedSourceValue : sourceValue,
				revision: correction === "source" ? 2 : 1,
				state: "active",
			})
			expect(target).toMatchObject({
				value: correction === "target" ? correctedTargetValue : targetValue,
				revision: correction === "target" ? 2 : 1,
				state: "active",
			})
			expect(target?.invalidatedBy).toBeUndefined()
			expect(targetRevisions).toBe(correction === "target" ? 1 : 0)
			expect(contradictionAudits).toBe(0)
		}
	})

	it("retries an aborted effect batch without repeating provider work", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-worker-effect-retry`
		const eventId = `event-worker-effect-retry-${randomUUID()}`
		const jobId = `extraction-${eventId}`
		const admission = await captureAdmissionToken({
			db,
			prefix: PREFIX,
			agentId,
		})
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "Remember this: the retry-safe launch code is Blue Finch.",
				scope: "agent",
				scopeRef: `agent:${agentId}`,
			},
		})
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				admissionEpoch: admission.epoch,
				payload: {
					eventId,
					scope: "agent",
					scopeRef: `agent:${agentId}`,
				},
			},
		})
		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-retry",
			leaseMs: 60_000,
			admissionEpoch: admission.epoch,
		})
		expect(claimed).not.toBeNull()
		if (!claimed) throw new Error("expected the retry extraction claim")

		const enrichment = await import("./mongodb-llm-enrichment.js")
		const provider = {
			name: "worker-effects-e2e",
			chatCompletion: vi.fn(async () => ({
				content: JSON.stringify({
					facts: [],
					qa_pairs: [],
					has_personal_content: false,
					validity: { scope: "ongoing" },
				}),
			})),
		}
		const providerSpy = vi
			.spyOn(enrichment, "resolveEnrichmentProvider")
			.mockReturnValue(provider)
		let injected = false
		let structuredUpdates = 0
		const providerCallsAtWrites: number[] = []
		const interceptedDb = proxyDbCollections(db, (name, collection) => {
			if (name !== `${PREFIX}structured_mem`) return collection
			return new Proxy(collection, {
				get(target, property) {
					if (property === "updateOne") {
						return async (...args: Parameters<typeof target.updateOne>) => {
							structuredUpdates += 1
							providerCallsAtWrites.push(
								provider.chatCompletion.mock.calls.length,
							)
							const result = await target.updateOne(...args)
							if (!injected) {
								injected = true
								throw new MongoServerError({
									ok: 0,
									code: 112,
									errmsg: "synthetic worker effect retry",
									errorLabels: ["TransientTransactionError"],
								})
							}
							return result
						}
					}
					const value = Reflect.get(target, property, target)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})
		try {
			await runClaimedExtraction(
				extractionRunnerManager(interceptedDb, agentId),
				claimed,
			)
		} finally {
			providerSpy.mockRestore()
		}

		expect(injected).toBe(true)
		expect(structuredUpdates).toBeGreaterThanOrEqual(2)
		expect(providerCallsAtWrites[0]).toBeGreaterThan(0)
		expect(providerCallsAtWrites[1]).toBe(providerCallsAtWrites[0])
		expect(
			await structuredMemCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(1)
		await expect(
			memoryJobsCollection(db, PREFIX).findOne({ jobId, agentId }),
		).resolves.toMatchObject({
			status: "completed",
			admissionEpoch: admission.epoch,
		})
	})

	it("breaks equal-createdAt claim ties by jobId", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-tie-break`
		const createdAt = new Date("2026-07-23T01:00:00.000Z")
		const suffix = randomUUID()
		const jobIds = [
			`extraction-${suffix}-z`,
			`extraction-${suffix}-a`,
			`extraction-${suffix}-m`,
		]
		await memoryJobsCollection(db, PREFIX).insertMany(
			jobIds.map((jobId) => ({
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				createdAt,
				attempts: 0,
				payload: { eventId: jobId },
			})),
		)

		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-tie-break",
			leaseMs: 60_000,
			now: new Date("2026-07-23T01:01:00.000Z"),
		})

		expect(claimed?.jobId).toBe(`extraction-${suffix}-a`)
	})

	it("applies one typed-relation side effect when replacement workers overlap", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-relation-race`
		const scopeRef = `agent:${agentId}`
		const target = `project-${randomUUID()}`
		await upsertRelation({
			db,
			prefix: PREFIX,
			client,
			relation: {
				fromEntityId: "old-owner",
				toEntityId: target,
				type: "owns",
				agentId,
				scope: "agent",
				scopeRef,
				sourceEventIds: ["evt-old-owner"],
				updatedAt: new Date(),
			},
		})

		const sourceEventId = `evt-${randomUUID()}`
		await Promise.all(
			Array.from({ length: 12 }, () =>
				upsertRelation({
					db,
					prefix: PREFIX,
					client,
					relation: {
						fromEntityId: "new-owner",
						toEntityId: target,
						type: "owns",
						agentId,
						scope: "agent",
						scopeRef,
						sourceEventIds: [sourceEventId],
						updatedAt: new Date(),
					},
					eventReceiptIds: [sourceEventId],
				}),
			),
		)

		const relationDocs = await relationsCollection(db, PREFIX)
			.find({ agentId, type: "owns", toEntityId: target })
			.toArray()
		expect(relationDocs).toHaveLength(2)
		expect(
			relationDocs.find((doc) => doc.fromEntityId === "old-owner"),
		).toMatchObject({ state: "invalidated" })
		expect(
			relationDocs.find((doc) => doc.fromEntityId === "new-owner"),
		).toMatchObject({
			state: "active",
			reinforcementCount: 1,
			sourceEventIds: [sourceEventId],
		})
	})

	it("applies one structured and procedure promotion when replacement workers overlap", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-promotion-race`
		const sourceEventId = `evt-${randomUUID()}`
		const structuredKey = `fact-${randomUUID()}`
		const procedureId = `procedure-${randomUUID()}`

		await Promise.all(
			Array.from({ length: 12 }, () =>
				writeStructuredMemory({
					db,
					prefix: PREFIX,
					client,
					embeddingMode: "automated",
					eventReceiptIds: [sourceEventId],
					entry: {
						type: "fact",
						key: structuredKey,
						value: "A stale worker must not replay this fact",
						agentId,
						sourceEventIds: [sourceEventId],
					},
				}),
			),
		)
		await Promise.all(
			Array.from({ length: 12 }, () =>
				writeProcedure({
					db,
					prefix: PREFIX,
					client,
					embeddingMode: "automated",
					eventReceiptIds: [sourceEventId],
					entry: {
						procedureId,
						name: "Fence replacement workers",
						steps: ["Read the event receipt", "Skip a replay"],
						agentId,
						sourceEventIds: [sourceEventId],
					},
				}),
			),
		)

		const structured = await structuredMemCollection(db, PREFIX).findOne({
			agentId,
			type: "fact",
			key: structuredKey,
		})
		const procedure = await proceduresCollection(db, PREFIX).findOne({
			agentId,
			procedureId,
		})
		expect(structured).toMatchObject({
			revision: 1,
			reinforcementCount: 1,
			sourceEventIds: [sourceEventId],
		})
		expect(procedure).toMatchObject({
			revision: 1,
			sourceEventIds: [sourceEventId],
		})
		expect(
			await structuredMemRevisionsCollection(db, PREFIX).countDocuments({
				agentId,
				key: structuredKey,
			}),
		).toBe(0)
		expect(
			await procedureRevisionsCollection(db, PREFIX).countDocuments({
				agentId,
				procedureId,
			}),
		).toBe(0)
	})

	it("keeps staged work unclaimable until the producer releases it", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-staged`
		const jobId = `extraction-staged-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				stagedAt: new Date(),
				payload: { eventId: "event-staged" },
			},
		})

		await expect(
			claimMemoryJob({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "extraction",
				workerId: "worker-before-release",
				leaseMs: 60_000,
			}),
		).resolves.toBeNull()
		await expect(
			releaseStagedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
			}),
		).resolves.toBe(true)
		await expect(
			claimMemoryJob({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "extraction",
				workerId: "worker-after-release",
				leaseMs: 60_000,
			}),
		).resolves.toMatchObject({
			jobId,
			leaseOwner: "worker-after-release",
			status: "running",
		})
	})

	it("commits the canonical event and staged job as one transaction", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-transaction-commit`
		const eventId = `event-transaction-commit-${randomUUID()}`
		const jobId = `extraction-${eventId}`
		const session = client.startSession()
		try {
			await session.withTransaction(async () => {
				await writeEvent({
					db,
					prefix: PREFIX,
					session,
					event: {
						eventId,
						agentId,
						role: "user",
						body: "Commit this event with its durable extraction job.",
						scope: "agent",
						extractionJobPendingAt: new Date(),
					},
				})
				await createMemoryJob({
					db,
					prefix: PREFIX,
					session,
					job: {
						jobId,
						jobType: "extraction",
						agentId,
						status: "pending",
						stagedAt: new Date(),
						payload: { eventId },
					},
				})
			}, MAJORITY_TRANSACTION_OPTIONS)
		} finally {
			await session.endSession()
		}

		expect(
			await eventsCollection(db, PREFIX).countDocuments({ eventId, agentId }),
		).toBe(1)
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({ jobId, agentId }),
		).toBe(1)
	})

	it("aborts the canonical event when staging the job fails", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-transaction-abort`
		const eventId = `event-transaction-abort-${randomUUID()}`
		const session = client.startSession()
		try {
			await expect(
				session.withTransaction(async () => {
					await writeEvent({
						db,
						prefix: PREFIX,
						session,
						event: {
							eventId,
							agentId,
							role: "user",
							body: "This event must roll back with its missing job.",
							scope: "agent",
							extractionJobPendingAt: new Date(),
						},
					})
					throw new Error("forced job staging failure")
				}, MAJORITY_TRANSACTION_OPTIONS),
			).rejects.toThrow("forced job staging failure")
		} finally {
			await session.endSession()
		}

		expect(
			await eventsCollection(db, PREFIX).countDocuments({ eventId, agentId }),
		).toBe(0)
	})

	it("repairs a standalone crash from the canonical event outbox", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-standalone-repair`
		const eventId = `event-standalone-repair-${randomUUID()}`
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "@alice restores #durable-memory after a process crash.",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			},
		})
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{ db, prefix: PREFIX, agentId, chunkCount: 0 },
		) as MongoDBMemoryManager

		await expect(manager.repairExtractionOutbox()).resolves.toEqual({
			eventsProcessed: 1,
			jobsCreated: 1,
			jobsReleased: 1,
			eventsFailed: 0,
		})
		const storedEvent = await eventsCollection(db, PREFIX).findOne({ eventId })
		expect(storedEvent).not.toHaveProperty("extractionJobPendingAt")
		expect(storedEvent?.projectedAt).toBeInstanceOf(Date)
		await expect(
			claimMemoryJob({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "extraction",
				workerId: "worker-after-standalone-repair",
				leaseMs: 60_000,
			}),
		).resolves.toMatchObject({
			jobId: `extraction-${eventId}`,
			status: "running",
		})
	})

	it("backstops batch-durable events that committed without extraction jobs (C-023)", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-batch-backstop`
		const eventIds = [
			`event-batch-backstop-1-${randomUUID()}`,
			`event-batch-backstop-2-${randomUUID()}`,
		]
		// The batch path commits events first and stages extraction jobs in a
		// separate insert; when that insert fails, the outbox markers stay set
		// on durable events. Pin the exact durable-but-unstaged state that
		// failure branch leaves (C-023) and prove the backstop sweep repairs it.
		await writeEventsBatch({
			db,
			prefix: PREFIX,
			events: eventIds.map((eventId) => ({
				eventId,
				agentId,
				role: "user",
				body: "@alice restores #durable-memory after a batch staging failure.",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			})),
		})
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{ db, prefix: PREFIX, agentId, chunkCount: 0 },
		) as MongoDBMemoryManager

		await expect(manager.repairExtractionOutbox()).resolves.toEqual({
			eventsProcessed: 2,
			jobsCreated: 2,
			jobsReleased: 2,
			eventsFailed: 0,
		})
		for (const eventId of eventIds) {
			const storedEvent = await eventsCollection(db, PREFIX).findOne({
				eventId,
			})
			expect(storedEvent).not.toHaveProperty("extractionJobPendingAt")
			expect(storedEvent?.projectedAt).toBeInstanceOf(Date)
		}
		// Both re-staged jobs are claimable: two claims drain both events.
		const claimedJobIds = new Set<string>()
		for (let index = 0; index < eventIds.length; index += 1) {
			const claimed = await claimMemoryJob({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "extraction",
				workerId: `worker-after-batch-backstop-${index}`,
				leaseMs: 60_000,
			})
			expect(claimed).not.toBeNull()
			claimedJobIds.add(claimed?.jobId as string)
		}
		expect(claimedJobIds).toEqual(
			new Set(eventIds.map((eventId) => `extraction-${eventId}`)),
		)
	})

	it("rejects the original admission when the epoch advances after the pending read", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-stale-admission`
		const eventId = `event-stale-admission-${randomUUID()}`
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "No graph entities in this sentence.",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			},
		})
		let pendingReadIntercepted = false
		const interceptedDb = proxyDbCollections(db, (name, collection) => {
			if (name !== `${PREFIX}events`) return collection
			return new Proxy(collection, {
				get(target, property) {
					if (property === "find") {
						return (...args: Parameters<typeof target.find>) => {
							const cursor = target.find(...args)
							const toArray = cursor.toArray.bind(cursor)
							cursor.toArray = async () => {
								const docs = await toArray()
								if (!pendingReadIntercepted) {
									pendingReadIntercepted = true
									await bumpTenantErasureEpoch(db, PREFIX, agentId)
								}
								return docs
							}
							return cursor
						}
					}
					const value = Reflect.get(target, property, target)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})
		const manager = repairManager(interceptedDb, agentId)

		await expect(manager.repairExtractionOutbox()).rejects.toMatchObject({
			code: "ERASURE_GATE_CONFLICT",
		})
		expect(pendingReadIntercepted).toBe(true)
		expect(
			await eventsCollection(db, PREFIX).findOne({ eventId, agentId }),
		).toMatchObject({
			extractionJobPendingAt: expect.any(Date),
		})
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		expect(await chunksCollection(db, PREFIX).countDocuments({ agentId })).toBe(
			0,
		)
		expect(
			await projectionRunsCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		expect(
			await telemetryCollection(db, PREFIX).countDocuments({
				"meta.agentId": agentId,
			}),
		).toBe(0)
	})

	it("does not write zero-entity diagnostics after a post-commit epoch advance", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-stale-diagnostics`
		const eventId = `event-stale-diagnostics-${randomUUID()}`
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "No graph entities in this sentence.",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			},
		})
		let gateReads = 0
		const interceptedDb = proxyDbCollections(db, (name, collection) => {
			if (name !== `${PREFIX}meta`) return collection
			return new Proxy(collection, {
				get(target, property) {
					if (property === "findOne") {
						return async (...args: Parameters<typeof target.findOne>) => {
							gateReads += 1
							if (gateReads === 2) {
								await bumpTenantErasureEpoch(db, PREFIX, agentId)
							}
							return target.findOne(...args)
						}
					}
					const value = Reflect.get(target, property, target)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})
		const manager = repairManager(interceptedDb, agentId)

		await expect(manager.repairExtractionOutbox()).resolves.toEqual({
			eventsProcessed: 1,
			jobsCreated: 1,
			jobsReleased: 1,
			eventsFailed: 0,
		})
		expect(
			await eventsCollection(db, PREFIX).findOne({ eventId, agentId }),
		).not.toHaveProperty("extractionJobPendingAt")
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({
				agentId,
				stagedAt: { $exists: false },
			}),
		).toBe(1)
		expect(
			await projectionRunsCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		expect(
			await telemetryCollection(db, PREFIX).countDocuments({
				"meta.agentId": agentId,
			}),
		).toBe(0)
	})

	it("stops mid-loop when the original admission becomes stale", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-mid-loop-stop`
		const eventIds = [
			`event-mid-loop-1-${randomUUID()}`,
			`event-mid-loop-2-${randomUUID()}`,
		]
		await writeEventsBatch({
			db,
			prefix: PREFIX,
			events: eventIds.map((eventId) => ({
				eventId,
				agentId,
				role: "user",
				body: "No graph entities in this sentence.",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			})),
		})
		let gateReads = 0
		const interceptedDb = proxyDbCollections(db, (name, collection) => {
			if (name !== `${PREFIX}meta`) return collection
			return new Proxy(collection, {
				get(target, property) {
					if (property === "findOne") {
						return async (...args: Parameters<typeof target.findOne>) => {
							gateReads += 1
							if (gateReads === 3) {
								await bumpTenantErasureEpoch(db, PREFIX, agentId)
							}
							return target.findOne(...args)
						}
					}
					const value = Reflect.get(target, property, target)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})
		const manager = repairManager(interceptedDb, agentId)

		await expect(manager.repairExtractionOutbox()).rejects.toMatchObject({
			code: "ERASURE_GATE_CONFLICT",
		})
		expect(
			await eventsCollection(db, PREFIX).findOne({
				eventId: eventIds[0],
				agentId,
			}),
		).not.toHaveProperty("extractionJobPendingAt")
		expect(
			await eventsCollection(db, PREFIX).findOne({
				eventId: eventIds[1],
				agentId,
			}),
		).toMatchObject({
			extractionJobPendingAt: expect.any(Date),
		})
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({
				agentId,
				jobId: `extraction-${eventIds[0]}`,
				stagedAt: { $exists: false },
			}),
		).toBe(1)
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({
				agentId,
				jobId: `extraction-${eventIds[1]}`,
			}),
		).toBe(0)
	})

	it("rolls back job, chunk, graph, release, and marker on a late failure", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-late-rollback`
		const eventId = `event-late-rollback-${randomUUID()}`
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "@alice discusses #rollback.",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			},
		})
		let injected = false
		const interceptedDb = proxyDbCollections(db, (name, collection) => {
			if (name !== `${PREFIX}events`) return collection
			return new Proxy(collection, {
				get(target, property) {
					if (property === "updateOne") {
						return async (...args: Parameters<typeof target.updateOne>) => {
							const result = await target.updateOne(...args)
							const filter = args[0] as Record<string, unknown>
							if ("extractionJobPendingAt" in filter && !injected) {
								injected = true
								throw new Error("synthetic late marker failure")
							}
							return result
						}
					}
					const value = Reflect.get(target, property, target)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})
		const manager = repairManager(interceptedDb, agentId)

		await expect(manager.repairExtractionOutbox()).resolves.toEqual({
			eventsProcessed: 0,
			jobsCreated: 0,
			jobsReleased: 0,
			eventsFailed: 1,
		})
		expect(injected).toBe(true)
		expect(
			await eventsCollection(db, PREFIX).findOne({ eventId, agentId }),
		).toMatchObject({
			extractionJobPendingAt: expect.any(Date),
		})
		expect(
			await eventsCollection(db, PREFIX).findOne({ eventId, agentId }),
		).not.toHaveProperty("projectedAt")
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		expect(await chunksCollection(db, PREFIX).countDocuments({ agentId })).toBe(
			0,
		)
		expect(
			await entitiesCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		expect(
			await relationsCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
		expect(
			await entityLinksCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(0)
	})

	it("keeps repair deltas and graph provenance stable when the transaction callback retries", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-callback-retry`
		const eventId = `event-callback-retry-${randomUUID()}`
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "@alice",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			},
		})
		let injected = false
		let entityBulkWrites = 0
		const interceptedDb = proxyDbCollections(db, (name, collection) => {
			if (name !== `${PREFIX}entities`) return collection
			return new Proxy(collection, {
				get(target, property) {
					if (property === "bulkWrite") {
						return async (...args: Parameters<typeof target.bulkWrite>) => {
							entityBulkWrites += 1
							const result = await target.bulkWrite(...args)
							if (!injected) {
								injected = true
								throw new MongoServerError({
									ok: 0,
									code: 112,
									errmsg: "synthetic retry after native write",
									errorLabels: ["TransientTransactionError"],
								})
							}
							return result
						}
					}
					const value = Reflect.get(target, property, target)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})
		const manager = repairManager(interceptedDb, agentId)

		await expect(manager.repairExtractionOutbox()).resolves.toEqual({
			eventsProcessed: 1,
			jobsCreated: 1,
			jobsReleased: 1,
			eventsFailed: 0,
		})
		expect(injected).toBe(true)
		expect(entityBulkWrites).toBeGreaterThanOrEqual(2)
		expect(manager.chunkCount).toBe(1)
		expect(
			await memoryJobsCollection(db, PREFIX).countDocuments({ agentId }),
		).toBe(1)
		expect(await chunksCollection(db, PREFIX).countDocuments({ agentId })).toBe(
			1,
		)
		const entity = await entitiesCollection(db, PREFIX).findOne({
			agentId,
			name: "alice",
		})
		expect(entity).toMatchObject({
			mentionCount: 1,
			sourceEventIds: [eventId],
		})
		expect(
			await eventsCollection(db, PREFIX).findOne({ eventId, agentId }),
		).not.toHaveProperty("extractionJobPendingAt")
	})

	it("recovers and executes staged outbox work through the public manager factory", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "memongo-manager-startup-"),
		)
		const agentId = `${AGENT}-factory-startup`
		const eventId = `event-factory-startup-${randomUUID()}`
		const db = client.db(TEST_DB)
		await writeEvent({
			db,
			prefix: PREFIX,
			event: {
				eventId,
				agentId,
				role: "user",
				body: "@alice restores #startup-recovery from the durable outbox.",
				scope: "agent",
				extractionJobPendingAt: new Date(),
			},
		})
		const cfg = {
			agents: { defaults: { workspace } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: TEST_URI,
					database: TEST_DB,
					collectionPrefix: PREFIX,
					enableChangeStreams: false,
					kb: { enabled: false },
					relevance: { enabled: false },
					episodes: { enabled: false },
				},
			},
		} as unknown as MemongoConfig
		const previousReadinessTimeout =
			process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS
		const previousReadinessPoll =
			process.env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS
		process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS = "1"
		process.env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS = "1"
		let manager: MongoDBMemoryManager | undefined
		try {
			manager = await MongoDBMemoryManager.create({
				cfg,
				agentId,
				resolved: resolveMemoryBackendConfig({ cfg, agentId }),
			})
			// Give-up budget, not an expected runtime: this waits on a full
			// manager startup (which now builds the vector indexes that used to
			// fail) plus a worker round trip, while every other e2e file is
			// hitting the same container.
			const deadline = Date.now() + 90_000
			let stored = await memoryJobsCollection(db, PREFIX).findOne({
				jobId: `extraction-${eventId}`,
				agentId,
			})
			while (stored?.status !== "completed" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50))
				stored = await memoryJobsCollection(db, PREFIX).findOne({
					jobId: `extraction-${eventId}`,
					agentId,
				})
			}
			expect(stored).toMatchObject({
				jobId: `extraction-${eventId}`,
				status: "completed",
				attempts: 1,
			})
			expect(
				await eventsCollection(db, PREFIX).findOne({ eventId, agentId }),
			).not.toHaveProperty("extractionJobPendingAt")
		} finally {
			if (previousReadinessTimeout === undefined) {
				delete process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS
			} else {
				process.env.MEMONGO_SEARCH_INDEX_READINESS_TIMEOUT_MS =
					previousReadinessTimeout
			}
			if (previousReadinessPoll === undefined) {
				delete process.env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS
			} else {
				process.env.MEMONGO_SEARCH_INDEX_READINESS_POLL_MS =
					previousReadinessPoll
			}
			await manager?.close()
			await rm(workspace, { recursive: true, force: true })
		}
		// Give-up budget. Manager startup now builds the vector indexes that
		// used to fail outright, and every other e2e file is hitting the same
		// container, so 30s no longer covers a healthy run.
	})

	it("replays foreground entity projection without double-counting an event", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-entity-replay`
		const eventId = `event-entity-replay-${randomUUID()}`
		const params = {
			db,
			prefix: PREFIX,
			agentId,
			eventContent: "@alice owns #durable-memory",
			scope: "agent" as const,
			sourceEventId: eventId,
		}

		const first = await extractAndUpsertEntities(params)
		await extractAndUpsertEntities(params)

		const storedAfterReplay = await entitiesCollection(db, PREFIX).findOne({
			entityId: first.entities[0]?.entityId,
			agentId,
		})
		expect(storedAfterReplay).toMatchObject({
			mentionCount: 1,
			sourceEventIds: [eventId],
		})

		const nextEventId = `event-entity-next-${randomUUID()}`
		await extractAndUpsertEntities({
			...params,
			sourceEventId: nextEventId,
		})
		const storedAfterNewEvent = await entitiesCollection(db, PREFIX).findOne({
			entityId: first.entities[0]?.entityId,
			agentId,
		})
		expect(storedAfterNewEvent).toMatchObject({ mentionCount: 2 })
		expect(storedAfterNewEvent?.sourceEventIds).toEqual(
			expect.arrayContaining([eventId, nextEventId]),
		)
		const storedRelation = await relationsCollection(db, PREFIX).findOne({
			agentId,
			type: "mentioned_with",
		})
		const storedLink = await entityLinksCollection(db, PREFIX).findOne({
			agentId,
		})
		expect(storedRelation?.sourceEventIds).toEqual(
			expect.arrayContaining([eventId, nextEventId]),
		)
		expect(storedLink?.sourceEventIds).toEqual(
			expect.arrayContaining([eventId, nextEventId]),
		)
	})

	it("reclaims an expired crash lease and fences the stale worker", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-crash`
		const jobId = `extraction-crash-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-crash" },
			},
		})

		// Lease expiry is stamped with server $$NOW, so a synthetic `now` can no
		// longer simulate a crashed worker. A negative leaseMs creates a lease
		// that is genuinely expired in server time (a minute of headroom absorbs
		// client/server clock skew on the reclaim comparison).
		const first = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-before-crash",
			leaseMs: -60_000,
		})
		expect(first).not.toBeNull()

		const recovered = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-after-crash",
			leaseMs: 60_000,
		})
		expect(recovered).toMatchObject({
			jobId,
			status: "running",
			attempts: 2,
			leaseOwner: "worker-after-crash",
		})

		await expect(
			completeClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: first?.leaseOwner ?? "",
				leaseToken: first?.leaseToken ?? "",
			}),
		).resolves.toBe(false)
		await expect(
			failClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: first?.leaseOwner ?? "",
				leaseToken: first?.leaseToken ?? "",
				error: "stale worker must not win",
			}),
		).resolves.toBe(false)
		await expect(
			completeClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: recovered?.leaseOwner ?? "",
				leaseToken: recovered?.leaseToken ?? "",
				// Real clock: the recovered lease is 60 s in the future.
			}),
		).resolves.toBe(true)

		const stored = await memoryJobsCollection(db, PREFIX).findOne({ jobId })
		expect(stored).toMatchObject({
			jobId,
			status: "completed",
			attempts: 2,
		})
		expect(stored).not.toHaveProperty("leaseOwner")
		expect(stored).not.toHaveProperty("leaseToken")
	})

	it("rejects terminal writes after lease expiry even before reclaim", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-expired-terminal`
		const jobId = `extraction-expired-terminal-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-expired-terminal" },
			},
		})
		// Negative leaseMs: the lease is stamped expired in server time (see the
		// crash-reclaim test above for why a synthetic `now` no longer works).
		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-expired-terminal",
			leaseMs: -60_000,
		})
		expect(claimed).not.toBeNull()

		await expect(
			completeClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: claimed?.leaseOwner ?? "",
				leaseToken: claimed?.leaseToken ?? "",
			}),
		).resolves.toBe(false)
		await expect(
			failClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: claimed?.leaseOwner ?? "",
				leaseToken: claimed?.leaseToken ?? "",
				error: "expired worker must not win",
			}),
		).resolves.toBe(false)
		expect(
			await memoryJobsCollection(db, PREFIX).findOne({ jobId }),
		).toMatchObject({ status: "running" })
	})

	it("retries a failed deterministic job while preserving attempt history", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-retry`
		const jobId = `extraction-retry-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-retry" },
			},
		})
		const claimedAt = new Date()
		const first = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-first-attempt",
			leaseMs: 60_000,
			now: claimedAt,
		})
		expect(first).not.toBeNull()
		await expect(
			failClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: first?.leaseOwner ?? "",
				leaseToken: first?.leaseToken ?? "",
				now: claimedAt,
				error: "temporary failure",
			}),
		).resolves.toBe(true)

		await expect(
			retryFailedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				payload: { eventId: "event-retry" },
			}),
		).resolves.toBe(true)
		const second = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-second-attempt",
			leaseMs: 60_000,
			now: new Date(claimedAt.getTime() + 1),
		})
		expect(second).toMatchObject({
			jobId,
			attempts: 2,
			status: "running",
			leaseOwner: "worker-second-attempt",
		})
	})

	it("retries a failed job until it exhausts its attempt budget (C4)", async () => {
		// Before this, `attempts` was incremented on every claim and read by
		// nothing, so claimMemoryJob never matched a failed job. Extraction
		// clears the event's extractionJobPendingAt marker when the job is
		// released — before the work runs — so repairExtractionOutbox could not
		// see it either. One transient failure dropped that event's memories
		// permanently and silently.
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-retry-budget`
		const jobId = `extraction-retry-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-retry" },
			},
		})

		// Each round claims, fails, then waits out the backoff by moving the
		// clock forward rather than sleeping.
		let now = new Date("2026-07-23T00:00:00.000Z")
		const observedAttempts: number[] = []
		for (let round = 0; round < MEMORY_JOB_MAX_ATTEMPTS; round++) {
			const claimed = await claimMemoryJob({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "extraction",
				workerId: `worker-${round}`,
				leaseMs: 60_000,
				now,
			})
			expect(claimed).not.toBeNull()
			observedAttempts.push(claimed!.attempts)
			await failClaimedMemoryJob({
				db,
				prefix: PREFIX,
				jobId,
				agentId,
				leaseOwner: claimed!.leaseOwner,
				leaseToken: claimed!.leaseToken,
				now,
				error: `transient failure ${round}`,
				attempts: claimed!.attempts,
			})
			// Past any backoff this job could have been given.
			now = new Date(now.getTime() + 2 * 60 * 60_000)
		}

		expect(observedAttempts).toEqual([1, 2, 3])

		// Budget spent: the job stays failed as an explicit dead letter.
		const exhausted = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-final",
			leaseMs: 60_000,
			now,
		})
		expect(exhausted).toBeNull()

		const doc = await memoryJobsCollection(db, PREFIX).findOne({ jobId })
		expect(doc?.status).toBe("failed")
		expect(doc?.attempts).toBe(MEMORY_JOB_MAX_ATTEMPTS)
		// WS-13: the exhausted job is an explicit dead letter — marked for
		// operator visibility and deliberately kept out of the completed-TTL
		// index's reach so it survives until requeued or dropped.
		expect(doc?.deadLetterAt).toBeInstanceOf(Date)
		expect(doc).not.toHaveProperty("completedAt")
		expect(doc).not.toHaveProperty("retryAt")
	})

	it("holds a failed job until its retry backoff elapses", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-retry-backoff`
		const jobId = `extraction-backoff-${randomUUID()}`
		await createMemoryJob({
			db,
			prefix: PREFIX,
			job: {
				jobId,
				jobType: "extraction",
				agentId,
				status: "pending",
				payload: { eventId: "event-backoff" },
			},
		})

		const now = new Date("2026-07-23T00:00:00.000Z")
		const claimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-a",
			leaseMs: 60_000,
			now,
		})
		expect(claimed).not.toBeNull()
		await failClaimedMemoryJob({
			db,
			prefix: PREFIX,
			jobId,
			agentId,
			leaseOwner: claimed!.leaseOwner,
			leaseToken: claimed!.leaseToken,
			now,
			error: "transient failure",
			attempts: claimed!.attempts,
		})

		// Immediately after failing, the job is still inside its backoff window,
		// so a job that fails for a persistent reason cannot spin the worker.
		const tooSoon = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-b",
			leaseMs: 60_000,
			now: new Date(now.getTime() + 1_000),
		})
		expect(tooSoon).toBeNull()

		const afterBackoff = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "extraction",
			workerId: "worker-c",
			leaseMs: 60_000,
			now: new Date(now.getTime() + 10 * 60_000),
		})
		expect(afterBackoff).not.toBeNull()
		expect(afterBackoff!.attempts).toBe(2)
	})

	it("auto-stages one consolidation job per cadence window and the drain claims and completes it (WS-13)", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-auto-consolidation`
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db,
				prefix: PREFIX,
				agentId,
				chunkCount: 0,
				memoryJobWorkerId: "worker-auto-consolidation",
				memoryJobWorkerStopped: false,
				memoryJobWorkerActive: false,
				memoryJobWakeRequested: false,
				memoryJobWorkerPromise: Promise.resolve(),
				memoryJobWorkerTimer: null,
				memoryJobOperationContexts: new Map(),
			},
		) as MongoDBMemoryManager
		const lifecycle = MongoDBMemoryManager.prototype as unknown as {
			drainMemoryJobQueue: (this: MongoDBMemoryManager) => Promise<void>
		}

		// Drain #1: stages the current cadence window's consolidation job,
		// finds no extraction work, then claims and completes the staged job
		// through the same lease/heartbeat fencing extraction uses.
		await lifecycle.drainMemoryJobQueue.call(manager)

		const windowIndex = Math.floor(Date.now() / (6 * 60 * 60 * 1000))
		const jobId = `consolidation-auto-${agentId}-${windowIndex}`
		const staged = await memoryJobsCollection(db, PREFIX).findOne({
			jobId,
			agentId,
		})
		expect(staged).not.toBeNull()
		expect(staged).toMatchObject({
			jobType: "consolidation",
			status: "completed",
		})
		expect(staged?.completedAt).toBeInstanceOf(Date)
		expect(staged?.metadata).toMatchObject({ auto: true })
		// The lease fields the claim set are released on completion.
		expect(staged).not.toHaveProperty("leaseOwner")
		expect(staged).not.toHaveProperty("leaseToken")

		// A second agent sharing the prefix stages ITS OWN window job: the
		// jobId is agent-scoped, so the first agent's unique index can never
		// swallow a peer agent's staging (one job per window per agent).
		const peerAgentId = `${AGENT}-auto-consolidation-peer`
		const peer = Object.assign(Object.create(MongoDBMemoryManager.prototype), {
			db,
			prefix: PREFIX,
			agentId: peerAgentId,
			chunkCount: 0,
			memoryJobWorkerId: "worker-auto-consolidation-peer",
			memoryJobWorkerStopped: false,
			memoryJobWorkerActive: false,
			memoryJobWakeRequested: false,
			memoryJobWorkerPromise: Promise.resolve(),
			memoryJobWorkerTimer: null,
			memoryJobOperationContexts: new Map(),
		}) as MongoDBMemoryManager
		await lifecycle.drainMemoryJobQueue.call(peer)

		const peerJobId = `consolidation-auto-${peerAgentId}-${windowIndex}`
		await expect(
			memoryJobsCollection(db, PREFIX).findOne({ jobId: peerJobId }),
		).resolves.toMatchObject({
			jobType: "consolidation",
			status: "completed",
		})

		// Drain #2 in the same window: the in-memory window memo skips
		// re-staging, so exactly one job document exists per agent for this
		// window.
		await lifecycle.drainMemoryJobQueue.call(manager)
		await expect(
			memoryJobsCollection(db, PREFIX).countDocuments({
				agentId,
				jobType: "consolidation",
				jobId: new RegExp(`^consolidation-auto-${agentId}-${windowIndex}$`),
			}),
		).resolves.toBe(1)
	})

	it("adopts a failed tracking row by clearing the marker in the claiming update", async () => {
		const db = client.db(TEST_DB)
		const agentId = `${AGENT}-tracking-adoption`
		const jobs = memoryJobsCollection(db, PREFIX)
		const baseJob = {
			jobType: "consolidation" as const,
			agentId,
			createdAt: new Date(),
		}

		// A failed tracking row (the terminal state of a crashed synchronous
		// run) is claimable; the SAME atomic claim clears the tracking marker,
		// so ownership transfers to the worker and later lease-expiry recovery
		// applies.
		const adoptedId = `consolidation-tracking-adopted-${randomUUID()}`
		await jobs.insertOne({
			...baseJob,
			jobId: adoptedId,
			status: "failed",
			attempts: 1,
			tracking: true,
		})
		const adopted = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "consolidation",
			workerId: "worker-tracking-adopter",
			leaseMs: -60_000,
		})
		expect(adopted).toMatchObject({ jobId: adoptedId, attempts: 2 })
		// The stored row, not just the returned view, lost the marker.
		const adoptedStored = await jobs.findOne({ jobId: adoptedId })
		expect(adoptedStored?.status).toBe("running")
		expect(adoptedStored).not.toHaveProperty("tracking")

		// The adopted row is now an ordinary running row: a replacement worker
		// reclaims it after lease expiry (tracking no longer excludes it).
		const reclaimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "consolidation",
			workerId: "worker-tracking-reclaimer",
			leaseMs: 60_000,
		})
		expect(reclaimed).toMatchObject({
			jobId: adoptedId,
			attempts: 3,
			leaseOwner: "worker-tracking-reclaimer",
		})

		// A tracking row whose attempt budget is spent dead-letters like any
		// other claimed work once the adopted lease expires.
		const deadId = `consolidation-tracking-dead-${randomUUID()}`
		await jobs.insertOne({
			...baseJob,
			jobId: deadId,
			status: "failed",
			attempts: MEMORY_JOB_MAX_ATTEMPTS - 1,
			tracking: true,
		})
		const deadClaimed = await claimMemoryJob({
			db,
			prefix: PREFIX,
			agentId,
			jobType: "consolidation",
			workerId: "worker-tracking-dead",
			leaseMs: -60_000,
		})
		expect(deadClaimed).toMatchObject({
			jobId: deadId,
			attempts: MEMORY_JOB_MAX_ATTEMPTS,
		})
		await expect(
			deadLetterExpiredMemoryJobs({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "consolidation",
			}),
		).resolves.toBe(1)
		const deadStored = await jobs.findOne({ jobId: deadId })
		expect(deadStored).toMatchObject({ status: "failed" })
		expect(deadStored?.deadLetterAt).toBeInstanceOf(Date)
		expect(deadStored).not.toHaveProperty("completedAt")

		// Guard: a LIVE synchronous row (running + tracking, lease-less) stays
		// unclaimable and sweep-exempt — the marker still protects rows the
		// synchronous runner owns.
		const liveId = `consolidation-tracking-live-${randomUUID()}`
		await jobs.insertOne({
			...baseJob,
			jobId: liveId,
			status: "running",
			attempts: 1,
			tracking: true,
		})
		for (const workerId of ["worker-guard-1", "worker-guard-2"]) {
			await expect(
				claimMemoryJob({
					db,
					prefix: PREFIX,
					agentId,
					jobType: "consolidation",
					workerId,
					leaseMs: 60_000,
				}),
			).resolves.toBeNull()
		}
		await expect(
			deadLetterExpiredMemoryJobs({
				db,
				prefix: PREFIX,
				agentId,
				jobType: "consolidation",
			}),
		).resolves.toBe(0)
		await expect(jobs.findOne({ jobId: liveId })).resolves.toMatchObject({
			status: "running",
			tracking: true,
			attempts: 1,
		})
	})
})
