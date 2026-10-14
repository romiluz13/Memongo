import { describe, expect, it } from "vitest"
import type { BenchmarkScenarioCleanupReport } from "../../packages/memory-engine/src/types.js"
import { buildBenchmarkRunReport } from "./mongodb-benchmark-runner.js"
import { BENCHMARK_SCENARIO_COLLECTION_SUFFIXES } from "./mongodb-manager-benchmark.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"

// Drives the real scenario cleanup against an in-memory fake db: no client,
// no network. Each registered collection's deleteMany outcome is scripted.
const PREFIX = "memongo_bench_cleanup_"
const AGENT = "benchmark-agent-1"
const CANARY = "mongodb+srv://cnryUser:cnryPass@cleanup.invalid"

type Behavior =
	| { kind: "ack"; deletedCount: number }
	| { kind: "unack" }
	| { kind: "reject"; error: unknown }

function fakeDb(behaviors: Record<string, Behavior> = {}) {
	const calls: Array<{ collection: string; filter: unknown }> = []
	const db = {
		collection: (name: string) => ({
			deleteMany: async (filter: unknown) => {
				calls.push({ collection: name, filter })
				const behavior = behaviors[name.slice(PREFIX.length)] ?? {
					kind: "ack",
					deletedCount: 1,
				}
				if (behavior.kind === "reject") throw behavior.error
				if (behavior.kind === "unack")
					return { acknowledged: false, deletedCount: 0 }
				return { acknowledged: true, deletedCount: behavior.deletedCount }
			},
		}),
	}
	return { db, calls }
}

function cleanup(behaviors?: Record<string, Behavior>) {
	const { db, calls } = fakeDb(behaviors)
	const ops = new MongoDBManagerBenchmarkScenarioOps({
		db,
		prefix: PREFIX,
	} as never)
	return { run: () => ops.cleanupBenchmarkScenarioData(AGENT), calls }
}

function driverError(message: string, code?: number) {
	const error = new Error(message) as Error & { code?: number }
	error.name = "MongoServerError"
	if (code !== undefined) error.code = code
	return error
}

describe("cleanupBenchmarkScenarioData", () => {
	it("reports every registered collection acknowledged on success", async () => {
		const { run, calls } = cleanup()
		const attempt = await run()
		expect(attempt.status).toBe("acknowledged")
		expect(attempt.agentId).toBe(AGENT)
		expect(attempt.registry.collections).toBe(
			BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.length,
		)
		expect(attempt.collections.map((entry) => entry.suffix)).toEqual([
			...BENCHMARK_SCENARIO_COLLECTION_SUFFIXES,
		])
		expect(
			attempt.collections.every((entry) => entry.status === "acknowledged"),
		).toBe(true)
		expect(calls).toHaveLength(BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.length)
		for (const call of calls) expect(call.filter).toEqual({ agentId: AGENT })
	})

	it("fails when one registered delete rejects, naming only that collection", async () => {
		const { run } = cleanup({
			memory_jobs: { kind: "reject", error: driverError(CANARY, 11600) },
		})
		const attempt = await run()
		expect(attempt.status).toBe("failed")
		expect(
			attempt.collections.filter((entry) => entry.status !== "acknowledged"),
		).toEqual([
			{
				suffix: "memory_jobs",
				status: "rejected",
				errorName: "MongoServerError",
				errorCode: 11600,
			},
		])
		expect(JSON.stringify(attempt)).not.toContain("cnry")
	})

	it("fails when every registered delete rejects", async () => {
		const behaviors = Object.fromEntries(
			BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map((suffix) => [
				suffix,
				{ kind: "reject", error: "plain string rejection" } as Behavior,
			]),
		)
		const attempt = await cleanup(behaviors).run()
		expect(attempt.status).toBe("failed")
		expect(attempt.collections.map((entry) => entry.status)).toEqual(
			BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map(() => "rejected"),
		)
		expect(attempt.collections[0]).toEqual({
			suffix: "events",
			status: "rejected",
			errorName: "unknown",
		})
	})

	it("never counts a fulfilled but unacknowledged delete as success", async () => {
		const attempt = await cleanup({ events: { kind: "unack" } }).run()
		expect(attempt.status).toBe("failed")
		expect(attempt.collections[0]).toEqual({
			suffix: "events",
			status: "unacknowledged",
		})
	})

	it("records acknowledged deletedCount as operation evidence only", async () => {
		const attempt = await cleanup({
			events: { kind: "ack", deletedCount: 0 },
		}).run()
		expect(attempt.status).toBe("acknowledged")
		expect(attempt.collections[0]).toEqual({
			suffix: "events",
			status: "acknowledged",
			deletedCount: 0,
		})
	})
})

