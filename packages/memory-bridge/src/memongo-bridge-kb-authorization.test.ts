import { beforeEach, describe, expect, it, vi } from "vitest"

const manager = vi.hoisted(() => ({
	search: vi.fn(),
	searchDetailed: vi.fn(),
	buildContextBundle: vi.fn(),
	relevanceExplain: vi.fn(),
	synthesizeProfile: vi.fn(),
	hydrateActiveSlate: vi.fn(),
}))

vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async () => ({
		manager,
		error: null,
	})),
	closeAllMemorySearchManagers: vi.fn(),
}))

vi.mock("@memongo/memory-engine/internal", () => ({
	materializeBlocks: vi.fn(() => ({
		blocks: [],
		totalTokenBudget: 0,
		totalActualTokens: 0,
	})),
}))

vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))

import {
	memongoBridgeBuildContextBundle,
	memongoBridgeGetState,
	memongoBridgeRelevanceExplain,
	memongoBridgeSearchDetailed,
	memongoBridgeSearchWithDegradation,
} from "./memongo-bridge.js"

describe("bridge KB authorization conduit", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		manager.search.mockResolvedValue([])
		manager.searchDetailed.mockResolvedValue({ results: [], metadata: {} })
		manager.buildContextBundle.mockResolvedValue({ sections: [] })
		manager.relevanceExplain.mockResolvedValue({
			health: "healthy",
			results: [],
		})
		manager.synthesizeProfile.mockResolvedValue({})
		manager.hydrateActiveSlate.mockResolvedValue(null)
	})

	it("forwards the request-local restriction through every fresh literal", async () => {
		await memongoBridgeSearchWithDegradation({
			agentId: "agent-A",
			query: "authorization probe",
			kbRestricted: true,
		})
		await memongoBridgeSearchDetailed({
			agentId: "agent-A",
			query: "authorization probe",
			kbRestricted: true,
		})
		await memongoBridgeBuildContextBundle({
			agentId: "agent-A",
			query: "authorization probe",
			kbRestricted: true,
		})
		await memongoBridgeRelevanceExplain({
			agentId: "agent-A",
			query: "authorization probe",
			kbRestricted: true,
		})
		await memongoBridgeGetState({
			agentId: "agent-A",
			kbRestricted: true,
		})

		expect(manager.search).toHaveBeenCalledWith(
			"authorization probe",
			expect.objectContaining({ kbRestricted: true }),
		)
		expect(manager.searchDetailed).toHaveBeenCalledWith(
			expect.objectContaining({ kbRestricted: true }),
		)
		expect(manager.relevanceExplain).toHaveBeenCalledWith(
			expect.objectContaining({ kbRestricted: true }),
		)
		expect(manager.buildContextBundle).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ kbRestricted: true }),
		)
		expect(manager.buildContextBundle).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ kbRestricted: true }),
		)
	})
})
