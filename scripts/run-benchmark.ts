#!/usr/bin/env bun
/**
 * Runs the LongMemEval benchmark through the shipped retrieval pipeline and
 * reports the result against the registered release quality contract.
 *
 *   bun run benchmark                 # full run, contract enforced, publishable
 *   bun run benchmark --sample 5      # subset smoke run, NOT publishable
 *   bun run benchmark --questions benchmarks/data/longmemeval_b2_frozen50_dataset.json
 *                                     # frozen subset run (B2 loop), NOT publishable
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
import { spawnSync } from "node:child_process"
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
import { LONGMEMEVAL_RELEASE_V2 } from "./benchmark/benchmark-quality-contracts.js"
import { OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL } from "./benchmark/longmemeval-official-qa.js"
import {
	resolveBenchmarkOfficialJudgeProvider,
	resolveBenchmarkQaProtocol,
} from "./benchmark/longmemeval-official-scoring.js"
import {
	benchmarkAnswerModelName,
	resolveBenchmarkAnswerProvider,
} from "./benchmark/benchmark-answer-provider.js"
import { MongoDBManagerBenchmarkOps } from "./benchmark/mongodb-manager-benchmark.js"

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
)
const DATA_DIR = path.join(REPO_ROOT, "benchmarks", "data")
const DATASET = path.join(DATA_DIR, "longmemeval_s_cleaned.json")

export function includeBenchmarkAllowedRoot(
	current: string | undefined,
	requiredRoot: string,
): string {
	const roots = (current ?? "")
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean)
	const resolvedRequiredRoot = path.resolve(requiredRoot)
	if (roots.some((entry) => path.resolve(entry) === resolvedRequiredRoot)) {
		return roots.join(path.delimiter)
	}
	return [...roots, resolvedRequiredRoot].join(path.delimiter)
}

/**
 * Publishable runs gate on LLM-judged answer accuracy, which requires a judge
 * model DISTINCT from the answer model on the same provider (a model grading
 * its own answers is self-judging). Pure env read: returns the refusal
 * message when the judge config cannot satisfy the contract, null when it
 * can. Checked BEFORE dataset ingest so a misconfigured run fails in seconds
 * instead of after a multi-hour ingest+eval that would end unpublishable.
 */
export function benchmarkJudgeConfigError(
	env: Record<string, string | undefined>,
): string | null {
	const answerModel = benchmarkAnswerModelName(env)
	const judgeModel = env.MEMONGO_BENCHMARK_JUDGE_MODEL?.trim() ?? ""
	if (!judgeModel) {
		return (
			"MEMONGO_BENCHMARK_JUDGE_MODEL is not set: a judge model distinct " +
			"from the answer model is required for a publishable run"
		)
	}
	if (answerModel && judgeModel === answerModel) {
		return (
			"MEMONGO_BENCHMARK_JUDGE_MODEL must differ from the benchmark answer model " +
			"(MEMONGO_BENCHMARK_ANSWER_MODEL or the MEMONGO_ENRICHMENT_MODEL fallback): " +
			"a judge cannot grade its own answers"
		)
	}
	return null
}

/**
 * Slice C: the default full500 run is the OFFICIAL QA protocol, so it must be
 * opted into explicitly — this command never sets the protocol env for the
 * user, so manager behavior always matches user-visible env. A custom-judge
 * full500 run (non-official judge such as gpt-5.6-luna) is permitted through
 * the same durable machinery with the same checkpoint/distinct-judge
 * requirements, but its results are non-official by construction. Pure env
 * read (the judge resolver does no network work): returns the refusal
 * message when the configuration cannot be a durable publishable run, null
 * when it can. Checked BEFORE dataset ingest, provider resolution, and
 * manager acquisition so a misconfigured run fails in seconds instead of
 * after a multi-hour ingest that would end unpublishable.
 */
