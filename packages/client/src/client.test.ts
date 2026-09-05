import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import type { ContextBundleModeValue } from "@memongo/lib"
import { CONTEXT_BUNDLE_MODE_VALUES } from "@memongo/lib"
import { MemongoClient, MemongoClientError } from "./client.js"
import { MEMONGO_CLIENT_VERSION } from "./version.js"
import type {
	MemongoConsolidateInput,
	MemongoContextBundleInput,
	MemongoScanNoveltyInput,
	MemongoScope,
} from "./index.js"

describe("public scope input types", () => {
	it("use the canonical MemongoScope union", () => {
		expectTypeOf<MemongoScanNoveltyInput["scope"]>().toEqualTypeOf<
			MemongoScope | undefined
		>()
		expectTypeOf<MemongoConsolidateInput["scope"]>().toEqualTypeOf<
			MemongoScope | undefined
		>()
		expectTypeOf<
			Parameters<MemongoClient["writeEvent"]>[0]["scope"]
		>().toEqualTypeOf<MemongoScope | undefined>()
		expectTypeOf<
			Parameters<MemongoClient["writeEvents"]>[0]["events"][number]["scope"]
		>().toEqualTypeOf<MemongoScope | undefined>()
	})
})

/**
 * First suite for the client package (P0.1 seeds it; P1.3 builds the full
 * contract suite). fetch is stubbed globally — no server is needed.
 */
describe("MemongoClient write idempotency", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	function stubFetchSequence(
		statuses: number[],
		calls: Array<{ url: string; init: RequestInit }>,
	) {
		let i = 0
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				const status = statuses[Math.min(i, statuses.length - 1)]
				i += 1
				if (status === 200) {
					return new Response(
						JSON.stringify({ ok: true, eventId: "evt-1", chunkCreated: true }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					)
				}
				return new Response("upstream busy", { status })
			}),
		)
	}

	it("sends customId in the body and as a stable Idempotency-Key header across retries", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubFetchSequence([503, 200], calls)

		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 1,
		})
		await client.add({ content: "hello", customId: "cid-1" })

		expect(calls).toHaveLength(2)
		for (const { url, init } of calls) {
			expect(url).toBe("http://127.0.0.1:3100/v1/add")
			expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
				"cid-1",
			)
			expect(JSON.parse(String(init.body)).customId).toBe("cid-1")
		}
	})

	it("sends expiresAt on add, writeEvent, and writeEvents items (B1)", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				const isBatch = String(url).endsWith("/v1/write-events")
				return new Response(
					JSON.stringify(
						isBatch
							? { ok: true, receipts: [] }
							: { eventId: "evt-1", chunkCreated: true },
					),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}),
		)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const expiresAt = "2030-01-01T00:00:00.000Z"
		await client.add({ content: "brief", expiresAt })
		await client.writeEvent({ role: "user", body: "brief", expiresAt })
		await client.writeEvents({
			events: [{ role: "user", body: "brief", expiresAt }],
		})

		expect(calls).toHaveLength(3)
		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/add")
		expect(JSON.parse(String(calls[0].init.body)).expiresAt).toBe(expiresAt)
		expect(calls[1].url).toBe("http://127.0.0.1:3100/v1/write-event")
		expect(JSON.parse(String(calls[1].init.body)).expiresAt).toBe(expiresAt)
		expect(calls[2].url).toBe("http://127.0.0.1:3100/v1/write-events")
		expect(JSON.parse(String(calls[2].init.body)).events[0].expiresAt).toBe(
			expiresAt,
		)
	})

	it("sends consolidation control flags (B8)", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				return new Response(
					JSON.stringify({
						factsExtracted: 0,
						eventsProcessed: 0,
						skipped: 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}),
		)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.consolidate({
			resolveContradictions: false,
			llmDedup: true,
		})

		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/consolidate")
		expect(JSON.parse(String(calls[0].init.body))).toEqual(
			expect.objectContaining({
				resolveContradictions: false,
				llmDedup: true,
			}),
		)
	})

	it("sends fusionMethod on searchKB when provided (P0.10)", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				return new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}),
		)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.searchKB({
			query: "architecture",
			fusionMethod: "scoreFusion",
		})

		expect(calls).toHaveLength(1)
		expect(JSON.parse(String(calls[0].init.body)).fusionMethod).toBe(
			"scoreFusion",
		)
	})

	it("generates one UUIDv4 key per logical write and reuses it across every retry", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubFetchSequence([503, 503, 200], calls)

		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 2,
		})
		await client.writeEvent({ role: "user", body: "generated key please" })

		expect(calls).toHaveLength(3)
		const keys = calls.map(
			({ init }) => (init.headers as Record<string, string>)["Idempotency-Key"],
		)
		const uuidV4 =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		for (const key of keys) {
			expect(key).toMatch(uuidV4)
		}
		expect(new Set(keys).size).toBe(1)
		// The same key travels in the body so the API accepts either channel.
		for (const { init } of calls) {
			expect(JSON.parse(String(init.body)).customId).toBe(keys[0])
		}
	})
})

