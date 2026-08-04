import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const bridgeMocks = vi.hoisted(() => ({
	memongoBridgeAdd: vi.fn(),
	memongoBridgeAccessSummaries: vi.fn(),
	memongoBridgeAccessTrends: vi.fn(),
	memongoBridgeImportConversations: vi.fn(),
	memongoBridgeBuildContextBundle: vi.fn(),
	memongoBridgeBuildDiscoveryProjection: vi.fn(),
	memongoBridgeDeleteLifecycleItem: vi.fn(),
	memongoBridgeApplyMemoryFeedback: vi.fn(),
	memongoBridgeGetState: vi.fn(),
	memongoBridgeGetDetailedStatus: vi.fn(),
	memongoBridgeExtractEvent: vi.fn(),
	memongoBridgeGetLifecycleHistory: vi.fn(),
	memongoBridgeGetLifecycleItem: vi.fn(),
	memongoBridgeGetMemoryJob: vi.fn(),
	memongoBridgeGetRecallTrace: vi.fn(),
	memongoBridgeHydrateActiveSlate: vi.fn(),
	memongoBridgeListMemoryJobs: vi.fn(),
	memongoBridgeListRecallTraces: vi.fn(),
	memongoBridgeProbeEmbedding: vi.fn(),
	memongoBridgeProbeVector: vi.fn(),
	memongoBridgeCapabilities: vi.fn(),
	memongoBridgeProfile: vi.fn(),
	memongoBridgeRecallConversation: vi.fn(),
	memongoBridgeReadFile: vi.fn(),
	memongoBridgeRelevanceExplain: vi.fn(),
	memongoBridgeRelevanceReport: vi.fn(),
	memongoBridgeRelevanceSampleRate: vi.fn(),
	memongoBridgeSearch: vi.fn(),
	memongoBridgeSearchDetailed: vi.fn(),
	memongoBridgeSearchKB: vi.fn(),
	memongoBridgeStats: vi.fn(),
	memongoBridgeStatus: vi.fn(),
	memongoBridgeSync: vi.fn(),
	memongoBridgeUpdateLifecycleItem: vi.fn(),
	memongoBridgeReportProcedureOutcome: vi.fn(),
	memongoBridgeWriteConversationEvent: vi.fn(),
	memongoBridgeWriteConversationEventsBatch: vi.fn(),
	memongoBridgeWriteProcedure: vi.fn(),
	memongoBridgeWriteStructuredMemory: vi.fn(),
	memongoBridgeTraceChain: vi.fn(),
	memongoBridgeScanNovelty: vi.fn(),
	memongoBridgeConsolidate: vi.fn(),
	memongoBridgeSelfEdit: vi.fn(),
	memongoBridgePingMongo: vi.fn(),
	buildMemongoConfig: vi.fn(),
}))

vi.mock("@memongo/memory-bridge", () => bridgeMocks)

import { createApp } from "./app.js"

