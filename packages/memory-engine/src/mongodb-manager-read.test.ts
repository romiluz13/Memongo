/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { describe, it, expect, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { mocked } from "./test-helpers/manager-test-kit.js"

vi.mock("./mongodb-events.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).eventsModuleMock(),
)

vi.mock("./mongodb-conversation-recall.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).conversationRecallModuleMock(),
)

vi.mock("./mongodb-ops.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).opsModuleMock(),
)

vi.mock("./mongodb-retrieval-planner.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).retrievalPlannerModuleMock(),
)

vi.mock("./mongodb-episodes.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).episodesModuleMock(),
)

vi.mock("./mongodb-graph.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).graphModuleMock(),
)

vi.mock("./mongodb-schema.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).schemaModuleMock(),
)

vi.mock("./mongodb-query-cache.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).queryCacheModuleMock(),
)

vi.mock("./mongodb-query-rewriter.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).queryRewriterModuleMock(),
)

vi.mock("./mongodb-reranker.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).rerankerModuleMock(),
)

vi.mock("./mongodb-lane-coverage.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).laneCoverageModuleMock(),
)

vi.mock("./mongodb-memory-jobs.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).memoryJobsModuleMock(),
)

vi.mock("./mongodb-consolidator.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).consolidatorModuleMock(),
)

vi.mock("./mongodb-derived-memory.js", async () =>
	(
		await import("./test-helpers/manager-test-kit.js")
	).derivedMemoryModuleMock(),
)

vi.mock("./mongodb-telemetry.js", async () =>
	(await import("./test-helpers/manager-test-kit.js")).telemetryModuleMock(),
)

describe("MongoDBMemoryManager conversation recall", () => {
	it("forwards the verified native bitemporal prefilter capability", async () => {
		const { recallConversation } = await import(
			"./mongodb-conversation-recall.js"
		)
		mocked(recallConversation).mockResolvedValue({
			results: [],
			metadata: {
				totalMatched: 0,
				filtersApplied: [],
				searchMethod: "standard",
				durationMs: 0,
			},
		})
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				capabilities: {
					vectorSearch: true,
					textSearch: true,
					rankFusion: true,
					storedSource: false,
					vectorIndexMethod: false,
					scoreFusion: false,
				},
				nativeBitemporalVectorPrefilter: true,
			},
		) as MongoDBMemoryManager

		await manager.recallConversation({ query: "deployment" })

		expect(recallConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				nativeBitemporalVectorPrefilter: true,
			}),
		)
	})

	it("activates native bitemporal prefiltering after a deferred index converges", async () => {
		const { recallConversation } = await import(
			"./mongodb-conversation-recall.js"
		)
		const { eventsCollection, isEventsVectorBitemporalPrefilterReady } =
			await import("./mongodb-schema.js")
		mocked(recallConversation).mockResolvedValue({
			results: [],
			metadata: {
				totalMatched: 0,
				filtersApplied: [],
				searchMethod: "standard",
				durationMs: 0,
			},
		})
		mocked(isEventsVectorBitemporalPrefilterReady).mockResolvedValue(true)
		mocked(eventsCollection).mockReturnValue({
			findOne: vi.fn(async () => null),
		} as unknown as import("mongodb").Collection)
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{
				db: {} as import("mongodb").Db,
				prefix: "test_",
				agentId: "agent-1",
				capabilities: {
					vectorSearch: true,
					textSearch: true,
					rankFusion: true,
					storedSource: false,
					vectorIndexMethod: false,
					scoreFusion: false,
				},
				nativeBitemporalVectorPrefilter: false,
				nativeBitemporalPrefilterCheckedAt: 0,
			},
		) as MongoDBMemoryManager

		await manager.recallConversation({ query: "deployment" })

		expect(recallConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				nativeBitemporalVectorPrefilter: true,
			}),
		)
	})
})

