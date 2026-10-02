import type { Collection, Db } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { resolveConflictedCandidate } from "./mongodb-consolidation-adjudication.js"
const agentId = "fixture-agent",
	admission = { kind: "admission" as const, agentId, epoch: 0 }
function fixtureDb(failure?: Error) {
	const toArray = vi.fn(async () => {
		if (failure) throw failure
		return [{ key: "city", value: "Lives in London" }]
	})
	const collection = {
		find: vi.fn(() => ({ sort: () => ({ limit: () => ({ toArray }) }) })),
	} as unknown as Collection
	return {
		db: { collection: vi.fn(() => collection) } as unknown as Db,
		toArray,
	}
}
describe("admitted contradiction conservative provider outcomes", () => {
	for (const [label, response] of [
		[
			"provider failure",
			async () => {
				throw new Error("owned provider failure")
			},
		],
		["malformed JSON", async () => ({ content: "broken{" })],
		["no contradiction", async () => ({ content: '{"contradictions":[]}' })],
	] as const) {
		it(label, async () => {
			const { db } = fixtureDb(),
				provider = { name: "local", chatCompletion: vi.fn(response) }
			expect(
				await resolveConflictedCandidate({
					db,
					prefix: "test_",
					provider,
					model: "fixture",
					agentId,
					candidate: { key: "relocation", value: "Moves to Paris" },
					admission,
				}),
			).toEqual({ resolved: false, invalidatedCount: 0 })
			expect(provider.chatCompletion).toHaveBeenCalledTimes(1)
		})
	}
	it("keeps a non-admitted database read failure conservative", async () => {
		const error = new Error("owned database read failure"),
			{ db } = fixtureDb(error),
			provider = {
				name: "local",
				chatCompletion: vi.fn(async () => ({
					content: '{"contradictions":[]}',
				})),
			}
		expect(
			await resolveConflictedCandidate({
				db,
				prefix: "test_",
				provider,
				model: "fixture",
				agentId,
				candidate: { key: "relocation", value: "Moves to Paris" },
			}),
		).toEqual({ resolved: false, invalidatedCount: 0 })
		expect(provider.chatCompletion).not.toHaveBeenCalled()
	})
	it("propagates an admitted database read failure before provider calls", async () => {
		const error = new Error("owned database read failure"),
			{ db } = fixtureDb(error),
			provider = {
				name: "local",
				chatCompletion: vi.fn(async () => ({
					content: '{"contradictions":[]}',
				})),
			}
		await expect(
			resolveConflictedCandidate({
				db,
				prefix: "test_",
				provider,
				model: "fixture",
				agentId,
				candidate: { key: "relocation", value: "Moves to Paris" },
				admission,
			}),
		).rejects.toBe(error)
		expect(provider.chatCompletion).not.toHaveBeenCalled()
	})
})
