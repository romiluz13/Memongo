import { promises as fs } from "node:fs"
import type {
	EnrichmentAuthStyle,
	EnrichmentChatUsage,
	EnrichmentProvider,
	EnrichmentResponseMeta,
	EnrichmentTokenParam,
} from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import {
	createHttpProvider,
	withRetry,
} from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import {
	benchmarkAnswerModelName,
	resolveBenchmarkAnswerProvider,
} from "./benchmark-answer-provider.js"
import type {
	BenchmarkE2eQaEnvelope,
	MemoryResultRole,
} from "../../packages/memory-engine/src/types.js"
import { LONGMEMEVAL_RELEASE_V2 } from "./benchmark-quality-contracts.js"
import type { BenchmarkJudgedAnswerMaterial } from "./benchmark-answer-quality.js"
import {
	OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
	OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
	OFFICIAL_LONGMEMEVAL_S_CASE_COUNT,
	OFFICIAL_QA_QUESTION_TYPE_ORDER,
	OfficialLongMemEvalQaError,
	buildOfficialAnscheckPrompt,
	computeOfficialLongMemEvalQaMetrics,
	isOfficialAbstentionQuestion,
	validateOfficialLongMemEvalFullCoverage,
} from "./longmemeval-official-qa.js"
import type {
	OfficialLongMemEvalQaMetrics,
	OfficialQaPrediction,
	OfficialQaReference,
} from "./longmemeval-official-qa.js"
import {
	createOfficialPredictionSidecar,
	deriveOfficialPredictionSidecarPath,
	readOfficialPredictionSidecar,
	recordOfficialAnswer,
	recordOfficialUnreliable,
	recordOfficialVerdict,
	writeOfficialPredictionSidecarAtomic,
} from "./longmemeval-prediction-sidecar.js"
import type { OfficialPredictionSidecar } from "./longmemeval-prediction-sidecar.js"

/**
 * Official LongMemEval QA scoring, wired into the benchmark manager.
 *
 * Opt-in via MEMONGO_BENCHMARK_QA_PROTOCOL=official (anything else keeps the
 * legacy custom-v1 harness untouched). Official mode:
 *
 *   - answers every declared case with a dated answer prompt (our prompt; the
 *     judge prompt stays byte-exact with the pinned upstream evaluator),
 *   - judges each answer with a separate provider that must run the pinned
 *     judge model,
 *   - persists answers and verdicts to a private sidecar beside the
 *     checkpoint so a crashed run resumes without re-paying for judged rows,
 *   - refuses to publish accuracy unless coverage is honest: partial runs
 *     report null accuracy plus the missing question ids, and the full
 *     export additionally requires exact-500 coverage.
 */

// ---------------------------------------------------------------------------
// Protocol and provider resolution
// ---------------------------------------------------------------------------

export type BenchmarkQaProtocol = "custom-v1" | "official" | "custom-judge"

/**
 * Resolve the QA protocol from env. Only the exact values "official" and
 * "custom-judge" opt into a durable-protocol run; undefined and "custom-v1"
 * keep the legacy harness, and anything else fails preflight before any
 * paid work.
 */
export function resolveBenchmarkQaProtocol(
	env: Record<string, string | undefined>,
): BenchmarkQaProtocol {
	const value = env.MEMONGO_BENCHMARK_QA_PROTOCOL
	if (value === undefined || value === "custom-v1") {
		return "custom-v1"
	}
	if (value === "official" || value === "custom-judge") {
		return value
	}
	throw new Error(
		`MEMONGO_BENCHMARK_QA_PROTOCOL must be "official" or "custom-v1", got ${JSON.stringify(value)}`,
	)
}

const JUDGE_AUTH_STYLES: ReadonlySet<string> = new Set([
	"authorization-bearer",
	"api-key",
	"x-api-key",
])
const JUDGE_TOKEN_PARAMS: ReadonlySet<string> = new Set([
	"max_tokens",
	"max_completion_tokens",
])

/**
 * Build the separate judge provider from MEMONGO_BENCHMARK_JUDGE_* env vars.
 * OpenAI-compatible only (both durable protocols talk to an
 * OpenAI-compatible endpoint). The official protocol requires the exact
 * pinned judge model; the custom-judge protocol accepts any configured model
 * (a non-official judge, e.g. gpt-5.6-luna) and never pins. Building the
 * provider makes no network call.
 */
export function resolveBenchmarkOfficialJudgeProvider(
	env: Record<string, string | undefined>,
	protocol: Extract<
		BenchmarkQaProtocol,
		"official" | "custom-judge"
	> = "official",
): EnrichmentProvider {
	const protocolLabel = protocol === "official" ? "official" : "custom-judge"
	const apiKey = env.MEMONGO_BENCHMARK_JUDGE_API_KEY?.trim()
	if (!apiKey) {
		throw new Error(
			`${protocolLabel} QA judge requires MEMONGO_BENCHMARK_JUDGE_API_KEY`,
		)
	}
	const baseUrl = env.MEMONGO_BENCHMARK_JUDGE_BASE_URL?.trim()
	if (!baseUrl) {
		throw new Error(
			`${protocolLabel} QA judge requires MEMONGO_BENCHMARK_JUDGE_BASE_URL`,
		)
	}
	const model = env.MEMONGO_BENCHMARK_JUDGE_MODEL?.trim()
	if (!model) {
		throw new Error(
			`${protocolLabel} QA judge requires MEMONGO_BENCHMARK_JUDGE_MODEL`,
		)
	}
	if (
		protocol === "official" &&
		model !== OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL
	) {
		throw new Error(
			`official QA judge requires model ${OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL}, got ${model}`,
		)
	}
	const authStyle = env.MEMONGO_BENCHMARK_JUDGE_AUTH_STYLE?.trim()
	if (
		authStyle !== undefined &&
		authStyle !== "" &&
		!JUDGE_AUTH_STYLES.has(authStyle)
	) {
		throw new Error(
			`MEMONGO_BENCHMARK_JUDGE_AUTH_STYLE must be one of authorization-bearer, api-key, x-api-key, got ${JSON.stringify(authStyle)}`,
		)
	}
	const tokenParam = env.MEMONGO_BENCHMARK_JUDGE_TOKEN_PARAM?.trim()
	if (
		tokenParam !== undefined &&
		tokenParam !== "" &&
		!JUDGE_TOKEN_PARAMS.has(tokenParam)
	) {
		throw new Error(
			`MEMONGO_BENCHMARK_JUDGE_TOKEN_PARAM must be max_tokens or max_completion_tokens, got ${JSON.stringify(tokenParam)}`,
		)
	}
	return createHttpProvider({
		baseUrl,
		apiKey,
		model,
		provider: "openai-compatible",
		...(authStyle ? { authStyle: authStyle as EnrichmentAuthStyle } : {}),
		...(tokenParam ? { tokenParam: tokenParam as EnrichmentTokenParam } : {}),
	})
}

