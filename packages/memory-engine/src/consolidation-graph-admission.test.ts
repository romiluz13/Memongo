import type { ClientSession } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { consolidateMemory } from "./mongodb-consolidator.js"
import {
	ErasureGateConflictError,
	MalformedGateError,
} from "./mongodb-erasure-epoch.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const mocks = vi.hoisted(() => ({
	graph: vi.fn(),
	projection: vi.fn(),
	telemetry: vi.fn(),
}))
vi.mock("./mongodb-graph.js", () => ({ extractAndUpsertEntities: mocks.graph }))
vi.mock("./mongodb-ops.js", () => ({ recordProjectionRun: mocks.projection }))
vi.mock("./mongodb-telemetry.js", () => ({ emitTelemetry: mocks.telemetry }))
vi.mock("./mongodb-llm-enrichment.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-llm-enrichment.js")>()),
	isExtractionLlmDisabled: () => true,
}))
vi.mock("./mongodb-novelty.js", () => ({
	scanNovelty: vi.fn(async () => ({ events: [], scannedCount: 0 })),
}))

beforeEach(() => {
	vi.clearAllMocks()
	mocks.graph.mockResolvedValue({
		entities: [],
		relationsCreated: 0,
		diagnostics: {
			durationMs: 0,
			extractionMethod: "regex",
			entitiesExtracted: 0,
			relationsCreated: 0,
		},
	})
	mocks.projection.mockResolvedValue("run")
	mocks.telemetry.mockResolvedValue(undefined)
})
async function fixture() {
	const f = createStatefulMongoFake()
	for (const eventId of ["event1", "event2"])
		await f.collection("events").insertOne({
			eventId,
			agentId: "agent1",
			body: "lowercase meeting notes",
			timestamp: new Date(),
			role: "user",
			importance: 1,
		})
	return {
		f,
		run: () =>
			consolidateMemory({
				db: f.db,
				prefix: "test_",
				agentId: "agent1",
				options: { minIntervalMs: 0, minCombinedScore: 0 },
			}),
	}
}
describe("graph admission composition", () => {
	it("awaits events sequentially and passes the session while suppressing helper diagnostics", async () => {
		const { f, run } = await fixture()
		let release = () => {}
		let reached = () => {}
		const paused = new Promise<void>((resolve) => {
			reached = resolve
		})
		const resume = new Promise<void>((resolve) => {
			release = resolve
		})
		mocks.graph.mockImplementationOnce(async () => {
			reached()
			await resume
			return {
				entities: [],
				relationsCreated: 0,
				diagnostics: {
					durationMs: 0,
					extractionMethod: "regex",
					entitiesExtracted: 0,
					relationsCreated: 0,
				},
			}
		})
		const running = run()
		try {
			await paused
			expect(mocks.graph).toHaveBeenCalledTimes(1)
			expect(mocks.projection).not.toHaveBeenCalled()
		} finally {
			release()
			await running
		}
		expect(mocks.graph).toHaveBeenCalledTimes(2)
		for (const [params] of mocks.graph.mock.calls)
			expect(params).toMatchObject({
				session: f.db.client.startSession() as ClientSession,
				recordRun: false,
			})
		expect(mocks.projection).toHaveBeenCalledTimes(4)
		expect(mocks.telemetry).not.toHaveBeenCalled()
	})
	it.each([
		new ErasureGateConflictError("agent1"),
		new MalformedGateError("agent1", "invalid gate"),
	])("propagates a typed graph error without diagnostics or the next event: %s", async (error) => {
		const { f, run } = await fixture()
		mocks.graph.mockRejectedValueOnce(error)
		await expect(run()).rejects.toBe(error)
		expect(mocks.graph).toHaveBeenCalledTimes(1)
		expect(mocks.projection).not.toHaveBeenCalled()
		expect(mocks.telemetry).not.toHaveBeenCalled()
		expect(
			f.all("events").every((event) => event.dreamerProcessedAt === undefined),
		).toBe(true)
	})
	it.each([
		new ErasureGateConflictError("agent1"),
		new MalformedGateError("agent1", "invalid gate"),
	])("propagates a typed diagnostic error before the next event: %s", async (error) => {
		const { f, run } = await fixture()
		mocks.projection.mockRejectedValueOnce(error)
		await expect(run()).rejects.toBe(error)
		expect(mocks.graph).toHaveBeenCalledTimes(1)
		expect(mocks.projection).toHaveBeenCalledTimes(1)
		expect(mocks.telemetry).not.toHaveBeenCalled()
		expect(
			f.all("events").every((event) => event.dreamerProcessedAt === undefined),
		).toBe(true)
	})
})
