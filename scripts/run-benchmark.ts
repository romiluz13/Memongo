#!/usr/bin/env bun
/**
 * Runs the LongMemEval benchmark through the shipped retrieval pipeline and
 * reports the result against the registered release quality contract.
 *
 *   bun run benchmark                 # full run, contract enforced, publishable
 *   bun run benchmark --sample 5      # subset smoke run, NOT publishable
 *   bun run benchmark --json          # machine-readable envelope on stdout
 *
 * Requires MEMONGO_MONGODB_URI. A full run ingests ~23,900 conversations with
 * server-side embedding, so it costs real cluster time and real embedding
 * tokens — hence the sample mode for validating the wiring first.
 *
 * Two properties make the output worth publishing, and both are enforced here
 * rather than documented and hoped for:
 *
 *   1. The dataset is verified byte-for-byte against the digest pinned in the
 *      release contract, which is the official public artifact. A reader can
 *      obtain the same bytes and the contract refuses to run against others.
 *   2. The run executes the SHIPPED profile. The diagnostic profile writes
 *      evidence documents and runs an enrichment pass that production never
 *      performs, and the shipped scorer then boosts exactly those documents.
 *      Numbers from that profile are not comparable to product behavior.
 */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import {
	memongoBridgeGetManager,
	memongoBridgeShutdown,
} from "@memongo/memory-bridge"
import { LONGMEMEVAL_RELEASE_V1 } from "./benchmark/benchmark-quality-contracts.js"
import { MongoDBManagerBenchmarkOps } from "./benchmark/mongodb-manager-benchmark.js"

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
)
const DATA_DIR = path.join(REPO_ROOT, "benchmarks", "data")
const DATASET = path.join(DATA_DIR, "longmemeval_s_cleaned.json")

function fail(message: string): never {
	console.error(`\n✗ ${message}\n`)
	process.exit(1)
}

function parseArgs() {
	const argv = process.argv.slice(2)
	const sampleFlag = argv.indexOf("--sample")
	const sample =
		sampleFlag >= 0 ? Number.parseInt(argv[sampleFlag + 1] ?? "", 10) : 0
	if (sampleFlag >= 0 && (!Number.isFinite(sample) || sample <= 0)) {
		fail("--sample requires a positive integer")
	}
	return { sample, json: argv.includes("--json") }
}

async function sha256OfFile(filePath: string): Promise<string> {
	const hash = createHash("sha256")
	await pipeline(createReadStream(filePath), hash)
	return hash.digest("hex")
}

/**
 * Writes the first N questions to a separate file for smoke runs.
 *
 * A subset necessarily hashes differently from the pinned artifact, so the
 * release contract cannot apply to it — which is correct, and why sample runs
 * are reported as not publishable rather than quietly compared to thresholds
 * calibrated on the full set.
 */
async function writeSample(count: number): Promise<string> {
	const raw = await readFile(DATASET, "utf8")
	const parsed = JSON.parse(raw) as unknown[]
	if (!Array.isArray(parsed)) {
		fail("dataset is not a JSON array of questions")
	}
	const subset = parsed.slice(0, count)
	const target = path.join(DATA_DIR, `longmemeval_sample_${count}.json`)
	await writeFile(target, JSON.stringify(subset), "utf8")
	return target
}

/**
 * #70: execute the conversation-recall regression suite for real and report
 * its outcome, so the release gate reflects THIS invocation instead of a
 * hard-coded "not-run" that made `publishable` structurally impossible.
 */