/**
 * P1.3: the client must not be a lossy filter. Every scope/scopeRef the
 * caller supplies reaches the wire; a scoped API key depends on this
 * (missing scope fields are a guaranteed 403 on scoped routes).
 */
describe("MemongoClient scope forwarding (P1.3)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	function stubJsonFetch(
		calls: Array<{ url: string; init: RequestInit }>,
		payload: unknown = { ok: true },
	) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}),
		)
	}

	function lastBody(
		calls: Array<{ url: string; init: RequestInit }>,
	): Record<string, unknown> {
		return JSON.parse(String(calls.at(-1)?.init.body)) as Record<
			string,
			unknown
		>
	}

	it("posts a batch to /v1/write-events with per-item idempotency keys (P3.9)", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, {
			ok: true,
			receipts: [
				{ ok: true, eventId: "evt-1", chunkCreated: true },
				{ ok: true, eventId: "evt-2", chunkCreated: false, replayed: true },
			],
		})

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const response = await client.writeEvents({
			agentId: "codex",
			events: [
				{ role: "user", body: "first", sessionId: "s-1" },
				{ role: "assistant", body: "second", customId: "key-explicit" },
			],
		})

		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/write-events")
		const body = lastBody(calls)
		expect(body.agentId).toBe("codex")
		const events = body.events as Array<Record<string, unknown>>
		expect(events).toHaveLength(2)
		expect(events[0].role).toBe("user")
		expect(events[0].sessionId).toBe("s-1")
		// A UUIDv4 key is generated for items without customId.
		expect(String(events[0].customId)).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		)
		// An explicit customId is preserved verbatim.
		expect(events[1].customId).toBe("key-explicit")
		expect(response).toEqual({
			ok: true,
			receipts: [
				{ ok: true, eventId: "evt-1", chunkCreated: true },
				{ ok: true, eventId: "evt-2", chunkCreated: false, replayed: true },
			],
		})
	})

	it("keeps per-item keys stable across batch retries", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		let i = 0
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				i += 1
				if (i < 2) {
					return new Response("upstream busy", { status: 503 })
				}
				return new Response(
					JSON.stringify({
						ok: true,
						receipts: [{ ok: true, eventId: "evt-1", chunkCreated: true }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}),
		)

		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 1,
		})
		await client.writeEvents({
			events: [{ role: "user", body: "retry me" }],
		})

		expect(calls).toHaveLength(2)
		const keys = calls.map(
			({ init }) =>
				(
					JSON.parse(String(init.body)) as {
						events: Array<{ customId: string }>
					}
				).events[0].customId,
		)
		expect(new Set(keys).size).toBe(1)
	})

	it("forwards scope/scopeRef/entityContext on add", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, { ok: true, eventId: "e1", chunkCreated: false })

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.add({
			content: "scoped note",
			scope: "tenant",
			scopeRef: "ref-A",
			entityContext: "entity ctx",
		})

		const body = lastBody(calls)
		expect(body.scope).toBe("tenant")
		expect(body.scopeRef).toBe("ref-A")
		expect(body.entityContext).toBe("entity ctx")
	})

	it("forwards scope/scopeRef on search", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, { results: [] })

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.search({ query: "q", scope: "workspace", scopeRef: "ref-W" })

		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/search")
		const body = lastBody(calls)
		expect(body.scope).toBe("workspace")
		expect(body.scopeRef).toBe("ref-W")
	})

	it("forwards scope/scopeRef on searchDetailed", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, { results: [], metadata: {} })

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.searchDetailed({
			query: "q",
			scope: "workspace",
			scopeRef: "acme/platform",
			limit: 3,
		})

		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/search-detailed")
		const body = lastBody(calls)
		expect(body.scope).toBe("workspace")
		expect(body.scopeRef).toBe("acme/platform")
		expect(body.maxResults).toBeUndefined()
	})

	it("forwards scope/scopeRef on searchKB (scoped keys need scopeRef here)", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, { results: [] })

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.searchKB({
			query: "q",
			scope: "tenant",
			scopeRef: "ref-A",
		})

		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/search-kb")
		const body = lastBody(calls)
		expect(body.scope).toBe("tenant")
		expect(body.scopeRef).toBe("ref-A")
	})

	it("forwards scope/scopeRef on recallConversation", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, { results: [], metadata: {} })

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.recallConversation({
			query: "q",
			scope: "session",
			scopeRef: "session:s1",
		})

		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/recall-conversation")
		const body = lastBody(calls)
		expect(body.scope).toBe("session")
		expect(body.scopeRef).toBe("session:s1")
	})

	it("forwards scopeRef on importConversations", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, { conversationsImported: 0 })

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.importConversations({
			datasetPath: "imports/history.json",
			scope: "workspace",
			scopeRef: "acme/platform",
		})

		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/import/conversations")
		const body = lastBody(calls)
		expect(body.scope).toBe("workspace")
		expect(body.scopeRef).toBe("acme/platform")
	})

	it("forwards scope/scopeRef on profile", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, { preferences: [] })

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.profile({
			scope: "user",
			scopeRef: "user-1",
		})

		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/profile")
		const body = lastBody(calls)
		expect(body.scope).toBe("user")
		expect(body.scopeRef).toBe("user-1")
	})

	it("preserves detailed-status data completeness health fields", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, {
			health: {
				dataCompleteness: "partial",
				failedChecks: ["entities.count", "projectionLag.entities"],
			},
		})

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const status = await client.getDetailedStatus("agent-1")

		expect(calls[0].url).toBe(
			"http://127.0.0.1:3100/v1/status/detailed?agentId=agent-1",
		)
		expect(status.health.dataCompleteness).toBe("partial")
		expect(status.health.failedChecks).toEqual([
			"entities.count",
			"projectionLag.entities",
		])
	})

	it("forwards scope/scopeRef on extract", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, { ok: true, jobId: "j1", scheduled: true })

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.extract({
			eventId: "evt-1",
			scope: "tenant",
			scopeRef: "ref-A",
		})

		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/extract")
		const body = lastBody(calls)
		expect(body.scope).toBe("tenant")
		expect(body.scopeRef).toBe("ref-A")
	})

	it("forwards scopeRef on scanNovelty", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls, { events: [], scannedCount: 0, agentId: "main" })

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.scanNovelty({
			agentId: "main",
			scope: "tenant",
			scopeRef: "ref-A",
		})

		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/novelty-scan")
		const body = lastBody(calls)
		expect(body.scope).toBe("tenant")
		expect(body.scopeRef).toBe("ref-A")
	})

	it("forwards canonical scopes on event writes and consolidation", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.writeEvent({
			role: "user",
			body: "tenant event",
			scope: "tenant",
			scopeRef: "tenant-A",
		})
		await client.writeEvents({
			events: [
				{
					role: "assistant",
					body: "workspace event",
					scope: "workspace",
					scopeRef: "acme/platform",
				},
			],
		})
		await client.consolidate({
			scope: "agent",
			scopeRef: "agent-1",
		})

		expect(calls.map(({ url }) => url)).toEqual([
			"http://127.0.0.1:3100/v1/write-event",
			"http://127.0.0.1:3100/v1/write-events",
			"http://127.0.0.1:3100/v1/consolidate",
		])
		expect(JSON.parse(String(calls[0].init.body))).toEqual(
			expect.objectContaining({ scope: "tenant", scopeRef: "tenant-A" }),
		)
		expect(
			(JSON.parse(String(calls[1].init.body)) as { events: unknown[] }).events,
		).toEqual([
			expect.objectContaining({
				scope: "workspace",
				scopeRef: "acme/platform",
			}),
		])
		expect(JSON.parse(String(calls[2].init.body))).toEqual(
			expect.objectContaining({ scope: "agent", scopeRef: "agent-1" }),
		)
	})

	it("throws on unserializable caller fields instead of dropping them", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubJsonFetch(calls)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const circular: Record<string, unknown> = {}
		circular.self = circular

		await expect(
			client.add({
				content: "x",
				metadata: circular as Record<string, string>,
			}),
		).rejects.toThrow()
		expect(calls).toHaveLength(0)
	})
})

