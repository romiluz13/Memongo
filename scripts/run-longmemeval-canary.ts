/**
 * Stratified LongMemEval canary runner.
 *
 * Selects a deterministic 48-evaluation subset from the official LongMemEval-S
 * dataset: 8 evaluation cases per question type when available, chosen by
 * stable sort on question_id.
 *
 * The canary preserves the official benchmark path by calling the same
 * /v1/admin/relevance/benchmark API with a subset dataset file. The subset
 * is written in the same raw LongMemEval format so the benchmark normalizer
 * handles it identically to the full dataset.
 */

import { createHash, randomUUID } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import {
	type BenchmarkFailureClass,
	classifyBenchmarkFailure,
} from "../packages/memory-engine/src/benchmark-failure-taxonomy.js"
import {
	resolveBenchmarkCollectionPrefix,
	validateBenchmarkCollectionPrefix,
} from "./benchmark-run-isolation.js"

// Bootstrap: set MEMONGO_LOG_LEVEL default to warn (Task 1.1). info during
// benchmark runs causes PTY backpressure and throttles Node writes. This
// runs BEFORE any other env read so downstream modules see the right value.
// Tests for `resolveCanaryLogLevel` cover the precedence rules.
// See docs/plans/2026-05-11-memongo-mempalace-roadmap-plan.md Task 1.1.
const __canaryLogLevelBootstrap = (() => {
	const explicit = process.env.MEMONGO_LOG_LEVEL?.trim()
	if (!explicit) {
		process.env.MEMONGO_LOG_LEVEL =
			process.env.MEMONGO_CANARY_DEBUG === "1" ? "info" : "warn"
	}
	return process.env.MEMONGO_LOG_LEVEL
})()
// Reference to prevent tree-shaking complaints; the side effect is the point.
void __canaryLogLevelBootstrap

// ---------------------------------------------------------------------------
// Types (raw LongMemEval entry shape)
// ---------------------------------------------------------------------------

export type RawLongMemEvalEntry = {
	question_id: string
	question_type: string
	question: string
	question_date?: string
	answer?: string
	answer_session_ids?: string[]
	haystack_session_ids?: string[]
	haystack_dates?: string[]
	haystack_sessions?: Record<string, unknown>[]
}

export type CanaryArtifact = {
	artifactVersion: 2
	runId: string
	status: "started" | "completed" | "failed"
	startedAt: string
	completedAt?: string
	datasetPath: string
	datasetHash: string
	subsetPath?: string
	httpRequest?: {
		endpointPath: string
		maxResults: number
		timeoutMs: number
		heartbeatIntervalMs?: number
	}
	runtime?: {
		collectionPrefix: string | null
		buildId: string | null
		benchmarkStrict: string | null
		strictMode: string | null
		derivedWorkMode: string | null
		benchmarkRetrievalLane: string | null
		sessionEvidenceMode: string | null
		fusionMethod: string | null
		rerankingEnabled: string | null
		benchmarkRerankMode: string | null
		rerankEndpointFamily: "mongodb-atlas" | "voyage-direct" | "unknown"
	}
	/** remfix H3: null when fullMode=true; the value is irrelevant then. */
	casesPerType: number | null
	/** remfix H3: null when fullMode=true or no explicit limit. */
	totalCaseLimit: number | null
	fullMode: boolean
	runShapeHash: string
	selectedQuestionIdFilter?: string[]
	questionIdSelection?: {
		source: "env" | "file" | "split"
		questionIdsFile?: string
		splitFile?: string
		splitKey?: string
	}
	totalEvaluations: number
	selectedQuestionIds: string[]
	questionTypeBreakdown: Record<string, number>
	metrics?: Record<string, unknown>
	benchmarkResponse?: unknown
	lastHeartbeatAt?: string
	heartbeatCount?: number
	failureClass?: BenchmarkFailureClass
	error?: string
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CASES_PER_TYPE = Math.max(
	1,
	Math.floor(Number(process.env.MEMONGO_CANARY_CASES_PER_TYPE?.trim()) || 8),
)

const repoRoot = process.cwd()
const workspaceDir =
	process.env.MEMONGO_WORKSPACE_DIR?.trim() ||
	path.join(os.homedir(), ".memongo", "workspace")
const datasetPath =
	process.env.MEMONGO_CANARY_DATASET_PATH?.trim() ||
	process.env.MEMONGO_BENCHMARK_DATASET_PATH?.trim() ||
	path.join(workspaceDir, "benchmarks", "longmemeval_s_cleaned.json")
const port = Number(process.env.MEMONGO_API_PORT?.trim() || "3847")
const baseUrl = `http://127.0.0.1:${port}`
const maxResults = Number(
	process.env.MEMONGO_BENCHMARK_MAX_RESULTS?.trim() || "50",
)
const dryRun = process.env.MEMONGO_CANARY_DRY_RUN === "1"
const totalCaseLimitRaw = process.env.MEMONGO_CANARY_TOTAL_CASES?.trim()
const totalCaseLimit = totalCaseLimitRaw
	? Math.max(1, Math.floor(Number(totalCaseLimitRaw) || 1))
	: undefined
const questionIdFilterResolution = resolveCanaryQuestionIdFilter({
	inlineQuestionIds: process.env.MEMONGO_CANARY_QUESTION_IDS,
	questionIdsFile: process.env.MEMONGO_CANARY_QUESTION_IDS_FILE,
	splitFile: process.env.MEMONGO_CANARY_SPLIT_FILE,
	splitKey: process.env.MEMONGO_CANARY_SPLIT_KEY,
})
const selectedQuestionIdFilter = questionIdFilterResolution.questionIds

const VOYAGE_RERANK_URL_ATLAS = "https://ai.mongodb.com/v1/rerank"
const VOYAGE_RERANK_URL_DIRECT = "https://api.voyageai.com/v1/rerank"

// ---------------------------------------------------------------------------
// Env-var contract helpers (Task 1.0 — exported for testability)
// ---------------------------------------------------------------------------

/**
 * Resolve the canary artifact directory. MEMONGO_CANARY_ARTIFACT_DIR, when set
 * and non-blank, is used verbatim — runId is NOT appended. Otherwise the
 * default root + runId is returned so each run gets its own subdirectory.
 */
export function resolveCanaryArtifactDir(params: {
	runId: string
	envDir: string | undefined
	repoRoot?: string
}): string {
	const trimmed = params.envDir?.trim()
	if (trimmed && trimmed.length > 0) {
		return params.envDir as string
	}
	const root = params.repoRoot ?? process.cwd()
	return path.join(
		root,
		".claude",
		"cc10x",
		"v10",
		"workflows",
		"memongo-memory-hardening",
		"artifacts",
		"canary-runs",
		params.runId,
	)
}

/** MEMONGO_CANARY_FULL=1 is truthy; every other value (including "true") is false. */
export function resolveCanaryFullMode(envValue: string | undefined): boolean {
	return envValue === "1"
}

/** MEMONGO_CANARY_RESUME=1 is truthy; every other value is false. */
export function resolveCanaryResumeMode(envValue: string | undefined): boolean {
	return envValue === "1"
}

/**
 * n≥3 canary sampling discipline — how many sequential runs on the same commit.
 *
 * Voyage rerank has observed non-determinism that dominates the 1/type canary
 * signal. Running the strict 1/type canary N=3 lets the aggregator partition
 * real (deterministic) misses from Voyage variance noise.
 *
 * Contract: integer ≥ 1. Any other value (NaN, zero, negative, fractional,
 * blank) throws with a clear message. No silent fallback — treating a
 * misconfigured env var as "use default 1" would silently invalidate a gate
 * re-run's n-discipline.
 *
 * Default `undefined` is the back-compat signal — old invocations without the
 * env var keep their single-run behavior.
 */
export function resolveCanaryRunsPerCommit(
	envValue: string | undefined,
): number {
	if (envValue === undefined) return 1
	const trimmed = envValue.trim()
	if (trimmed.length === 0) {
		throw new Error(
			"MEMONGO_CANARY_RUNS_PER_COMMIT must be a positive integer; got empty string",
		)
	}
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
		throw new Error(
			`MEMONGO_CANARY_RUNS_PER_COMMIT must be a positive integer (≥ 1); got ${envValue}`,
		)
	}
	return parsed
}

