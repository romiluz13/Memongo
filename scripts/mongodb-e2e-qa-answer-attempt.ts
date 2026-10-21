import { createHash } from "node:crypto"
import type {
	EnrichmentChatResponse,
	EnrichmentResponseShape,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type {
	BenchmarkAnswerAttempt,
	BenchmarkAnswerAttemptStatus,
	BenchmarkAnswerFinishReason,
} from "../packages/memory-engine/src/types.js"

const LISTED_FINISH_REASONS: ReadonlySet<string> = new Set<
	Exclude<BenchmarkAnswerFinishReason, "other">
>([
	"stop",
	"length",
	"content_filter",
	"tool_calls",
	"function_call",
	"max_tokens",
	"end_turn",
])

const ENVELOPE_FAILURES: ReadonlyMap<
	EnrichmentResponseShape,
	BenchmarkAnswerAttemptStatus
> = new Map<EnrichmentResponseShape, BenchmarkAnswerAttemptStatus>([
	["refusal", "refusal"],
	["content-filter", "content-filter"],
	["missing-choices", "missing-choices"],
	["malformed-message", "malformed-message"],
	["malformed-body", "malformed-body"],
	["null-content", "empty-body"],
	["empty-content", "empty-body"],
])

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
	const reported = response.responseMeta?.finishReason
	const evidence: Omit<BenchmarkAnswerAttempt, "layer" | "status"> = {
		shape: response.responseMeta?.shape ?? "unvalidated",
		...(reported === undefined
			? {}
			: {
					finishReason: LISTED_FINISH_REASONS.has(reported)
						? (reported as BenchmarkAnswerFinishReason)
						: "other",
				}),
		contentBytes: Buffer.byteLength(response.content, "utf8"),
		contentSha256: createHash("sha256")
			.update(response.content, "utf8")
			.digest("hex"),
	}
	const shape = response.responseMeta?.shape
	const envelopeStatus =
		(shape && ENVELOPE_FAILURES.get(shape)) ??
		(response.content.trim() === "" ? "empty-body" : undefined)
	if (envelopeStatus) {
		return {
			attempt: { layer: "envelope", status: envelopeStatus, ...evidence },
		}
	}
	const parsed = parseAnswer(response.content)
	if ("failure" in parsed) {
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