describe("MemongoClient tenant erasure (C-003)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	it("posts the typed confirm to /v1/admin/erase and returns the receipt", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		const receipt = {
			agentId: "agent-42",
			status: "complete",
			receipts: [
				{ collection: "events", deleted: 5 },
				{ collection: "chunks", deleted: 11 },
			],
			mutationId: "mut-7",
			completedAt: "2026-08-15T00:00:00.000Z",
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				return new Response(JSON.stringify(receipt), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}),
		)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const response = await client.eraseAgent({
			confirm: "erase",
			agentId: "agent-42",
		})

		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/admin/erase")
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			confirm: "erase",
			agentId: "agent-42",
		})
		expect(response).toEqual(receipt)
	})
})

describe("MemongoClient quarantine review (C-004)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	it("lists quarantined memories with status and limit query params", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		const entries = [
			{
				quarantineId: "q-1",
				agentId: "agent-42",
				content: "user: remember my passphrase is hunter2",
				classification: "injection-control",
				tier: "pattern",
				matchedPatterns: ["credential-request"],
				status: "pending-review",
				createdAt: "2026-08-15T00:00:00.000Z",
			},
		]
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				return new Response(JSON.stringify(entries), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}),
		)
		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const response = await client.listQuarantined({
			agentId: "agent-42",
			status: "pending-review",
			limit: 5,
		})
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe(
			"http://127.0.0.1:3100/v1/admin/quarantine?agentId=agent-42&status=pending-review&limit=5",
		)
		expect(calls[0].init.method).toBe("GET")
		expect(response).toEqual(entries)
	})

	it("lists every stage when no filters are given", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				return new Response(JSON.stringify([]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}),
		)
		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const response = await client.listQuarantined()
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe("http://127.0.0.1:3100/v1/admin/quarantine")
		expect(response).toEqual([])
	})

	it("promotes a quarantined memory with reviewer metadata", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		const receipt = {
			quarantineId: "q-1",
			agentId: "agent-42",
			status: "promoted",
			reviewedAt: "2026-08-15T00:01:00.000Z",
			reviewerId: "reviewer-9",
			reviewNotes: "false positive",
			memoryId: "mem-77",
			mutationId: "mut-8",
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				return new Response(JSON.stringify(receipt), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}),
		)
		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const response = await client.promoteQuarantined({
			quarantineId: "q-1",
			agentId: "agent-42",
			reviewerId: "reviewer-9",
			reviewNotes: "false positive",
		})
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe(
			"http://127.0.0.1:3100/v1/admin/quarantine/promote",
		)
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			quarantineId: "q-1",
			agentId: "agent-42",
			reviewerId: "reviewer-9",
			reviewNotes: "false positive",
		})
		expect(response).toEqual(receipt)
	})

	it("rejects a quarantined memory and omits undefined optional fields", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		const receipt = {
			quarantineId: "q-2",
			agentId: "agent-42",
			status: "rejected",
			reviewedAt: "2026-08-15T00:02:00.000Z",
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				return new Response(JSON.stringify(receipt), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}),
		)
		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const response = await client.rejectQuarantined({
			quarantineId: "q-2",
		})
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe(
			"http://127.0.0.1:3100/v1/admin/quarantine/reject",
		)
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			quarantineId: "q-2",
		})
		expect(response).toEqual(receipt)
	})
})

