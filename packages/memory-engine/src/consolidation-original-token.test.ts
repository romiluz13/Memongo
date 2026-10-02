import type { Db } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import {
	beginErasure,
	captureAdmissionToken,
	readErasureGate,
	type AdmissionToken,
} from "./mongodb-write-fence.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const provider = vi.hoisted(() => vi.fn(() => null))
vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => false,
	resolveEnrichmentProvider: provider,
}))
beforeEach(() => provider.mockClear())
describe("consolidation supplied original admission", () => {
	it.each([
		{ kind: "admission", agentId: "other", epoch: 0 },
		{ kind: "erasure", agentId: "agent1", epoch: 0 },
		{ kind: "admission", agentId: "agent1", epoch: -1 },
		{ kind: "admission", agentId: "agent1", epoch: 1.5 },
		{ kind: "admission", agentId: "agent1", epoch: Number.NaN },
		{ kind: "admission", agentId: "agent1", epoch: Number.POSITIVE_INFINITY },
		{ kind: "admission", agentId: "agent1", epoch: "0" },
		null,
	])("rejects an invalid supplied token before provider or database effects: %j", async (admission) => {
		const collection = vi.fn(() => {
			throw new Error("unexpected database access")
		})
		await expect(
			consolidateMemory({
				db: { collection } as unknown as Db,
				prefix: "test_",
				agentId: "agent1",
				admission: admission as AdmissionToken,
			}),
		).rejects.toThrow(TypeError)
		expect(provider).not.toHaveBeenCalled()
		expect(collection).not.toHaveBeenCalled()
	})
	it("reuses a matching supplied token and passes the session to the claim", async () => {
		const f = createStatefulMongoFake()
		const admission = await captureAdmissionToken({
			db: f.db,
			prefix: "test_",
			agentId: "agent1",
		})
		const meta = f.collection("meta")
		const capture = vi.spyOn(meta, "findOneAndUpdate")
		const runs = f.collection("consolidation_runs")
		const claim = vi.spyOn(runs, "findOneAndUpdate")
		await consolidateMemory({
			db: f.db,
			prefix: "test_",
			agentId: "agent1",
			admission,
		})
		expect(capture).not.toHaveBeenCalled()
		expect(claim).toHaveBeenCalledExactlyOnceWith(
			expect.any(Object),
			expect.any(Array),
			expect.objectContaining({
				session: f.db.client.startSession(),
				upsert: true,
			}),
		)
		expect(
			await readErasureGate({ db: f.db, prefix: "test_", agentId: "agent1" }),
		).toMatchObject({ epoch: 0, state: "open", serial: 1 })
	})
	it("rejects a supplied stale epoch rather than capturing a fresh one", async () => {
		const f = createStatefulMongoFake()
		const admission = await captureAdmissionToken({
			db: f.db,
			prefix: "test_",
			agentId: "agent1",
		})
		await beginErasure({ db: f.db, prefix: "test_", agentId: "agent1" })
		const capture = vi.spyOn(f.collection("meta"), "findOneAndUpdate")
		await expect(
			consolidateMemory({
				db: f.db,
				prefix: "test_",
				agentId: "agent1",
				admission,
			}),
		).rejects.toMatchObject({ code: "ERASURE_GATE_CONFLICT" })
		expect(capture).not.toHaveBeenCalled()
		expect(f.all("consolidation_runs")).toEqual([])
	})
})
