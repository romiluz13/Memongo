import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import {
	promoteDerivedMemoryFromEvent,
	type PreparedDerivedMemoryPromotion,
} from "./mongodb-derived-memory.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { createMemoryJob, claimMemoryJob } from "./mongodb-memory-jobs.js"
import { ensureCollections } from "./mongodb-schema.js"
import { captureAdmissionToken } from "./mongodb-write-fence.js"

const transport = vi.hoisted(() => ({
	prepared: null as PreparedDerivedMemoryPromotion | null,
	calls: 0,
	wait: async () => {},
}))
vi.mock("./mongodb-derived-memory.js", async (original) => ({
	...(await original<typeof import("./mongodb-derived-memory.js")>()),
	prepareDerivedMemoryPromotion: async () => transport.prepared,
}))
vi.mock("./mongodb-graph.js", async (original) => ({
	...(await original<typeof import("./mongodb-graph.js")>()),
	extractAndUpsertEntities: async () => ({
		entities: [],
		relationsCreated: 0,
		diagnostics: { durationMs: 0 },
	}),
}))
vi.mock("./mongodb-llm-enrichment.js", async (original) => ({
	...(await original<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => false,
	resolveEnrichmentProvider: (): EnrichmentProvider => ({
		name: "owned-local-authority-fixture",
		async chatCompletion(request) {
			if (
				!request.messages[0]?.content.includes(
					"You detect direct contradictions",
				)
			)
				throw new Error("unexpected local provider request")
			transport.calls++
			await transport.wait()
			return {
				content: '{"contradictions":[{"key":"city","rationale":"relocation"}]}',
			}
		},
	}),
}))
const uri = process.env.MEMONGO_TEST_MONGODB_URI
if (
	!uri ||
	new URL(uri).hostname !== "127.0.0.1" ||
	new URL(uri).port !== "27218"
)
	throw new Error("E160 explicit owned server only")
const client = new MongoClient(uri)
const name = `memongo_e160_authority_${randomUUID().replaceAll("-", "")}`
const db = client.db(name),
	prefix = "test_"
function evidence(label: string, value: unknown) {
	if (process.env.E22_FETCH_EVIDENCE_DIR)
		writeFileSync(
			`${process.env.E22_FETCH_EVIDENCE_DIR}/promotion-authority-${label}.json`,
			JSON.stringify(value),
		)
}
beforeAll(async () => {
	evidence("fixture-worker", { fixturePid: process.pid })
	await client.connect()
	await ensureCollections(db, prefix)
})
afterAll(async () => {
	vi.restoreAllMocks()
	try {
		await db.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name } })
		expect(listed.databases).toEqual([])
		evidence("cleanup", { name, databases: listed.databases })
	} finally {
		await client.close()
	}
})
const kinds = [
	"guard-rejected",
	"invalidated",
	"conflicted",
	"happy",
	"fresh-happy",
	"source-stale",
] as const
for (const path of ["worker", "direct"] as const) {
	it.each(
		kinds,
	)(`${path} %s cannot retire from rejected source`, async (kind) => {
		const agentId = randomUUID(),
			eventId = randomUUID(),
			now = new Date()
		const scope = "agent" as const,
			scopeRef = `agent:${agentId}`
		const event = {
			eventId,
			agentId,
			scope,
			scopeRef,
			role: "user" as const,
			body: "Remember this: moved to Paris",
			timestamp: now,
		}
		await captureAdmissionToken({ db, prefix, agentId })
		await db.collection(`${prefix}events`).insertOne(event)
		const col = db.collection(`${prefix}structured_mem`)
		await col.insertOne({
			agentId,
			scope,
			scopeRef,
			type: "fact",
			key: "city",
			value: "Lives in London",
			state: "active",
			revision: 1,
			createdAt: now,
			updatedAt: now,
		})
		const targetBefore = await col.findOne({ agentId, key: "city" })
		if (kind !== "guard-rejected" && kind !== "fresh-happy")
			await col.insertOne({
				agentId,
				scope,
				scopeRef,
				type: "fact",
				key: "relocation",
				value: "Moved to Paris",
				state:
					kind === "invalidated" || kind === "conflicted" ? kind : "active",
				revision: 1,
				sourceEventIds: [eventId],
				createdAt: now,
				updatedAt: now,
			})
		const sourceBefore = await col.findOne({ agentId, key: "relocation" })
		const prepared: PreparedDerivedMemoryPromotion = {
			structuredCandidates: [
				{
					agentId,
					scope,
					scopeRef,
					type: "fact",
					key: "relocation",
					value: "Moved to Paris",
					sourceEventIds: [eventId],
				},
			],
			procedureCandidates: [],
			promotionGuards: {
				"fact\0relocation":
					kind === "guard-rejected"
						? {
								kind: "existing",
								revision: 1,
								value: "Missing durable evidence",
							}
						: { kind: "immediate" },
			},
		}
		transport.prepared = prepared
		transport.calls = 0
		let changed = false
		transport.wait = async () => {
			if (kind === "source-stale") {
				changed = true
				await col.updateOne(
					{ agentId, key: "relocation" },
					{ $set: { value: "Moved to Rome", revision: 2 } },
				)
			}
		}
		if (path === "worker") {
			const jobId = randomUUID()
			await createMemoryJob({
				db,
				prefix,
				job: {
					jobId,
					jobType: "extraction",
					agentId,
					status: "pending",
					payload: { eventId },
				},
			})
			const job = await claimMemoryJob({
				db,
				prefix,
				agentId,
				jobType: "extraction",
				workerId: "owned-fixture",
				leaseMs: 60000,
			})
			expect(job).not.toBeNull()
			if (!job) throw new Error("fixture lease missing")
			const host = {
				client,
				db,
				prefix,
				agentId,
				config: { mongodb: { embeddingMode: "automated" } },
				workspaceDir: "/tmp/memongo-e160",
				memoryJobOperationContexts: new Map(),
			} as unknown as MongoDBManagerHost
			await new MongoDBManagerJobsOps(host).runClaimedBackgroundExtractionJob(
				job,
			)
			expect(
				await db.collection(`${prefix}memory_jobs`).findOne({ jobId }),
			).toMatchObject({ status: "completed" })
		} else {
			const enrichment = await import("./mongodb-llm-enrichment.js")
			await promoteDerivedMemoryFromEvent({
				db,
				prefix,
				client,
				event,
				prepared,
				embeddingMode: "automated",
				contradictionProvider: enrichment.resolveEnrichmentProvider(
					process.env,
				),
			})
		}
		const target = await col.findOne({ agentId, key: "city" })
		const source = await col.findOne({ agentId, key: "relocation" })
		if (kind === "happy" || kind === "fresh-happy") {
			expect(transport.calls).toBe(1)
			expect(target).toMatchObject({
				state: "invalidated",
				revision: 2,
				invalidatedBy: {
					byKey: "relocation",
					byValue: "Moved to Paris",
					runId: eventId,
				},
			})
			if (kind === "fresh-happy") {
				expect(source).toMatchObject({
					agentId,
					type: "fact",
					key: "relocation",
					value: "Moved to Paris",
					state: "active",
					revision: 1,
					sourceEventIds: [eventId],
				})
			} else expect(source).toEqual(sourceBefore)
			expect(
				await db
					.collection(`${prefix}memory_mutations`)
					.countDocuments({ agentId, operation: "invalidate" }),
			).toBe(1)
		} else {
			expect(target).toEqual(targetBefore)
			expect(
				await db
					.collection(`${prefix}memory_mutations`)
					.countDocuments({ agentId, operation: "invalidate" }),
			).toBe(0)
			expect(
				await db
					.collection(`${prefix}structured_mem_revisions`)
					.countDocuments({ agentId, key: "city" }),
			).toBe(0)
			if (kind === "source-stale") {
				expect(changed).toBe(true)
				expect(transport.calls).toBe(1)
				expect(source).toEqual({
					...sourceBefore,
					value: "Moved to Rome",
					revision: 2,
				})
			} else {
				expect(transport.calls).toBe(0)
				expect(source).toEqual(sourceBefore)
			}
		}
		evidence(`${path}-${kind}`, {
			calls: transport.calls,
			changed,
			target,
			source,
		})
	})
}
