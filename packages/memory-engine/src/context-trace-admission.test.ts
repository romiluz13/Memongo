import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { MongoServerError } from "mongodb"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import type { MemoryContextBundle } from "./types.js"

const state = vi.hoisted(() => ({
	order: [] as string[],
	fault: undefined as Error | undefined,
	search: false,
}))
vi.mock("./mongodb-write-fence.js", () => ({
	captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => {
		state.order.push("admit")
		if (state.fault) throw state.fault
		return { kind: "admission", agentId, epoch: 3 }
	}),
}))
vi.mock("./mongodb-context-bundle.js", () => ({
	buildContextBundle: vi.fn(async (params) => {
		if (state.search)
			await params.search({
				query: "private",
				maxResults: 1,
				scope: "session",
				scopeRef: "s1",
			})
		state.order.push("compose")
		return {
			metadata: { pathsExecuted: [], estimatedTokensUsed: 0 },
		} as unknown as MemoryContextBundle
	}),
}))
vi.mock("./mongodb-search-v2.js", () => ({
	searchV2: vi.fn(async () => ({
		results: [],
		metadata: { pathsExecuted: [], resultsByPath: {} },
	})),
}))
vi.mock("./mongodb-recall-traces.js", () => ({
	recordRecallTrace: vi.fn(async () => "trace"),
}))
const { recordRecallTrace } = await import("./mongodb-recall-traces.js")
const { buildContextBundle } = await import("./mongodb-context-bundle.js")
function ops() {
	const host = {
		db: {},
		prefix: "test_",
		agentId: "agent-1",
		config: {
			mongodb: {
				kb: { enabled: false },
				episodes: { enabled: false },
				graph: { enabled: false, maxGraphDepth: 0 },
				relevance: { telemetry: { queryPrivacyMode: "none" } },
			},
		},
		buildV2AvailablePaths: () => new Set(),
		buildConversationChunkFilter: () => ({}),
		buildScopeAwareBridgeChunkFilter: () => ({}),
		getBridgeChunkBudget: () => 0,
		capabilities: {},
	}
	return new MongoDBManagerLifecycleOps(host as unknown as MongoDBManagerHost)
}
beforeEach(() => {
	vi.clearAllMocks()
	state.order.length = 0
	state.fault = undefined
	state.search = false
})
describe("context bundle admission before reads", () => {
	it("passes the entry token through the context search callback", async () => {
		state.search = true
		await ops().buildContextBundle({ query: "private" })
		const { searchV2 } = await import("./mongodb-search-v2.js")
		expect(searchV2).toHaveBeenCalledWith(
			expect.anything(),
			"test_",
			"private",
			"agent-1",
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 3 },
			}),
		)
	})

	it("passes the original admission to its trace after composing", async () => {
		await ops().buildContextBundle({ query: "private" })
		expect(state.order).toEqual(["admit", "compose"])
		expect(recordRecallTrace).toHaveBeenCalledWith(
			expect.objectContaining({
				admission: { kind: "admission", agentId: "agent-1", epoch: 3 },
				trace: expect.objectContaining({ agentId: "agent-1" }),
			}),
		)
	})
	it("rejects a capture fault before composing or recording", async () => {
		const fault = new Error("owned admission fault")
		state.fault = fault
		await expect(ops().buildContextBundle({ query: "private" })).rejects.toBe(
			fault,
		)
		expect(buildContextBundle).not.toHaveBeenCalled()
		expect(recordRecallTrace).not.toHaveBeenCalled()
		expect(state.order).toEqual(["admit"])
	})
})

it("preserves a context bundle while hiding a rejected trace's private error", async () => {
	const privateText = "violet confidential context CANARY90"
	const lines: string[] = []
	vi.spyOn(console, "warn").mockImplementation((...args) =>
		lines.push(args.join(" ")),
	)
	vi.mocked(recordRecallTrace).mockRejectedValueOnce(
		new MongoServerError({ errmsg: privateText, code: 2 }),
	)
	const out = await ops().buildContextBundle({ query: "public topic" })
	expect(out.metadata.pathsExecuted).toEqual([])
	await new Promise<void>((resolve) => setImmediate(resolve))
	expect(lines).toHaveLength(1)
	expect(lines[0]).not.toContain(privateText)
	expect(lines[0]).toContain('"code":2')
})
afterEach(() => vi.restoreAllMocks())