// ---------------------------------------------------------------------------
// Dated answer prompt (ours; the judge prompt is Slice A, byte-exact)
// ---------------------------------------------------------------------------

export const OFFICIAL_DATED_ANSWER_VERSION = "dated-v2"

/**
 * B8/B9-3: pinned answer-call settings for every durable-protocol run. The
 * values are recorded in the sidecar identity (B9-3) so answers made under
 * different settings never share rows, and the preflight probe (B8-2) pays
 * one cheap call to verify the provider accepts them before the run pays
 * for retrieval or burns a partial multi-question pass.
 */
export const OFFICIAL_ANSWER_TEMPERATURE = 0
export const OFFICIAL_ANSWER_MAX_TOKENS = 4096
/**
 * N1: bounded in-process transport retries on the answer call (3 attempts
 * total: 1 + 2 retries, exponential backoff with jitter, via the shared
 * enrichment retry policy — 408/429/5xx, timeouts and network errors).
 * Transport-class failures are not deterministic measurement failures, so
 * they are retried here and, if they persist, rethrown so the scenario
 * aborts un-checkpointed and --resume retries them — never recorded as
 * sticky unreliable rows. Length, empty and unparseable answers stay
 * terminal unreliable rows (temperature 0 reproduces those).
 */
export const OFFICIAL_ANSWER_TRANSPORT_RETRIES = 2
/**
 * J1: judge completions that are empty, truncated, or not a clean yes/no get
 * this many fresh judge calls before the case is recorded unreliable.
 */
export const OFFICIAL_JUDGE_CONTENT_RETRIES = 1

const OFFICIAL_DATED_ANSWER_ROLE_LABELS: Record<MemoryResultRole, string> = {
	user: "User",
	assistant: "Assistant",
	system: "System",
	tool: "Tool",
}

const OFFICIAL_DATED_ANSWER_SYSTEM_PROMPT = [
	"You answer questions about a user from stored memory passages.",
	"Work in two steps. First take notes: for each passage that bears on the question, record the passage number, the relevant fact, and the session date(s) that passage carries. Then reason over your notes in order and answer.",
	"The passages are presented in chronological order by session date (earliest first); passages without a session date come last, in retrieval order. Each passage is labeled with its session date(s) and, when known, the speaking role (User or Assistant).",
	'When the question or the context carries date(s) of the conversation session(s), use those dates to resolve relative time references ("last week", "recently").',
	"For facts that changed across sessions, the latest dated statement wins: answer with the most recent value, and mention the earlier value too.",
	"If the passages do not contain the answer, say that the memory does not cover it instead of guessing.",
	'Return only JSON of the form {"notes":[{"passage":<number>,"relevant_fact":"...","date":"..."}],"reasoning":"...","answer":"..."} with a concise final answer.',
].join(" ")

/**
 * Passage indices in chronological order: dated passages by their earliest
 * session date ascending (YYYY/MM/DD strings compare chronologically), then
 * undated passages in capture (retrieval) order. Stable for ties, so equal
 * dates keep retrieval order.
 */
function chronologicalPassageIndices(
	material: Pick<
		BenchmarkJudgedAnswerMaterial,
		"contextPassages" | "passageDates"
	>,
): number[] {
	const indices = material.contextPassages.map((_, index) => index)
	const earliestDate = (index: number): string | undefined => {
		const dates = material.passageDates?.[index] ?? []
		return dates.length > 0 ? [...dates].sort()[0] : undefined
	}
	return indices.sort((a, b) => {
		const dateA = earliestDate(a)
		const dateB = earliestDate(b)
		if (dateA !== undefined && dateB !== undefined) {
			return dateA < dateB ? -1 : dateA > dateB ? 1 : a - b
		}
		if (dateA !== undefined) return -1
		if (dateB !== undefined) return 1
		return a - b
	})
}

/**
 * B9-2: chunk text already carries its role label ("User: ..." from the
 * event renderer), so a second label from this prompt builder would read
 * "User: User: ...". The prompt only adds its own label when the passage
 * text does not already start with it.
 */
function passageAlreadyCarriesRoleLabel(
	passage: string,
	label: string,
): boolean {
	return passage.startsWith(`${label}:`) || passage.startsWith(`${label} :`)
}

/**
 * Build the dated answer user content: the question (with its ask date when
 * known), the pass-0 context passages sorted chronologically by session date
 * and labeled with their date(s) and speaking role, and the JSON-only
 * chain-of-note return instruction.
 */
export function buildOfficialDatedAnswerUserContent(
	material: Pick<
		BenchmarkJudgedAnswerMaterial,
		| "question"
		| "contextPassages"
		| "questionDate"
		| "passageDates"
		| "passageRoles"
	>,
): string {
	const lines: string[] = []
	if (material.questionDate) {
		lines.push(
			`QUESTION (asked on ${material.questionDate}): ${material.question}`,
		)
	} else {
		lines.push(`QUESTION: ${material.question}`)
	}
	lines.push("<context>")
	chronologicalPassageIndices(material).forEach((index, position) => {
		const passage = material.contextPassages[index]
		if (passage === undefined) return
		const dates = material.passageDates?.[index] ?? []
		const role = material.passageRoles?.[index]
		const label =
			role !== undefined
				? (OFFICIAL_DATED_ANSWER_ROLE_LABELS[role] ?? role)
				: undefined
		const datePrefix = dates.length > 0 ? ` [${dates.join("; ")}]` : ""
		// B9-2: only add the role label when the passage text does not
		// already start with the same label.
		const rolePrefix =
			label !== undefined && !passageAlreadyCarriesRoleLabel(passage, label)
				? ` ${label}:`
				: ""
		lines.push(`[${position + 1}]${datePrefix}${rolePrefix} ${passage}`)
	})
	lines.push("</context>")
	lines.push(
		'Return only {"notes":[{"passage":<number>,"relevant_fact":"...","date":"..."}],"reasoning":"...","answer":"..."}.',
	)
	return lines.join("\n")
}

