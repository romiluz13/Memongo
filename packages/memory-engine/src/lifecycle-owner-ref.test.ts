import type { MemoryScope } from "@memongo/lib"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import { resolveScopeRef } from "./mongodb-scope.js"

const helpers = vi.hoisted(() => ({
	profile: vi.fn(async (_params: Record<string, unknown>) => ({})),
	slate: vi.fn(async (_params: Record<string, unknown>) => ({})),
	discovery: vi.fn(async (_params: Record<string, unknown>) => ({})),
}))
vi.mock("./mongodb-profile.js", () => ({ synthesizeProfile: helpers.profile }))
vi.mock("./mongodb-active-slate.js", () => ({
	hydrateActiveSlate: helpers.slate,
}))
vi.mock("./mongodb-discovery-projections.js", () => ({
	buildDiscoveryProjection: helpers.discovery,
}))

const workspaceDir = "/memongo-owned-fixture/not-an-existing-workspace"
const host = {
	db: createStatefulMongoFake().db,
	prefix: "test_",
	agentId: "agent1",
	agentScopeRef: "agent:agent1",
	workspaceDir,
}
const ops = new MongoDBManagerLifecycleOps(
	host as unknown as MongoDBManagerHost,
)
const wrappers = [
	{
		name: "profile",
		mock: helpers.profile,
		call: (input: { scope?: MemoryScope; scopeRef?: string }) =>
			ops.synthesizeProfile(input),
	},
	{
		name: "slate",
		mock: helpers.slate,
		call: (input: { scope?: MemoryScope; scopeRef?: string }) =>
			ops.hydrateActiveSlate(input),
	},
	{
		name: "discovery",
		mock: helpers.discovery,
		call: (input: { scope?: MemoryScope; scopeRef?: string }) =>
			ops.buildDiscoveryProjection({ kind: "entity-brief", ...input }),
	},
] as const
beforeEach(() => {
	vi.clearAllMocks()
	host.db = createStatefulMongoFake().db
})
describe.each(wrappers)("$name owner reference", ({ mock, call }) => {
	it.each([
		"global",
		"workspace",
	] as const)("derives explicit %s reference", async (scope) => {
		await call({ scope })
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({
				scope,
				scopeRef: resolveScopeRef({ scope, agentId: "agent1", workspaceDir }),
			}),
		)
	})
	it("preserves an explicit reference", async () => {
		await call({ scope: "tenant", scopeRef: "tenant:one" })
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "tenant", scopeRef: "tenant:one" }),
		)
	})
	it("preserves absent-scope agent owner", async () => {
		await call({})
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "agent", scopeRef: "agent:agent1" }),
		)
	})
	it.each([
		"user",
		"tenant",
		"session",
	] as const)("rejects %s without a required coordinate", async (scope) => {
		await expect(call({ scope })).rejects.toThrow(`${scope} scope requires`)
		expect(mock).not.toHaveBeenCalled()
	})
	it.each([
		"global",
		"workspace",
	] as const)("preserves explicit empty %s reference", async (scope) => {
		await call({ scope, scopeRef: "" })
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ scope, scopeRef: "" }),
		)
	})

	it("preserves an explicit empty reference for compatibility", async () => {
		await call({ scope: "agent", scopeRef: "" })
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "agent", scopeRef: "" }),
		)
	})
})