/**
 * Inter-run delay (ms) between sequential canary runs on the same commit.
 *
 * Voyage rerank has a per-minute rate limit; back-to-back bursts trigger
 * 429s that then cascade into `model-failure` classifications. The default
 * 2000ms spread smooths the burst profile across multiple runs.
 *
 * Contract: non-negative integer. NaN, negative, and non-numeric throw.
 * Zero is accepted (for tests; no delay between runs).
 */
export function resolveCanaryRunIntervalMs(
	envValue: string | undefined,
): number {
	if (envValue === undefined) return 2000
	const trimmed = envValue.trim()
	if (trimmed.length === 0) return 2000
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
		throw new Error(
			`MEMONGO_CANARY_RUN_INTERVAL_MS must be a non-negative integer; got ${envValue}`,
		)
	}
	return parsed
}

export function resolveCanaryModelPreflightMode(params: {
	modelPreflightEnv: string | undefined
	strictEnv: string | undefined
	rerankEnabled?: boolean
}): boolean {
	const explicit = params.modelPreflightEnv?.trim()
	if (explicit === "0") return false
	if (explicit === "1") return true
	if (params.rerankEnabled === false) return false
	return params.strictEnv === "1" || params.strictEnv?.toLowerCase() === "true"
}

export function resolveCanaryRerankEnabled(params: {
	rerankingEnabledEnv: string | undefined
	benchmarkRerankModeEnv: string | undefined
}): boolean {
	const mode = params.benchmarkRerankModeEnv?.trim().toLowerCase()
	if (mode) {
		if (["disabled", "off", "none", "0", "false", "raw"].includes(mode)) {
			return false
		}
		if (["enabled", "on", "1", "true", "rerank"].includes(mode)) {
			return true
		}
	}
	const enabled = params.rerankingEnabledEnv?.trim().toLowerCase()
	if (!enabled) return true
	if (["0", "false", "no", "off", "disabled"].includes(enabled)) return false
	if (["1", "true", "yes", "on", "enabled"].includes(enabled)) return true
	return true
}

export function resolveCanaryModelPreflightTimeoutMs(
	envValue: string | undefined,
): number {
	if (envValue === undefined || envValue.trim() === "") return 5000
	const parsed = Number(envValue)
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(
			`MEMONGO_CANARY_MODEL_PREFLIGHT_TIMEOUT_MS must be a non-negative number, got ${envValue}`,
		)
	}
	return Math.floor(parsed)
}

export function resolveCanaryRequireAtlasModelKey(
	envValue: string | undefined,
): boolean {
	return envValue?.trim() !== "0"
}

export function resolveVoyageRerankEndpoint(apiKey: string): {
	url: string
	keyKind: "atlas-model" | "direct-voyage" | "unknown"
} {
	if (apiKey.startsWith("al-")) {
		return { url: VOYAGE_RERANK_URL_ATLAS, keyKind: "atlas-model" }
	}
	if (apiKey.startsWith("pa-")) {
		return { url: VOYAGE_RERANK_URL_DIRECT, keyKind: "direct-voyage" }
	}
	return { url: VOYAGE_RERANK_URL_DIRECT, keyKind: "unknown" }
}

export async function runVoyageRerankPreflight(params: {
	apiKey: string | undefined
	model?: "rerank-2.5" | "rerank-2.5-lite"
	timeoutMs?: number
	requireAtlasModelKey?: boolean
	fetchImpl?: typeof fetch
}): Promise<{ status: number; keyKind: string; url: string }> {
	const apiKey = params.apiKey?.trim() ?? ""
	const model = params.model ?? "rerank-2.5"
	const timeoutMs = params.timeoutMs ?? 5000
	const requireAtlasModelKey = params.requireAtlasModelKey ?? true
	if (!apiKey) {
		throw new Error(
			"canary model preflight failed: VOYAGE_API_KEY is missing; strict rerank requires a MongoDB Atlas model API key",
		)
	}

	const endpoint = resolveVoyageRerankEndpoint(apiKey)
	if (requireAtlasModelKey && endpoint.keyKind !== "atlas-model") {
		throw new Error(
			`canary model preflight failed: VOYAGE_API_KEY is ${endpoint.keyKind}; expected a MongoDB Atlas model API key (al-...) for MongoDB-only benchmark lanes`,
		)
	}

	const fetchImpl = params.fetchImpl ?? fetch
	const response = await fetchImpl(endpoint.url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			query: "Memongo benchmark model preflight",
			documents: [
				"MongoDB Atlas Search can combine lexical and vector retrieval.",
				"Memongo strict mode treats fallback as benchmark failure.",
			],
			top_k: 1,
		}),
		signal: AbortSignal.timeout(timeoutMs),
	})

	if (!response.ok) {
		const host = new URL(endpoint.url).host
		throw new Error(
			`canary model preflight failed: rerank endpoint rejected request with HTTP ${response.status} (${endpoint.keyKind}, ${host}); verify the MongoDB Atlas model API key is active and authorized for Voyage rerank`,
		)
	}

	return {
		status: response.status,
		keyKind: endpoint.keyKind,
		url: endpoint.url,
	}
}

/**
 * Per-run artifact subdirectory.
 *
 * Each run within a single invocation writes into
 * `{baseDir}/run-{runIndex}/`. The aggregate-summary.json lives at `{baseDir}`.
 */
export function deriveCanaryRunDir(params: {
	baseDir: string
	runIndex: number
}): string {
	return path.join(params.baseDir, `run-${params.runIndex}`)
}

/**
 * Per-run MongoDB collection prefix (collision-proof across runs AND
 * invocations).
 *
 * Format: `{basePrefix}run{runIndex}_{invocationTimestampMs}_`
 *
 * Why both invocation timestamp AND run index:
 * - Different runs in the same invocation need different prefixes (Atlas
 *   Search index caches are keyed per-collection; reusing a prefix would let
 *   run-2 see cached index state populated by run-1).
 * - Different invocations of the same command need different prefixes
 *   (otherwise a stale collection from a prior invocation could leak into
 *   run-1 of the new invocation).
 *
 * The invocation timestamp is passed in (not read from Date.now) so the
 * helper is testable.
 */
export function deriveCanaryRunCollectionPrefix(params: {
	basePrefix: string
	runIndex: number
	invocationTimestampMs: number
}): string {
	const prefix = `${params.basePrefix}run${params.runIndex}_${params.invocationTimestampMs}_`
	validateBenchmarkCollectionPrefix(prefix)
	return prefix
}

// ---------------------------------------------------------------------------
// Aggregate synthesis (n≥3 discipline)
// ---------------------------------------------------------------------------

/**
 * Per-run summary shape — the subset of canary-artifact fields needed by the
 * aggregator. Extracted from `summary.json` after each run completes.
 */