export function buildOfficialDatedAnswerMessages(
	material: Pick<
		BenchmarkJudgedAnswerMaterial,
		| "question"
		| "contextPassages"
		| "questionDate"
		| "passageDates"
		| "passageRoles"
	>,
): Array<{ role: string; content: string }> {
	return [
		{ role: "system", content: OFFICIAL_DATED_ANSWER_SYSTEM_PROMPT },
		{ role: "user", content: buildOfficialDatedAnswerUserContent(material) },
	]
}

// ---------------------------------------------------------------------------
// Official QA context and preflight
// ---------------------------------------------------------------------------

export type OfficialQaUnavailableReason =
	| "missing-gold"
	| "unsupported-question-type"

export type OfficialQaStats = {
	attempts: { answerGeneration: number; answerJudge: number }
	successes: { answerGeneration: number; answerJudge: number }
	failures: { answerGeneration: number; answerJudge: number }
	/**
	 * B8-3/B9-1: cases recorded as unreliable (provider failure, budget
	 * truncation, empty answer, or a response with no extractable answer).
	 * Terminal like judged but excluded from coverage; the run continues.
	 */
	unreliable: { answerGeneration: number; answerJudge: number }
}

export type OfficialQaContext = {
	/** Which durable QA protocol this run uses (official or custom-judge). */
	protocol: Extract<BenchmarkQaProtocol, "official" | "custom-judge">
	answerProvider: EnrichmentProvider
	judgeProvider: EnrichmentProvider
	answerModel: string
	judgeModel: string
	sidecarPath: string
	sidecar: OfficialPredictionSidecar
	stats: OfficialQaStats
	unavailable: Array<{
		questionId: string
		reason: OfficialQaUnavailableReason
	}>
}

/**
 * Preflight a durable QA run (official or custom-judge). Validation failure
 * modes fire before any provider call: missing checkpoint path, missing
 * answer provider, a judge model equal to the answer model (the contract
 * requires a distinct judge), a sidecar that does not match this run, and —
 * on resume — a completed checkpoint scenario whose declared cases are not
 * all judged or unreliable in the sidecar. After validation, one cheap
 * preflight answer call (B8-2) probes the pinned answer settings so a
 * provider that rejects them fails before the run pays for anything else.
 */
export async function prepareOfficialQa(params: {
	env: Record<string, string | undefined>
	checkpointPath: string | undefined
	runId: string
	configurationHash: string
	datasetSha256: string
	resumeCompletedScenarios?: Array<{
		scenarioId: string
		declaredCaseIds: string[]
	}>
	resolveProviders?: () => {
		answer: EnrichmentProvider | null
		judge: EnrichmentProvider
	}
}): Promise<OfficialQaContext> {
	// The manager dispatches here only after resolving "official" or
	// "custom-judge" from this same env, so production never arrives with the
	// env unset; direct callers that leave it unset get the historical
	// official default. An explicit "custom-v1" (or unknown) value is a
	// misrouted call and fails before any paid work.
	const protocolValue = params.env.MEMONGO_BENCHMARK_QA_PROTOCOL
	let protocol: Extract<BenchmarkQaProtocol, "official" | "custom-judge"> =
		"official"
	if (protocolValue !== undefined) {
		const resolved = resolveBenchmarkQaProtocol(params.env)
		if (resolved === "custom-v1") {
			throw new Error(
				`MEMONGO_BENCHMARK_QA_PROTOCOL=${resolved} does not use the durable scoring path`,
			)
		}
		protocol = resolved
	}
	if (!params.checkpointPath) {
		throw new Error(
			`MEMONGO_BENCHMARK_QA_PROTOCOL=${protocol} requires checkpointPath: predictions must persist beside the checkpoint for crash-safe resume`,
		)
	}
	const providers = params.resolveProviders
		? params.resolveProviders()
		: {
				answer: resolveBenchmarkAnswerProvider(params.env),
				judge: resolveBenchmarkOfficialJudgeProvider(params.env, protocol),
			}
	if (!providers.answer) {
		throw new Error(
			`${protocol} QA mode requires a benchmark answer provider for answer generation: set MEMONGO_BENCHMARK_ANSWER_API_KEY, MEMONGO_BENCHMARK_ANSWER_BASE_URL and MEMONGO_BENCHMARK_ANSWER_MODEL, or the MEMONGO_ENRICHMENT_* fallback, or unset MEMONGO_BENCHMARK_QA_PROTOCOL`,
		)
	}
	const answerModel = benchmarkAnswerModelName(params.env)
	const judgeModel = params.env.MEMONGO_BENCHMARK_JUDGE_MODEL?.trim() ?? ""
	if (answerModel && judgeModel && judgeModel === answerModel) {
		throw new Error(
			`${protocol} QA mode requires a judge model distinct from the answer model (both are ${answerModel}); self-judging is not comparable to the official protocol`,
		)
	}
	const sidecarPath = deriveOfficialPredictionSidecarPath(params.checkpointPath)
	const identity = {
		runId: params.runId,
		datasetSha256: params.datasetSha256,
		configurationHash: params.configurationHash,
		answerModel,
		judgeModel,
		judgeProtocol:
			protocol === "official" ? "official-anscheck" : "custom-judge-anscheck",
		promptVersion: OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
		// B9-3: the answer prompt and answer-call settings belong to the run
		// identity. Without them, a dated-v1 run and a dated-v2 run (or a run
		// with different temperature/maxTokens) share rows silently.
		answerPromptVersion: OFFICIAL_DATED_ANSWER_VERSION,
		answerTemperature: `${OFFICIAL_ANSWER_TEMPERATURE}`,
		answerMaxTokens: `${OFFICIAL_ANSWER_MAX_TOKENS}`,
	}
	const sidecar =
		(await readOfficialPredictionSidecar(sidecarPath, identity)) ??
		createOfficialPredictionSidecar(identity)
	for (const scenario of params.resumeCompletedScenarios ?? []) {
		for (const caseId of scenario.declaredCaseIds) {
			const stage = sidecar.rows[caseId]?.stage
			// B8-3: unreliable rows are terminal like judged ones — the
			// scenario resolved every case (judged or honestly unmeasured), so
			// a resume must not re-run or re-pay for it.
			if (stage !== "judged" && stage !== "unreliable") {
				throw new Error(
					`checkpoint claims scenario ${scenario.scenarioId} is complete but the official prediction sidecar has no judged or unreliable row for question ${caseId}; the checkpoint and sidecar disagree, so the run cannot resume — delete the checkpoint or restore the matching sidecar`,
				)
			}
		}
	}
	// B8-2: one cheap paid probe with the exact run settings. Answer routes
	// that reject temperature:0 (HTTP 400 unsupported_value on some
	// reasoning-class endpoints) must fail here, before the run pays for
	// retrieval or burns a partial multi-question pass, with an actionable
	// message instead of a per-question failure loop.
	await preflightOfficialAnswerProvider(providers.answer, answerModel, protocol)
	return {
		protocol,
		answerProvider: providers.answer,
		judgeProvider: providers.judge,
		answerModel,
		judgeModel,
		sidecarPath,
		sidecar,
		stats: {
			attempts: { answerGeneration: 0, answerJudge: 0 },
			successes: { answerGeneration: 0, answerJudge: 0 },
			failures: { answerGeneration: 0, answerJudge: 0 },
			unreliable: { answerGeneration: 0, answerJudge: 0 },
		},
		unavailable: [],
	}
}

