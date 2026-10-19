import type { Collection, Db } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { resolveConflictedCandidate } from "./mongodb-consolidation-adjudication.js"
import { EnrichmentParseError } from "./mongodb-llm-enrichment.js"
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
const candidate = { key: "relocation", value: "Moves to Paris" }
describe("contradiction provider outcomes", () => {
	it("a well-formed empty verdict is unresolved", async () => {
		const { db } = fixtureDb(),
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
				candidate,
				admission,
			}),
		).toEqual({ resolved: false, invalidatedCount: 0 })
		expect(provider.chatCompletion).toHaveBeenCalledTimes(1)
	})
	for (const withAdmission of [true, false]) {
		const label = withAdmission ? "admitted" : "non-admitted"
		it(`a ${label} provider failure rejects and is never unresolved`, async () => {
			const failure = new Error("owned provider failure"),
				{ db } = fixtureDb(),
				provider = {
					name: "local",
					chatCompletion: vi.fn(async () => {
						throw failure
					}),
				}
			await expect(
				resolveConflictedCandidate({
					db,
					prefix: "test_",
					provider,
					model: "fixture",
					agentId,
					candidate,
					...(withAdmission ? { admission } : {}),
				}),
			).rejects.toBe(failure)
		})
		it(`${label} malformed JSON rejects with a typed parse error and is never unresolved`, async () => {
			const { db } = fixtureDb(),
				provider = {
					name: "local",
					chatCompletion: vi.fn(async () => ({ content: "broken{" })),
				}
			await expect(
				resolveConflictedCandidate({
					db,
					prefix: "test_",
					provider,
					model: "fixture",
					agentId,
					candidate,
					...(withAdmission ? { admission } : {}),
				}),
			).rejects.toBeInstanceOf(EnrichmentParseError)
		})
		it(`a ${label} database read failure rejects before any provider call`, async () => {
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
					candidate,
					...(withAdmission ? { admission } : {}),
				}),
			).rejects.toBe(error)
			expect(provider.chatCompletion).not.toHaveBeenCalled()
		})
	}
})
