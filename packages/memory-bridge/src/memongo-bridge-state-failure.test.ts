import { beforeEach, describe, expect, it, vi } from "vitest"

const manager = vi.hoisted(() => ({
	synthesizeProfile: vi.fn(),
	hydrateActiveSlate: vi.fn(),
	buildContextBundle: vi.fn(),
}))
const blocks = { blocks: [], totalTokenBudget: 80, totalActualTokens: 0 }
vi.mock("@memongo/memory-engine", () => ({
	getMemorySearchManager: vi.fn(async () => ({ manager, error: null })),
	closeAllMemorySearchManagers: vi.fn(),
}))
vi.mock("@memongo/memory-engine/internal", () => ({
	materializeBlocks: vi.fn(() => blocks),
}))
vi.mock("./memory-config.js", () => ({
	resolveBridgeConfig: vi.fn(() => ({})),
}))
import { getMemorySearchManager } from "@memongo/memory-engine"
import { materializeBlocks } from "@memongo/memory-engine/internal"
import { memongoBridgeGetState } from "./memongo-bridge.js"

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(getMemorySearchManager).mockResolvedValue({
		manager,
		error: null,
	} as never)
})

describe("unified state total failure", () => {
	it("rejects with the three exact reasons in lane order after all lanes settle", async () => {
		const reasons = [
			new Error("profile-private"),
			"slate-private",
			new TypeError("bundle-private"),
		]
		manager.synthesizeProfile.mockRejectedValue(reasons[0])
		manager.hydrateActiveSlate.mockRejectedValue(reasons[1])
		manager.buildContextBundle.mockRejectedValue(reasons[2])
		const error = await memongoBridgeGetState({ agentId: "agent" }).catch(
			(reason: unknown) => reason,
		)
		expect(error).toBeInstanceOf(AggregateError)
		if (!(error instanceof AggregateError))
			throw new Error("expected aggregate")
		expect(error.message).toBe("all unified state reads failed")
		expect(error.errors).toEqual(reasons)
		for (const [index, reason] of reasons.entries())
			expect(error.errors[index]).toBe(reason)
		expect(Object.getOwnPropertyDescriptor(error, "errors")?.enumerable).toBe(
			false,
		)
		expect(JSON.stringify(error)).toBe("{}")
		expect(manager.synthesizeProfile).toHaveBeenCalledTimes(1)
		expect(manager.hydrateActiveSlate).toHaveBeenCalledTimes(1)
		expect(manager.buildContextBundle).toHaveBeenCalledTimes(1)
		expect(materializeBlocks).not.toHaveBeenCalled()
	})

	it.each([
		1, 2, 3, 4, 5, 6, 7,
	])("preserves the fulfilled and partial shapes for lane mask %i", async (mask) => {
		const profile = { profile: [] }
		const slate = { items: [] }
		const bundle = { sections: [], metadata: { partial: true } }
		const mocks = [
			manager.synthesizeProfile,
			manager.hydrateActiveSlate,
			manager.buildContextBundle,
		]
		const values = [profile, slate, bundle]
		for (const [index, mock] of mocks.entries()) {
			if (mask & (1 << index)) mock.mockResolvedValue(values[index])
			else mock.mockRejectedValue(new Error("private lane failure"))
		}
		const state = await memongoBridgeGetState({
			agentId: "agent",
			scope: "workspace",
			scopeRef: "workspace:one",
			kbRestricted: true,
		})
		expect(state).toEqual({
			profile: mask & 1 ? profile : {},
			blocks:
				mask & 2
					? blocks
					: { blocks: [], totalTokenBudget: 0, totalActualTokens: 0 },
			bundle: mask & 4 ? bundle : {},
			...(mask === 7 ? {} : { partial: true }),
		})
		for (const mock of mocks)
			expect(mock).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: "workspace",
					scopeRef: "workspace:one",
				}),
			)
		expect(manager.buildContextBundle).toHaveBeenCalledWith(
			expect.objectContaining({ kbRestricted: true }),
		)
		expect(vi.mocked(getMemorySearchManager).mock.calls).toHaveLength(3)
		for (const call of vi.mocked(getMemorySearchManager).mock.calls)
			expect(call[0]).toEqual(expect.objectContaining({ agentId: "agent" }))
	})

	it("keeps startup string failures as plain reasons rather than inventing a driver class", async () => {
		vi.mocked(getMemorySearchManager).mockResolvedValue({
			manager: null,
			error: "private startup failure",
		})
		const error = await memongoBridgeGetState({}).catch(
			(reason: unknown) => reason,
		)
		expect(error).toBeInstanceOf(AggregateError)
		if (!(error instanceof AggregateError))
			throw new Error("expected aggregate")
		expect(error.errors).toHaveLength(3)
		for (const reason of error.errors)
			expect(reason).toEqual(new Error("private startup failure"))
		expect(manager.synthesizeProfile).not.toHaveBeenCalled()
		expect(manager.hydrateActiveSlate).not.toHaveBeenCalled()
		expect(manager.buildContextBundle).not.toHaveBeenCalled()
	})
})