/**
 * B8-2: preflight the answer provider with the exact pinned answer settings.
 * The probe prompt is trivial, so the call costs near nothing on a plain
 * model; a rejection of temperature:0 or the token budget fails fast with a
 * message that names the setting and the way out.
 */
async function preflightOfficialAnswerProvider(
	provider: EnrichmentProvider,
	model: string,
	protocol: Extract<BenchmarkQaProtocol, "official" | "custom-judge">,
): Promise<void> {
	try {
		// N1: a transient 503/timeout at preflight must not abort the run
		// with a temperature-flavored message; the same bounded transport
		// retry as the answer call applies. A 400-style rejection of the
		// pinned settings is not transport-class and still fails fast.
		await withRetry(
			() =>
				provider.chatCompletion({
					model,
					messages: [
						{
							role: "user",
							content:
								"Benchmark preflight probe. Reply with the single word: ok",
						},
					],
					maxTokens: OFFICIAL_ANSWER_MAX_TOKENS,
					temperature: OFFICIAL_ANSWER_TEMPERATURE,
				}),
			OFFICIAL_ANSWER_TRANSPORT_RETRIES,
		)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(
			`${protocol} QA answer provider preflight failed (settings: temperature=${OFFICIAL_ANSWER_TEMPERATURE}, maxTokens=${OFFICIAL_ANSWER_MAX_TOKENS}, model=${model}): ${message}. If the provider rejects temperature:0, point MEMONGO_BENCHMARK_ANSWER_* at a provider that accepts it, or unset MEMONGO_BENCHMARK_QA_PROTOCOL to fall back to the legacy harness`,
		)
	}
}

// ---------------------------------------------------------------------------
// Per-scenario scoring
// ---------------------------------------------------------------------------

const SUPPORTED_QUESTION_TYPES: ReadonlySet<string> = new Set(
	OFFICIAL_QA_QUESTION_TYPE_ORDER,
)

/**
 * Strip the markdown code fence some answer models wrap their JSON in
 * (```json ... ``` or ``` ... ```), leaving the fenced body.
 */
function stripJsonCodeFences(content: string): string {
	const trimmed = content.trim()
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
	return fenced ? (fenced[1] ?? "") : trimmed
}

/**
 * Yield every balanced top-level {...} object in a response that may carry
 * prose before, between or after JSON (reasoning-class models prepend or
 * append commentary, and thinking blocks can contain their own braces).
 * String-aware: braces inside JSON strings do not count toward the balance.
 * Candidates are yielded left to right, non-overlapping; an unterminated
 * opening brace skips ahead to the next `{` instead of giving up (N4).
 */
function* iterateBalancedObjects(content: string): Generator<string> {
	let cursor = 0
	while (cursor < content.length) {
		const start = content.indexOf("{", cursor)
		if (start === -1) {
			return
		}
		let depth = 0
		let inString = false
		let escaped = false
		for (let index = start; index < content.length; index += 1) {
			const char = content[index]
			if (escaped) {
				escaped = false
				continue
			}
			if (inString && char === "\\") {
				escaped = true
				continue
			}
			if (char === '"') {
				inString = !inString
				continue
			}
			if (inString) {
				continue
			}
			if (char === "{") {
				depth += 1
			} else if (char === "}") {
				depth -= 1
				if (depth === 0) {
					const candidate = content.slice(start, index + 1)
					cursor = index + 1
					yield candidate
					break
				}
			}
		}
		if (depth !== 0) {
			// Unterminated from `start`: a later `{` may still close (e.g. a
			// thinking block's stray brace before the real answer object).
			cursor = start + 1
		}
	}
}

export type ParsedOfficialHypothesis =
	| { kind: "answer"; answer: string }
	| { kind: "unreliable"; reason: string }

/**
 * Extract the hypothesis from an answer-model response. The chain-of-note
 * prompt asks for {"notes":[...],"reasoning":"...","answer":"..."}; only the
 * final answer string is scored. Reasoning-class models fence the JSON or
 * surround it with prose (and thinking blocks can carry their own braces),
 * so the extraction strips fences and tries every balanced object in order,
 * taking the first that parses with a string answer (N4). Raw reasoning
 * text is never sent to the judge: a response with no extractable answer is
 * an unreliable measurement (B9-1). A fence-free single line of plain prose
 * is a bare answer and is used as-is — but content that looks like JSON
 * (any brace or bracket, or a code fence) is never a bare answer: it is a
 * truncated or unparseable response and is unreliable (N3).
 */
export function parseOfficialHypothesis(
	content: string,
): ParsedOfficialHypothesis {
	const fenced = stripJsonCodeFences(content)
	for (const candidate of iterateBalancedObjects(fenced)) {
		try {
			const parsed: unknown = JSON.parse(candidate)
			if (typeof parsed === "object" && parsed !== null) {
				const answer = (parsed as { answer?: unknown }).answer
				if (typeof answer === "string" && answer.trim() !== "") {
					return { kind: "answer", answer }
				}
				// Parses but carries no usable answer field: a later object
				// may be the real answer (N4), so keep iterating.
			}
		} catch {
			// Not JSON (prose brace): a later object may still be the answer.
		}
	}
	// N3: no balanced object produced an answer. If the content looks like
	// JSON at all — any brace or bracket, or a code fence — the bare-line
	// fallback would ship truncated JSON or raw reasoning to the judge
	// (B9-1), so it is never used for JSON-looking content.
	const looksLikeJson =
		fenced.includes("{") ||
		fenced.includes("[") ||
		content.trimStart().startsWith("```")
	if (looksLikeJson) {
		return {
			kind: "unreliable",
			reason:
				"unterminated or unparseable JSON in the answer model response (no bare-line fallback for JSON-looking content)",
		}
	}
	// No object at all: a single non-empty line is a plausible bare answer;
	// multi-line prose or reasoning is not.
	const lines = fenced
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
	if (lines.length === 1) {
		return { kind: "answer", answer: lines[0] ?? "" }
	}
	return {
		kind: "unreliable",
		reason:
			"answer model response contained no extractable answer JSON and was not a single-line answer",
	}
}