describe("MemongoClient error envelope (P1.3)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	it("parses {error:{code,message}} into code and apiMessage", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: "VALIDATION_ERROR", message: "query is required" },
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					),
			),
		)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const err = (await client
			.search({ query: "q" })
			.catch((e: unknown) => e)) as MemongoClientError

		expect(err).toBeInstanceOf(MemongoClientError)
		expect(err.status).toBe(400)
		expect(err.code).toBe("VALIDATION_ERROR")
		expect(err.apiMessage).toBe("query is required")
		expect(err.message).toBe(
			"Memongo API 400 VALIDATION_ERROR: query is required",
		)
	})

	it("keeps non-envelope bodies off the error message (C-002)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("boom", { status: 500 })),
		)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const err = (await client
			.status()
			.catch((e: unknown) => e)) as MemongoClientError

		expect(err).toBeInstanceOf(MemongoClientError)
		expect(err.code).toBeUndefined()
		expect(err.apiMessage).toBeUndefined()
		// The message is structural; raw proxy/500 bodies (which can echo
		// request content) stay on the property, never on the message.
		expect(err.message).toBe("Memongo API 500 (non-JSON body, 4 bytes)")
		expect(err.body).toBe("boom")
	})

	it("never lets a credential-bearing non-envelope body reach the message (C-002)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Response(
						["upstream echo: ", "apiKey", "=dummy-", "token-00000000"].join(""),
						{
							status: 502,
						},
					),
			),
		)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		const err = (await client
			.status()
			.catch((e: unknown) => e)) as MemongoClientError

		expect(err).toBeInstanceOf(MemongoClientError)
		expect(err.message).toBe("Memongo API 502 (non-JSON body, 42 bytes)")
		expect(err.message).not.toContain("apiKey")
		// The raw body is still programmatically available when needed.
		expect(err.body).toContain("apiKey")
	})
})