export function benchmarkOfficialFullRunError(
	env: Record<string, string | undefined>,
	options: { checkpointDisabled: boolean },
): string | null {
	let protocol: ReturnType<typeof resolveBenchmarkQaProtocol>
	try {
		protocol = resolveBenchmarkQaProtocol(env)
	} catch (error) {
		// Unknown protocol values are refused with the resolver's own message.
		return error instanceof Error ? error.message : String(error)
	}
	if (protocol === "custom-judge") {
		// Custom-judge full runs go through the same durable scoring path
		// (sidecar, checkpoint gating, summary) with a non-official judge, so
		// the same crash-safety and distinct-judge contracts apply.
		if (options.checkpointDisabled) {
			return (
				"MEMONGO_BENCHMARK_QA_PROTOCOL=custom-judge requires checkpointPath: " +
				"predictions must persist beside the checkpoint for crash-safe resume"
			)
		}
		const answerModel = benchmarkAnswerModelName(env)
		const judgeModel = env.MEMONGO_BENCHMARK_JUDGE_MODEL?.trim() ?? ""
		if (answerModel && judgeModel && judgeModel === answerModel) {
			return (
				"custom-judge QA mode requires a judge model distinct from the answer model " +
				`(both are ${answerModel}); self-judging is not comparable to the official protocol`
			)
		}
		try {
			resolveBenchmarkOfficialJudgeProvider(env, "custom-judge")
		} catch (error) {
			// Missing judge env; the custom-judge resolver does not pin a model.
			return error instanceof Error ? error.message : String(error)
		}
		return null
	}
	if (protocol !== "official") {
		return (
			"full500 publishable runs require MEMONGO_BENCHMARK_QA_PROTOCOL=official; " +
			"custom-v1 judged answers are not the official protocol"
		)
	}
	if (options.checkpointDisabled) {
		return (
			"MEMONGO_BENCHMARK_QA_PROTOCOL=official requires checkpointPath: " +
			"predictions must persist beside the checkpoint for crash-safe resume"
		)
	}
	// Judge==answer distinctness first: a pure env comparison, so even a
	// self-judging misconfiguration that would also fail the pinned-model
	// check refuses with the official preflight's exact wording.
	const answerModel = benchmarkAnswerModelName(env)
	const judgeModel = env.MEMONGO_BENCHMARK_JUDGE_MODEL?.trim() ?? ""
	if (answerModel && judgeModel && judgeModel === answerModel) {
		return (
			"official QA mode requires a judge model distinct from the answer model " +
			`(both are ${answerModel}); self-judging is not comparable to the official protocol`
		)
	}
	try {
		resolveBenchmarkOfficialJudgeProvider(env)
	} catch (error) {
		// Missing judge env or a model other than the pinned official judge.
		return error instanceof Error ? error.message : String(error)
	}
	return null
}

/**
 * Slice C (C3): official runs are judged by the pinned official judge model,
 * which differs from the run's answer model — so the number is NOT an
 * identical-model head-to-head against competitors that answer with GPT-4o.
 * Returns the disclosure line when the run carries an official QA summary
 * (canonical location: officialMetrics.longMemEval.answerQuality.official),
 * null otherwise. Never claims an identical-model comparison.
 */
export function officialModelDifferenceDisclosure(answerQuality: {
	answerModel: string | null
	official?: unknown
}): string | null {
	if (!answerQuality.official) {
		return null
	}
	const answerModel = answerQuality.answerModel ?? "unavailable"
	return (
		`official answer model ${answerModel} is judged by the pinned official judge ` +
		`${OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL}: the models differ, so this is not an ` +
		"identical-model head-to-head against GPT-4o-answer competitors"
	)
}

/**
 * Custom-judge integration: custom-judge runs are judged by a separately
 * configured NON-OFFICIAL judge model (for example gpt-5.6-luna), so the
 * published accuracy is explicitly not an official-protocol number. Returns
 * the disclosure line when the run carries a customJudge QA summary
 * (canonical location: officialMetrics.longMemEval.answerQuality.customJudge),
 * null otherwise. Never claims official provenance.
 */
export function customJudgeDifferenceDisclosure(answerQuality: {
	answerModel: string | null
	customJudge?: { judgeModel?: string | null } | unknown
}): string | null {
	if (!answerQuality.customJudge) {
		return null
	}
	const answerModel = answerQuality.answerModel ?? "unavailable"
	const summary = answerQuality.customJudge as { judgeModel?: unknown }
	const judgeModel =
		typeof summary.judgeModel === "string" ? summary.judgeModel : "unavailable"
	return (
		`custom-judge (non-official) run: answer model ${answerModel} is judged by ` +
		`${judgeModel} under the custom-judge protocol; this is NOT the official ` +
		"LongMemEval protocol number (the judge is not the pinned official judge)"
	)
}

function fail(message: string): never {
	console.error(`\n✗ ${message}\n`)
	process.exit(1)
}