/**
 * Score one scenario's declared cases against the official protocol. Stages
 * each case "answered" then "judged" in the sidecar, writing after every
 * stage so a crash never re-pays for finished work. Judged rows are reused
 * with zero provider calls; answered rows skip the answer call. Cases with
 * no measurable target (missing gold, unsupported question type) are marked
 * unavailable before any paid work. B8-3: a deterministic reliability
 * failure on one question (budget truncation, empty answer, unparseable
 * response) records an unreliable sidecar row — terminal, excluded from
 * judged coverage — and the run continues instead of aborting; the scenario
 * still counts as resolved for checkpointing, and the summary names the
 * unreliable ids. N1: a provider/transport failure is not deterministic —
 * the answer call gets bounded transport retries and, if the provider is
 * still failing, the error rethrows so the scenario aborts un-checkpointed
 * and --resume retries it on a healthy provider.
 * An upstream retrieval failure still throws a sanitized error (scenario
 * and question id only, never the upstream text) before the checkpoint can
 * record the scenario as complete.
 */
export async function scoreOfficialScenario(params: {
	context: OfficialQaContext
	scenarioId: string
	declaredCaseIds: string[]
	materialByCaseId: Map<string, BenchmarkJudgedAnswerMaterial>
	onProviderCall?: (
		operation: "answer-generation" | "answer-judge",
		outcome: "attempted" | "succeeded" | "failed",
		usage?: EnrichmentChatUsage,
	) => void
}): Promise<{
	scenarioId: string
	complete: boolean
	judgedCaseIds: string[]
	unreliableCaseIds: string[]
	unavailable: Array<{
		questionId: string
		reason: OfficialQaUnavailableReason
	}>
}> {
	const { context } = params
	const declared = new Set<string>()
	for (const caseId of params.declaredCaseIds) {
		if (declared.has(caseId)) {
			throw new Error(
				`scenario ${params.scenarioId} declares duplicate case id ${caseId}`,
			)
		}
		declared.add(caseId)
	}
	const judgedCaseIds: string[] = []
	const unreliableCaseIds: string[] = []
	const unavailable: Array<{
		questionId: string
		reason: OfficialQaUnavailableReason
	}> = []
	for (const caseId of params.declaredCaseIds) {
		const material = params.materialByCaseId.get(caseId)
		if (!material) {
			throw new Error(
				`scenario ${params.scenarioId} declares case ${caseId} with no captured QA material; the declared case set and the captured material disagree`,
			)
		}
		const existing = context.sidecar.rows[caseId]
		if (existing?.stage === "judged") {
			judgedCaseIds.push(caseId)
			continue
		}
		if (existing?.stage === "unreliable") {
			// B8-3: unreliable rows are terminal; a resume never re-pays for
			// them (temperature 0 reproduces the failure).
			unreliableCaseIds.push(caseId)
			continue
		}
		if (material.upstreamFailure) {
			throw new Error(
				`official QA scoring for scenario ${params.scenarioId} stopped before the checkpoint: upstream retrieval failed for question ${caseId}; re-run the scenario before scoring`,
			)
		}
		const abstention =
			material.abstention || isOfficialAbstentionQuestion(caseId)
		if (!abstention && material.goldAnswer.trim() === "") {
			unavailable.push({ questionId: caseId, reason: "missing-gold" })
			context.unavailable.push({ questionId: caseId, reason: "missing-gold" })
			continue
		}
		if (!SUPPORTED_QUESTION_TYPES.has(material.questionType ?? "")) {
			unavailable.push({
				questionId: caseId,
				reason: "unsupported-question-type",
			})
			context.unavailable.push({
				questionId: caseId,
				reason: "unsupported-question-type",
			})
			continue
		}
		let hypothesis: string
		if (existing?.stage === "answered") {
			hypothesis = existing.hypothesis
		} else {
			const generated = await generateOfficialAnswer(
				params,
				context,
				caseId,
				material,
			)
			if (generated === null) {
				// B8-3: the unreliable row is already recorded and persisted;
				// keep scoring the rest of the scenario.
				unreliableCaseIds.push(caseId)
				continue
			}
			hypothesis = generated
		}
		const verdict = await judgeOfficialHypothesis(
			params,
			context,
			caseId,
			material,
			hypothesis,
			abstention,
		)
		if (verdict === null) {
			// J1: the judge-unreliable row is already recorded and persisted.
			unreliableCaseIds.push(caseId)
			continue
		}
		judgedCaseIds.push(caseId)
	}
	return {
		scenarioId: params.scenarioId,
		// B8-3: a scenario is resolved (checkpointable) when every declared
		// case is judged or honestly recorded unreliable. Unavailable cases
		// keep the historical semantics: the scenario re-runs on resume.
		complete:
			judgedCaseIds.length + unreliableCaseIds.length ===
			params.declaredCaseIds.length,
		judgedCaseIds,
		unreliableCaseIds,
		unavailable,
	}
}

/**
 * B8-3: record and persist an unreliable case. Terminal like a judged row,
 * excluded from judged coverage, and the run continues past it.
 */
async function recordUnreliableAnswer(
	context: OfficialQaContext,
	caseId: string,
	reason: string,
): Promise<void> {
	context.stats.unreliable.answerGeneration += 1
	context.sidecar = recordOfficialUnreliable(context.sidecar, caseId, reason)
	await writeOfficialPredictionSidecarAtomic(
		context.sidecarPath,
		context.sidecar,
	)
}