describe("MemongoClient resilience (P1.3)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	it("honors Retry-After on 429 before retrying", async () => {
		vi.useFakeTimers()
		try {
			const calls: Array<{ url: string; init: RequestInit }> = []
			let i = 0
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					calls.push({ url: String(url), init: init ?? {} })
					i += 1
					if (i === 1) {
						return new Response("rate limited", {
							status: 429,
							headers: { "Retry-After": "2" },
						})
					}
					return new Response(JSON.stringify({ results: [] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				}),
			)

			const client = new MemongoClient({
				baseUrl: "http://127.0.0.1:3100",
				maxRetries: 1,
			})
			// C-011: retry timing is exercised through a GET, which is
			// retry-safe by method; unkeyed POSTs no longer retry at all.
			const promise = client.status()
			// Before the server-mandated 2s elapse, no retry may fire.
			await vi.advanceTimersByTimeAsync(1999)
			expect(calls).toHaveLength(1)
			await vi.advanceTimersByTimeAsync(1)
			await promise
			expect(calls).toHaveLength(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it("caps an absurd Retry-After instead of parking the client", async () => {
		vi.useFakeTimers()
		try {
			let i = 0
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					i += 1
					if (i === 1) {
						return new Response("rate limited", {
							status: 429,
							headers: { "Retry-After": "3600" },
						})
					}
					return new Response(JSON.stringify({ results: [] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				}),
			)

			const client = new MemongoClient({
				baseUrl: "http://127.0.0.1:3100",
				maxRetries: 1,
			})
			// C-011: GET is retry-safe by method, so the Retry-After cap still
			// applies to it; unkeyed POSTs no longer retry at all.
			const promise = client.status()
			// The cap is 10s: advancing 10s must complete the retry even though
			// the server asked for an hour.
			await vi.advanceTimersByTimeAsync(10_000)
			await promise
			expect(i).toBe(2)
		} finally {
			vi.useRealTimers()
		}
	})

	it("aborts a hung request after timeoutMs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							reject(init.signal?.reason ?? new Error("aborted"))
						})
					}),
			),
		)

		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			timeoutMs: 20,
		})
		const err = await client.status().catch((e: unknown) => e)
		expect(err).toBeInstanceOf(Error)
		expect((err as Error).name).toBe("TimeoutError")
	})

	it("works when process is undefined (browser/edge runtimes)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ results: [] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			),
		)
		vi.stubGlobal("process", undefined)

		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await expect(client.search({ query: "q" })).resolves.toEqual({
			results: [],
		})
	})
})

