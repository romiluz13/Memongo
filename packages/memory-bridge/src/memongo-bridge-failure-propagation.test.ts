import { beforeEach, describe, expect, it, vi } from "vitest"

// M2 T11 (failure matrix): every bridge accessor whose engine call can fail
// hands the engine's typed failure to its caller unchanged. None of them
// catches it, none turns it into an empty value, and none rewrites a healthy
// empty answer.

const manager = {
	readFile: vi.fn(),
	writeConversationEvent: vi.fn(),
	writeConversationEventsBatch: vi.fn(),
	writeStructuredMemory: vi.fn(),
	writeProcedure: vi.fn(),
	hydrateActiveSlate: vi.fn(),
	buildDiscoveryProjection: vi.fn(),
	buildContextBundle: vi.fn(),
	recallConversation: vi.fn(),
	invalidateLifecycleItem: vi.fn(),
	status: vi.fn(),
	getDetailedStatus: vi.fn(),
	stats: vi.fn(),
	sync: vi.fn(),
	relevanceExplain: vi.fn(),
	traceChain: vi.fn(),
	scanNovelty: vi.fn(),
	consolidate: vi.fn(),
}

vi.mock("@memongo/memory-engine", async () => {
	const actual = await vi.importActual<typeof import("@memongo/memory-engine")>(
		"@memongo/memory-engine",
	)
	return {
		...actual,
		getMemorySearchManager: vi.fn(async () => ({ manager, error: null })),
		closeAllMemorySearchManagers: vi.fn(),
	}
})
vi.mock("@memongo/memory-engine/internal", () => ({
	materializeBlocks: vi.fn(),
}))
vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))

import { SearchLaneError } from "@memongo/memory-engine"
import * as bridge from "./memongo-bridge.js"

const handle = {
	type: "structured_memory",
	id: "k",
	agentId: "a",
	scope: "agent",
	scopeRef: "a",
} as never
const entry = { key: "k", value: "v", type: "fact" } as never

type Case = {
	row: string
	engine: keyof typeof manager
	call: () => Promise<unknown>
}

const CASES: Case[] = [
	{
		row: "B-07 readFile",
		engine: "readFile",
		call: () => bridge.memongoBridgeReadFile({ relPath: "p" }),
	},
	{
		row: "B-08 add",
		engine: "writeConversationEvent",
		call: () => bridge.memongoBridgeAdd({ content: "c" }),
	},
	{
		row: "B-09 writeConversationEvent",
		engine: "writeConversationEvent",
		call: () =>
			bridge.memongoBridgeWriteConversationEvent({ role: "user", body: "b" }),
	},
	{
		row: "B-10 writeConversationEventsBatch",
		engine: "writeConversationEventsBatch",
		call: () =>
			bridge.memongoBridgeWriteConversationEventsBatch({ events: [] }),
	},
	{
		row: "B-12 writeStructuredMemory",
		engine: "writeStructuredMemory",
		call: () => bridge.memongoBridgeWriteStructuredMemory({ entry }),
	},
	{
		row: "B-13 writeProcedure",
		engine: "writeProcedure",
		call: () => bridge.memongoBridgeWriteProcedure({ entry }),
	},
	{
		row: "B-15 hydrateActiveSlate",
		engine: "hydrateActiveSlate",
		call: () => bridge.memongoBridgeHydrateActiveSlate({}),
	},
	{
		row: "B-16 buildDiscoveryProjection",
		engine: "buildDiscoveryProjection",
		call: () =>
			bridge.memongoBridgeBuildDiscoveryProjection({ kind: "what-changed" }),
	},
	{
		row: "B-17 buildContextBundle",
		engine: "buildContextBundle",
		call: () => bridge.memongoBridgeBuildContextBundle({}),
	},
	{
		row: "B-18 recallConversation",
		engine: "recallConversation",
		call: () => bridge.memongoBridgeRecallConversation({ query: "q" }),
	},
	{
		row: "B-21 deleteLifecycleItem",
		engine: "invalidateLifecycleItem",
		call: () => bridge.memongoBridgeDeleteLifecycleItem({ handle }),
	},
	{
		row: "B-26 status",
		engine: "status",
		call: () => bridge.memongoBridgeStatus({}),
	},
	{
		row: "B-27 getDetailedStatus",
		engine: "getDetailedStatus",
		call: () => bridge.memongoBridgeGetDetailedStatus({}),
	},
	{
		row: "B-28 stats",
		engine: "stats",
		call: () => bridge.memongoBridgeStats({}),
	},
	{
		row: "B-33 sync",
		engine: "sync",
		call: () => bridge.memongoBridgeSync({}),
	},
	{
		row: "B-38 relevanceExplain",
		engine: "relevanceExplain",
		call: () => bridge.memongoBridgeRelevanceExplain({ query: "q" }),
	},
	{
		row: "B-44 traceChain",
		engine: "traceChain",
		call: () =>
			bridge.memongoBridgeTraceChain({ factId: "f", collection: "facts" }),
	},
	{
		row: "B-45 scanNovelty",
		engine: "scanNovelty",
		call: () => bridge.memongoBridgeScanNovelty({}),
	},
	{
		row: "B-46 consolidate",
		engine: "consolidate",
		call: () => bridge.memongoBridgeConsolidate({}),
	},
]

beforeEach(() => {
	for (const fn of Object.values(manager)) fn.mockReset()
})

describe.each(CASES)("$row", ({ engine, call }) => {
	it("rethrows the engine's typed lane failure, never an empty value", async () => {
		const failure = new SearchLaneError({
			lane: "hybrid",
			stage: "lane",
			reason: "query-error",
		})
		manager[engine].mockRejectedValueOnce(failure)
		await expect(call()).rejects.toBe(failure)
	})

	it("rethrows a transaction refusal instead of swallowing it", async () => {
		const failure = Object.assign(new Error("transactions are required"), {
			code: "TRANSACTION_UNSUPPORTED",
		})
		manager[engine].mockRejectedValueOnce(failure)
		await expect(call()).rejects.toBe(failure)
	})

	it("returns the engine's healthy empty answer untouched", async () => {
		const empty = { sentinel: "healthy-empty" }
		manager[engine].mockResolvedValueOnce(empty)
		await expect(call()).resolves.toBe(empty)
	})
})