async function generateOfficialAnswer(
	params: {
		context: OfficialQaContext
		onProviderCall?: (
			operation: "answer-generation" | "answer-judge",
			outcome: "attempted" | "succeeded" | "failed",
			usage?: EnrichmentChatUsage,
		) => void
	},
	context: OfficialQaContext,
	caseId: string,
	material: BenchmarkJudgedAnswerMaterial,
): Promise<string | null> {
	context.stats.attempts.answerGeneration += 1
	params.onProviderCall?.("answer-generation", "attempted", undefined)
	let completion: {
		content: string
		usage?: EnrichmentChatUsage
		responseMeta?: EnrichmentResponseMeta
	}
	try {
		// N1: transport-class failures (408/429/5xx, timeouts, network
		// errors) get bounded in-process retries with backoff. If they
		// persist, the error rethrows below so the scenario aborts
		// un-checkpointed and --resume retries the question — a provider
		// outage must never become a sticky unreliable row.
		completion = await withRetry(
			() =>
				context.answerProvider.chatCompletion({
					model: context.answerModel,
					messages: buildOfficialDatedAnswerMessages(material),
					// B8: answer-call hygiene. A reasoning-class answer model burns a
					// 512-token budget on hidden reasoning and hands back an empty or
					// truncated answer that would be judged as a normal wrong answer.
					// 4096 covers both plain and reasoning models; temperature 0 pins
					// the benchmark answer deterministic. The values are pinned in the
					// sidecar identity (B9-3) and probed by the preflight (B8-2).
					maxTokens: OFFICIAL_ANSWER_MAX_TOKENS,
					temperature: OFFICIAL_ANSWER_TEMPERATURE,
				}),
			OFFICIAL_ANSWER_TRANSPORT_RETRIES,
		)
	} catch (error) {
		context.stats.failures.answerGeneration += 1
		params.onProviderCall?.("answer-generation", "failed", undefined)
		const message = error instanceof Error ? error.message : String(error)
		// N1: a provider/transport failure is never a sticky unreliable row.
		// Rethrowing mirrors the judge path: the scenario stops before the
		// checkpoint can record it complete, so --resume retries the question
		// on a healthy provider instead of permanently excluding it.
		throw new Error(
			`official answer generation failed for question ${caseId}: ${message}`,
		)
	}
	// B8: finish_reason=length is a reliability failure of the measurement,
	// never a scored wrong answer (same posture as the B4 convergence
	// timeouts). B9-1: a response with no extractable answer is likewise
	// unreliable — raw reasoning text is never sent to the judge.
	const finishReason = completion.responseMeta?.finishReason
	const truncatedByBudget =
		completion.responseMeta?.shape === "length" ||
		finishReason === "length" ||
		finishReason === "max_tokens"
	const parsed = parseOfficialHypothesis(completion.content)
	if (truncatedByBudget) {
		context.stats.failures.answerGeneration += 1
		params.onProviderCall?.("answer-generation", "failed", completion.usage)
		await recordUnreliableAnswer(
			context,
			caseId,
			`answer truncated by the token budget (finishReason=${finishReason ?? "length"})`,
		)
		return null
	}
	if (parsed.kind === "unreliable") {
		context.stats.failures.answerGeneration += 1
		params.onProviderCall?.("answer-generation", "failed", completion.usage)
		await recordUnreliableAnswer(context, caseId, parsed.reason)
		return null
	}
	const hypothesis = parsed.answer
	context.stats.successes.answerGeneration += 1
	params.onProviderCall?.("answer-generation", "succeeded", completion.usage)
	context.sidecar = recordOfficialAnswer(context.sidecar, caseId, hypothesis)
	await writeOfficialPredictionSidecarAtomic(
		context.sidecarPath,
		context.sidecar,
	)
	return hypothesis
}

async function judgeOfficialHypothesis(
	params: {
		context: OfficialQaContext
		onProviderCall?: (
			operation: "answer-generation" | "answer-judge",
			outcome: "attempted" | "succeeded" | "failed",
			usage?: EnrichmentChatUsage,
		) => void
	},
	context: OfficialQaContext,
	caseId: string,
	material: BenchmarkJudgedAnswerMaterial,
	hypothesis: string,
	abstention: boolean,
): Promise<string | null> {
	const prompt = buildOfficialAnscheckPrompt({
		questionType: material.questionType ?? "",
		question: material.question,
		goldAnswer: material.goldAnswer,
		hypothesis,
		abstention,
	})
	// J1: a judge completion that is empty, cut by the token budget, or not a
	// clean yes/no is a judge failure, never a silent "no". It gets one fresh
	// judge call; if that also fails, the case is recorded unreliable.
	let lastFailure = ""
	for (
		let judgeCall = 0;
		judgeCall <= OFFICIAL_JUDGE_CONTENT_RETRIES;
		judgeCall++
	) {
		context.stats.attempts.answerJudge += 1
		params.onProviderCall?.("answer-judge", "attempted", undefined)
		let completion: {
			content: string
			usage?: EnrichmentChatUsage
			responseMeta?: EnrichmentResponseMeta
		}
		try {
			// N1-c: the judge call gets the same bounded transport retry as the
			// answer call — a judge 503 is as transport-class as an answer 503.
			completion = await withRetry(
				() =>
					context.judgeProvider.chatCompletion({
						model: context.judgeModel,
						messages: [{ role: "user", content: prompt }],
						// The official protocol pins a 10-token budget with temperature 0
						// (single yes/no token, deterministic). The custom-judge protocol
						// needs a 1024-token budget: 10-token probes exhausted output
						// tokens with invalid verdicts on both the common-GLM and the
						// opposite-DeepSeek judge probes, and exactly one 1024-token probe
						// per model succeeded (HTTP 200, finish_reason stop, normalized
						// yes — luna-judge-settings-verified.md). temperature must be
						// omitted entirely for custom-judge: the Luna Foundry route
						// rejects temperature:0 with HTTP 400 unsupported_value.
						maxTokens: context.protocol === "custom-judge" ? 1024 : 10,
						...(context.protocol === "custom-judge" ? {} : { temperature: 0 }),
					}),
				OFFICIAL_ANSWER_TRANSPORT_RETRIES,
			)
		} catch (error) {
			context.stats.failures.answerJudge += 1
			params.onProviderCall?.("answer-judge", "failed", undefined)
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(
				`official judging failed for question ${caseId}: ${message}`,
			)
		}
		params.onProviderCall?.("answer-judge", "succeeded", completion.usage)
		const finishReason = completion.responseMeta?.finishReason
		if (
			completion.responseMeta?.shape === "length" ||
			finishReason === "length" ||
			finishReason === "max_tokens"
		) {
			lastFailure = "judge completion was truncated by the token budget"
			continue
		}
		const verdict = parseOfficialJudgeVerdict(completion.content)
		if (verdict === null) {
			lastFailure =
				completion.content.trim() === ""
					? "judge completion was empty"
					: "judge completion was not a clean yes/no verdict"
			continue
		}
		context.stats.successes.answerJudge += 1
		context.sidecar = recordOfficialVerdict(context.sidecar, caseId, verdict)
		await writeOfficialPredictionSidecarAtomic(
			context.sidecarPath,
			context.sidecar,
		)
		return verdict
	}
	context.stats.unreliable.answerJudge += 1
	const recorded = recordOfficialUnreliable(
		context.sidecar,
		caseId,
		`judge failure after ${OFFICIAL_JUDGE_CONTENT_RETRIES + 1} judge calls: ${lastFailure}`,
	)
	// Keep the paid-for answer on the unreliable row so the case can be
	// re-judged offline; the stored-row parser preserves it.
	const row = recorded.rows[caseId]
	context.sidecar = row
		? {
				...recorded,
				rows: { ...recorded.rows, [caseId]: { ...row, hypothesis } },
			}
		: recorded
	await writeOfficialPredictionSidecarAtomic(
		context.sidecarPath,
		context.sidecar,
	)
	return null
}