export type CanaryPerRunSummary = {
	runIndex: number
	hitRate: number
	rAt5: number
	rAt10: number
	ndcgAt10: number
	sessionAny1: number
	turnAny1: number
	/** Array of question IDs that missed in this run. */
	missLedger: string[]
	caseDiagnosticsLength: number
	artifactPath: string
}

type AggregateStat = {
	mean: number
	min: number
	max: number
	stddev: number
}

type Gate3ExitCriteria = {
	deterministicPass: boolean
	partialPass: boolean
	fail: boolean
}

export type CanaryAggregateSummary = {
	runs: CanaryPerRunSummary[]
	aggregate: {
		hitRate: AggregateStat
		sessionAny1: AggregateStat
		turnAny1: AggregateStat
	}
	deterministicMisses: string[]
	varianceMisses: string[]
	gate3ExitCriteria: Gate3ExitCriteria
	verdict: "DETERMINISTIC_PASS" | "PARTIAL_PASS" | "FAIL"
	reasoning: string
}

function computeAggregateStat(values: number[]): AggregateStat {
	if (values.length === 0) {
		return { mean: 0, min: 0, max: 0, stddev: 0 }
	}
	const sum = values.reduce((a, b) => a + b, 0)
	const mean = sum / values.length
	const min = Math.min(...values)
	const max = Math.max(...values)
	const variance =
		values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
	const stddev = Math.sqrt(variance)
	return { mean, min, max, stddev }
}

/**
 * Synthesize aggregate summary across N sequential canary runs on the same
 * commit.
 *
 * Gate-3 exit classification (refined per plan):
 * - `deterministicPass`: `min(hitRate) === 1.0` AND `|deterministicMisses| === 0`
 * - `partialPass`: `min(hitRate) >= 0.666` AND `mean(hitRate) >= 0.833`
 *   AND `|deterministicMisses| <= 2`
 * - `fail`: otherwise
 *
 * Miss partitioning:
 * - `deterministicMisses`: question IDs present in EVERY run's missLedger
 *   (real, reproducible failures)
 * - `varianceMisses`: question IDs in SOME but not all runs' missLedgers
 *   (Voyage rerank non-determinism)
 */
export function computeCanaryAggregateSummary(params: {
	runs: CanaryPerRunSummary[]
}): CanaryAggregateSummary {
	const { runs } = params
	if (runs.length === 0) {
		throw new Error(
			"computeCanaryAggregateSummary requires at least one run summary",
		)
	}

	const hitRateStat = computeAggregateStat(runs.map((r) => r.hitRate))
	const sessionAny1Stat = computeAggregateStat(runs.map((r) => r.sessionAny1))
	const turnAny1Stat = computeAggregateStat(runs.map((r) => r.turnAny1))

	// Partition misses: deterministic = present in EVERY run; variance = some.
	const allMissSets = runs.map((r) => new Set(r.missLedger))
	const unionMisses = new Set<string>()
	for (const set of allMissSets) {
		for (const qid of set) unionMisses.add(qid)
	}
	const deterministicMisses: string[] = []
	const varianceMisses: string[] = []
	for (const qid of unionMisses) {
		const presentInAll = allMissSets.every((set) => set.has(qid))
		if (presentInAll) {
			deterministicMisses.push(qid)
		} else {
			varianceMisses.push(qid)
		}
	}
	deterministicMisses.sort()
	varianceMisses.sort()

	// Gate-3 exit criteria — strict order: deterministic first, then partial,
	// else fail.
	const deterministicPass =
		hitRateStat.min === 1 && deterministicMisses.length === 0
	const partialPass =
		!deterministicPass &&
		hitRateStat.min >= 0.666 &&
		hitRateStat.mean >= 0.833 &&
		deterministicMisses.length <= 2
	const fail = !deterministicPass && !partialPass

	const verdict: CanaryAggregateSummary["verdict"] = deterministicPass
		? "DETERMINISTIC_PASS"
		: partialPass
			? "PARTIAL_PASS"
			: "FAIL"

	const reasoning = deterministicPass
		? `All ${runs.length} runs scored hitRate=1.0 with zero deterministic misses; retrieval quality is fully reproducible on this commit.`
		: partialPass
			? `min(hitRate)=${hitRateStat.min.toFixed(3)} mean=${hitRateStat.mean.toFixed(3)} with ${deterministicMisses.length} deterministic miss(es) and ${varianceMisses.length} variance miss(es); retrieval quality is partial — deterministic misses are real signal, variance misses are Voyage rerank non-determinism.`
			: `min(hitRate)=${hitRateStat.min.toFixed(3)} mean=${hitRateStat.mean.toFixed(3)} with ${deterministicMisses.length} deterministic miss(es); retrieval quality fails gate 3 exit criteria.`

	return {
		runs,
		aggregate: {
			hitRate: hitRateStat,
			sessionAny1: sessionAny1Stat,
			turnAny1: turnAny1Stat,
		},
		deterministicMisses,
		varianceMisses,
		gate3ExitCriteria: {
			deterministicPass,
			partialPass,
			fail,
		},
		verdict,
		reasoning,
	}
}

/**
 * Task 1.6 — canary strict mode. MEMONGO_BENCHMARK_STRICT=1 means: abort the
 * run on the first fatal-classified failure (harness-timeout, model-failure,
 * json-parse, queue-settle-timeout, probe-timeout, index-not-ready,
 * scope-leak) instead of swallowing and continuing.
 *
 * The 7 fatal classes are a strict subset of the 9-class taxonomy.
 * `retrieval-miss` and `unknown` are NOT fatal (retrieval-miss is a
 * metric-worthy event, unknown is surfaced but doesn't imply the infra
 * broke).
 */
export const BENCHMARK_STRICT_FATAL_CLASSES: ReadonlyArray<BenchmarkFailureClass> =
	[
		"harness-timeout",
		"model-failure",
		"json-parse",
		"queue-settle-timeout",
		"probe-timeout",
		"index-not-ready",
		"scope-leak",
	]

export function isCanaryFatalFailureClass(
	failureClass: BenchmarkFailureClass,
): boolean {
	return (BENCHMARK_STRICT_FATAL_CLASSES as readonly string[]).includes(
		failureClass,
	)
}

export function shouldCanaryAbort(params: {
	strictEnv: string | undefined
	failureClass: BenchmarkFailureClass
}): boolean {
	const strict =
		params.strictEnv === "1" || params.strictEnv?.toLowerCase() === "true"
	if (!strict) return false
	return isCanaryFatalFailureClass(params.failureClass)
}

/**
 * Task 1.7 — enumerate the set of scenario indices whose `progress/{idx}.json`
 * file is truly complete (valid JSON, non-empty, and `completed === true` with
 * `passStatus === "pass"`). Kept as a back-compat shim; new callers should use
 * `listResumableProgress` (remfix H1/H2) which also verifies questionId match
 * and `runShapeHash`.
 */
export function listCompletedScenarioIndices(runDir: string): Set<number> {
	const progressDir = path.join(runDir, "progress")
	if (!existsSync(progressDir)) return new Set()
	let entries: string[]
	try {
		entries = readdirSync(progressDir)
	} catch {
		return new Set()
	}
	const completed = new Set<number>()
	for (const name of entries) {
		// accept exactly "{integer}.json"
		const match = /^(\d+)\.json$/.exec(name)
		if (!match) continue
		const idx = Number(match[1])
		if (!Number.isInteger(idx) || idx < 0) continue
		const filePath = path.join(progressDir, name)
		try {
			const raw = readFileSync(filePath, "utf8")
			if (raw.length === 0) continue
			const doc = JSON.parse(raw) as Record<string, unknown>
			if (doc.completed !== true) continue
			if (doc.passStatus !== "pass") continue
			completed.add(idx)
		} catch {}
	}
	return completed
}

