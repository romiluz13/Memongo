// M2 T5 (#114): rerank is unsupported in M2. A per-request rerank demand is a
// typed `rerank-unsupported` error, and status reports the rerank lane as
// not-applicable (capability-absent) with native rerank unsupported by the
// engine and unknown on the server. Native `$rerank` arrives in M4 on Atlas.
import { describe, expect, it, vi } from "vitest"
import { MongoDBManagerAdminOps } from "./mongodb-manager-admin.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { SearchLaneError } from "./search-outcomes.js"
import {
	buildMockManager,
	captureManagerPrototype,
	kitMongoConfig,
} from "./test-helpers/manager-test-kit.js"

captureManagerPrototype(MongoDBMemoryManager)

describe("a per-request rerank demand is rerank-unsupported", () => {
	it("rejects searchConfig.rerank: true with a typed SearchLaneError", async () => {
		const manager = buildMockManager()

		const failure = await manager
			.searchDetailed({
				query: "what did we decide",
				searchConfig: { rerank: true },
			})
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			name: "SearchLaneError",
			stage: "request",
			reason: "rerank-unsupported",
		})
	})

	it("fails before any retrieval work, so a demand never becomes a partial answer", async () => {
		const collection = vi.fn()
		const manager = buildMockManager({ db: { collection } })

		await manager
			.searchDetailed({
				query: "what did we decide",
				searchConfig: { rerank: true },
			})
			.catch(() => undefined)

		expect(collection).not.toHaveBeenCalled()
	})

	it("carries only enum values, never the query text", async () => {
		const manager = buildMockManager()

		const failure = (await manager
			.searchDetailed({
				query: "CANARY-QUERY-TEXT confidential plan",
				searchConfig: { rerank: true },
			})
			.catch((err: unknown) => err)) as Error

		expect(failure.message).not.toContain("CANARY-QUERY-TEXT")
		expect(failure.message).toContain("rerank-unsupported")
	})

	it("accepts an explicit rerank: false, which is always honored", async () => {
		const manager = buildMockManager({ db: { collection: vi.fn() } })

		const failure = await manager
			.searchDetailed({ query: "", searchConfig: { rerank: false } })
			.catch((err: unknown) => err)

		expect(failure).not.toBeInstanceOf(SearchLaneError)
	})
})

describe("status reports rerank as not supported", () => {
	function statusOf() {
		const host = {
			config: kitMongoConfig(),
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				rankFusion: true,
				scoreFusion: true,
				storedSource: false,
				vectorIndexMethod: false,
			},
			probeEmbeddingModeSupportsVector: () => true,
			fileCount: 0,
			chunkCount: 0,
			dirty: false,
			workspaceDir: "/tmp/ws",
			lastSearchMode: "none",
			lastSearchDetails: undefined,
			relevance: null,
		}
		return new MongoDBManagerAdminOps(host as never).status()
	}

	it("reports engine native-rerank support false and server support unknown", () => {
		expect(statusOf().custom?.rerank).toMatchObject({
			nativeRerank: { engineSupport: false, serverSupport: "unknown" },
		})
	})

	it("reports the rerank lane as not-applicable with reason capability-absent", () => {
		expect(statusOf().custom?.rerank).toMatchObject({
			lane: { outcome: "not-applicable", reason: "capability-absent" },
		})
	})

	it("does not report a configured HTTP reranker anywhere in status", () => {
		const serialized = JSON.stringify(statusOf())
		expect(serialized).not.toMatch(/rerank-(2|3)/)
		expect(serialized).not.toMatch(/voyage/i)
	})
})