/**
 * J1: strict judge verdict. The first token after trimming (leading quote,
 * backtick, asterisk and whitespace characters ignored, case-insensitive)
 * must be exactly "yes" or "no"; anything else is not a verdict. A substring
 * match would pass "…would not say yes…".
 */
export function parseOfficialJudgeVerdict(
	content: string,
): "yes" | "no" | null {
	const match = /^(yes|no)\b/i.exec(content.trim().replace(/^[\s"'`*]+/, ""))
	return match ? (match[1]?.toLowerCase() as "yes" | "no") : null
}

// ---------------------------------------------------------------------------
// Run summary and prediction export
// ---------------------------------------------------------------------------

export type OfficialBenchmarkQaCoverage = "full" | "partial" | "unavailable"

/**
 * Write the durable-protocol predictions as JSONL with exactly the keys the
 * pinned evaluator consumes: {"question_id":...,"hypothesis":...} per line.
 * The full export additionally requires the pinned LongMemEval dataset
 * digest (a 500-case set from any other corpus is not comparable to the
 * official S split) and exact-500 id-matched coverage, and refuses
 * (validator error) rather than silently shrinking or relabeling. A
 * custom-judge export carries the distinct `.export.custom-judge` filename
 * infix so non-official provenance is visible in the artifact name itself.
 */
export async function exportOfficialPredictionsJsonl(params: {
	sidecarPath: string
	predictions: OfficialQaPrediction[]
	references: OfficialQaReference[]
	kind: "sample" | "full"
	datasetSha256: string
	protocol?: Extract<BenchmarkQaProtocol, "official" | "custom-judge">
}): Promise<{ kind: "sample" | "full"; path: string; rows: number }> {
	if (params.kind === "full") {
		if (params.datasetSha256 !== LONGMEMEVAL_RELEASE_V2.datasetSha256) {
			throw new OfficialLongMemEvalQaError(
				`full-set export requires the pinned LongMemEval dataset digest ${LONGMEMEVAL_RELEASE_V2.datasetSha256}, got ${params.datasetSha256}; export this run as a sample instead`,
				"coverage",
			)
		}
		validateOfficialLongMemEvalFullCoverage({
			predictions: params.predictions,
			references: params.references,
		})
	}
	const infix = params.protocol === "custom-judge" ? ".custom-judge" : ""
	const exportPath =
		params.kind === "full"
			? `${params.sidecarPath}.export${infix}.jsonl`
			: `${params.sidecarPath}.export${infix}.sample.jsonl`
	const body = params.predictions
		.map((prediction) =>
			JSON.stringify({
				question_id: prediction.questionId,
				hypothesis: prediction.hypothesis,
			}),
		)
		.map((line) => `${line}\n`)
		.join("")
	await fs.writeFile(exportPath, body, "utf8")
	return {
		kind: params.kind,
		path: exportPath,
		rows: params.predictions.length,
	}
}

/**
 * Summarize a durable QA run (official or custom-judge). Metrics come from
 * the Slice A computation over the judged rows; accuracy is only published
 * when coverage is full (every declared case covered by a completed
 * checkpoint scenario and judged). Partial and unavailable runs report null
 * accuracy with the missing question ids named. Judged rows whose scenario
 * never reached a completed checkpoint are reported as lost pre-checkpoint
 * usage, marking the accounting incomplete.
 */
export async function summarizeOfficialBenchmarkQaRun(params: {
	context: OfficialQaContext
	scenarios: Array<{
		scenarioId: string
		conversations: unknown[]
		evaluations: Array<{
			caseId: string
			query: string
			answer?: string
			questionType?: string
			abstention?: boolean
		}>
	}>
	coveredCaseIds: Set<string>
	datasetSha256: string
	/**
	 * Slice B round 2: true when the run resumed from a checkpoint. A resumed
	 * run may have lost pre-checkpoint usage that no sidecar row survives to
	 * testify about, so its accounting is honestly incomplete even when
	 * coverage ends up full.
	 */
	resumedFromCheckpoint?: boolean
	/**
	 * Slice B round 2: judged sidecar rows that were already orphans when the
	 * run started (their scenario had no completed checkpoint entry at
	 * startup). They stay lost for accounting even if this run later covers
	 * them, so recovery cannot silently clear the uncertainty.
	 */
	startupLostQuestionIds?: string[]
}): Promise<{
	envelope: BenchmarkE2eQaEnvelope
	metrics: OfficialLongMemEvalQaMetrics | null
}> {
	const references: OfficialQaReference[] = []
	for (const scenario of params.scenarios) {
		for (const evaluation of scenario.evaluations) {
			references.push({
				questionId: evaluation.caseId,
				question: evaluation.query,
				answer: evaluation.answer ?? "",
				questionType: (evaluation.questionType ??
					"single-session-user") as OfficialQaReference["questionType"],
			})
		}
	}
	const referenceByQuestionId = new Map(
		references.map((reference) => [reference.questionId, reference]),
	)
	const judgedRows = Object.values(params.context.sidecar.rows).filter(
		(row) => row.stage === "judged",
	)
	// B8-3/B9-1: unreliable rows are named in the summary so an unmeasured
	// case is visible as itself, not just as an anonymous missing id.
	const unreliableRows = Object.values(params.context.sidecar.rows).filter(
		(row) => row.stage === "unreliable",
	)
	const unreliableQuestionIds = unreliableRows.map((row) => row.questionId)
	const judgedIds = new Set(judgedRows.map((row) => row.questionId))
	const declaredIds = references.map((reference) => reference.questionId)
	const missingQuestionIds = declaredIds.filter((id) => !judgedIds.has(id))
	// Slice B round 2: lost pre-checkpoint usage is sticky. Startup orphans
	// (judged rows whose scenario never reached a completed checkpoint before
	// this run started) stay lost even when this run later covers them, and
	// the current-run orphans are unioned in — recovery never silently clears
	// the uncertainty.
	const lostPreCheckpointQuestionIds = [
		...new Set([
			...(params.startupLostQuestionIds ?? []),
			...judgedRows
				.map((row) => row.questionId)
				.filter((id) => !params.coveredCaseIds.has(id)),
		]),
	]
	const coverage: OfficialBenchmarkQaCoverage =
		judgedRows.length === 0
			? "unavailable"
			: declaredIds.every(
						(id) => params.coveredCaseIds.has(id) && judgedIds.has(id),
					)
				? "full"
				: "partial"
	const metrics =
		judgedRows.length > 0
			? computeOfficialLongMemEvalQaMetrics(
					judgedRows.map((row) => {
						const reference = referenceByQuestionId.get(row.questionId)
						return {
							questionId: row.questionId,
							questionType: (reference?.questionType ??
								"single-session-user") as OfficialQaReference["questionType"],
							abstention: isOfficialAbstentionQuestion(row.questionId),
							label: row.verdict === "yes",
						}
					}),
				)
			: null
	let exportInfo:
		| { kind: "sample" | "full"; path: string; rows: number }
		| undefined
	if (judgedRows.length > 0) {
		const predictions: OfficialQaPrediction[] = judgedRows.map((row) => ({
			questionId: row.questionId,
			hypothesis: row.hypothesis,
		}))
		// Slice B round 2: full-set export requires the pinned LongMemEval
		// digest on top of full coverage and exact-500; anything else is an
		// honestly-labeled sample.
		const wantsFull =
			coverage === "full" &&
			predictions.length === OFFICIAL_LONGMEMEVAL_S_CASE_COUNT &&
			params.datasetSha256 === LONGMEMEVAL_RELEASE_V2.datasetSha256
		exportInfo = await exportOfficialPredictionsJsonl({
			sidecarPath: params.context.sidecarPath,
			predictions,
			references,
			kind: wantsFull ? "full" : "sample",
			datasetSha256: params.datasetSha256,
			protocol: params.context.protocol,
		})
	}
	const protocolLabel =
		params.context.protocol === "custom-judge" ? "custom-judge" : "official"
	const unavailableReason =
		coverage === "full"
			? undefined
			: `${protocolLabel} QA coverage is ${coverage}; accuracy is withheld until every declared question is judged${
					missingQuestionIds.length > 0
						? ` (${missingQuestionIds.length} missing, first: ${missingQuestionIds[0]})`
						: ""
				}`
	const envelope: BenchmarkE2eQaEnvelope = {
		answerModel: params.context.answerModel,
		judge: params.context.judgeModel,
		judgeVersion: OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
		accuracy: coverage === "full" ? (metrics?.overallAccuracy ?? null) : null,
		latencyMs: null,
		judgeFalsePositiveRate: null,
		cases: {
			eligible: references.length,
			attempted: params.context.stats.attempts.answerGeneration,
			completed: judgedRows.length,
			failed:
				params.context.stats.failures.answerGeneration +
				params.context.stats.failures.answerJudge,
		},
		attempts: {
			answerGeneration: params.context.stats.attempts.answerGeneration,
			answerJudge: params.context.stats.attempts.answerJudge,
			decoyJudge: 0,
		},
		caseResults: judgedRows.map((row) => ({
			caseId: row.questionId,
			candidateAnswer: row.hypothesis,
			correct: row.verdict === "yes",
			abstention: isOfficialAbstentionQuestion(row.questionId),
			// Official mode does not measure per-case latency; the field is
			// kept for envelope shape compatibility.
			latencyMs: 0,
		})),
		...(unavailableReason ? { unavailableReason } : {}),
		// Protocol provenance: an official run publishes the official block;
		// a custom-judge run publishes the customJudge block (same reviewed
		// machinery, distinct protocol label and judge model) and never
		// fabricates an official summary for a non-official judge.
		...(params.context.protocol === "custom-judge"
			? {
					customJudge: {
						protocol: "custom-judge-anscheck" as const,
						judgeModel: params.context.judgeModel,
						coverage,
						overallAccuracy:
							coverage === "full" ? (metrics?.overallAccuracy ?? null) : null,
						taskAveragedAccuracy:
							coverage === "full"
								? (metrics?.taskAveragedAccuracy ?? null)
								: null,
						abstentionAccuracy:
							coverage === "full"
								? (metrics?.abstentionAccuracy ?? null)
								: null,
						abstentionCount: metrics?.abstentionCount ?? 0,
						perType: metrics?.perType ?? [],
						missingQuestionIds,
						unreliableQuestionIds,
						lostPreCheckpointQuestionIds,
						accountingCompleteness:
							lostPreCheckpointQuestionIds.length > 0 ||
							params.resumedFromCheckpoint === true
								? ("incomplete" as const)
								: ("complete" as const),
						...(exportInfo ? { export: exportInfo } : {}),
					},
				}
			: {
					official: {
						protocol: "official-anscheck" as const,
						coverage,
						overallAccuracy:
							coverage === "full" ? (metrics?.overallAccuracy ?? null) : null,
						taskAveragedAccuracy:
							coverage === "full"
								? (metrics?.taskAveragedAccuracy ?? null)
								: null,
						// Slice B round 2: abstention accuracy is preserved with null
						// honesty — null when not measured (partial coverage or no
						// abstention rows judged), never a fabricated zero.
						abstentionAccuracy:
							coverage === "full"
								? (metrics?.abstentionAccuracy ?? null)
								: null,
						abstentionCount: metrics?.abstentionCount ?? 0,
						perType: metrics?.perType ?? [],
						missingQuestionIds,
						unreliableQuestionIds,
						lostPreCheckpointQuestionIds,
						// Slice B round 2: a resumed run is honestly incomplete even
						// with zero surviving orphans — rows lost before any checkpoint
						// may have no surviving evidence at all.
						accountingCompleteness:
							lostPreCheckpointQuestionIds.length > 0 ||
							params.resumedFromCheckpoint === true
								? ("incomplete" as const)
								: ("complete" as const),
						...(exportInfo ? { export: exportInfo } : {}),
					},
				}),
	}
	return { envelope, metrics }
}