/**
 * remfix H1: compute a stable run-shape hash. Different shapes (fullMode on,
 * different CASES_PER_TYPE, different TOTAL_CASES, different questionId set)
 * must produce different hashes so resume can refuse to mix two runs.
 *
 * questionIds are sorted before hashing so stratified-selection ordering
 * quirks do not spuriously invalidate resume.
 */
export function computeRunShapeHash(params: {
	casesPerType: number
	totalCaseLimit: number | null
	questionIds: ReadonlyArray<string>
	fullMode: boolean
}): string {
	const normalized = {
		casesPerType: params.casesPerType,
		totalCaseLimit: params.totalCaseLimit ?? null,
		fullMode: Boolean(params.fullMode),
		// canonicalize order for shape-stability
		questionIds: [...params.questionIds].sort(),
	}
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

export type ResumableProgress = {
	aborted: boolean
	abortReason?: string
	/** questionIds safe to skip on this resume pass. */
	skipQuestionIds: Set<string>
}

/**
 * remfix H1/H2: return the set of questionIds that are SAFE to skip on resume.
 *
 * A progress entry counts as "skip" only if ALL of:
 *   1. file parses as JSON and is non-empty
 *   2. `completed === true`
 *   3. `passStatus === "pass"`
 *   4. `questionId` appears in the current-run scenarios list
 *   5. `runShapeHash` matches the current run's shape hash
 *
 * If any existing progress file's `runShapeHash` does not match the current
 * expected hash, we ABORT resume and tell the caller to delete progress/ or
 * start fresh. Resuming across two different shapes is unsafe.
 */
export function listResumableProgress(params: {
	runDir: string
	scenarioQuestionIds: ReadonlyArray<string>
	expectedRunShapeHash: string
}): ResumableProgress {
	const progressDir = path.join(params.runDir, "progress")
	if (!existsSync(progressDir)) {
		return { aborted: false, skipQuestionIds: new Set() }
	}
	let entries: string[]
	try {
		entries = readdirSync(progressDir)
	} catch {
		return { aborted: false, skipQuestionIds: new Set() }
	}
	const currentQuestionIds = new Set(params.scenarioQuestionIds)
	const skip = new Set<string>()
	for (const name of entries) {
		if (!/^(\d+)\.json$/.test(name)) continue
		const file = path.join(progressDir, name)
		let raw: string
		try {
			raw = readFileSync(file, "utf8")
		} catch {
			continue
		}
		if (raw.length === 0) continue
		let doc: Record<string, unknown>
		try {
			doc = JSON.parse(raw) as Record<string, unknown>
		} catch {
			// Corrupt JSON — re-run that scenario.
			continue
		}
		const runShapeHash = doc.runShapeHash
		if (typeof runShapeHash === "string" && runShapeHash.length > 0) {
			if (runShapeHash !== params.expectedRunShapeHash) {
				return {
					aborted: true,
					abortReason:
						"run shape changed; resume unsafe; delete progress/ or start a fresh run",
					skipQuestionIds: new Set(),
				}
			}
		}
		if (doc.completed !== true) continue
		if (doc.passStatus !== "pass") continue
		const questionId = doc.questionId
		if (typeof questionId !== "string" || questionId.length === 0) continue
		if (!currentQuestionIds.has(questionId)) continue
		skip.add(questionId)
	}
	return { aborted: false, skipQuestionIds: skip }
}

/**
 * remfix H3: build the case-limit fields of the canary artifact.
 *
 * When MEMONGO_CANARY_FULL=1, casesPerType and totalCaseLimit do NOT describe
 * the run (they're overridden by full-mode). Emit `null` so the artifact
 * cannot lie about the run shape.
 */
export function buildCanaryArtifactCaseLimits(params: {
	fullMode: boolean
	casesPerType: number
	totalCaseLimit: number | undefined
}): { casesPerType: number | null; totalCaseLimit: number | null } {
	if (params.fullMode) {
		return { casesPerType: null, totalCaseLimit: null }
	}
	return {
		casesPerType: params.casesPerType,
		totalCaseLimit: params.totalCaseLimit ?? null,
	}
}

function nullableEnv(name: string): string | null {
	const value = process.env[name]?.trim()
	return value && value.length > 0 ? value : null
}

function resolveRerankEndpointFamily():
	| "mongodb-atlas"
	| "voyage-direct"
	| "unknown" {
	const endpoint = process.env.MEMONGO_VOYAGE_RERANK_URL?.trim()
	if (!endpoint) return "unknown"
	if (endpoint.includes("ai.mongodb.com")) return "mongodb-atlas"
	if (endpoint.includes("voyageai.com")) return "voyage-direct"
	return "unknown"
}

export function buildCanaryRuntimeSnapshot(): NonNullable<
	CanaryArtifact["runtime"]
> {
	return {
		collectionPrefix: nullableEnv("MEMONGO_MONGODB_COLLECTION_PREFIX"),
		buildId: nullableEnv("MEMONGO_BUILD_ID"),
		benchmarkStrict: nullableEnv("MEMONGO_BENCHMARK_STRICT"),
		strictMode: nullableEnv("MEMONGO_STRICT_MODE"),
		derivedWorkMode: nullableEnv("MEMONGO_BENCHMARK_DERIVED_WORK_MODE"),
		benchmarkRetrievalLane: nullableEnv("MEMONGO_BENCHMARK_RETRIEVAL_LANE"),
		sessionEvidenceMode: nullableEnv("MEMONGO_SESSION_EVIDENCE_MODE"),
		fusionMethod: nullableEnv("MEMONGO_MONGODB_FUSION_METHOD"),
		rerankingEnabled: nullableEnv("MEMONGO_RERANKING_ENABLED"),
		benchmarkRerankMode: nullableEnv("MEMONGO_BENCHMARK_RERANK_MODE"),
		rerankEndpointFamily: resolveRerankEndpointFamily(),
	}
}

export function writeCanaryArtifactFile(params: {
	runDir: string
	artifact: CanaryArtifact
}): string {
	mkdirSync(params.runDir, { recursive: true })
	const artifactPath = path.join(params.runDir, "canary-artifact.json")
	writeFileSync(artifactPath, JSON.stringify(params.artifact, null, "\t"))
	return artifactPath
}

export function writeCanaryHeartbeatFile(params: {
	runDir: string
	runId: string
	elapsedMs: number
	heartbeatCount: number
	message: string
}): string {
	mkdirSync(params.runDir, { recursive: true })
	const heartbeatPath = path.join(params.runDir, "canary-heartbeat.json")
	writeFileSync(
		heartbeatPath,
		JSON.stringify(
			{
				runId: params.runId,
				heartbeatAt: new Date().toISOString(),
				elapsedMs: params.elapsedMs,
				heartbeatCount: params.heartbeatCount,
				message: params.message,
			},
			null,
			"\t",
		),
	)
	return heartbeatPath
}

/**
 * Task 1.2 — per-scenario progress artifact emitter.
 *
 * Writes `{runDir}/progress/{index}.json` synchronously so a failure leaves a
 * trail. Shape documented inline at plan Task 1.2 Step 3. The directory is
 * created if absent. Write is synchronous (fs.writeFileSync) to survive
 * abrupt process termination.
 *
 * remfix C1: `completed` and `runShapeHash` are MANDATORY fields. The bulk
 * fan-out fallback (no per-case API stream yet) MUST write `completed:false`
 * with a `reason` so resume mode (remfix H1/H2) correctly re-runs every
 * scenario.
 */
export function writeScenarioProgress(params: {
	runDir: string
	index: number
	questionId: string
	questionType: string
	passStatus: "pass" | "fail" | "abstain"
	failureClass: string | null
	metrics: Record<string, unknown> | null
	completed: boolean
	runShapeHash: string
	reason?: string
}): string {
	const progressDir = path.join(params.runDir, "progress")
	mkdirSync(progressDir, { recursive: true })
	const file = path.join(progressDir, `${params.index}.json`)
	const doc: Record<string, unknown> = {
		index: params.index,
		questionId: params.questionId,
		questionType: params.questionType,
		completedAt: new Date().toISOString(),
		passStatus: params.passStatus,
		failureClass: params.failureClass,
		metrics: params.metrics,
		completed: params.completed,
		runShapeHash: params.runShapeHash,
	}
	if (params.reason !== undefined) {
		doc.reason = params.reason
	}
	writeFileSync(file, JSON.stringify(doc, null, "\t"))
	return file
}

/**
 * Task 1.1 — canary default log level is `warn`. `info` during benchmark runs
 * causes PTY backpressure and throttles Node writes. MEMONGO_CANARY_DEBUG=1
 * upgrades to `info`; an explicit MEMONGO_LOG_LEVEL always wins.
 */
export function resolveCanaryLogLevel(params: {
	logLevel: string | undefined
	debug: string | undefined
}): string {
	const explicit = params.logLevel?.trim()
	if (explicit && explicit.length > 0) {
		return explicit
	}
	if (params.debug === "1") {
		return "info"
	}
	return "warn"
}

// ---------------------------------------------------------------------------
// Stratified selection (exported for testability)
// ---------------------------------------------------------------------------

export function selectStratifiedSubset(
	entries: RawLongMemEvalEntry[],
	casesPerType: number,
	options: {
		totalCaseLimit?: number
		questionIds?: string[]
	} = {},
): {
	selected: RawLongMemEvalEntry[]
	selectedQuestionIds: string[]
	breakdown: Record<string, number>
} {
	if (options.questionIds && options.questionIds.length > 0) {
		const requested = new Set(options.questionIds)
		const selected = entries.filter((entry) => requested.has(entry.question_id))
		const found = new Set(selected.map((entry) => entry.question_id))
		const missing = [...requested].filter((id) => !found.has(id))
		if (missing.length > 0) {
			throw new Error(
				`Requested question_id(s) not found: ${missing.join(", ")}`,
			)
		}
		if (options.totalCaseLimit && options.totalCaseLimit > 0) {
			return selectStratifiedEntries(
				selected,
				casesPerType,
				options.totalCaseLimit,
			)
		}
		return summarizeSelectedEntries(selected)
	}

	return selectStratifiedEntries(entries, casesPerType, options.totalCaseLimit)
}

function selectStratifiedEntries(
	entries: RawLongMemEvalEntry[],
	casesPerType: number,
	totalCaseLimit?: number,
): {
	selected: RawLongMemEvalEntry[]
	selectedQuestionIds: string[]
	breakdown: Record<string, number>
} {
	// Group by question_type
	const byType = new Map<string, RawLongMemEvalEntry[]>()
	for (const entry of entries) {
		const qt = entry.question_type?.trim() || "unknown"
		const group = byType.get(qt) || []
		group.push(entry)
		byType.set(qt, group)
	}

	const pickedByType: RawLongMemEvalEntry[][] = []
	for (const [_qt, group] of [...byType.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		group.sort((a, b) => a.question_id.localeCompare(b.question_id))
		pickedByType.push(group.slice(0, casesPerType))
	}

	if (totalCaseLimit && totalCaseLimit > 0) {
		const selected: RawLongMemEvalEntry[] = []
		for (let index = 0; selected.length < totalCaseLimit; index++) {
			let added = false
			for (const group of pickedByType) {
				const entry = group[index]
				if (!entry) continue
				selected.push(entry)
				added = true
				if (selected.length >= totalCaseLimit) break
			}
			if (!added) break
		}
		return summarizeSelectedEntries(selected)
	}

	return summarizeSelectedEntries(pickedByType.flat())
}

export function resolveCanaryQuestionIdFilter(params: {
	inlineQuestionIds?: string
	questionIdsFile?: string
	splitFile?: string
	splitKey?: string
}): {
	questionIds: string[]
	selection?: CanaryArtifact["questionIdSelection"]
} {
	const inline = params.inlineQuestionIds?.trim()
	const questionIdsFile = params.questionIdsFile?.trim()
	const splitFile = params.splitFile?.trim()
	const sources = [
		inline ? "MEMONGO_CANARY_QUESTION_IDS" : null,
		questionIdsFile ? "MEMONGO_CANARY_QUESTION_IDS_FILE" : null,
		splitFile ? "MEMONGO_CANARY_SPLIT_FILE" : null,
	].filter(Boolean)
	if (sources.length > 1) {
		throw new Error(
			`Set only one canary question-id source; got ${sources.join(", ")}`,
		)
	}

	if (inline) {
		return {
			questionIds: normalizeQuestionIds(inline.split(",")),
			selection: { source: "env" },
		}
	}

	if (questionIdsFile) {
		const raw = readFileSync(questionIdsFile, "utf8")
		return {
			questionIds: parseQuestionIdsFile(raw, questionIdsFile),
			selection: { source: "file", questionIdsFile },
		}
	}

	if (splitFile) {
		const splitKey = params.splitKey?.trim() || "held_out"
		const raw = readFileSync(splitFile, "utf8")
		const parsed = JSON.parse(raw) as unknown
		if (!isRecord(parsed) || !Array.isArray(parsed[splitKey])) {
			throw new Error(
				`MEMONGO_CANARY_SPLIT_FILE ${splitFile} must contain an array at key "${splitKey}"`,
			)
		}
		return {
			questionIds: normalizeQuestionIds(parsed[splitKey]),
			selection: { source: "split", splitFile, splitKey },
		}
	}

	return { questionIds: [] }
}

function parseQuestionIdsFile(raw: string, filename: string): string[] {
	const trimmed = raw.trim()
	if (!trimmed) {
		throw new Error(`Question-id file is empty: ${filename}`)
	}
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		const parsed = JSON.parse(trimmed) as unknown
		if (Array.isArray(parsed)) return normalizeQuestionIds(parsed)
		if (isRecord(parsed) && Array.isArray(parsed.questionIds)) {
			return normalizeQuestionIds(parsed.questionIds)
		}
		throw new Error(
			`Question-id file ${filename} must be a JSON array or an object with questionIds[]`,
		)
	}
	return normalizeQuestionIds(trimmed.split(/[\s,]+/))
}

function normalizeQuestionIds(values: readonly unknown[]): string[] {
	const seen = new Set<string>()
	const questionIds: string[] = []
	for (const value of values) {
		const id = typeof value === "string" ? value.trim() : ""
		if (!id || seen.has(id)) continue
		seen.add(id)
		questionIds.push(id)
	}
	if (questionIds.length === 0) {
		throw new Error("Question-id selection resolved to zero IDs")
	}
	return questionIds
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function summarizeSelectedEntries(entries: RawLongMemEvalEntry[]): {
	selected: RawLongMemEvalEntry[]
	selectedQuestionIds: string[]
	breakdown: Record<string, number>
} {
	const selectedQuestionIds: string[] = []
	const breakdown: Record<string, number> = {}
	for (const entry of entries) {
		selectedQuestionIds.push(entry.question_id)
		const qt = entry.question_type?.trim() || "unknown"
		breakdown[qt] = (breakdown[qt] ?? 0) + 1
	}
	return { selected: entries, selectedQuestionIds, breakdown }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

export function resolveCanaryHttpTimeoutMs(
	envValue: string | undefined,
): number {
	if (envValue === undefined || envValue.trim() === "") return 20 * 60 * 1000
	const parsed = Number(envValue)
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(
			`MEMONGO_CANARY_HTTP_TIMEOUT_MS must be a non-negative number, got ${envValue}`,
		)
	}
	return Math.floor(parsed)
}

export function resolveCanaryHeartbeatIntervalMs(
	envValue: string | undefined,
): number {
	if (envValue === undefined || envValue.trim() === "") return 30 * 1000
	const parsed = Number(envValue)
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(
			`MEMONGO_CANARY_HEARTBEAT_INTERVAL_MS must be a non-negative number, got ${envValue}`,
		)
	}
	return Math.floor(parsed)
}

export function postJson(params: {
	url: string
	payload: unknown
	timeoutMs: number
	heartbeatIntervalMs?: number
	onHeartbeat?: (elapsedMs: number) => void
}): Promise<{ statusCode: number; body: string }> {
	const body = JSON.stringify(params.payload)
	const parsed = new URL(params.url)
	return new Promise((resolve, reject) => {
		let settled = false
		let heartbeatTimer: ReturnType<typeof setInterval> | undefined
		const startedAtMs = Date.now()
		const clearHeartbeat = () => {
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer)
				heartbeatTimer = undefined
			}
		}
		const resolveOnce = (value: { statusCode: number; body: string }) => {
			if (settled) return
			settled = true
			clearHeartbeat()
			resolve(value)
		}
		const rejectOnce = (err: Error) => {
			if (settled) return
			settled = true
			clearHeartbeat()
			reject(err)
		}
		const heartbeatIntervalMs = params.heartbeatIntervalMs ?? 0
		if (heartbeatIntervalMs > 0 && params.onHeartbeat) {
			heartbeatTimer = setInterval(() => {
				if (!settled) {
					params.onHeartbeat?.(Date.now() - startedAtMs)
				}
			}, heartbeatIntervalMs)
			heartbeatTimer.unref?.()
		}
		const req = http.request(
			{
				hostname: parsed.hostname,
				port: parsed.port || 80,
				path: parsed.pathname + parsed.search,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
				timeout: params.timeoutMs,
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on("data", (chunk: Buffer) => chunks.push(chunk))
				res.on("end", () => {
					resolveOnce({
						statusCode: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					})
				})
				res.on("error", (err) => {
					rejectOnce(err)
				})
			},
		)
		req.on("timeout", () => {
			const err = new Error(
				`canary benchmark request timed out after ${params.timeoutMs}ms`,
			)
			rejectOnce(err)
			req.destroy(err)
		})
		req.on("error", (err) => {
			rejectOnce(err)
		})
		req.write(body)
		req.end()
	})
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Extract a CanaryPerRunSummary from the full benchmark response JSON.
 * Exported for testability.
 */