describe("createApp", () => {
	const prevEnv = { ...process.env }

	beforeEach(() => {
		process.env = { ...prevEnv }
		// Hermetic auth state: an ambient MEMONGO_API_KEY from the developer's
		// shell (the dogfood lesson) must not activate auth in these tests —
		// tests that need a key set it explicitly.
		delete process.env.MEMONGO_API_KEY
		delete process.env.MEMONGO_API_SCOPED_KEYS
		process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH = "true"
		bridgeMocks.memongoBridgeSearch.mockReset()
		bridgeMocks.memongoBridgeSearchDetailed.mockReset()
		bridgeMocks.memongoBridgeAdd.mockReset()
		bridgeMocks.memongoBridgeAccessSummaries.mockReset()
		bridgeMocks.memongoBridgeAccessTrends.mockReset()
		bridgeMocks.memongoBridgeImportConversations.mockReset()
		bridgeMocks.memongoBridgeBuildContextBundle.mockReset()
		bridgeMocks.memongoBridgeBuildDiscoveryProjection.mockReset()
		bridgeMocks.memongoBridgeDeleteLifecycleItem.mockReset()
		bridgeMocks.memongoBridgeApplyMemoryFeedback.mockReset()
		bridgeMocks.memongoBridgeExtractEvent.mockReset()
		bridgeMocks.memongoBridgeGetLifecycleHistory.mockReset()
		bridgeMocks.memongoBridgeGetLifecycleItem.mockReset()
		bridgeMocks.memongoBridgeGetState.mockReset()
		bridgeMocks.memongoBridgeGetMemoryJob.mockReset()
		bridgeMocks.memongoBridgeGetRecallTrace.mockReset()
		bridgeMocks.memongoBridgeProfile.mockReset()
		bridgeMocks.memongoBridgeRecallConversation.mockReset()
		bridgeMocks.memongoBridgeListMemoryJobs.mockReset()
		bridgeMocks.memongoBridgeListRecallTraces.mockReset()
		bridgeMocks.memongoBridgeStatus.mockReset()
		bridgeMocks.memongoBridgeTraceChain.mockReset()
		bridgeMocks.memongoBridgeScanNovelty.mockReset()
		bridgeMocks.memongoBridgeConsolidate.mockReset()
		bridgeMocks.memongoBridgeSelfEdit.mockReset()
		bridgeMocks.memongoBridgePingMongo.mockReset()
		bridgeMocks.buildMemongoConfig.mockReset()
		bridgeMocks.memongoBridgeUpdateLifecycleItem.mockReset()
		bridgeMocks.memongoBridgeReportProcedureOutcome.mockReset()
		bridgeMocks.memongoBridgeWriteConversationEvent.mockReset()
		bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockReset()
		bridgeMocks.memongoBridgeSearch.mockResolvedValue([])
		bridgeMocks.memongoBridgeSearchDetailed.mockResolvedValue({
			results: [],
			metadata: {
				mode: "auto",
				classification: "factoid",
				sourceOrder: ["conversation"],
				passes: [],
				queriesTried: [],
				constraintsApplied: [],
				resultsRejected: [],
				evidenceCoverage: {
					totalResults: 0,
					sourceCounts: {},
					exactEvidenceCount: 0,
					coverageRatio: 0,
				},
				pathsExecuted: [],
				resultsByPath: {},
				queryRewritten: false,
				reranked: false,
			},
		})
		bridgeMocks.memongoBridgeAdd.mockResolvedValue({
			eventId: "evt-1",
			chunkCreated: true,
		})
		bridgeMocks.memongoBridgeWriteConversationEvent.mockResolvedValue({
			eventId: "evt-2",
			chunkCreated: true,
		})
		bridgeMocks.memongoBridgeWriteConversationEventsBatch.mockImplementation(
			async ({ events }: { events: Array<{ body: string }> }) =>
				events.map((_, index) => ({
					ok: true,
					eventId: `evt-batch-${index}`,
					chunkCreated: true,
				})),
		)
		bridgeMocks.memongoBridgeProfile.mockResolvedValue({ profile: [] })
		bridgeMocks.memongoBridgeHydrateActiveSlate.mockResolvedValue({
			agentId: "main",
			scope: "agent",
			scopeRef: "agent:main",
			items: [],
			metadata: {
				maxItems: 5,
				truncated: false,
				partial: false,
				countsByKind: {},
				sourceCounts: {},
			},
			hydratedAt: "2026-04-05T12:00:00.000Z",
		})
		bridgeMocks.memongoBridgeBuildDiscoveryProjection.mockResolvedValue({
			kind: "entity-brief",
			query: "Phoenix",
			title: "Phoenix entity brief",
			summary: "Phoenix has one active owner and one linked decision.",
			scope: "agent",
			scopeRef: "agent:main",
			sections: [],
			metadata: {
				partial: false,
				evidenceCount: 0,
				sourceCounts: {},
			},
			builtAt: "2026-04-05T12:00:00.000Z",
		})
		bridgeMocks.memongoBridgeBuildContextBundle.mockResolvedValue({
			agentId: "main",
			query: "Phoenix",
			scope: "agent",
			scopeRef: "agent:main",
			sessionId: "session-main",
			rendered:
				"## Active Slate\nHighest-salience durable state assembled from structured memory, procedures, and recent anchors.",
			sections: [],
			metadata: {
				tokenBudget: 320,
				estimatedTokensUsed: 48,
				partial: false,
				truncated: false,
				pathsExecuted: ["active-slate"],
				sectionsIncluded: [],
			},
			builtAt: "2026-04-05T12:00:00.000Z",
		})
		bridgeMocks.memongoBridgeRecallConversation.mockResolvedValue({
			results: [],
			metadata: {
				totalMatched: 0,
				filtersApplied: ["excludeToolMessages"],
				searchMethod: "standard",
				durationMs: 2,
			},
		})
		bridgeMocks.memongoBridgeGetLifecycleItem.mockResolvedValue({
			family: "structured",
			handle: {
				family: "structured",
				id: "structured:agent-42:agent:agent-42:decision:db",
				agentId: "agent-42",
				scope: "agent",
				scopeRef: "agent-42",
				revision: 2,
				state: "active",
				structured: { type: "decision", key: "db" },
				updatedAt: "2026-04-10T12:00:00.000Z",
			},
			data: {
				type: "decision",
				key: "db",
				value: "Use MongoDB Atlas Local",
				sourceAgent: { id: "dreamer", name: "Dreamer" },
			},
			createdAt: "2026-04-09T12:00:00.000Z",
			updatedAt: "2026-04-10T12:00:00.000Z",
		})
		bridgeMocks.memongoBridgeUpdateLifecycleItem.mockImplementation(
			async ({ handle, patch }) => ({
				family: handle.family,
				handle: {
					...handle,
					revision: handle.revision + 1,
					updatedAt: "2026-04-10T12:05:00.000Z",
				},
				data:
					handle.family === "structured"
						? {
								type: handle.structured.type,
								key: handle.structured.key,
								value:
									typeof patch?.value === "string"
										? patch.value
										: "Use MongoDB Atlas Local",
							}
						: {
								procedureId: handle.procedure.procedureId,
								name: typeof patch?.name === "string" ? patch.name : "Deploy",
								steps: Array.isArray(patch?.steps) ? patch.steps : ["Build"],
							},
				createdAt: "2026-04-09T12:00:00.000Z",
				updatedAt: "2026-04-10T12:05:00.000Z",
			}),
		)
		bridgeMocks.memongoBridgeDeleteLifecycleItem.mockImplementation(
			async ({ handle }) => ({
				family: handle.family,
				handle: {
					...handle,
					revision: handle.revision + 1,
					state: "invalidated",
					validTo: "2026-04-10T12:10:00.000Z",
					updatedAt: "2026-04-10T12:10:00.000Z",
				},
				data:
					handle.family === "structured"
						? {
								type: handle.structured.type,
								key: handle.structured.key,
								value: "Use MongoDB Atlas Local",
							}
						: {
								procedureId: handle.procedure.procedureId,
								name: "Deploy",
								steps: ["Build"],
							},
				createdAt: "2026-04-09T12:00:00.000Z",
				updatedAt: "2026-04-10T12:10:00.000Z",
			}),
		)
		bridgeMocks.memongoBridgeGetLifecycleHistory.mockResolvedValue([
			{
				family: "structured",
				handle: {
					family: "structured",
					id: "structured:agent-42:agent:agent-42:decision:db",
					agentId: "agent-42",
					scope: "agent",
					scopeRef: "agent-42",
					revision: 1,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
				data: {
					type: "decision",
					key: "db",
					value: "Use local files",
				},
				historyKind: "revision",
				supersededAt: "2026-04-10T12:00:00.000Z",
			},
			{
				family: "structured",
				handle: {
					family: "structured",
					id: "structured:agent-42:agent:agent-42:decision:db",
					agentId: "agent-42",
					scope: "agent",
					scopeRef: "agent-42",
					revision: 2,
					state: "active",
					structured: { type: "decision", key: "db" },
				},
				data: {
					type: "decision",
					key: "db",
					value: "Use MongoDB Atlas Local",
				},
				historyKind: "current",
			},
		])
		bridgeMocks.memongoBridgeGetState.mockResolvedValue({
			profile: { profile: [] },
			blocks: {
				blocks: [],
				totalTokenBudget: 0,
				totalActualTokens: 0,
			},
			bundle: {
				agentId: "main",
				scope: "agent",
				scopeRef: "agent:main",
				rendered: "",
				sections: [],
				metadata: {
					tokenBudget: 320,
					estimatedTokensUsed: 0,
					partial: false,
					truncated: false,
					pathsExecuted: [],
					sectionsIncluded: [],
				},
				builtAt: "2026-04-05T12:00:00.000Z",
			},
		})
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({
			backend: "mongodb",
			provider: "voyage",
		})
		bridgeMocks.memongoBridgeExtractEvent.mockResolvedValue({
			jobId: "extraction-evt-1",
			scheduled: true,
		})
		bridgeMocks.memongoBridgeAccessTrends.mockResolvedValue([])
		bridgeMocks.memongoBridgeImportConversations.mockResolvedValue({
			datasetPath: "/tmp/history.json",
			datasetName: "history.json",
			datasetKind: "generic",
			conversationsImported: 1,
			turnsImported: 2,
			skippedConversations: 0,
			failedLines: 0,
			failedTurns: 0,
			startedAt: "2026-04-11T09:00:00.000Z",
			completedAt: "2026-04-11T09:00:02.000Z",
		})
		bridgeMocks.memongoBridgeListRecallTraces.mockResolvedValue([])
		bridgeMocks.memongoBridgeListMemoryJobs.mockResolvedValue([])
	})

	afterEach(() => {
		process.env = { ...prevEnv }
	})

	it("#28: rate limiting can be disabled with MEMONGO_API_RATE_LIMIT=0", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "0"
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({ ok: true })

		const app = createApp()
		for (let i = 0; i < 5; i++) {
			expect((await app.request("/v1/status")).status).toBe(200)
		}
	})

	it("#28: ignores X-Forwarded-For for rate limiting unless MEMONGO_TRUST_PROXY is set", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		process.env.MEMONGO_TRUST_PROXY = ""
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({ ok: true })

		const app = createApp()
		// Different spoofed XFF values must NOT create separate buckets by default,
		// or an attacker could rotate the header to evade the limit.
		const first = await app.request("/v1/status", {
			headers: { "X-Forwarded-For": "1.1.1.1" },
		})
		expect(first.status).toBe(200)
		const second = await app.request("/v1/status", {
			headers: { "X-Forwarded-For": "2.2.2.2" },
		})
		expect(second.status).toBe(429)
	})

	it("#28: rotating unvalidated bearer tokens cannot evade the pre-auth rate limit", async () => {
		process.env.MEMONGO_API_KEY = "valid-admin-key"
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		process.env.MEMONGO_TRUST_PROXY = ""

		const app = createApp()
		const first = await app.request("/v1/status", {
			headers: { Authorization: "Bearer attacker-token-a" },
		})
		expect(first.status).toBe(401)
		const second = await app.request("/v1/status", {
			headers: { Authorization: "Bearer attacker-token-b" },
		})
		expect(second.status).toBe(429)
	})

	it("#28: validated credentials receive separate rate-limit buckets", async () => {
		process.env.MEMONGO_API_KEY = "admin-key"
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-A", agentIds: ["agent-A"] },
			{ token: "scoped-B", agentIds: ["agent-B"] },
		])
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		process.env.MEMONGO_TRUST_PROXY = ""

		const app = createApp()
		expect(
			(
				await app.request("/v1/status", {
					headers: { Authorization: "Bearer invalid-key" },
				})
			).status,
		).toBe(401)
		expect(
			(
				await app.request("/v1/status", {
					headers: { Authorization: "Bearer admin-key" },
				})
			).status,
		).toBe(200)
		for (const [key, agentId] of [
			["scoped-A", "agent-A"],
			["scoped-B", "agent-B"],
		] as const) {
			const res = await app.request("/v1/search", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ agentId, query: "hello" }),
			})
			expect(res.status).toBe(200)
		}
	})

	it("#28: keys rate limiting per forwarded IP when MEMONGO_TRUST_PROXY is enabled", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "1"
		process.env.MEMONGO_TRUST_PROXY = "true"
		bridgeMocks.memongoBridgeStatus.mockResolvedValue({ ok: true })

		const app = createApp()
		const a = await app.request("/v1/status", {
			headers: { "X-Forwarded-For": "1.1.1.1" },
		})
		const b = await app.request("/v1/status", {
			headers: { "X-Forwarded-For": "2.2.2.2" },
		})
		expect(a.status).toBe(200)
		expect(b.status).toBe(200)
	})

	it("#28: MEMONGO_API_MAX_BODY_BYTES=0 disables the body cap", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "0"
		process.env.MEMONGO_API_MAX_BODY_BYTES = "0"

		const body = JSON.stringify({ query: "x".repeat(5000) })
		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(body.length),
			},
			body,
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledOnce()
	})

	it("#28: caps request body size and returns 413 before the handler parses it", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "0"
		process.env.MEMONGO_API_MAX_BODY_BYTES = "50"

		const body = JSON.stringify({ query: "x".repeat(5000) })
		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(body.length),
			},
			body,
		})

		expect(res.status).toBe(413)
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("#28: caps streamed request bodies without a Content-Length header", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		process.env.MEMONGO_API_RATE_LIMIT = "0"
		process.env.MEMONGO_API_MAX_BODY_BYTES = "50"

		const payload = new TextEncoder().encode(
			JSON.stringify({ query: "x".repeat(5000) }),
		)
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(payload)
				controller.close()
			},
		})
		const request = new Request("http://localhost/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" })

		const res = await createApp().request(request)

		expect(res.status).toBe(413)
		expect(await res.json()).toEqual({
			error: {
				code: "PAYLOAD_TOO_LARGE",
				message: "request body exceeds the configured size limit",
			},
		})
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("denies v1 by default when no API credentials are configured", async () => {
		process.env.MEMONGO_API_KEY = ""
		process.env.MEMONGO_API_SCOPED_KEYS = ""
		delete process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "must not execute", agentId: "main" }),
		})

		expect(res.status).toBe(401)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "AUTH_NOT_CONFIGURED",
				message: "API authentication is required",
			},
		})
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("allows explicit unauthenticated local development and warns once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { resetUnauthenticatedApiWarningForTests } = await import(
				"./app.js"
			)
			resetUnauthenticatedApiWarningForTests()

			createApp()
			createApp()

			expect(warn).toHaveBeenCalledTimes(1)
			expect(warn.mock.calls[0]?.[0]).toContain(
				"MEMONGO_ALLOW_INSECURE_NO_AUTH",
			)
		} finally {
			warn.mockRestore()
		}
	})

	it("denies unlisted origins when MEMONGO_CORS_ORIGINS is unset (dev defaults apply)", async () => {
		delete process.env.MEMONGO_CORS_ORIGINS

		const res = await createApp().request("/health", {
			headers: { Origin: "https://attacker.example" },
		})

		expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull()
	})

	it("applies dev-default CORS origins for the web console when MEMONGO_CORS_ORIGINS is unset", async () => {
		delete process.env.MEMONGO_CORS_ORIGINS
		const app = createApp()

		const localhost = await app.request("/health", {
			headers: { Origin: "http://localhost:3040" },
		})
		const loopback = await app.request("/health", {
			headers: { Origin: "http://127.0.0.1:3040" },
		})

		expect(localhost.headers.get("Access-Control-Allow-Origin")).toBe(
			"http://localhost:3040",
		)
		expect(loopback.headers.get("Access-Control-Allow-Origin")).toBe(
			"http://127.0.0.1:3040",
		)
	})

	it("emits CORS headers only for configured origins", async () => {
		process.env.MEMONGO_CORS_ORIGINS =
			"https://console.example, https://admin.example"
		const app = createApp()

		const allowed = await app.request("/health", {
			headers: { Origin: "https://console.example" },
		})
		const denied = await app.request("/health", {
			headers: { Origin: "https://attacker.example" },
		})

		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://console.example",
		)
		expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull()
	})

	it("does not warn when admin or scoped API auth is configured", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { resetUnauthenticatedApiWarningForTests } = await import(
				"./app.js"
			)
			resetUnauthenticatedApiWarningForTests()

			process.env.MEMONGO_API_KEY = "secret"
			createApp()
			process.env.MEMONGO_API_KEY = ""
			process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
				{ token: "scoped-secret", agentIds: ["agent"] },
			])
			createApp()

			expect(warn).not.toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	it("registers a graceful shutdown handler that runs bridge close on SIGTERM/SIGINT (bridge shutdown part 2)", async () => {
		const { registerGracefulShutdown } = await import("./app.js")
		expect(typeof registerGracefulShutdown).toBe("function")

		const emitter = new (await import("node:events")).EventEmitter()
		const shutdownCalls: string[] = []
		const closeBridge = vi.fn(async () => {
			shutdownCalls.push("bridge-closed")
		})
		const closeServer = vi.fn(async () => {
			shutdownCalls.push("server-closed")
		})
		const exit = vi.fn()

		registerGracefulShutdown({
			signals: ["SIGTERM", "SIGINT"],
			process: emitter as unknown as NodeJS.Process,
			closeBridge,
			closeServer,
			exit,
			timeoutMs: 50,
		})

		// Emit SIGTERM — expect closeBridge and closeServer both called, process.exit(0).
		emitter.emit("SIGTERM")
		// Handler is async; give it a tick to run.
		await new Promise((r) => setTimeout(r, 10))
		expect(closeBridge).toHaveBeenCalledOnce()
		expect(closeServer).toHaveBeenCalledOnce()
		expect(exit).toHaveBeenCalledWith(0)
		expect(shutdownCalls).toEqual(["server-closed", "bridge-closed"])
	})

	it("shutdown forces exit(1) when close handlers exceed the timeout (bridge shutdown part 2)", async () => {
		const { registerGracefulShutdown } = await import("./app.js")
		const emitter = new (await import("node:events")).EventEmitter()

		// closeBridge hangs past the timeout.
		const closeBridge = vi.fn(
			() => new Promise<void>((resolve) => setTimeout(resolve, 500)),
		)
		const closeServer = vi.fn(async () => {})
		const exit = vi.fn()

		registerGracefulShutdown({
			signals: ["SIGTERM"],
			process: emitter as unknown as NodeJS.Process,
			closeBridge,
			closeServer,
			exit,
			timeoutMs: 20,
		})

		emitter.emit("SIGTERM")
		// Wait past the timeout.
		await new Promise((r) => setTimeout(r, 60))
		expect(exit).toHaveBeenCalledWith(1)
	})

	it("compares bearer tokens in constant time (MED timing-safe)", async () => {
		// Behavioral regression: rejection must hold for tokens of the same length
		// AND different length; the implementation must not short-circuit on length
		// alone (which would leak length via timing). Both must reject with 401.
		const { timingSafeBearerEquals } = await import("./app.js")
		expect(typeof timingSafeBearerEquals).toBe("function")

		// Exact match.
		expect(
			timingSafeBearerEquals("supersecret-token", "supersecret-token"),
		).toBe(true)

		// Same length, one char off — rejects.
		expect(
			timingSafeBearerEquals("supersecret-token", "supersecret-tokeX"),
		).toBe(false)

		// Different length — rejects without throwing.
		expect(timingSafeBearerEquals("short", "supersecret-token")).toBe(false)
		expect(timingSafeBearerEquals("supersecret-token", "short")).toBe(false)

		// Empty inputs — rejects (never accept empty bearer).
		expect(timingSafeBearerEquals("", "any")).toBe(false)
		expect(timingSafeBearerEquals("any", "")).toBe(false)
		expect(timingSafeBearerEquals("", "")).toBe(false)
	})

	it("fails closed when scoped API key policy JSON is invalid", () => {
		process.env.MEMONGO_API_SCOPED_KEYS = "not-json"

		expect(() => createApp()).toThrow(
			"MEMONGO_API_SCOPED_KEYS must be valid JSON",
		)
	})

	it("fails closed when scoped API key policies are unconstrained", () => {
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{ token: "scoped-secret" },
		])

		expect(() => createApp()).toThrow(
			"MEMONGO_API_SCOPED_KEYS policy for token scoped-secret must constrain agentIds, scopes, or scopeRefs",
		)
	})

	it("allows scoped API keys only inside their agent and scope policy", async () => {
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/memongo"],
			},
		])

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "scoped gates",
				agentId: "codex",
				scope: "workspace",
				scopeRef: "/workspace/memongo",
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "codex",
				scope: "workspace",
				scopeRef: "/workspace/memongo",
			}),
		)
	})

	it("rejects scoped API keys outside their allowed scopeRef", async () => {
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/memongo"],
			},
		])

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "scoped gates",
				agentId: "codex",
				scope: "workspace",
				scopeRef: "/workspace/other",
			}),
		})

		expect(res.status).toBe(403)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "FORBIDDEN",
				message: "scopeRef is not allowed for this API key",
			},
		})
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("requires explicit scoped fields for scoped API keys", async () => {
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/memongo"],
			},
		])

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer scoped-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "scoped gates",
				agentId: "codex",
			}),
		})

		expect(res.status).toBe(403)
		await expect(res.json()).resolves.toEqual({
			error: {
				code: "FORBIDDEN",
				message: "scope is required for this API key",
			},
		})
		expect(bridgeMocks.memongoBridgeSearch).not.toHaveBeenCalled()
	})

	it("keeps MEMONGO_API_KEY as the admin key when scoped keys are configured", async () => {
		process.env.MEMONGO_API_KEY = "admin-secret"
		process.env.MEMONGO_API_SCOPED_KEYS = JSON.stringify([
			{
				token: "scoped-secret",
				agentIds: ["codex"],
				scopes: ["workspace"],
				scopeRefs: ["/workspace/memongo"],
			},
		])

		const res = await createApp().request("/v1/search", {
			method: "POST",
			headers: {
				Authorization: "Bearer admin-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: "admin can inspect another scope",
				agentId: "other-agent",
				scope: "global",
				scopeRef: "global",
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeSearch).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "other-agent",
				scope: "global",
				scopeRef: "global",
			}),
		)
	})

	it("forwards add scope and scopeRef when provided", async () => {
		const res = await createApp().request("/v1/add", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: "remember the scoped thing",
				agentId: "codex",
				sessionId: "session-9",
				scope: "session",
				scopeRef: "session:session-9",
			}),
		})

		expect(res.status).toBe(200)
		expect(bridgeMocks.memongoBridgeAdd).toHaveBeenCalledWith(
			expect.objectContaining({
				content: "remember the scoped thing",
				agentId: "codex",
				sessionId: "session-9",
				scope: "session",
				scopeRef: "session:session-9",
			}),
		)
	})

	it("forwards write-event scopeRef when provided", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "assistant",
				body: "scoped assistant memory",
				agentId: "codex",
				sessionId: "session-9",
				scope: "session",
				scopeRef: "session:session-9",
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "assistant",
				body: "scoped assistant memory",
				agentId: "codex",
				sessionId: "session-9",
				scope: "session",
				scopeRef: "session:session-9",
			}),
		)
	})

	it("forwards write-event validity bounds when provided", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "assistant",
				body: "historically valid memory",
				validAt: "2026-04-09T12:00:00.000Z",
				invalidAt: "2026-04-10T12:00:00.000Z",
			}),
		})

		expect(res.status).toBe(200)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				validAt: "2026-04-09T12:00:00.000Z",
				invalidAt: "2026-04-10T12:00:00.000Z",
			}),
		)
	})

	it.each([
		"timestamp",
		"validAt",
		"invalidAt",
	])("rejects an invalid write-event %s", async (field) => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "assistant",
				body: "invalid dated memory",
				[field]: "not-a-date",
			}),
		})

		expect(res.status).toBe(400)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).not.toHaveBeenCalled()
	})

	it("rejects a write-event validity window that does not advance", async () => {
		const res = await createApp().request("/v1/write-event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				role: "assistant",
				body: "invalid validity window",
				validAt: "2026-04-10T12:00:00.000Z",
				invalidAt: "2026-04-10T12:00:00.000Z",
			}),
		})

		expect(res.status).toBe(400)
		expect(
			bridgeMocks.memongoBridgeWriteConversationEvent,
		).not.toHaveBeenCalled()
	})
})
