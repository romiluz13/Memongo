import { describe, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { beginErasure, readErasureGate } from "./mongodb-write-fence.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const provider = vi.hoisted(() => vi.fn(() => null))
vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => false,
	resolveEnrichmentProvider: provider,
}))
describe("consolidation entry admission", () => {
	it("rejects an erasing agent before provider, lease and source effects", async () => {
		const f = createStatefulMongoFake()
		await beginErasure({ db: f.db, prefix: "test_", agentId: "agent1" })
		provider.mockClear()
		await expect(
			consolidateMemory({ db: f.db, prefix: "test_", agentId: "agent1" }),
		).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
		expect(provider).not.toHaveBeenCalled()
		expect(f.all("consolidation_runs")).toEqual([])
	})
	it("validates maxEvents before even initializing admission", async () => {
		const f = createStatefulMongoFake()
		provider.mockClear()
		await expect(
			consolidateMemory({
				db: f.db,
				prefix: "test_",
				agentId: "agent1",
				options: { maxEvents: 0 },
			}),
		).rejects.toThrow("maxEvents must be a positive integer")
		expect(
			await readErasureGate({ db: f.db, prefix: "test_", agentId: "agent1" }),
		).toBeNull()
		expect(provider).not.toHaveBeenCalled()
		expect(f.all("consolidation_runs")).toEqual([])
	})
	it("initializes an open entry gate for an ordinary empty run", async () => {
		const f = createStatefulMongoFake()
		const result = await consolidateMemory({
			db: f.db,
			prefix: "test_",
			agentId: "agent1",
		})
		expect(result.eventsProcessed).toBe(0)
		expect(
			await readErasureGate({ db: f.db, prefix: "test_", agentId: "agent1" }),
		).toMatchObject({ state: "open", epoch: 0, serial: 1 })
	})
})