function parseArgs(argv: string[] = process.argv.slice(2)) {
	const sampleFlag = argv.indexOf("--sample")
	const sample =
		sampleFlag >= 0 ? Number.parseInt(argv[sampleFlag + 1] ?? "", 10) : 0
	if (sampleFlag >= 0 && (!Number.isFinite(sample) || sample <= 0)) {
		fail("--sample requires a positive integer")
	}
	const questionsFlag = argv.indexOf("--questions")
	const questionsArgument = argv[questionsFlag + 1]?.trim()
	if (
		questionsFlag >= 0 &&
		(!questionsArgument || questionsArgument.startsWith("--"))
	) {
		fail("--questions requires a file path")
	}
	if (questionsFlag >= 0 && sampleFlag >= 0) {
		fail("--questions and --sample are mutually exclusive")
	}
	const checkpointFlag = argv.indexOf("--checkpoint")
	const checkpointArgument = argv[checkpointFlag + 1]?.trim()
	if (
		checkpointFlag >= 0 &&
		(!checkpointArgument || checkpointArgument.startsWith("--"))
	) {
		fail("--checkpoint requires a file path")
	}
	const checkpointTarget = argv.includes("--no-checkpoint")
		? undefined
		: checkpointFlag >= 0
			? checkpointArgument
			: path.join(
					"benchmarks",
					"results",
					"checkpoints",
					`longmemeval-${
						sample > 0
							? `sample-${sample}`
							: questionsArgument
								? `questions-${questionsCheckpointStem(questionsArgument)}`
								: "full"
					}.json`,
				)
	const checkpointPath = checkpointTarget
		? path.resolve(REPO_ROOT, checkpointTarget)
		: undefined
	return {
		sample,
		questionsPath:
			questionsFlag >= 0 && questionsArgument
				? path.resolve(REPO_ROOT, questionsArgument)
				: undefined,
		json: argv.includes("--json"),
		resume: argv.includes("--resume"),
		// B7: explicit opt-out of the cross-encoder reranker. Sets
		// MEMONGO_RERANKING_ENABLED=false before the manager exists, so the
		// resolved config disables reranking and the run manifest records the
		// deviation (a rerank-off run must never look identical to a
		// rerank-on run).
		noRerank: argv.includes("--no-rerank"),
		checkpointPath,
	}
}

/**
 * B2: checkpoint stem for a --questions run, derived from the subset file
 * name so two different frozen sets can never share a default checkpoint.
 * Strips the .json extension and any redundant longmemeval[-_] prefix.
 */
