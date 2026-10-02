import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
	searchKB: vi.fn(async (_query: string, _opts: Record<string, unknown>) => []),
	getManager: vi.fn(),
}))
vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: mocks.getManager,
	closeAllMemorySearchManagers: vi.fn(),
}))
vi.mock("@memongo/memory-engine/internal", () => ({
	materializeBlocks: vi.fn(),
}))
vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))
import {
	memongoBridgeSearchKB,
	memongoBridgeSearchKBWithDegradation,
} from "./memongo-bridge.js"
beforeEach(() => {
	mocks.searchKB.mockReset()
	mocks.searchKB.mockResolvedValue([])
	mocks.getManager.mockReset()
	mocks.getManager.mockResolvedValue({
		manager: { searchKB: mocks.searchKB },
		error: null,
	})
})
afterEach(() => vi.restoreAllMocks())
type Params = Parameters<typeof memongoBridgeSearchKB>[0] & {
	scope?: "global" | "session"
	sessionKey?: string
}
it.each([
	memongoBridgeSearchKB,
	memongoBridgeSearchKBWithDegradation,
])("forwards explicit KB scope, coordinate and reference without changing other options", async (search) => {
	await search({
		query: "architecture",
		agentId: "owner",
		scope: "session",
		sessionKey: "run",
		scopeRef: "explicit",
		maxResults: 7,
		minScore: 0.2,
		filter: { category: "runbook" },
		fusionMethod: "js-merge",
	} as Params)
	expect(mocks.getManager).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ agentId: "owner" }),
	)
	expect(mocks.searchKB).toHaveBeenCalledExactlyOnceWith(
		"architecture",
		expect.objectContaining({
			scope: "session",
			sessionKey: "run",
			scopeRef: "explicit",
			maxResults: 7,
			minScore: 0.2,
			filter: { category: "runbook" },
			fusionMethod: "js-merge",
		}),
	)
})
it("preserves the degradation sink with explicit scope", async () => {
	const marker = {
		kind: "throttled",
		scope: "vector-lane-skipped",
		retryAfterMs: 1,
	}
	mocks.searchKB.mockImplementation(async (_query, opts) => {
		;(opts.onDegradation as (value: unknown) => void)(marker)
		return []
	})
	expect(
		await memongoBridgeSearchKBWithDegradation({
			query: "architecture",
			scope: "global",
		} as Params),
	).toEqual({ results: [], degradation: marker })
	expect(mocks.searchKB.mock.calls[0][1].scope).toBe("global")
})
it.each([
	memongoBridgeSearchKB,
	memongoBridgeSearchKBWithDegradation,
])("keeps omitted scope and coordinates absent", async (search) => {
	await search({ query: "architecture", agentId: "owner" })
	expect(mocks.searchKB.mock.calls[0][1].scope).toBeUndefined()
	expect(mocks.searchKB.mock.calls[0][1].sessionKey).toBeUndefined()
	expect(mocks.searchKB.mock.calls[0][1].scopeRef).toBeUndefined()
})