function reportWith(scenarioCleanup?: BenchmarkScenarioCleanupReport) {
	return buildBenchmarkRunReport({
		datasetVersion: "dataset-v1",
		cases: 1,
		hitRate: 1,
		emptyRate: 0,
		avgTopScore: 1,
		p95LatencyMs: 1,
		...(scenarioCleanup ? { scenarioCleanup } : {}),
	})
}

function outcome(
	scenarioId: string,
	status: "acknowledged" | "failed" | "retained" | "not-attempted",
) {
	return {
		version: 1 as const,
		runId: "run-1",
		scenarioId,
		agentId: `agent-${scenarioId}`,
		status,
		registry: { version: 1 as const, digest: "f".repeat(64), collections: 1 },
		collections:
			status === "acknowledged"
				? [
						{
							suffix: "events",
							status: "acknowledged" as const,
							deletedCount: 1,
						},
					]
				: status === "failed"
					? [
							{
								suffix: "events",
								status: "rejected" as const,
								errorName: "MongoServerError",
							},
						]
					: [],
	}
}

function cleanupGate(scenarioCleanup?: BenchmarkScenarioCleanupReport) {
	const report = reportWith(scenarioCleanup)
	return {
		report,
		gate: report.releaseGates.find(
			(entry) => entry.gate === "scenario-cleanup",
		),
	}
}

describe("scenario-cleanup release gate", () => {
	it("passes only acknowledged cleanup and labels its limited coverage", () => {
		const { report, gate } = cleanupGate({
			version: 1,
			status: "acknowledged",
			coverage: "registered-scenario-collections",
			scenarios: [outcome("s1", "acknowledged")],
		})
		expect(gate?.status).toBe("passed")
		expect(gate?.evidence).toContain("registered collections only")
		expect(gate?.evidence).toContain("does not prove")
		expect(report.publicationDecision.blockingGates).not.toContain(
			"scenario-cleanup",
		)
		expect(report.scenarioCleanup?.status).toBe("acknowledged")
	})

	it("fails and blocks publication on any failed scenario cleanup", () => {
		const { report, gate } = cleanupGate({
			version: 1,
			status: "failed",
			coverage: "registered-scenario-collections",
			scenarios: [outcome("s1", "acknowledged"), outcome("s2", "failed")],
		})
		expect(gate).toMatchObject({ status: "failed" })
		expect(gate?.evidence).toContain("s2")
		expect(report.publicationDecision.publishable).toBe(false)
		expect(report.publicationDecision.failedGates).toContain("scenario-cleanup")
	})

	it.each([
		["retained (KEEP)", outcome("s1", "retained")],
		["not attempted", outcome("s1", "not-attempted")],
		["unknown legacy", { scenarioId: "s1", status: "unknown" as const }],
	])("blocks publication when cleanup is %s", (_name, entry) => {
		const { report, gate } = cleanupGate({
			version: 1,
			status: "incomplete",
			coverage: "registered-scenario-collections",
			scenarios: [entry],
		})
		expect(gate?.status).toBe("not-run")
		expect(report.publicationDecision.blockingGates).toContain(
			"scenario-cleanup",
		)
	})

	it("blocks publication when no cleanup outcome exists (old report input)", () => {
		const { report, gate } = cleanupGate()
		expect(gate?.status).toBe("not-run")
		expect(gate?.evidence).toContain("unknown")
		expect(report.publicationDecision.blockingGates).toContain(
			"scenario-cleanup",
		)
	})
})
