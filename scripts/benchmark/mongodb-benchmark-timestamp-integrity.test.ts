import { describe, expect, it, vi } from "vitest"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"
import { testOperationRunContext } from "../../packages/memory-engine/src/test-helpers/manager-test-kit.js"

describe("benchmark timestamp admission across manager paths", () => {
	it("fast ingest refuses a later invalid turn before any collection access", async () => {
		const collection = vi.fn(() => {
			throw new Error("unexpected fake write")
		})
		const ops = new MongoDBManagerBenchmarkScenarioOps({
			db: { collection },
		} as never)
		await expect(
			ops.fastIngestBenchmarkConversations({
				datasetPath: "synthetic.json",
				datasetKind: "longmemeval",
				conversations: [
					{
						turns: [
							{
								role: "user",
								body: "first",
								timestamp: "2024/06/15 (Sat) 14:30",
							},
							{ role: "user", body: "second", timestamp: "invalid" },
						],
					},
				],
			}),
		).rejects.toThrow("timestamp")
		expect(collection).not.toHaveBeenCalled()
	})
	it.each([
		null,
		"",
		"2024/02/30 (Fri) 01:00",
	])("rejects question-date %s before scenario or provider work", async (questionDate) => {
		const ops = new MongoDBManagerBenchmarkOps({} as never)
		const create = vi.spyOn(
			ops as unknown as { createBenchmarkScenarioManager(): never },
			"createBenchmarkScenarioManager",
		)
		await expect(
			ops.runScenarioBenchmarkDataset({
				datasetPath: "synthetic.json",
				datasetVersion: "synthetic",
				maxResults: 1,
				minScore: 0,
				runContext: testOperationRunContext("timestamp-check"),
				dataset: {
					name: "synthetic",
					datasetKind: "longmemeval",
					conversations: [],
					scenarios: [
						{
							scenarioId: "q",
							conversations: [],
							evaluations: [
								{
									caseId: "q",
									query: "synthetic",
									expectedSessionIds: [],
									metadata: { questionDate },
								},
							],
						},
					],
				},
			}),
		).rejects.toThrow("timestamp")
		expect(create).not.toHaveBeenCalled()
	})
})
