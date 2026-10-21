import { createHash } from "node:crypto"
import type {
	EnrichmentChatResponse,
	EnrichmentResponseShape,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type {
	BenchmarkAnswerAttempt,
	BenchmarkAnswerAttemptStatus,
	BenchmarkAnswerFinishReason,
	BenchmarkJudgeAttemptStatus,
} from "../packages/memory-engine/src/types.js"

const LISTED_FINISH_REASONS: ReadonlySet<string> = new Set<
	Exclude<BenchmarkAnswerFinishReason, "unlisted">
>([
	"stop",
	"length",
	"content_filter",
	"tool_calls",
	"function_call",
	"max_tokens",
	"end_turn",
	"safety",
	"recitation",
	"language",
	"other",
	"blocklist",
	"prohibited_content",
	"spii",
	"malformed_function_call",
	"malformed_response",
	"unexpected_tool_call",
])

function listedFinishReason(reported: string): BenchmarkAnswerFinishReason {
	const normalized = reported.toLowerCase()
	return LISTED_FINISH_REASONS.has(normalized)
		? (normalized as BenchmarkAnswerFinishReason)
		: "unlisted"
}

type EnvelopeFailure = Extract<
	BenchmarkAnswerAttemptStatus,
	| "refusal"
	| "content-filter"
	| "missing-choices"
	| "malformed-message"
	| "malformed-body"
>

const ENVELOPE_FAILURES: ReadonlyMap<EnrichmentResponseShape, EnvelopeFailure> =
	new Map<EnrichmentResponseShape, EnvelopeFailure>([
		["refusal", "refusal"],
		["content-filter", "content-filter"],
		["missing-choices", "missing-choices"],
		["malformed-message", "malformed-message"],
		["malformed-body", "malformed-body"],
	])

const LENGTH_FINISH_REASONS: ReadonlySet<BenchmarkAnswerFinishReason> =
	new Set<BenchmarkAnswerFinishReason>(["length", "max_tokens"])

/** Fixed evidence from the provider envelope; never the body text. */
export type EnvelopeEvidence = Omit<BenchmarkAnswerAttempt, "layer" | "status">

type EnvelopeReading = {
	evidence: EnvelopeEvidence
	/** Set when the envelope alone decides the status. */
	failure?: EnvelopeFailure | "empty-body" | "truncated"
	/** The provider stopped on its token budget. */
	lengthStop: boolean
}

/**
 * Read the envelope before the content: a token-budget stop is known from the
 * stop signal, so content that then fails to parse is `truncated`, not
 * `invalid-json`.
 */
function readEnvelope(response: EnrichmentChatResponse): EnvelopeReading {
	const meta = response.responseMeta
	const finishReason =
		meta?.finishReason === undefined
			? undefined
			: listedFinishReason(meta.finishReason)
	const evidence: EnvelopeEvidence = {
		shape: meta?.shape ?? "unvalidated",
		...(finishReason === undefined ? {} : { finishReason }),
		contentBytes: Buffer.byteLength(response.content, "utf8"),
		contentSha256: createHash("sha256")
			.update(response.content, "utf8")
			.digest("hex"),
		...(meta?.responseId ? { responseId: meta.responseId } : {}),
		...(meta?.responseModel ? { responseModel: meta.responseModel } : {}),
		...(meta?.droppedEnvelopeFields?.length
			? { droppedEnvelopeFields: [...meta.droppedEnvelopeFields] }
			: {}),
	}
	const lengthStop =
		meta?.shape === "length" ||
		(finishReason !== undefined && LENGTH_FINISH_REASONS.has(finishReason))
	const structural = meta?.shape && ENVELOPE_FAILURES.get(meta.shape)
	if (structural) return { evidence, failure: structural, lengthStop }
	if (
		meta?.shape === "null-content" ||
		meta?.shape === "empty-content" ||
		response.content.trim() === ""
	) {
		return {
			evidence,
			failure: lengthStop ? "truncated" : "empty-body",
			lengthStop,
		}
	}
	return { evidence, lengthStop }
}

export const TRANSPORT_FAILURE_ATTEMPT: BenchmarkAnswerAttempt = {
	layer: "transport",
	status: "transport-failure",
}

export type ClassifiedAnswer = {
	attempt: BenchmarkAnswerAttempt
	/** Present only when the content holds a valid string answer. */
	answer?: string
}

export function stripFences(content: string): string {
	return content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "")
}

function parseAnswer(
	content: string,
): { answer: string } | { failure: BenchmarkAnswerAttemptStatus } {
	let parsed: unknown
	try {
		parsed = JSON.parse(stripFences(content))
	} catch {
		return { failure: "invalid-json" }
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!("answer" in parsed)
	) {
		return { failure: "missing-answer" }
	}
	const { answer } = parsed as { answer: unknown }
	if (typeof answer !== "string") return { failure: "wrong-answer-type" }
	return { answer: answer.trim() }
}

/**
 * Classify a provider response that arrived over a working transport. Only
 * fixed classes, byte length and digest leave this function; the body and any
 * parser message stay inside it.
 */
export function classifyAnswerResponse(
	response: EnrichmentChatResponse,
): ClassifiedAnswer {
	const { evidence, failure, lengthStop } = readEnvelope(response)
	if (failure) {
		return { attempt: { layer: "envelope", status: failure, ...evidence } }
	}
	const parsed = parseAnswer(response.content)
	if ("failure" in parsed) {
		if (lengthStop && parsed.failure === "invalid-json") {
			return {
				attempt: { layer: "envelope", status: "truncated", ...evidence },
			}
		}
		return {
			attempt: { layer: "content", status: parsed.failure, ...evidence },
		}
	}
	return {
		attempt: {
			layer: "content",
			status: parsed.answer === "" ? "empty-answer" : "answer",
			...evidence,
		},
		answer: parsed.answer,
	}
}

export type ClassifiedVerdict = {
	status: BenchmarkJudgeAttemptStatus
	evidence?: EnvelopeEvidence
	/** Present only when the content parsed into a scoreable verdict. */
	verdict?: { correct: boolean; rationale: string }
}

/** The judge counterpart of classifyAnswerResponse, with the same layers. */
export function classifyJudgeResponse(
	response: EnrichmentChatResponse,
): ClassifiedVerdict {
	const { evidence, failure, lengthStop } = readEnvelope(response)
	if (failure) return { status: failure, evidence }
	let parsed: unknown
	try {
		parsed = JSON.parse(stripFences(response.content))
	} catch {
		return { status: lengthStop ? "truncated" : "invalid-json", evidence }
	}
	const fields =
		parsed !== null && typeof parsed === "object"
			? (parsed as { correct?: unknown; rationale?: unknown })
			: {}
	return {
		status: typeof fields.correct === "boolean" ? "verdict" : "missing-verdict",
		evidence,
		verdict: {
			// An ambiguous verdict is never a silent pass.
			correct: fields.correct === true,
			rationale:
				typeof fields.rationale === "string" ? fields.rationale.trim() : "",
		},
	}
}