describe("MemongoClient 404 -> null (P1.3)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	function stub404() {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: "NOT_FOUND", message: "not found" },
						}),
						{ status: 404, headers: { "Content-Type": "application/json" } },
					),
			),
		)
	}

	it("getJob returns null on 404 (type said | null all along)", async () => {
		stub404()
		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await expect(client.getJob({ jobId: "missing" })).resolves.toBeNull()
	})

	it("getRecallTrace returns null on 404", async () => {
		stub404()
		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await expect(
			client.getRecallTrace({ traceId: "missing" }),
		).resolves.toBeNull()
	})

	it("getJob still throws on non-404 errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("boom", { status: 500 })),
		)
		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await expect(client.getJob({ jobId: "x" })).rejects.toBeInstanceOf(
			MemongoClientError,
		)
	})
})

describe("MemongoClient silent option (P1.5)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	it("returns {results: []} with an unavailable degradation marker on HTTP 500 instead of throwing (C-019)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("boom", { status: 500 })),
		)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			silent: true,
		})
		await expect(client.search({ query: "anything" })).resolves.toEqual({
			results: [],
			degradation: { kind: "unavailable", status: 500 },
		})
	})

	it("classifies a swallowed 401 as auth degradation, not empty results (C-019)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: "AUTH_NOT_CONFIGURED", message: "no" },
						}),
						{ status: 401 },
					),
			),
		)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			silent: true,
		})
		await expect(client.search({ query: "anything" })).resolves.toEqual({
			results: [],
			degradation: { kind: "auth", status: 401 },
		})
	})

	it("classifies a swallowed 429 as throttled degradation (C-019)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("slow down", { status: 429 })),
		)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			silent: true,
		})
		await expect(client.searchKB({ query: "anything" })).resolves.toEqual({
			results: [],
			degradation: { kind: "throttled", status: 429 },
		})
	})

	it("returns an empty context bundle with an unavailable degradation marker on HTTP 500 (middleware injects nothing)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("boom", { status: 500 })),
		)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			silent: true,
		})
		const bundle = await client.buildContextBundle({ agentId: "a" })
		expect(bundle.rendered).toBe("")
		expect(bundle.sections).toEqual([])
		expect(bundle.degradation).toEqual({ kind: "unavailable", status: 500 })
	})

	it("returns empty results with an unavailable (no status) degradation marker on network failure (fetch rejects)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED")
			}),
		)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			silent: true,
		})
		await expect(client.searchDetailed({ query: "x" })).resolves.toMatchObject({
			results: [],
			degradation: { kind: "unavailable" },
		})
	})

	it("still throws on HTTP 500 when silent is not set (strictly opt-in)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("boom", { status: 500 })),
		)
		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await expect(client.search({ query: "anything" })).rejects.toBeInstanceOf(
			MemongoClientError,
		)
	})
})

/**
 * WS-08 / C-011: 429/503 retries are restricted to requests that are
 * idempotent by construction — GET/HEAD, a POST carrying an
 * Idempotency-Key, and the per-item-keyed bulk write. Every other POST
 * fails fast so a retry can never double-write memory.
 */