describe("MongoDBManagerReadOps structured locator TTL guard (B1)", () => {
	it("excludes expired structured records from locator reads", async () => {
		const { MongoDBManagerReadOps } = await import("./mongodb-manager-read.js")
		const { structuredMemCollection } = await import("./mongodb-schema.js")
		const findOne = vi.fn(async () => null)
		mocked(structuredMemCollection).mockReturnValue({
			findOne,
			updateOne: vi.fn(async () => ({ modifiedCount: 0 })),
		} as unknown as import("mongodb").Collection)

		const ops = new MongoDBManagerReadOps({
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
		} as unknown as import("./mongodb-manager-host.js").MongoDBManagerHost)

		const result = await ops.readFile({
			relPath: "structured:preference:editor-theme",
		})

		expect(result.text).toBe("")
		expect(findOne).toHaveBeenCalledWith(
			expect.objectContaining({
				$or: [
					{ expiresAt: { $exists: false } },
					{ expiresAt: { $gt: expect.any(Date) } },
				],
			}),
		)
	})

	it("excludes expired events from canonical event locator reads (B1)", async () => {
		const { MongoDBManagerReadOps } = await import("./mongodb-manager-read.js")
		const { eventsCollection } = await import("./mongodb-schema.js")
		const findOne = vi.fn(async () => null)
		mocked(eventsCollection).mockReturnValue({
			findOne,
		} as unknown as import("mongodb").Collection)

		const ops = new MongoDBManagerReadOps({
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
		} as unknown as import("./mongodb-manager-host.js").MongoDBManagerHost)

		const result = await ops.readCanonicalEvent(
			"evt-expired",
			"event:evt-expired",
		)

		expect(result.text).toBe("")
		expect(findOne).toHaveBeenCalledWith(
			expect.objectContaining({
				$or: [
					{ expiresAt: { $exists: false } },
					{ expiresAt: { $gt: expect.any(Date) } },
				],
			}),
		)
	})

	it("excludes expired events from episode expansion reads (B1)", async () => {
		const { MongoDBManagerReadOps } = await import("./mongodb-manager-read.js")
		const { episodesCollection, eventsCollection } = await import(
			"./mongodb-schema.js"
		)
		mocked(episodesCollection).mockReturnValue({
			findOne: vi.fn(async () => ({
				episodeId: "ep-1",
				type: "review",
				title: "Episode",
				sourceEventIds: ["evt-1"],
			})),
		} as unknown as import("mongodb").Collection)
		const find = vi.fn().mockReturnValue({
			toArray: vi.fn(async () => []),
		})
		mocked(eventsCollection).mockReturnValue({
			find,
		} as unknown as import("mongodb").Collection)

		const ops = new MongoDBManagerReadOps({
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
		} as unknown as import("./mongodb-manager-host.js").MongoDBManagerHost)

		await ops.readEpisodeLocator({
			rawPath: "episode:ep-1?expand=events",
			episodeId: "ep-1",
			expandEvents: true,
		})

		expect(find).toHaveBeenCalledWith(
			expect.objectContaining({
				$or: [
					{ expiresAt: { $exists: false } },
					{ expiresAt: { $gt: expect.any(Date) } },
				],
			}),
		)
	})
})