export function extractPerRunSummaryFromBenchmarkResponse(params: {
	runIndex: number
	artifactPath: string
	benchmarkResponse: Record<string, unknown>
}): CanaryPerRunSummary {
	const br = params.benchmarkResponse
	const officialMetrics =
		(br.officialMetrics as Record<string, unknown> | undefined) ?? {}
	const longMemEval =
		(officialMetrics.longMemEval as Record<string, unknown> | undefined) ?? {}
	const session =
		(longMemEval.session as Record<string, unknown> | undefined) ?? {}
	const turn = (longMemEval.turn as Record<string, unknown> | undefined) ?? {}

	const toNum = (v: unknown): number =>
		typeof v === "number" && Number.isFinite(v) ? v : 0

	const missLedgerRaw = Array.isArray(br.missLedger) ? br.missLedger : []
	const missLedger: string[] = []
	for (const m of missLedgerRaw) {
		if (m && typeof m === "object") {
			const caseId = (m as Record<string, unknown>).caseId
			if (typeof caseId === "string" && caseId.length > 0) {
				missLedger.push(caseId)
			}
		}
	}

	const caseDiagnosticsRaw = Array.isArray(br.caseDiagnostics)
		? br.caseDiagnostics
		: []

	return {
		runIndex: params.runIndex,
		hitRate: toNum(br.hitRate),
		rAt5: toNum(br.rAt5),
		rAt10: toNum(br.rAt10),
		ndcgAt10: toNum(br.ndcgAt10),
		sessionAny1: toNum(session.recallAnyAt1),
		turnAny1: toNum(turn.recallAnyAt1),
		missLedger,
		caseDiagnosticsLength: caseDiagnosticsRaw.length,
		artifactPath: params.artifactPath,
	}
}

