import { afterEach, describe, expect, it, vi } from "vitest"
import type { BenchmarkScenarioCleanupReport } from "../../packages/memory-engine/src/types.js"
import {
	cleanupRegistry,
	restoreScenarioCleanup,
} from "./benchmark-scenario-cleanup.js"
import { buildBenchmarkRunReport } from "./mongodb-benchmark-runner.js"
import { BENCHMARK_SCENARIO_COLLECTION_SUFFIXES } from "./mongodb-manager-benchmark.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"

// Drives the real scenario cleanup against an in-memory fake db: no client,
// no network. Each registered collection's deleteMany outcome is scripted.
const PREFIX = "memongo_bench_cleanup_"
const AGENT = "benchmark-agent-1"
const CANARY = "mongodb+srv://cnryUser:cnryPass@cleanup.invalid"
// Shaped like an identifier, so a regex-only name/code filter passes it.
const IDENT_CANARY = "SYNTHETIC_PRIVATE_CANARY_1138"
const REGISTRY = cleanupRegistry(BENCHMARK_SCENARIO_COLLECTION_SUFFIXES)

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
		registry: REGISTRY,
		collections:
			status === "acknowledged" || status === "failed"
				? BENCHMARK_SCENARIO_COLLECTION_SUFFIXES.map((suffix, index) =>
						status === "failed" && index === 0
							? {
									suffix,
									status: "rejected" as const,
									errorName: "MongoServerError",
								}
							: { suffix, status: "acknowledged" as const, deletedCount: 1 },
					)
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

describe("1139.4 corrections", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("R3: keeps only known driver error names and numeric codes in outcome and log", async () => {
		const written: string[] = []
		for (const stream of [process.stdout, process.stderr])
			vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
				written.push(String(chunk))
				return true
			})
		for (const method of ["log", "info", "warn", "error", "debug"] as const)
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				written.push(args.map(String).join(" "))
			})
		const named = new Error(CANARY) as Error & { code?: unknown }
		named.name = IDENT_CANARY
		named.code = IDENT_CANARY
		const known = new Error(CANARY) as Error & { code?: unknown }
		known.name = "MongoServerError"
		known.code = IDENT_CANARY
		const attempt = await cleanup({
			events: { kind: "reject", error: named },
			chunks: { kind: "reject", error: known },
		}).run()
		expect(attempt.collections.slice(0, 2)).toEqual([
			{ suffix: "events", status: "rejected", errorName: "unknown" },
			{ suffix: "chunks", status: "rejected", errorName: "MongoServerError" },
		])
		expect(JSON.stringify(attempt)).not.toContain("CANARY")
		expect(written.join("\n")).not.toContain("CANARY")
		expect(written.join("\n")).not.toContain("cnry")
	})

	it("R3: a fulfilled delete with a negative deletedCount is not acknowledged", async () => {
		const attempt = await cleanup({
			events: { kind: "ack", deletedCount: -1 },
		}).run()
		expect(attempt.status).toBe("failed")
		expect(attempt.collections[0]).toEqual({
			suffix: "events",
			status: "unacknowledged",
		})
	})

	const expected = { runId: "run-1", scenarioId: "s1" }
	type Outcome = ReturnType<typeof outcome>
	it.each([
		[
			"a duplicate suffix replacing another",
			(o: Outcome) => {
				o.collections[1] = { ...o.collections[0] } as never
			},
		],
		[
			"a foreign suffix",
			(o: Outcome) => {
				o.collections[1] = {
					suffix: "foreign_unregistered",
					status: "acknowledged",
					deletedCount: 1,
				} as never
			},
		],
		[
			"a negative deletedCount",
			(o: Outcome) => {
				o.collections[0] = {
					suffix: "events",
					status: "acknowledged",
					deletedCount: -1,
				} as never
			},
		],
		[
			"a null agent",
			(o: Outcome) => {
				o.agentId = null as never
			},
		],
		[
			"an unknown restored error name",
			(o: Outcome) => {
				o.status = "failed"
				o.collections[0] = {
					suffix: "events",
					status: "rejected",
					errorName: IDENT_CANARY,
				} as never
			},
		],
		[
			"a restored string error code",
			(o: Outcome) => {
				o.status = "failed"
				o.collections[0] = {
					suffix: "events",
					status: "rejected",
					errorName: "MongoServerError",
					errorCode: IDENT_CANARY,
				} as never
			},
		],
	])("R1: restores %s as unknown", (_name, corrupt) => {
		const valid = outcome("s1", "acknowledged")
		expect(restoreScenarioCleanup(valid, expected).status).toBe("acknowledged")
		const corrupted = structuredClone(valid)
		corrupt(corrupted)
		const restored = restoreScenarioCleanup(corrupted, expected)
		expect(restored).toEqual({ scenarioId: "s1", status: "unknown" })
		const { gate } = cleanupGate({
			version: 1,
			status: "acknowledged",
			coverage: "registered-scenario-collections",
			scenarios: [restored],
		})
		expect(gate?.status).not.toBe("passed")
	})

	it("R1: restores a valid failed outcome as failed", () => {
		expect(
			restoreScenarioCleanup(outcome("s1", "failed"), expected).status,
		).toBe("failed")
	})

	it.each([
		["an empty acknowledged summary", "empty"],
		["an acknowledged label over a malformed scenario", "malformed"],
		["an acknowledged label over an unknown scenario", "unknown"],
	])("R2: does not pass %s", (_name, kind) => {
		const malformed = { ...outcome("s1", "acknowledged"), collections: [] }
		const scenarios =
			kind === "malformed"
				? [malformed]
				: kind === "unknown"
					? [{ scenarioId: "s1", status: "unknown" as const }]
					: []
		const { report, gate } = cleanupGate({
			version: 1,
			status: "acknowledged",
			coverage: "registered-scenario-collections",
			scenarios,
		})
		expect(gate?.status).toBe("not-run")
		expect(report.publicationDecision.blockingGates).toContain(
			"scenario-cleanup",
		)
	})

	it("R2/R3: the report carries only rebuilt outcomes, never raw input payloads", () => {
		const raw = {
			...outcome("s1", "acknowledged"),
			extra: IDENT_CANARY,
			collections: [],
		}
		const { report } = cleanupGate({
			version: 1,
			status: "acknowledged",
			coverage: "registered-scenario-collections",
			scenarios: [raw as never],
		})
		expect(report.scenarioCleanup).toMatchObject({
			status: "incomplete",
			scenarios: [{ scenarioId: "s1", status: "unknown" }],
		})
		expect(JSON.stringify(report)).not.toContain("CANARY")
	})

	it("R2: an acknowledged label over a failed scenario fails the gate", () => {
		const { gate } = cleanupGate({
			version: 1,
			status: "acknowledged",
			coverage: "registered-scenario-collections",
			scenarios: [outcome("s1", "failed")],
		})
		expect(gate?.status).toBe("failed")
	})
})