describe("MongoDBManagerReadOps kb locator tenant scoping (C-035)", () => {
	type KBTestDoc = {
		_id: string
		agentId: string
		scope: string
		scopeRef: string
		title: string
		content: string
		source: { type: string; path?: string; importedBy: string }
		updatedAt: Date
	}

	// Two tenants in ONE shared physical collection (issue #27 mode) plus a
	// global-corpus document. Tenants A and B deliberately share the same
	// source.path AND title: pre-C-035 the locator filter carried only the
	// $or, so a path/title collision crossed the tenant boundary and
	// whichever document sorted first won. Only the identity filter can
	// isolate them now.
	const docA: KBTestDoc = {
		_id: "doc-a",
		agentId: "agent-a",
		scope: "agent",
		scopeRef: "agent:agent-a",
		title: "handbook.md",
		content: "tenant A private content",
		source: { type: "file", path: "docs/handbook.md", importedBy: "pi" },
		updatedAt: new Date("2026-01-02T00:00:00.000Z"),
	}
	const docB: KBTestDoc = {
		_id: "doc-b",
		agentId: "agent-b",
		scope: "agent",
		scopeRef: "agent:agent-b",
		title: "handbook.md",
		content: "tenant B private content",
		source: { type: "file", path: "docs/handbook.md", importedBy: "pi" },
		updatedAt: new Date("2026-01-03T00:00:00.000Z"),
	}
	const docGlobal: KBTestDoc = {
		_id: "doc-global",
		agentId: "agent-a",
		scope: "global",
		scopeRef: "global",
		title: "glossary.md",
		content: "shared corpus content",
		source: { type: "file", path: "docs/glossary.md", importedBy: "pi" },
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	}

	function docMatches(
		doc: KBTestDoc,
		filter: Record<string, unknown>,
	): boolean {
		for (const [key, value] of Object.entries(filter)) {
			if (key === "$or") {
				const alternatives = value as Array<Record<string, unknown>>
				if (!alternatives.some((alt) => docMatches(doc, alt))) return false
				continue
			}
			if (key === "source.path") {
				if (doc.source.path !== value) return false
				continue
			}
			if ((doc as Record<string, unknown>)[key] !== value) return false
		}
		return true
	}

	function seedKbCollection(docs: KBTestDoc[]) {
		return vi.fn(async (filter: Record<string, unknown>) => {
			// The engine emits sort {updatedAt: -1, _id: 1}; each filter below
			// matches at most one seeded document, so first-match is exact.
			return docs.find((doc) => docMatches(doc, filter)) ?? null
		})
	}

	async function makeOps(
		agentId: string,
		findOne: ReturnType<typeof seedKbCollection>,
	) {
		const { MongoDBManagerReadOps } = await import("./mongodb-manager-read.js")
		const { resolveScopeIdentity } = await import("./mongodb-scope.js")
		const { kbCollection } = await import("./mongodb-schema.js")
		mocked(kbCollection).mockReturnValue({
			findOne,
		} as unknown as import("mongodb").Collection)
		const ops = new MongoDBManagerReadOps({
			db: {} as import("mongodb").Db,
			prefix: "shared_",
			agentId,
			resolveSearchIdentity: (opts?: {
				scope?: import("@memongo/lib").MemoryScope
				scopeRef?: string
			}) =>
				resolveScopeIdentity({
					scope: opts?.scope,
					scopeRef: opts?.scopeRef,
					agentId,
					defaultScope: "agent",
				}),
		} as unknown as import("./mongodb-manager-host.js").MongoDBManagerHost)
		return { ops, findOne }
	}

	it("scopes the kb locator to the caller's tenant (regression)", async () => {
		const findOneA = seedKbCollection([docA, docB, docGlobal])
		const { ops } = await makeOps("agent-a", findOneA)

		const result = await ops.readFile({ relPath: "kb:docs/handbook.md" })

		expect(result.text).toBe("tenant A private content")
		// The locator filter must carry the caller's full identity, not just
		// the path $or — the pre-fix filter was only the $or.
		expect(findOneA).toHaveBeenCalledWith(
			{
				agentId: "agent-a",
				scope: "agent",
				scopeRef: "agent:agent-a",
				$or: [
					{ "source.path": "docs/handbook.md" },
					{ title: "docs/handbook.md" },
				],
			},
			{ sort: { updatedAt: -1, _id: 1 } },
		)
	})

	it("resolves a same-path collision to the caller's own document", async () => {
		// Both tenants ingested a document with the same source.path and
		// title; the identity filter — not the $or — decides which one is
		// returned (pre-C-035, whichever document sorted first won).
		const findOneB = seedKbCollection([docA, docB, docGlobal])
		const { ops } = await makeOps("agent-b", findOneB)

		const result = await ops.readFile({ relPath: "kb:docs/handbook.md" })

		expect(result.text).toBe("tenant B private content")
		expect(findOneB).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-b",
				scopeRef: "agent:agent-b",
			}),
			expect.anything(),
		)
	})

	it("returns empty when only another tenant owns the path match", async () => {
		const docOnlyA: KBTestDoc = {
			_id: "doc-only-a",
			agentId: "agent-a",
			scope: "agent",
			scopeRef: "agent:agent-a",
			title: "only-a.md",
			content: "tenant A private content",
			source: { type: "file", path: "docs/only-a.md", importedBy: "pi" },
			updatedAt: new Date("2026-01-05T00:00:00.000Z"),
		}
		const findOneB = seedKbCollection([docOnlyA, docB])
		const { ops } = await makeOps("agent-b", findOneB)

		const result = await ops.readFile({ relPath: "kb:docs/only-a.md" })

		expect(result.text).toBe("")
	})

	it("reads by the reference: alias with the same identity filter", async () => {
		const findOneA = seedKbCollection([docA, docB, docGlobal])
		const { ops } = await makeOps("agent-a", findOneA)

		const result = await ops.readFile({ relPath: "reference:handbook.md" })

		expect(result.text).toBe("tenant A private content")
		expect(findOneA).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-a",
				scopeRef: "agent:agent-a",
				$or: expect.arrayContaining([{ title: "handbook.md" }]),
			}),
			expect.anything(),
		)
	})

	it("explicit ?scope=global round-trips only for the ingesting agent", async () => {
		const findOneA = seedKbCollection([docA, docB, docGlobal])
		const { ops } = await makeOps("agent-a", findOneA)
		const shared = await ops.readFile({
			relPath: "kb:docs/glossary.md?scope=global",
		})
		expect(shared.text).toBe("shared corpus content")

		// agent-b resolves the same global scopeRef but did not ingest the
		// document — the agentId tag still fences full-content reads.
		const findOneB = seedKbCollection([docA, docB, docGlobal])
		const opsB = await makeOps("agent-b", findOneB)
		const miss = await opsB.ops.readFile({
			relPath: "kb:docs/glossary.md?scope=global",
		})
		expect(miss.text).toBe("")
	})

	it("unknown scope query values fail closed", async () => {
		const findOneA = seedKbCollection([docA, docB, docGlobal])
		const { ops } = await makeOps("agent-a", findOneA)

		const result = await ops.readFile({
			relPath: "kb:docs/handbook.md?scope=bogus",
		})

		expect(result.text).toBe("")
	})
})