/**
 * Execute one full canary run (dataset select → bootstrap → POST → write
 * artifacts). Extracted so the n≥3 discipline can iterate cleanly.
 *
 * Each run writes into `{baseDir}/run-{runIndex}/` and uses a unique
 * `MEMONGO_MONGODB_COLLECTION_PREFIX` so the benchmark API isolates its
 * MongoDB state per run (preventing Atlas Search index cache contamination).
 *
 * Returns a per-run summary for the aggregator.
 */
async function runSingleCanary(params: {
	runIndex: number
	baseDir: string
	invocationTimestampMs: number
	runsPerCommit: number
	/** Snapshotted at invocation start so repeated mutation of
	 *  process.env.MEMONGO_MONGODB_COLLECTION_PREFIX across runs does not
	 *  stack `_runN_{ts}` suffixes onto the prefix each pass. */
	invocationBasePrefix: string
}): Promise<CanaryPerRunSummary | null> {
	const {
		runIndex,
		baseDir,
		invocationTimestampMs,
		runsPerCommit,
		invocationBasePrefix,
	} = params

	// Per-run artifact dir. When runsPerCommit=1, keep back-compat: write
	// directly into baseDir (not baseDir/run-1/). This keeps existing single-
	// invocation scripts, decision-log references, and downstream summary
	// writers pointing at the same path they used before.
	const runDir =
		runsPerCommit > 1 ? deriveCanaryRunDir({ baseDir, runIndex }) : baseDir
	mkdirSync(runDir, { recursive: true })

	// Per-run collection prefix. Always derive from the invocation-level base,
	// NOT from the current process.env (which was overwritten by run N-1). This
	// keeps the prefix semantics pure: `{base}_run{N}_{invocationTimestampMs}`.
	const perRunPrefix =
		runsPerCommit > 1
			? deriveCanaryRunCollectionPrefix({
					basePrefix: invocationBasePrefix,
					runIndex,
					invocationTimestampMs,
				})
			: invocationBasePrefix
	process.env.MEMONGO_MONGODB_COLLECTION_PREFIX = perRunPrefix
	console.log(
		`[canary] run ${runIndex}/${runsPerCommit} using collectionPrefix=${perRunPrefix}`,
	)

	const startedAt = new Date()
	const runId =
		runsPerCommit > 1
			? `canary-run${runIndex}-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
			: process.env.MEMONGO_CANARY_RUN_ID?.trim() ||
				`canary-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
	const fullMode = resolveCanaryFullMode(process.env.MEMONGO_CANARY_FULL)

	console.log(
		`[canary] run=${runId} runIndex=${runIndex} dataset=${datasetPath} dryRun=${dryRun} fullMode=${fullMode} runDir=${runDir}`,
	)

	return await runCanaryBody({
		runId,
		runIndex,
		runDir,
		startedAt,
		fullMode,
	})
}

