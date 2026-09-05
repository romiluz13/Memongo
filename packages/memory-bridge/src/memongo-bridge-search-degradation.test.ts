import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// WS-12 (C-019) degradation passthrough: the bridge search accessors must
// forward the onDegradation sink into the engine, merge the marker into the
// returned envelope exactly when admission control degraded the answer, and
// keep the envelope bare (no degradation key) when the answer is
// authoritative — so a throttled search can never read as "no memories
// found" at the API boundary.

const search = vi.fn(async () => [] as unknown[])
const searchKB = vi.fn(async () => [] as unknown[])

vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async ({ agentId }: { agentId: string }) => ({
		manager: {
			agentId,
			search,
			searchKB,
		},
		error: null,
	})),
	closeAllMemorySearchManagers: vi.fn(),
}))

vi.mock("@memongo/memory-engine/internal", () => ({
	materializeBlocks: vi.fn(),
}))

vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))

import { getMemorySearchManager } from "@memongo/memory-engine"
import {
	memongoBridgeSearchKBWithDegradation,
	memongoBridgeSearchWithDegradation,
} from "./memongo-bridge.js"

type EngineDegradation = {
	kind: "throttled"
	scope: "denied" | "legacy-fallback-skipped" | "vector-lane-skipped"
	retryAfterMs: number
}

describe("bridge search degradation passthrough (WS-12, C-019)", () => {
	const prevAgentId = process.env.MEMONGO_AGENT_ID

	beforeEach(() => {
		delete process.env.MEMONGO_AGENT_ID
		search.mockReset()
		searchKB.mockReset()
		vi.mocked(getMemorySearchManager).mockClear()
	})

	it("merges the engine's denied marker into the search envelope", async () => {
		search.mockImplementation(
			async (
				_query: string,
				opts?: { onDegradation?: (degradation: EngineDegradation) => void },
			) => {
				opts?.onDegradation?.({
					kind: "throttled",
					scope: "denied",
					retryAfterMs: 2500,
				})
				return []
			},
		)

		const out = await memongoBridgeSearchWithDegradation({
			agentId: "agent-A",
			query: "deployment runbook",
		})

		expect(out).toEqual({
			results: [],
			degradation: { kind: "throttled", scope: "denied", retryAfterMs: 2500 },
		})
	})

	it("forwards the onDegradation sink and search options to the engine", async () => {
		search.mockImplementation(async () => [])

		await memongoBridgeSearchWithDegradation({
			agentId: "agent-A",
			query: "deployment runbook",
			maxResults: 5,
			scope: "workspace",
			scopeRef: "acme/platform",
		})

		expect(vi.mocked(getMemorySearchManager)).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent-A" }),
		)
		expect(search).toHaveBeenCalledWith(
			"deployment runbook",
			expect.objectContaining({
				maxResults: 5,
				scope: "workspace",
				scopeRef: "acme/platform",
				onDegradation: expect.any(Function),
			}),
		)
	})

	it("keeps the search envelope bare on a healthy empty answer", async () => {
		search.mockImplementation(async () => [])

		const out = await memongoBridgeSearchWithDegradation({
			agentId: "agent-A",
			query: "nothing matches",
		})

		expect(out).toEqual({ results: [] })
		expect("degradation" in out).toBe(false)
	})

	it("merges the vector-lane-skip marker into the KB search envelope", async () => {
		searchKB.mockImplementation(
			async (
				_query: string,
				opts?: { onDegradation?: (degradation: EngineDegradation) => void },
			) => {
				opts?.onDegradation?.({
					kind: "throttled",
					scope: "vector-lane-skipped",
					retryAfterMs: 4000,
				})
				return []
			},
		)

		const out = await memongoBridgeSearchKBWithDegradation({
			agentId: "agent-A",
			query: "onboarding guide",
			scopeRef: "acme/platform",
		})

		expect(out).toEqual({
			results: [],
			degradation: {
				kind: "throttled",
				scope: "vector-lane-skipped",
				retryAfterMs: 4000,
			},
		})
	})

	it("keeps the KB search envelope bare on a healthy empty answer", async () => {
		searchKB.mockImplementation(async () => [])

		const out = await memongoBridgeSearchKBWithDegradation({
			agentId: "agent-A",
			query: "nothing matches",
		})

		expect(out).toEqual({ results: [] })
		expect("degradation" in out).toBe(false)
	})

	afterEach(() => {
		if (prevAgentId === undefined) {
			delete process.env.MEMONGO_AGENT_ID
		} else {
			process.env.MEMONGO_AGENT_ID = prevAgentId
		}
	})
})