describe("MongoDBManagerReadOps relation locator (C-025)", () => {
	it("passes a typed locator through to findRelationByLocatorId without extra parameters", async () => {
		const { MongoDBManagerReadOps } = await import("./mongodb-manager-read.js")
		const { findRelationByLocatorId } = await import("./mongodb-graph.js")
		mocked(findRelationByLocatorId).mockResolvedValue({
			fromEntityId: "ent-1",
			toEntityId: "ent-2",
			type: "works_on",
			state: "active",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			updatedAt: new Date(),
		})

		const ops = new MongoDBManagerReadOps({
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
			agentScopeRef: "agent:agent-1",
		} as unknown as import("./mongodb-manager-host.js").MongoDBManagerHost)

		const result = await ops.readFile({
			relPath: "relation:ent-1-ent-2-works_on",
		})

		expect(findRelationByLocatorId).toHaveBeenCalledWith(
			expect.objectContaining({
				relationId: "ent-1-ent-2-works_on",
				type: undefined,
			}),
		)
		expect(result.text).toContain("type: works_on")
		expect(result.source).toBe("conversation")
	})

	it("forwards ?type= so a bare pair disambiguates same-pair relations", async () => {
		const { MongoDBManagerReadOps } = await import("./mongodb-manager-read.js")
		const { findRelationByLocatorId } = await import("./mongodb-graph.js")
		mocked(findRelationByLocatorId).mockResolvedValue(null)

		const ops = new MongoDBManagerReadOps({
			db: {} as import("mongodb").Db,
			prefix: "test_",
			agentId: "agent-1",
			agentScopeRef: "agent:agent-1",
		} as unknown as import("./mongodb-manager-host.js").MongoDBManagerHost)

		const result = await ops.readFile({
			relPath: "relation:ent-1-ent-2?type=works_on&scope=agent",
		})

		expect(findRelationByLocatorId).toHaveBeenCalledWith(
			expect.objectContaining({
				relationId: "ent-1-ent-2",
				type: "works_on",
				scope: "agent",
			}),
		)
		// Miss renders as an empty conversation read, not an error.
		expect(result.text).toBe("")
	})
})
