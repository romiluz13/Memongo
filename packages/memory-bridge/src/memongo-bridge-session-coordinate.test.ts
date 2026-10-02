import { beforeEach, describe, expect, it, vi } from "vitest"

const helpers = vi.hoisted(() => ({
	profile: vi.fn(async (_params: Record<string, unknown>) => ({})),
	slate: vi.fn(async (_params: Record<string, unknown>) => ({})),
	discovery: vi.fn(async (_params: Record<string, unknown>) => ({})),
}))
vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async () => ({
		manager: {
			synthesizeProfile: helpers.profile,
			hydrateActiveSlate: helpers.slate,
			buildDiscoveryProjection: helpers.discovery,
		},
		error: null,
	})),
}))
vi.mock("./memory-config.js", () => ({ resolveBridgeConfig: () => ({}) }))
import {
	memongoBridgeProfile,
	memongoBridgeHydrateActiveSlate,
	memongoBridgeBuildDiscoveryProjection,
} from "./memongo-bridge.js"

beforeEach(() => vi.clearAllMocks())
const wrappers = [
	{ name: "profile", mock: helpers.profile, call: memongoBridgeProfile },
	{ name: "slate", mock: helpers.slate, call: memongoBridgeHydrateActiveSlate },
	{
		name: "discovery",
		mock: helpers.discovery,
		call: (input: Parameters<typeof memongoBridgeProfile>[0]) =>
			memongoBridgeBuildDiscoveryProjection({ kind: "what-changed", ...input }),
	},
] as const
describe.each(wrappers)("$name bridge coordinate", ({ mock, call }) => {
	it.each([
		undefined,
		"session:explicit",
	])("forwards sessionId with scopeRef %s", async (scopeRef) => {
		await call({
			agentId: "agent1",
			scope: "session",
			scopeRef,
			sessionId: "session-one",
		})
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "session",
				scopeRef,
				sessionId: "session-one",
			}),
		)
	})
})
