import { afterEach, describe, expect, it, vi } from "vitest"
import { MongoClient } from "mongodb"
import {
	fixture,
	event,
	BODY,
	type Row,
} from "./test-helpers/persistence-contract-store.js"
import {
	prepareDerivedMemoryPromotion,
	persistPreparedDerivedMemoryPromotion,
} from "./mongodb-derived-memory.js"
import { withFencedWrite } from "./mongodb-write-fence.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { MongoDBManagerJobsOps } from "./mongodb-manager-jobs.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import type { ClaimedMemoryJob } from "./types.js"

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

const PREFIX_FACT =
	"From a conversation about parcel pickup: The user's pickup label is NARU-617-QP."
async function managerLoop(
	options: {
		fact?: string
		batchFacts?: string[]
		mutateSupport?: (row: Row) => void
		mutateCurrent?: (row: Row) => void
		roles?: ["user" | "assistant" | "tool", "user" | "assistant" | "tool"]
		failWrite?: boolean
		transientWrite?: boolean
	} = {},
) {
	const connect = vi
		.spyOn(MongoClient.prototype, "connect")
		.mockImplementation(async () => {
			throw Error("real MongoClient forbidden")
		})
	const f = fixture([])
	f.rows.set("test_events", [])
	f.table("test_meta").push({
		_id: "tenant-erasure-epoch:offline",
		agentId: "offline",
		epoch: 0,
		state: "open",
		serial: 0,
	})
	const manager = Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		db: f.db,
		prefix: "test_",
		agentId: event.agentId,
		config: {
			mongodb: { embeddingMode: "automated", episodes: { enabled: false } },
		},
		closed: false,
		writeQueue: Promise.resolve(),
		writeQueueDepth: 0,
		chunkCount: 0,
		memoryJobWorkerActive: true,
		memoryJobWorkerStopped: false,
		memoryJobWorkerGeneration: 0,
		memoryJobOperationContexts: new Map(),
	}) as MongoDBMemoryManager
	const receipts = await manager.writeConversationEventsBatch([
		{ ...event, role: options.roles?.[0] ?? "user" },
		{
			...event,
			role: options.roles?.[1] ?? "assistant",
			timestamp: new Date(1),
		},
	])
	expect(receipts.every((r) => r.ok)).toBe(true)
	expect(receipts.every((r) => r.ok && r.chunkCreated)).toBe(true)
	const actual = f.table("test_events")
	const fact = options.fact ?? PREFIX_FACT
	options.mutateSupport?.(actual[1])
	options.mutateCurrent?.(actual[0])
	f.controls.failStructuredWrites = options.failWrite ? 1 : 0
	f.controls.transientStructuredWrites = options.transientWrite ? 1 : 0
	vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "offline-dummy")
	vi.stubEnv("MEMONGO_ENRICHMENT_BASE_URL", "http://127.0.0.1:1/v1")
	vi.stubEnv("MEMONGO_ENRICHMENT_PROVIDER", "openai-compatible")
	vi.stubEnv("MEMONGO_ENRICHMENT_AUTH_STYLE", "api-key")
	vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "FW-DeepSeek-V4.1-Flash")
	vi.stubEnv("MEMONGO_ENRICHMENT_ALLOW_PRIVATE_NETWORK", "true")
	vi.stubEnv("MEMONGO_EXTRACTION_LLM", "on")
	let requests = 0
	const transcripts: string[] = []
	const extractionResponses: { transcript: string; facts: string[] }[] = []
	vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
		requests++
		const request = JSON.parse(String(init.body)) as {
			messages: { role: string; content: string }[]
		}
		const transcript =
			request.messages.find((m) => m.role === "user")?.content ?? ""
		transcripts.push(transcript)
		const facts = transcript.includes(
			`<transcript>\n${BODY}\n${BODY}\n</transcript>`,
		)
			? (options.batchFacts ?? [fact])
			: [fact]
		if (transcript.includes("<transcript>")) {
			extractionResponses.push({ transcript, facts })
		}
		return new Response(
			JSON.stringify({
				model: "FW-DeepSeek-V4.1-Flash",
				choices: [
					{
						message: {
							content: JSON.stringify({
								facts,
								qa_pairs: [],
								has_personal_content: true,
							}),
						},
						finish_reason: "stop",
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)
	})
	const host = manager as unknown as MongoDBManagerHost
	const jobs = f.table("test_memory_jobs").map((row) =>
		Object.assign(row, {
			status: "running",
			leaseOwner: "fixture",
			leaseToken: `lease-${row.jobId}`,
			leaseExpiresAt: new Date(Date.now() + 60000),
			startedAt: new Date(),
			attempts: 1,
		}),
	) as ClaimedMemoryJob[]
	const assigned = await new MongoDBManagerJobsOps(
		host,
	).prefetchExtractionSessionFacts(jobs)
	const worker = new MongoDBManagerJobsOps(host)
	await worker.runClaimedBackgroundExtractionJob(
		jobs[0],
		assigned.get(actual[0].eventId as string),
	)
	const completed = f.table("test_memory_jobs")[0]
	const stored = f.table("test_structured_mem")
	console.log(
		"STAGES",
		JSON.stringify({
			canonical: f.table("test_events").length,
			mockHttp: requests,
			assigned: assigned.size,
			written: stored.length,
			jobStatus: completed.status,
			jobError: completed.error,
			outputCount: completed.outputCount,
			transactions: f.transactions,
			missing: [
				"real driver/server transaction concurrency",
				"automatic lease claim scheduler",
			],
		}),
	)
	expect(connect).not.toHaveBeenCalled()
	return {
		f,
		actual,
		assigned,
		completed: f.table("test_memory_jobs")[0],
		stored,
		requests,
		transcripts,
		extractionResponses,
	}
}

describe("prompt-compatible facts reach durable persistence through actual assignment", () => {
	it("persists a grounded contextual possessive fact through the actual manager and worker", async () => {
		const r = await managerLoop()
		expect(r.completed.status).toBe("completed")
		expect(r.completed.outputCount).toBe(1)
		expect(r.stored).toHaveLength(1)
		expect(r.stored[0]).toMatchObject({
			value: PREFIX_FACT,
			sourceEventIds: r.actual.map((e) => e.eventId).sort(),
			reinforcementCount: 2,
			sourceAgent: { name: "extractor" },
			provenance: {
				promotionTrigger: "repeated-evidence",
				supportingEventCount: 1,
			},
		})
		expect(r.assigned.size).toBe(0)
	})
	it("valid empty batch facts retain actual per-event fallback", async () => {
		const r = await managerLoop({ batchFacts: [] })
		expect(r.extractionResponses).toEqual([
			{
				transcript: expect.stringContaining(
					`<transcript>\n${BODY}\n${BODY}\n</transcript>`,
				),
				facts: [],
			},
			{
				transcript: expect.stringContaining(
					`<transcript>\n${BODY}\n</transcript>`,
				),
				facts: [PREFIX_FACT],
			},
		])
		expect(r.assigned.size).toBe(0)
		expect(r.completed.status).toBe("completed")
		expect(r.completed.outputCount).toBe(1)
		expect(r.stored).toHaveLength(1)
		expect(r.stored[0]).toMatchObject({
			value: PREFIX_FACT,
			sourceEventIds: r.actual.map((e) => e.eventId).sort(),
			reinforcementCount: 2,
			provenance: {
				promotionTrigger: "repeated-evidence",
				supportingEventCount: 1,
			},
		})
	})
	it.each([
		[
			"quoted current claim",
			{
				mutateCurrent: (row: Row) => {
					row.body = `Alice said, "${BODY}"`
				},
			},
		],
		[
			"named current claim",
			{
				mutateCurrent: (row: Row) => {
					row.body = `Alice: ${BODY}`
				},
			},
		],
		[
			"extended current claim",
			{
				mutateCurrent: (row: Row) => {
					row.body = `${BODY} This is a quoted example.`
				},
			},
		],
		[
			"unsupported claim",
			{
				fact: "From a conversation about parcel pickup: The user's pickup label is WRONG.",
			},
		],
		[
			"quoted support",
			{
				mutateSupport: (row: Row) => {
					row.body = `Alice said, "${BODY}"`
				},
			},
		],
		[
			"named support",
			{
				mutateSupport: (row: Row) => {
					row.body = `Alice: ${BODY}`
				},
			},
		],
		[
			"cross-agent",
			{
				mutateSupport: (row: Row) => {
					row.agentId = "other"
				},
			},
		],
		[
			"cross-scope",
			{
				mutateSupport: (row: Row) => {
					row.scope = "session"
				},
			},
		],
		[
			"cross-scope reference",
			{
				mutateSupport: (row: Row) => {
					row.scopeRef = "other"
				},
			},
		],
		[
			"expired",
			{
				mutateSupport: (row: Row) => {
					row.expiresAt = new Date(0)
				},
			},
		],
		[
			"invalidated",
			{
				mutateSupport: (row: Row) => {
					row.invalidAt = new Date(0)
				},
			},
		],
		[
			"future-valid",
			{
				mutateSupport: (row: Row) => {
					row.validAt = new Date(Date.now() + 3600000)
				},
			},
		],
	] as const)("does not persist %s evidence", async (_name, options) => {
		const r = await managerLoop(options)
		expect(r.stored).toHaveLength(0)
		expect(r.completed.status).toBe("completed")
		expect(r.completed.outputCount).toBe(0)
	})
	it("permits repeated evidence from another same-scope session while batch grouping stays isolated", async () => {
		const r = await managerLoop({
			mutateSupport: (row) => {
				row.sessionId = "other-session"
			},
		})
		expect(r.assigned.size).toBe(0)
		expect(r.completed.status).toBe("completed")
		expect(r.stored).toHaveLength(1)
	})
	it("rejects an unlabelled contextual write failure and rolls back its transaction", async () => {
		const r = await managerLoop({ failWrite: true })
		expect(r.stored).toHaveLength(0)
		expect(r.completed.status).toBe("failed")
		expect(r.completed.error).toBe("offline structured write failure")
		expect(r.f.transactions.aborted).toBe(1)
	})
	it("retries a labelled transactional write failure with one durable result", async () => {
		const r = await managerLoop({ transientWrite: true })
		expect(r.stored).toHaveLength(1)
		expect(r.completed.status).toBe("completed")
		expect(r.completed.outputCount).toBe(1)
		expect(r.f.transactions.retried).toBe(1)
		expect(r.f.transactions.aborted).toBe(1)
	})
	it("rechecks the prepared reinforcement body before persistence", async () => {
		const f = fixture()
		const args = {
			db: f.db,
			prefix: "test_",
			event,
			prefetchedLlmFacts: [PREFIX_FACT],
		}
		const prepared = await prepareDerivedMemoryPromotion(args)
		expect(prepared.structuredCandidates).toHaveLength(1)
		f.table("test_events")[1].body = "changed"
		const result = await persistPreparedDerivedMemoryPromotion({
			...args,
			prepared,
			embeddingMode: "automated",
		})
		expect(result.structuredCreated).toBe(0)
		expect(f.table("test_structured_mem")).toHaveLength(0)
	})
})

describe("contextual personal facts require a canonical user witness", () => {
	it.each([
		["assistant", "assistant"],
		["tool", "tool"],
		["assistant", "tool"],
	] as const)("rejects %s plus %s evidence", async (current, support) => {
		const r = await managerLoop({ roles: [current, support] })
		expect(r.stored).toHaveLength(0)
		expect(r.completed.status).toBe("completed")
		expect(r.completed.outputCount).toBe(0)
	})
	it.each([
		["user", "assistant"],
		["user", "user"],
		["assistant", "user"],
	] as const)("preserves %s plus %s evidence", async (current, support) => {
		const r = await managerLoop({ roles: [current, support] })
		expect(r.stored).toHaveLength(1)
		expect(r.completed.status).toBe("completed")
		expect(r.completed.outputCount).toBe(1)
		expect(r.stored[0].value).toBe(PREFIX_FACT)
	})
	it("rejects stale user role supplied in the event argument", async () => {
		const f = fixture()
		for (const row of f.table("test_events")) row.role = "assistant"
		const prepared = await prepareDerivedMemoryPromotion({
			db: f.db,
			prefix: "test_",
			event,
			prefetchedLlmFacts: [PREFIX_FACT],
		})
		expect(prepared.structuredCandidates).toHaveLength(0)
	})
	it.each([
		"role",
		"body",
		"scope",
		"expired",
		"invalidated",
		"removed",
	] as const)("fenced commit rejects changed current user witness: %s", async (change) => {
		const f = fixture()
		f.table("test_events")[1].role = "assistant"
		const args = {
			db: f.db,
			prefix: "test_",
			event,
			prefetchedLlmFacts: [PREFIX_FACT],
		}
		const prepared = await prepareDerivedMemoryPromotion(args)
		expect(prepared.structuredCandidates).toHaveLength(1)
		const row = f.table("test_events")[0]
		if (change === "role") row.role = "assistant"
		if (change === "body") row.body = "changed"
		if (change === "scope") row.scopeRef = "other"
		if (change === "expired") row.expiresAt = new Date(0)
		if (change === "invalidated") row.invalidAt = new Date(0)
		if (change === "removed")
			f.rows.set("test_events", f.table("test_events").slice(1))
		f.table("test_meta").push({
			_id: "tenant-erasure-epoch:offline",
			agentId: "offline",
			epoch: 0,
			state: "open",
			serial: 0,
		})
		const result = await withFencedWrite({
			db: f.db,
			prefix: "test_",
			token: { kind: "admission", agentId: "offline", epoch: 0 },
			fn: (session) =>
				persistPreparedDerivedMemoryPromotion({
					...args,
					prepared,
					embeddingMode: "automated",
					session,
				}),
		})
		expect(result.structuredCreated).toBe(0)
		expect(f.table("test_structured_mem")).toHaveLength(0)
		expect(f.table("test_meta")[0].serial).toBe(1)
		expect(f.transactions.ended).toBe(1)
	})
	it("fenced commit rejects changed supporting user role", async () => {
		const f = fixture()
		f.table("test_events")[0].role = "assistant"
		const args = {
			db: f.db,
			prefix: "test_",
			event: { ...event, role: "assistant" as const },
			prefetchedLlmFacts: [PREFIX_FACT],
		}
		const prepared = await prepareDerivedMemoryPromotion(args)
		expect(prepared.structuredCandidates).toHaveLength(1)
		f.table("test_events")[1].role = "assistant"
		f.table("test_meta").push({
			_id: "tenant-erasure-epoch:offline",
			agentId: "offline",
			epoch: 0,
			state: "open",
			serial: 0,
		})
		const result = await withFencedWrite({
			db: f.db,
			prefix: "test_",
			token: { kind: "admission", agentId: "offline", epoch: 0 },
			fn: (session) =>
				persistPreparedDerivedMemoryPromotion({
					...args,
					prepared,
					embeddingMode: "automated",
					session,
				}),
		})
		expect(result.structuredCreated).toBe(0)
		expect(f.table("test_structured_mem")).toHaveLength(0)
		expect(f.table("test_meta")[0].serial).toBe(1)
		expect(f.transactions.ended).toBe(1)
	})
})