export function questionsCheckpointStem(filePath: string): string {
	return path.basename(filePath, ".json").replace(/^longmemeval[-_]/, "")
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
 * B2: a --questions run executes a frozen subset file. The parent dataset
 * digest was already verified above, proving the parent bytes are the
 * official ones; this asserts the subset cannot have drifted from that
 * parent in two steps: every record's question_id must exist in the full
 * set (the failure mode after a dataset re-fetch), and every record must be
 * byte-identical to its parent record (a hand-edited subset fails here). If
 * the file is the frozen-50 materialized dataset, its sha256 must also
 * match the committed identity pin (scripts/benchmark/
 * longmemeval-b2-frozen50.ids.json). The subset file must live under an
 * allowed root (benchmarks/data/ by default) for the manager's dataset
 * path resolution.
 */
export async function assertQuestionsSubsetOfDataset(
	questionsPath: string,
): Promise<void> {
	const [rawSubset, rawFull] = await Promise.all([
		readFile(questionsPath, "utf8"),
		readFile(DATASET, "utf8"),
	])
	const subset = JSON.parse(rawSubset) as unknown[]
	if (!Array.isArray(subset) || subset.length === 0) {
		fail("--questions file is not a non-empty JSON array of questions")
	}
	const full = JSON.parse(rawFull) as unknown[]
	if (!Array.isArray(full)) {
		fail("dataset is not a JSON array of questions")
	}
	const fullById = new Map<string, unknown>()
	for (const entry of full) {
		const id = (entry as { question_id?: unknown }).question_id
		if (typeof id === "string") {
			fullById.set(id, entry)
		}
	}
	for (const entry of subset) {
		const id = (entry as { question_id?: unknown }).question_id
		if (typeof id !== "string" || !fullById.has(id)) {
			fail(
				`--questions file contains a question_id absent from the full dataset: ${String(id)}\n` +
					"  The parent dataset may have been re-fetched; regenerate the frozen\n" +
					"  subset with: bun scripts/benchmark/longmemeval-b2-frozen50.ts",
			)
		}
		// Deep equality against the parent record catches hand-edited subsets
		// that keep valid ids but alter question content.
		const parent = fullById.get(id)
		if (JSON.stringify(entry) !== JSON.stringify(parent)) {
			fail(
				`--questions record ${id} differs from its parent dataset record; a frozen subset must carry the parent bytes unmodified`,
			)
		}
	}
	const frozenPinPath = path.join(
		REPO_ROOT,
		"scripts/benchmark/longmemeval-b2-frozen50.ids.json",
	)
	if (path.basename(questionsPath) === "longmemeval_b2_frozen50_dataset.json") {
		const pin = JSON.parse(await readFile(frozenPinPath, "utf8")) as {
			subsetSha256?: string
		}
		const digest = createHash("sha256")
			.update(await readFile(questionsPath))
			.digest("hex")
		if (pin.subsetSha256 !== digest) {
			fail(
				`--questions file is the frozen-50 materialized dataset but its sha256 ${digest} does not match the committed identity pin ${String(pin.subsetSha256)}; regenerate with: bun scripts/benchmark/longmemeval-b2-frozen50.ts`,
			)
		}
	}
}

/**
 * #70: execute the conversation-recall regression suite for real and report
 * its outcome, so the release gate reflects THIS invocation instead of a
 * hard-coded "not-run" that made `publishable` structurally impossible.
 */
export async function runRecallRegressionSuite(): Promise<{
	status: "passed" | "failed"
	evidence: string
}> {
	// Lead-reproduced blocker: a bare file filter also matched broken
	// platform-baseline copies under .orchestrator/ worktrees (they cannot
	// resolve @memongo/lib), so the subprocess exited 1 while the live suite
	// itself passed. The explicit exclusion keeps the LIVE suite as the only
	// gate; the worktree copies are neither read nor deleted. The spawn uses
	// node:child_process so the REAL subprocess is runnable from the vitest
	// Node pool as well as the Bun CLI runtime — same process, same stdio.
	const command =
		"vitest run scripts/benchmark/mongodb-conversation-recall-benchmark.test.ts --exclude **/.orchestrator/**"
	const proc = spawnSync(
		"bunx",
		[
			"vitest",
			"run",
			"scripts/benchmark/mongodb-conversation-recall-benchmark.test.ts",
			"--exclude",
			"**/.orchestrator/**",
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	)
	const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`
	const testsLine =
		output
			.split("\n")
			.find((line) => line.includes("Tests"))
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes from vitest output
			?.replace(/\x1b\[[0-9;]*m/g, "")
			.trim() ?? "test summary unavailable"
	return proc.status === 0
		? {
				status: "passed",
				evidence: `${command}: ${testsLine}`,
			}
		: {
				status: "failed",
				evidence: `${command} exited ${proc.status}: ${testsLine}`,
			}
}

/**
 * Minimal test seam (Slice C): main stays the real control flow — parseArgs →
 * digest gate → publishable pre-ingest gate → manager — but the three
 * process/filesystem boundaries (dataset digest read, recall subprocess,
 * sample file write) can be replaced so the flow is testable offline against
 * mocked manager/provider seams. Defaults are the production functions.
 */
type BenchmarkCliDeps = {
	readDatasetDigest?: (filePath: string) => Promise<string>
	runRecallRegression?: () => Promise<{
		status: "passed" | "failed"
		evidence: string
	}>
	writeSample?: (count: number) => Promise<string>
	assertQuestionsSubset?: (questionsPath: string) => Promise<void>
}

export async function main(
	argv: string[] = process.argv.slice(2),
	deps: BenchmarkCliDeps = {},
): Promise<void> {
	const { sample, questionsPath, json, resume, checkpointPath, noRerank } =
		parseArgs(argv)

	if (!process.env.MEMONGO_MONGODB_URI?.trim()) {
		fail(
			"MEMONGO_MONGODB_URI is not set.\n" +
				"  The benchmark runs against a real cluster; there is no offline mode.",
		)
	}

	// B7: --no-rerank must take effect before the manager is acquired (the
	// resolved config is built at acquisition time) and before the benchmark
	// ops reranker-key gate runs. The env value is also recorded verbatim in
	// the run manifest's settings snapshot, so the rerank-off deviation is
	// part of the run's configuration identity.
	if (noRerank) {
		process.env.MEMONGO_RERANKING_ENABLED = "false"
	}

	let datasetPath = DATASET
	try {
		const digest = await (deps.readDatasetDigest ?? sha256OfFile)(DATASET)
		if (digest !== LONGMEMEVAL_RELEASE_V2.datasetSha256) {
			fail(
				`dataset digest does not match the release contract\n` +
					`    expected ${LONGMEMEVAL_RELEASE_V2.datasetSha256}\n` +
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

	const publishable = sample === 0 && !questionsPath
	if (questionsPath) {
		await (deps.assertQuestionsSubset ?? assertQuestionsSubsetOfDataset)(
			questionsPath,
		)
		datasetPath = questionsPath
	} else if (!publishable) {
		datasetPath = await (deps.writeSample ?? writeSample)(sample)
	}

	// The V2 contract gates on LLM-judged answer accuracy, and the default
	// full500 is the OFFICIAL protocol (Slice C): it must be opted into
	// explicitly — this command never sets MEMONGO_BENCHMARK_QA_PROTOCOL, so
	// the manager always sees the user's own environment. Everything the
	// official run needs (protocol, checkpoint, pinned judge, distinct answer
	// model) is refused here in seconds — before any ingest, provider
	// resolution, or manager acquisition. Sample runs stay provider-optional
	// and protocol-free (accuracy reports unavailable instead).
	if (publishable) {
		const officialError = benchmarkOfficialFullRunError(process.env, {
			checkpointDisabled: !checkpointPath,
		})
		if (officialError) {
			// Protocol-aware hint: the custom-judge refusal wording names its
			// own protocol, so the fix instructions must too.
			const customJudge =
				process.env.MEMONGO_BENCHMARK_QA_PROTOCOL === "custom-judge"
			fail(
				`${officialError}\n` +
					(customJudge
						? "  Custom-judge mode must be configured explicitly; this command never\n" +
							"  sets MEMONGO_BENCHMARK_QA_PROTOCOL for you.\n" +
							"  Set MEMONGO_BENCHMARK_QA_PROTOCOL=custom-judge with a separate\n" +
							"  judge (MEMONGO_BENCHMARK_JUDGE_MODEL) and a checkpoint, or use\n" +
							"  --sample N for a provider-optional smoke run."
						: "  Official mode must be configured explicitly; this command never\n" +
							"  sets MEMONGO_BENCHMARK_QA_PROTOCOL for you.\n" +
							"  Set MEMONGO_BENCHMARK_QA_PROTOCOL=official with the pinned judge\n" +
							"  (MEMONGO_BENCHMARK_JUDGE_MODEL=gpt-4o-2024-08-06) and a checkpoint,\n" +
							"  or use --sample N for a provider-optional smoke run."),
			)
		}
		// The official judge env is validated above; the answer provider still
		// needs to resolve up front for the same fail-fast reason.
		let providerError: string | null = null
		try {
			const provider = resolveBenchmarkAnswerProvider(process.env)
			if (!provider) {
				providerError =
					"no benchmark answer provider configured (set MEMONGO_BENCHMARK_ANSWER_API_KEY, MEMONGO_BENCHMARK_ANSWER_BASE_URL, MEMONGO_BENCHMARK_ANSWER_MODEL, or the MEMONGO_ENRICHMENT_* fallback)"
			}
		} catch (error) {
			providerError = `benchmark answer provider misconfigured: ${error instanceof Error ? error.message : String(error)}`
		}
		if (providerError) {
			fail(
				`${providerError}\n` +
					"  The contract gates on LLM-judged answer accuracy and cannot be\n" +
					"  satisfied without the answer/judge provider.",
			)
		}
	}

	console.log("")
	console.log(`profile     : shipped`)
	console.log(`dataset     : ${path.relative(REPO_ROOT, datasetPath)}`)
	console.log(
		`scope       : ${publishable ? "full (500 questions)" : questionsPath ? `frozen subset (${path.relative(REPO_ROOT, questionsPath)})` : `sample of ${sample}`}`,
	)
	console.log(
		`contract    : ${publishable ? `${LONGMEMEVAL_RELEASE_V2.thresholds.contractId}@${LONGMEMEVAL_RELEASE_V2.thresholds.version}` : "none — SUBSET RUNS ARE NOT PUBLISHABLE"}`,
	)
	console.log(
		`checkpoint  : ${checkpointPath ? path.relative(REPO_ROOT, checkpointPath) : "disabled"}`,
	)
	console.log(`resume      : ${resume ? "enabled" : "disabled"}`)
	if (noRerank) {
		console.log("rerank      : disabled (--no-rerank)")
	}
	console.log("")

	const recallRegression = await (
		deps.runRecallRegression ?? runRecallRegressionSuite
	)()
	console.log(
		`recall gate : ${recallRegression.status} — ${recallRegression.evidence}`,
	)
	console.log("")

	const started = Date.now()
	process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS = includeBenchmarkAllowedRoot(
		process.env.MEMONGO_BENCHMARK_ALLOWED_ROOTS,
		DATA_DIR,
	)
	// The CLI owns this manager for the whole run: never cached, so
	// idle-TTL/LRU eviction cannot close it mid-run. The finally below
	// closes it exactly once, success or failure.
	const manager = await memongoBridgeGetManager(undefined, {
		ownership: "owned",
	})
	let result: Awaited<
		ReturnType<MongoDBManagerBenchmarkOps["relevanceBenchmark"]>
	>
	try {
		result = await new MongoDBManagerBenchmarkOps(manager).relevanceBenchmark({
			datasetPath,
			// The contract binds thresholds to the dataset digest, so it can only be
			// applied to the full artifact it pins.
			...(publishable
				? { qualityThresholds: LONGMEMEVAL_RELEASE_V2.thresholds }
				: {}),
			// B2: frozen-subset runs carry no quality contract, which would
			// silently default maxResults to 10 and degenerate recall@50 into
			// recall@10; the loop's R metric needs the full depth.
			...(questionsPath ? { maxResults: 50 } : {}),
			...(checkpointPath ? { checkpointPath } : {}),
			resume,
			conversationRecallRegression: recallRegression,
		})
	} finally {
		await manager.close()
	}
	const elapsedSec = ((Date.now() - started) / 1000).toFixed(1)

	// C3: canonical location of the official QA summary is
	// officialMetrics.longMemEval.answerQuality.official (there is
	// deliberately no sibling officialQa field). Custom-judge runs carry
	// their summary at ...answerQuality.customJudge instead.
	const answerQuality = result.officialMetrics?.longMemEval?.answerQuality
	const officialDisclosure = answerQuality
		? officialModelDifferenceDisclosure(answerQuality)
		: null
	const customJudgeDisclosure = answerQuality
		? customJudgeDifferenceDisclosure(answerQuality)
		: null

	if (json) {
		// Stdout carries only the machine-readable envelope (CI tee's stdout
		// into a file and parses it with jq); human diagnostics go to stderr.
		console.log(JSON.stringify(result, null, 2))
		if (officialDisclosure) {
			console.error(`\n⚠ ${officialDisclosure}`)
		}
		if (customJudgeDisclosure) {
			console.error(`\n⚠ ${customJudgeDisclosure}`)
		}
		console.error(`\nelapsed: ${elapsedSec}s`)
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
	// C-039: the answer half of the official protocol, next to the retrieval
	// half above. Unavailable is stated, never zeroed.
	if (answerQuality) {
		console.log(
			`  answer acc     : ${answerQuality.accuracy != null ? answerQuality.accuracy.toFixed(4) : "unavailable"}`,
		)
		console.log(
			`  answer model   : ${answerQuality.answerModel ?? "unavailable"}  judge ${answerQuality.judge ?? "n/a"}@${answerQuality.judgeVersion ?? "n/a"}`,
		)
		if (answerQuality.unavailableReason) {
			console.log(`    ⚠ ${answerQuality.unavailableReason}`)
		}
		// C3: name both models and state the comparison limits explicitly —
		// never an identical-model head-to-head claim. Custom-judge runs get
		// the non-official disclosure instead: never an official-protocol claim.
		if (officialDisclosure) {
			console.log(`    ⚠ ${officialDisclosure}`)
		}
		if (customJudgeDisclosure) {
			console.log(`    ⚠ ${customJudgeDisclosure}`)
		}
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
			"\n⚠ subset run — no quality contract applied. Do not publish this number.\n",
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