describe("MemongoClient retry safety (C-011)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	function stubStatusSequence(
		statuses: number[],
		calls: Array<{ url: string; init: RequestInit }>,
		okBody = JSON.stringify({ ok: true }),
	) {
		let i = 0
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init: init ?? {} })
				const status = statuses[Math.min(i, statuses.length - 1)]
				i += 1
				if (status === 200) {
					return new Response(okBody, {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				}
				return new Response("upstream busy", { status })
			}),
		)
	}

	it("retries a GET on 503 and succeeds", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubStatusSequence([503, 200], calls, JSON.stringify({ ok: true }))
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 1,
		})
		await client.status()
		expect(calls).toHaveLength(2)
		expect(calls[0].url).toContain("/v1/status")
		expect(calls[0].init.method ?? "GET").toBe("GET")
	})

	it("fails fast on 503 for a POST query without an Idempotency-Key", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubStatusSequence([503, 503, 503], calls, JSON.stringify({ results: [] }))
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 2,
		})
		// Search is a POST the client cannot prove idempotent, so it fails
		// fast instead of retrying (C-011).
		await expect(client.search({ query: "hello" })).rejects.toMatchObject({
			status: 503,
		})
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toContain("/v1/search")
	})

	it("retries a POST that carries an Idempotency-Key on 503", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubStatusSequence(
			[503, 200],
			calls,
			JSON.stringify({ ok: true, eventId: "evt-1", chunkCreated: true }),
		)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 1,
		})
		await client.add({ content: "hello", customId: "cid-1" })
		expect(calls).toHaveLength(2)
	})

	it("retries the per-item-keyed bulk write on 503", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubStatusSequence(
			[503, 200],
			calls,
			JSON.stringify({ ok: true, receipts: [] }),
		)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 1,
		})
		await client.writeEvents({ events: [{ role: "user", body: "hello" }] })
		expect(calls).toHaveLength(2)
		expect(calls[0].url).toContain("/v1/write-events")
	})

	it("fails fast on 503 for a POST without an Idempotency-Key", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubStatusSequence([503, 503, 503], calls)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 2,
		})
		await expect(
			client.writeStructured({ entry: { type: "fact", key: "k", value: "v" } }),
		).rejects.toMatchObject({ status: 503 })
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toContain("/v1/write-structured")
		expect(
			(calls[0].init.headers as Record<string, string>)["Idempotency-Key"],
		).toBeUndefined()
	})

	it("fails fast on 429 for a POST without an Idempotency-Key", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		stubStatusSequence([429, 429, 429], calls)
		const client = new MemongoClient({
			baseUrl: "http://127.0.0.1:3100",
			maxRetries: 2,
		})
		await expect(
			client.selfEdit({
				inputs: [{ role: "user", content: "remember this" }],
			}),
		).rejects.toMatchObject({ status: 429 })
		expect(calls).toHaveLength(1)
	})
})

describe("Client contract single-sourcing (WS-08 / C-013)", () => {
	it("declares exactly the lib context-bundle mode set on MemongoContextBundleInput", () => {
		// Compile-time: the client's inline mode union must equal the lib
		// contract union the API validates (contextBundleModeSchema), so no
		// caller can pass a typed value the server would 400.
		expectTypeOf<MemongoContextBundleInput["mode"]>().toEqualTypeOf<
			ContextBundleModeValue | undefined
		>()
		// Runtime mirror of the same contract: the lib set is exactly the
		// two modes the API accepts.
		expect([...CONTEXT_BUNDLE_MODE_VALUES]).toEqual(["full", "wake-up"])
	})
})

describe("Client version telemetry header (WS-08 / C-014)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
	})

	it("sends x-memongo-client-version on every request", async () => {
		const seenHeaders: HeadersInit[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				seenHeaders.push(init?.headers ?? {})
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}),
		)
		const client = new MemongoClient({ baseUrl: "http://127.0.0.1:3100" })
		await client.status()
		expect(seenHeaders).toHaveLength(1)
		const headers = new Headers(seenHeaders[0])
		// The server's version-skew logger (createClientVersionSkewLogger)
		// keys off this exact header name.
		expect(headers.get("x-memongo-client-version")).toBe(MEMONGO_CLIENT_VERSION)
	})
})
