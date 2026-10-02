import type { MemoryScope } from "@memongo/lib"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"

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
const host = {
	db: createStatefulMongoFake().db,
	prefix: "test_",
	agentId: "agent1",
	agentScopeRef: "agent:agent1",
}
const ops = new MongoDBManagerLifecycleOps(
	host as unknown as MongoDBManagerHost,
)
type Input = { scope?: MemoryScope; scopeRef?: string; sessionId?: string }
const wrappers = [
	{
		name: "profile",
		mock: helpers.profile,
		call: (input: Input) => ops.synthesizeProfile(input),
	},
	{
		name: "slate",
		mock: helpers.slate,
		call: (input: Input) => ops.hydrateActiveSlate(input),
	},
	{
		name: "discovery",
		mock: helpers.discovery,
		call: (input: Input) =>
			ops.buildDiscoveryProjection({ kind: "entity-brief", ...input }),
	},
] as const
beforeEach(() => {
	vi.clearAllMocks()
	host.db = createStatefulMongoFake().db
})
describe.each(wrappers)("$name session coordinate", ({ mock, call }) => {
	it("derives session reference from sessionId", async () => {
		await call({ scope: "session", sessionId: "session-one" })
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "session",
				scopeRef: "session:session-one",
			}),
		)
	})
	it("preserves explicit reference precedence", async () => {
		await call({
			scope: "session",
			scopeRef: "session:explicit",
			sessionId: "session-one",
		})
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "session",
				scopeRef: "session:explicit",
			}),
		)
	})
	it("preserves an explicit empty reference", async () => {
		await call({ scope: "session", scopeRef: "", sessionId: "session-one" })
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "session", scopeRef: "" }),
		)
	})
	it.each([
		"agent",
		"global",
	] as const)("ignores a session coordinate for explicit %s scope", async (scope) => {
		await call({ scope, sessionId: "session-one" })
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({
				scope,
				scopeRef: scope === "agent" ? "agent:agent1" : "global",
			}),
		)
	})
	it("keeps agent default with an unused session hint", async () => {
		await call({ sessionId: "session-one" })
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "agent", scopeRef: "agent:agent1" }),
		)
	})
})