async function runCanaryBody(params: {
	runId: string
	runIndex: number
	runDir: string
	startedAt: Date
	fullMode: boolean
}): Promise<CanaryPerRunSummary | null> {
	const { runId, runIndex, runDir, startedAt, fullMode } = params

	// Load dataset
	if (!existsSync(datasetPath)) {
		throw new Error(`Dataset not found: ${datasetPath}`)
	}
	const raw = readFileSync(datasetPath, "utf8")
	const dataset = JSON.parse(raw) as unknown
	const datasetHash = createHash("sha256").update(raw).digest("hex")

	// Validate it is a raw LongMemEval array
	if (!Array.isArray(dataset) || dataset.length === 0) {
		throw new Error(
			"Dataset must be a non-empty JSON array of LongMemEval entries",
		)
	}
	const entries = dataset as RawLongMemEvalEntry[]

	// Select stratified subset.
	const { selected, selectedQuestionIds, breakdown } = fullMode
		? selectStratifiedSubset(entries, entries.length, {
				questionIds:
					selectedQuestionIdFilter.length > 0
						? selectedQuestionIdFilter
						: undefined,
			})
		: selectStratifiedSubset(entries, CASES_PER_TYPE, {
				totalCaseLimit,
				questionIds: selectedQuestionIdFilter,
			})

	console.log(
		`[canary] selected ${selectedQuestionIds.length} evaluations across ${Object.keys(breakdown).length} types from ${entries.length} total`,
	)
	for (const [qt, count] of Object.entries(breakdown)) {
		console.log(`  ${qt}: ${count}`)
	}

	const runShapeHash = computeRunShapeHash({
		casesPerType: CASES_PER_TYPE,
		totalCaseLimit: totalCaseLimit ?? null,
		questionIds: selectedQuestionIds,
		fullMode,
	})

	// Resume semantics stay per-run-dir (already isolated under run-N/ in
	// multi-run mode).
	const resumeMode = resolveCanaryResumeMode(process.env.MEMONGO_CANARY_RESUME)
	let scenariosSkipped = 0
	if (resumeMode) {
		const resumable = listResumableProgress({
			runDir,
			scenarioQuestionIds: selectedQuestionIds,
			expectedRunShapeHash: runShapeHash,
		})
		if (resumable.aborted) {
			throw new Error(
				`canary resume aborted: ${resumable.abortReason ?? "run shape mismatch"}`,
			)
		}
		if (resumable.skipQuestionIds.size > 0) {
			const beforeCount = selected.length
			for (let idx = selected.length - 1; idx >= 0; idx--) {
				const qid = selected[idx].question_id
				if (resumable.skipQuestionIds.has(qid)) {
					selected.splice(idx, 1)
					selectedQuestionIds.splice(idx, 1)
				}
			}
			scenariosSkipped = beforeCount - selected.length
			console.log(
				`[canary] resume mode: skipped ${scenariosSkipped}/${beforeCount} already-completed scenarios`,
			)
		}
	}

	// Write subset dataset inside the workspace so the benchmark API accepts it
	const subsetDir = path.join(workspaceDir, "benchmarks", "canary")
	mkdirSync(subsetDir, { recursive: true })
	const subsetPath = path.join(subsetDir, `${runId}.json`)
	writeFileSync(subsetPath, JSON.stringify(selected, null, 2))
	const httpTimeoutMs = resolveCanaryHttpTimeoutMs(
		process.env.MEMONGO_CANARY_HTTP_TIMEOUT_MS,
	)
	const heartbeatIntervalMs = resolveCanaryHeartbeatIntervalMs(
		process.env.MEMONGO_CANARY_HEARTBEAT_INTERVAL_MS,
	)

	const caseLimits = buildCanaryArtifactCaseLimits({
		fullMode,
		casesPerType: CASES_PER_TYPE,
		totalCaseLimit,
	})

	const artifact: CanaryArtifact = {
		artifactVersion: 2,
		runId,
		status: "started",
		startedAt: startedAt.toISOString(),
		datasetPath,
		datasetHash,
		subsetPath,
		httpRequest: {
			endpointPath: "/v1/admin/relevance/benchmark",
			maxResults,
			timeoutMs: httpTimeoutMs,
			heartbeatIntervalMs,
		},
		runtime: buildCanaryRuntimeSnapshot(),
		casesPerType: caseLimits.casesPerType,
		totalCaseLimit: caseLimits.totalCaseLimit,
		fullMode,
		runShapeHash,
		...(selectedQuestionIdFilter.length > 0
			? { selectedQuestionIdFilter }
			: {}),
		...(questionIdFilterResolution.selection
			? { questionIdSelection: questionIdFilterResolution.selection }
			: {}),
		totalEvaluations: selectedQuestionIds.length,
		selectedQuestionIds,
		questionTypeBreakdown: breakdown,
	}
	const artifactPath = writeCanaryArtifactFile({ runDir, artifact })
	console.log(`[canary] started. Artifact: ${artifactPath}`)

	if (dryRun) {
		artifact.status = "completed"
		artifact.completedAt = new Date().toISOString()
		writeCanaryArtifactFile({ runDir, artifact })
		console.log(`[canary] dry-run complete. Artifact: ${artifactPath}`)
		console.log(JSON.stringify({ ok: true, runId, dryRun: true }, null, 2))
		return null
	}

	// Call benchmark API with the subset
	const agentId = `canary-${runId}`
	console.log(
		`[canary] posting benchmark to ${baseUrl}/v1/admin/relevance/benchmark`,
	)
	let heartbeatCount = 0
	let response: { statusCode: number; body: string }
	try {
		response = await postJson({
			url: `${baseUrl}/v1/admin/relevance/benchmark`,
			timeoutMs: httpTimeoutMs,
			heartbeatIntervalMs,
			onHeartbeat: (elapsedMs) => {
				heartbeatCount += 1
				artifact.lastHeartbeatAt = new Date().toISOString()
				artifact.heartbeatCount = heartbeatCount
				writeCanaryArtifactFile({ runDir, artifact })
				writeCanaryHeartbeatFile({
					runDir,
					runId,
					elapsedMs,
					heartbeatCount,
					message: "waiting for benchmark API response",
				})
				console.log(
					`[canary] waiting for benchmark response elapsedMs=${elapsedMs}`,
				)
			},
			payload: {
				agentId,
				datasetPath: subsetPath,
				maxResults,
				datasetSha256: datasetHash,
				retrievalLane:
					nullableEnv("MEMONGO_BENCHMARK_RETRIEVAL_LANE") ?? undefined,
			},
		})
	} catch (err) {
		artifact.status = "failed"
		artifact.error = err instanceof Error ? err.message : String(err)
		artifact.failureClass = classifyBenchmarkFailure(err)
		artifact.completedAt = new Date().toISOString()
		writeCanaryArtifactFile({ runDir, artifact })
		throw err
	}

	if (response.statusCode < 200 || response.statusCode >= 300) {
		artifact.status = "failed"
		artifact.error = `HTTP ${response.statusCode}: ${response.body.slice(0, 500)}`
		artifact.failureClass = classifyBenchmarkFailure(new Error(artifact.error))
		artifact.completedAt = new Date().toISOString()
		writeCanaryArtifactFile({ runDir, artifact })
		throw new Error(artifact.error)
	}

	let benchmarkResponse: Record<string, unknown>
	try {
		benchmarkResponse = JSON.parse(response.body) as Record<string, unknown>
	} catch (err) {
		artifact.status = "failed"
		artifact.error = err instanceof Error ? err.message : String(err)
		artifact.failureClass = classifyBenchmarkFailure(err)
		artifact.completedAt = new Date().toISOString()
		writeCanaryArtifactFile({ runDir, artifact })
		throw err
	}
	artifact.status = "completed"
	artifact.benchmarkResponse = benchmarkResponse
	artifact.metrics = benchmarkResponse.benchmarkReport as
		| Record<string, unknown>
		| undefined
	artifact.completedAt = new Date().toISOString()

	const responseMetricsDigest =
		typeof benchmarkResponse.rAt5 === "number" ||
		typeof benchmarkResponse.hitRate === "number"
			? {
					rAt5: benchmarkResponse.rAt5,
					rAt10: benchmarkResponse.rAt10,
					ndcgAt10: benchmarkResponse.ndcgAt10,
					hitRate: benchmarkResponse.hitRate,
				}
			: null
	for (let idx = 0; idx < selected.length; idx++) {
		const entry = selected[idx]
		writeScenarioProgress({
			runDir,
			index: idx,
			questionId: entry.question_id,
			questionType: entry.question_type || "unknown",
			passStatus: "abstain",
			failureClass: null,
			metrics: responseMetricsDigest,
			completed: false,
			reason: "bulk-api-no-per-case-stream-yet",
			runShapeHash,
		})
	}

	// Write per-run artifacts
	const responsePath = path.join(runDir, "benchmark-response.json")
	writeCanaryArtifactFile({ runDir, artifact })
	writeFileSync(responsePath, JSON.stringify(benchmarkResponse, null, "\t"))

	console.log(`[canary] complete. Artifact: ${artifactPath}`)
	console.log(
		JSON.stringify(
			{
				ok: true,
				runId,
				runIndex,
				totalEvaluations: selectedQuestionIds.length,
				breakdown,
				artifactPath,
				responsePath,
			},
			null,
			2,
		),
	)

	return extractPerRunSummaryFromBenchmarkResponse({
		runIndex,
		artifactPath,
		benchmarkResponse,
	})
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return
	await new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
	const startedAt = new Date()
	const invocationTimestampMs = startedAt.getTime()

	// n≥3 canary sampling discipline. Default 1 for back-compat.
	const runsPerCommit = resolveCanaryRunsPerCommit(
		process.env.MEMONGO_CANARY_RUNS_PER_COMMIT,
	)
	const runIntervalMs = resolveCanaryRunIntervalMs(
		process.env.MEMONGO_CANARY_RUN_INTERVAL_MS,
	)

	// Base directory holds per-run subdirs + aggregate-summary.json.
	const fallbackRunId = `canary-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
	const baseDir = resolveCanaryArtifactDir({
		runId: fallbackRunId,
		envDir: process.env.MEMONGO_CANARY_ARTIFACT_DIR,
		repoRoot,
	})
	mkdirSync(baseDir, { recursive: true })
	const rerankEnabled = resolveCanaryRerankEnabled({
		rerankingEnabledEnv: process.env.MEMONGO_RERANKING_ENABLED,
		benchmarkRerankModeEnv: process.env.MEMONGO_BENCHMARK_RERANK_MODE,
	})

	if (
		!dryRun &&
		resolveCanaryModelPreflightMode({
			modelPreflightEnv: process.env.MEMONGO_CANARY_MODEL_PREFLIGHT,
			strictEnv: process.env.MEMONGO_BENCHMARK_STRICT,
			rerankEnabled,
		})
	) {
		const preflight = await runVoyageRerankPreflight({
			apiKey: process.env.VOYAGE_API_KEY,
			timeoutMs: resolveCanaryModelPreflightTimeoutMs(
				process.env.MEMONGO_CANARY_MODEL_PREFLIGHT_TIMEOUT_MS,
			),
			requireAtlasModelKey: resolveCanaryRequireAtlasModelKey(
				process.env.MEMONGO_CANARY_REQUIRE_ATLAS_MODEL_KEY,
			),
		})
		console.log(
			`[canary] model preflight ok: rerank endpoint accepted ${preflight.keyKind} credential`,
		)
	}

	if (runsPerCommit > 1) {
		console.log(
			`[canary] n≥3 discipline: runsPerCommit=${runsPerCommit} runIntervalMs=${runIntervalMs} baseDir=${baseDir}`,
		)
	}

	// Snapshot the invocation-level base collection prefix once so per-run
	// isolation does not stack `_runN_{ts}` suffixes each pass.
	const invocationBasePrefix = resolveBenchmarkCollectionPrefix({
		runId: fallbackRunId,
		explicitPrefix: process.env.MEMONGO_MONGODB_COLLECTION_PREFIX,
	}).collectionPrefix

	const perRunSummaries: CanaryPerRunSummary[] = []
	for (let runIndex = 1; runIndex <= runsPerCommit; runIndex++) {
		const summary = await runSingleCanary({
			runIndex,
			baseDir,
			invocationTimestampMs,
			runsPerCommit,
			invocationBasePrefix,
		})
		if (summary !== null) {
			perRunSummaries.push(summary)
		}
		if (runIndex < runsPerCommit && runIntervalMs > 0) {
			console.log(
				`[canary] sleeping ${runIntervalMs}ms before run ${runIndex + 1}/${runsPerCommit}`,
			)
			await sleep(runIntervalMs)
		}
	}

	if (runsPerCommit > 1 && perRunSummaries.length > 0) {
		const aggregate = computeCanaryAggregateSummary({ runs: perRunSummaries })
		const aggregatePath = path.join(baseDir, "aggregate-summary.json")
		writeFileSync(aggregatePath, JSON.stringify(aggregate, null, "\t"))
		console.log(`[canary] aggregate-summary written: ${aggregatePath}`)
		console.log(
			`[canary] verdict=${aggregate.verdict} hitRate.mean=${aggregate.aggregate.hitRate.mean.toFixed(3)} min=${aggregate.aggregate.hitRate.min.toFixed(3)} max=${aggregate.aggregate.hitRate.max.toFixed(3)} deterministicMisses=${aggregate.deterministicMisses.length} varianceMisses=${aggregate.varianceMisses.length}`,
		)
		console.log(`[canary] reasoning: ${aggregate.reasoning}`)
	}
}

/**
 * Task 1.4 — write `failure.json` in the run dir when main() throws so the
 * forensic trail captures the failure class even if no scenarios completed.
 * Falls back to a best-effort artifact dir when MEMONGO_CANARY_ARTIFACT_DIR
 * is set; otherwise uses the default path resolver.
 */
function writeTopLevelFailureArtifact(err: unknown): void {
	try {
		const failureClass: BenchmarkFailureClass = classifyBenchmarkFailure(err)
		const envDir = process.env.MEMONGO_CANARY_ARTIFACT_DIR
		const runIdForFallback =
			process.env.MEMONGO_CANARY_RUN_ID?.trim() ||
			`canary-failure-${Date.now()}`
		const runDir = resolveCanaryArtifactDir({
			runId: runIdForFallback,
			envDir,
			repoRoot: process.cwd(),
		})
		mkdirSync(runDir, { recursive: true })
		const doc = {
			failedAt: new Date().toISOString(),
			failureClass,
			message: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		}
		writeFileSync(
			path.join(runDir, "failure.json"),
			JSON.stringify(doc, null, "\t"),
		)
	} catch {
		// Never swallow the original error — best-effort artifact only.
	}
}

if (import.meta.main) {
	main().catch((err) => {
		writeTopLevelFailureArtifact(err)
		console.error(err instanceof Error ? err.stack || err.message : err)
		process.exitCode = 1
	})
}
