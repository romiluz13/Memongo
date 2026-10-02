import type { Document } from "mongodb"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"
import { resolveScopeRef } from "./mongodb-scope.js"

function fixture() {
	const fake = createStatefulMongoFake()
	const aggregate = vi
		.spyOn(fake.collection("kb_chunks"), "aggregate")
		.mockImplementation(() => ({ toArray: async () => [] }) as never)
	const collection = vi.spyOn(fake.db, "collection")
	const manager = Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		db: fake.db,
		prefix: "test_",
		agentId: "owner",
		agentScopeRef: "agent:owner",
		workspaceDir: "/memongo-fixture-workspace",
		config: {
			mongodb: { embeddingMode: "automated", fusionMethod: "js-merge" },
		},
		capabilities: {
			vectorSearch: false,
			textSearch: false,
			scoreFusion: false,
			rankFusion: false,
			storedSource: false,
			vectorIndexMethod: false,
		},
	}) as MongoDBMemoryManager
	return { manager, aggregate, collection }
}
beforeEach(() => vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false"))
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})
type KBOptions = NonNullable<
	Parameters<MongoDBMemoryManager["searchKB"]>[1]
> & {
	scope?: "agent" | "global" | "workspace" | "user" | "tenant" | "session"
	sessionKey?: string
}
it.each([
	[{ scope: "global" }, "global"],
	[{ scope: "session", sessionKey: "run" }, "session:run"],
	[
		{ scope: "workspace" },
		resolveScopeRef({
			scope: "workspace",
			agentId: "owner",
			workspaceDir: "/memongo-fixture-workspace",
		}),
	],
	[{}, "agent:owner"],
	[{ sessionKey: "run" }, "agent:owner"],
	[{ scope: "global", scopeRef: "explicit" }, "explicit"],
	[{ scope: "user", scopeRef: "user:one" }, "user:one"],
] as const)("uses the requested KB partition for %j", async (options, reference) => {
	const { manager, aggregate } = fixture()
	await manager.searchKB("architecture", options as KBOptions)
	expect(aggregate).toHaveBeenCalledOnce()
	expect((aggregate.mock.calls[0][0] as Document[])[0].$match).toEqual({
		$text: { $search: "architecture" },
		scopeRef: reference,
	})
})
it("keeps omitted KB scope in the legacy agent partition under a user default", async () => {
	vi.stubEnv("MEMONGO_DEFAULT_SCOPE", "user")
	const { manager, aggregate } = fixture()
	await manager.searchKB("architecture")
	expect((aggregate.mock.calls[0][0] as Document[])[0].$match.scopeRef).toBe(
		"agent:owner",
	)
})
it("does not carry scope state across calls on the same manager", async () => {
	const { manager, aggregate } = fixture()
	for (const options of [
		{ scope: "global" },
		{},
		{ scope: "global", scopeRef: "explicit" },
	])
		await manager.searchKB("architecture", options as KBOptions)
	expect(
		aggregate.mock.calls.map(
			([pipeline]) => (pipeline as Document[])[0].$match.scopeRef,
		),
	).toEqual(["global", "agent:owner", "explicit"])
})
it.each([
	{ scope: "session" },
	{ scope: "user" },
	{ scope: "tenant" },
] as const)("rejects incomplete %j before any database access", async (options) => {
	const { manager, collection, aggregate } = fixture()
	await expect(
		manager.searchKB("architecture", options as KBOptions),
	).rejects.toThrow("scope requires")
	expect(collection).not.toHaveBeenCalled()
	expect(aggregate).not.toHaveBeenCalled()
})
it("keeps empty queries free of resolution and database access", async () => {
	const { manager, collection } = fixture()
	expect(
		await manager.searchKB("  ", { scope: "session" } as KBOptions),
	).toEqual([])
	expect(collection).not.toHaveBeenCalled()
})