async function runRecallRegressionSuite(): Promise<{
	status: "passed" | "failed"
	evidence: string
}> {
	const engineDir = path.join(REPO_ROOT, "packages", "memory-engine")
	const proc = Bun.spawnSync(
		[
			"bunx",
			"vitest",
			"run",
			"src/mongodb-conversation-recall-benchmark.test.ts",
		],
		{ cwd: engineDir, stdout: "pipe", stderr: "pipe" },
	)
	const output = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`
	const testsLine =
		output
			.split("\n")
			.find((line) => line.includes("Tests"))
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes from vitest output
			?.replace(/\x1b\[[0-9;]*m/g, "")
			.trim() ?? "test summary unavailable"
	return proc.exitCode === 0
		? {
				status: "passed",
				evidence: `vitest run mongodb-conversation-recall-benchmark.test.ts: ${testsLine}`,
			}
		: {
				status: "failed",
				evidence: `vitest run mongodb-conversation-recall-benchmark.test.ts exited ${proc.exitCode}: ${testsLine}`,
			}
}

async function main(): Promise<void> {
	const { sample, json } = parseArgs()

	if (!process.env.MEMONGO_MONGODB_URI?.trim()) {
		fail(
			"MEMONGO_MONGODB_URI is not set.\n" +
				"  The benchmark runs against a real cluster; there is no offline mode.",
		)
	}

	let datasetPath = DATASET
	try {
		const digest = await sha256OfFile(DATASET)
		if (digest !== LONGMEMEVAL_RELEASE_V1.datasetSha256) {
			fail(
				`dataset digest does not match the release contract\n` +
					`    expected ${LONGMEMEVAL_RELEASE_V1.datasetSha256}\n` +
					`    received ${digest}\n` +
					"  Re-fetch with: bun run benchmark:fetch",
			)
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			fail("dataset not found.\n  Fetch it first with: bun run benchmark:fetch")
		}
		throw err
	}

	const publishable = sample === 0
	if (!publishable) {
		datasetPath = await writeSample(sample)
	}

	console.log("")
	console.log(`profile     : shipped`)
	console.log(`dataset     : ${path.relative(REPO_ROOT, datasetPath)}`)
	console.log(
		`scope       : ${publishable ? "full (500 questions)" : `sample of ${sample}`}`,
	)
	console.log(
		`contract    : ${publishable ? `${LONGMEMEVAL_RELEASE_V1.thresholds.contractId}@${LONGMEMEVAL_RELEASE_V1.thresholds.version}` : "none — SAMPLE RUNS ARE NOT PUBLISHABLE"}`,
	)
	console.log("")

	const recallRegression = await runRecallRegressionSuite()
	console.log(
		`recall gate : ${recallRegression.status} — ${recallRegression.evidence}`,
	)
	console.log("")

	const started = Date.now()
	const manager = await memongoBridgeGetManager()
	const result = await new MongoDBManagerBenchmarkOps(
		manager,
	).relevanceBenchmark({
		datasetPath,
		// The contract binds thresholds to the dataset digest, so it can only be
		// applied to the full artifact it pins.
		...(publishable
			? { qualityThresholds: LONGMEMEVAL_RELEASE_V1.thresholds }
			: {}),
		conversationRecallRegression: recallRegression,
	})
	const elapsedSec = ((Date.now() - started) / 1000).toFixed(1)

	if (json) {
		console.log(JSON.stringify(result, null, 2))
		console.log(`\nelapsed: ${elapsedSec}s`)
		if (!publishable) {
			return
		}
		if (result.benchmarkReport?.publicationDecision?.publishable === false) {
			process.exit(1)
		}
		return
	}

	console.log("metrics")
	console.log(`  cases          : ${result.cases}`)
	console.log(`  scoredCases    : ${result.scoredCases ?? "n/a"}`)
	console.log(`  hitRate        : ${result.hitRate.toFixed(4)}`)
	console.log(`  emptyRate      : ${result.emptyRate.toFixed(4)}`)
	console.log(`  R@5            : ${result.rAt5?.toFixed(4) ?? "n/a"}`)
	console.log(`  nDCG@10        : ${result.ndcgAt10?.toFixed(4) ?? "n/a"}`)
	console.log(`  p95 latency ms : ${result.p95LatencyMs.toFixed(0)}`)
	const laneLatency = Object.entries(result.laneLatencyP95 ?? {}).toSorted(
		([, left], [, right]) => right.p95Ms - left.p95Ms,
	)
	if (laneLatency.length > 0) {
		console.log("  per-lane p95 ms")
		for (const [lane, stats] of laneLatency) {
			console.log(
				`    ${lane.padEnd(24)} ${stats.p95Ms.toFixed(0).padStart(6)}  (${stats.cases} cases)`,
			)
		}
	}
	if (result.officialMetrics) {
		console.log(`  official       : ${JSON.stringify(result.officialMetrics)}`)
	}
	const passes = result.measurementPasses
	if (passes) {
		console.log(
			`  measurement passes (gate = pass ${passes.gatePass}; --json carries per-pass official metrics and lane p95)`,
		)
		for (const sample of passes.samples) {
			console.log(
				`    pass ${String(sample.pass).padStart(2)}${sample.pass === passes.gatePass ? " (gate)" : "       "}  p95 ${sample.p95LatencyMs.toFixed(0).padStart(6)} ms  hitRate ${sample.hitRate.toFixed(4)}  nDCG@10 ${sample.ndcgAt10.toFixed(4)}`,
			)
		}
		console.log(
			`    p95 band          median ${passes.p95LatencyMs.median.toFixed(0)} ms  min ${passes.p95LatencyMs.min.toFixed(0)} ms  max ${passes.p95LatencyMs.max.toFixed(0)} ms  stddev ${passes.p95LatencyMs.stddev.toFixed(0)} ms`,
		)
	}

	const report = result.benchmarkReport
	if (report?.releaseGates?.length) {
		console.log("\nrelease gates")
		for (const gate of report.releaseGates) {
			console.log(`  ${gate.status.padEnd(13)} ${gate.gate}`)
			for (const check of gate.checks ?? []) {
				if (check.passed) {
					continue
				}
				console.log(
					`      ✗ ${check.metric} ${check.actual ?? "null"} ${check.operator} ${check.threshold}`,
				)
			}
		}
	}

	for (const warning of report?.warnings ?? []) {
		console.log(`\n⚠ ${warning}`)
	}

	console.log(`\nelapsed: ${elapsedSec}s`)

	if (!publishable) {
		console.log(
			"\n⚠ sample run — no quality contract applied. Do not publish this number.\n",
		)
		return
	}

	// A gate that cannot fail the command is decoration. Surface the aggregate
	// verdict as the exit code so CI treats a regression as a build failure.
	const decision = report?.publicationDecision
	if (decision?.publishable === false) {
		console.error("\n✗ NOT PUBLISHABLE")
		if (decision.blockingGates?.length) {
			console.error(`    blocking: ${decision.blockingGates.join(", ")}`)
		}
		if (decision.failedGates?.length) {
			console.error(`    failed  : ${decision.failedGates.join(", ")}`)
		}
		console.error("")
		process.exit(1)
	}
	console.log("\n✓ publishable — all release gates passed\n")
}

if (import.meta.main) {
	try {
		await main()
	} finally {
		await memongoBridgeShutdown().catch(() => {})
	}
}
