import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
	EnrichmentChatResponse,
	EnrichmentProvider,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { runE2eQa } from "./mongodb-e2e-qa.js"

// Synthetic, fictional envelopes. Every body carries the canary so any leak
// of response text into the case result or the logs is caught.
const CANARY = "OKAPI-CANARY-77"
const VERDICT = JSON.stringify({ correct: true, rationale: CANARY })

type Replies = {
	answer: EnrichmentChatResponse
	judge?: EnrichmentChatResponse
	decoy?: EnrichmentChatResponse
}

function fixtureProvider(replies: Replies): EnrichmentProvider {
	return {
		name: "fixture",
		chatCompletion: vi.fn<EnrichmentProvider["chatCompletion"]>(
			async ({ messages }) => {
				const user = messages.find((m) => m.role === "user")?.content ?? ""
				if (!user.includes("GOLD ANSWER:")) return replies.answer
				if (user.includes("CANDIDATE ANSWER: Porto")) {
					return replies.decoy ?? { content: VERDICT }
				}
				return replies.judge ?? { content: VERDICT }
			},
		),
	}
}

let logged: string[] = []
beforeEach(() => {
	logged = []
	for (const method of ["log", "warn", "error", "debug", "info"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "))
		})
	}
})
afterEach(() => {
	vi.restoreAllMocks()
})

const ANSWER: EnrichmentChatResponse = {
	content: JSON.stringify({ answer: "Lisbon" }),
	responseMeta: { shape: "ok", finishReason: "stop" },
}

async function runCases(replies: Replies, withDecoy = false) {
	return runE2eQa({
		provider: fixtureProvider(replies),
		model: "fixture-answer-model",
		judgeModel: "fixture-judge-model",
		cases: [
			{
				caseId: "fixture-case",
				question: "Where did the fictional bakery move?",
				goldAnswer: "Lisbon",
				contextPassages: ["The fictional bakery moved to Lisbon."],
			},
			...(withDecoy
				? [
						{
							caseId: "decoy-source",
							question: "Where did the fictional florist move?",
							goldAnswer: "Porto",
							contextPassages: ["The fictional florist moved to Porto."],
						},
					]
				: []),
		],
	})
}

describe("answer attempt provider identity (B6)", () => {
	it("records the envelope response id and model on the answer attempt", async () => {
		const envelope = await runCases({
			answer: {
				...ANSWER,
				responseMeta: {
					shape: "ok",
					finishReason: "stop",
					responseId: "resp-fixture-1",
					responseModel: "gemini-fixture",
				},
			},
		})
		expect(envelope.caseResults[0]?.answerAttempt).toMatchObject({
			status: "answer",
			responseId: "resp-fixture-1",
			responseModel: "gemini-fixture",
		})
	})

	it("records which identity fields the envelope check dropped", async () => {
		const envelope = await runCases({
			answer: {
				...ANSWER,
				responseMeta: {
					shape: "ok",
					finishReason: "stop",
					responseModel: "gemini-fixture",
					droppedEnvelopeFields: ["id"],
				},
			},
		})
		const attempt = envelope.caseResults[0]?.answerAttempt
		expect(attempt).toMatchObject({
			responseModel: "gemini-fixture",
			droppedEnvelopeFields: ["id"],
		})
		expect(attempt).not.toHaveProperty("responseId")
	})
})

describe("finish reason allowlist (B1)", () => {
	it.each([
		["MAX_TOKENS", "max_tokens"],
		["SAFETY", "safety"],
		["RECITATION", "recitation"],
		["LANGUAGE", "language"],
		["OTHER", "other"],
		["BLOCKLIST", "blocklist"],
		["PROHIBITED_CONTENT", "prohibited_content"],
		["SPII", "spii"],
		["MALFORMED_FUNCTION_CALL", "malformed_function_call"],
		["MALFORMED_RESPONSE", "malformed_response"],
		["UNEXPECTED_TOOL_CALL", "unexpected_tool_call"],
		["STOP", "stop"],
	])("preserves Gemini-native %s as %s", async (reported, recorded) => {
		const envelope = await runCases({
			answer: {
				...ANSWER,
				responseMeta: { shape: "ok", finishReason: reported },
			},
		})
		expect(envelope.caseResults[0]?.answerAttempt?.finishReason).toBe(recorded)
	})

	it("records an unlisted value as unlisted, apart from Gemini's OTHER", async () => {
		const envelope = await runCases({
			answer: {
				...ANSWER,
				responseMeta: { shape: "ok", finishReason: CANARY },
			},
		})
		const result = envelope.caseResults[0]
		expect(result?.answerAttempt?.finishReason).toBe("unlisted")
		expect(JSON.stringify(result)).not.toContain(CANARY)
	})
})

describe("truncation is decided by the stop reason before parsing (B3)", () => {
	it.each([
		[
			"length shape with invalid JSON",
			{ shape: "length", finishReason: "length" },
			`{"answer":"${CANARY}`,
		],
		[
			"Gemini MAX_TOKENS with invalid JSON",
			{ shape: "ok", finishReason: "MAX_TOKENS" },
			`{"answer":"${CANARY}`,
		],
		[
			"Anthropic max_tokens with invalid JSON",
			{ shape: "length", finishReason: "max_tokens" },
			`{"answer":"${CANARY}`,
		],
		[
			"length shape with no content",
			{ shape: "length", finishReason: "length" },
			"",
		],
	] as const)("classifies %s as truncated", async (_label, meta, content) => {
		const envelope = await runCases({
			answer: { content, responseMeta: { ...meta } },
		})
		const result = envelope.caseResults[0]
		expect(result?.answerAttempt).toMatchObject({
			layer: "envelope",
			status: "truncated",
		})
		expect(result?.error).toBe("answer-generation: truncated")
		expect(envelope.cases.failed).toBe(1)
	})

	it("keeps a length stop whose JSON parses as a content-layer answer", async () => {
		const envelope = await runCases({
			answer: {
				content: JSON.stringify({ answer: "Lisbon" }),
				responseMeta: { shape: "length", finishReason: "length" },
			},
		})
		expect(envelope.caseResults[0]?.answerAttempt).toMatchObject({
			layer: "content",
			status: "answer",
			finishReason: "length",
		})
	})

	it("keeps invalid JSON under a normal stop as invalid-json", async () => {
		const envelope = await runCases({
			answer: {
				content: `{"answer":"${CANARY}`,
				responseMeta: { shape: "ok", finishReason: "stop" },
			},
		})
		expect(envelope.caseResults[0]?.answerAttempt).toMatchObject({
			layer: "content",
			status: "invalid-json",
		})
	})
})

describe("judge and decoy-judge classification (B3, B4)", () => {
	const TRUNCATED: EnrichmentChatResponse = {
		content: `{"correct":true,"rationale":"${CANARY}`,
		responseMeta: { shape: "length", finishReason: "length" },
	}

	function expectNoBodyText(value: unknown) {
		const text = `${JSON.stringify(value)}\n${logged.join("\n")}`
		expect(text).not.toContain(CANARY)
		expect(text).not.toMatch(/JSON Parse|Unexpected|Unterminated|position/i)
	}

	it("classifies a truncated judge verdict as truncated, not invalid-json", async () => {
		const envelope = await runCases({ answer: ANSWER, judge: TRUNCATED })
		const result = envelope.caseResults[0]
		expect(result?.error).toBe("answer-judge: truncated")
		expect(result?.correct).toBe(false)
		expect(envelope.cases.failed).toBe(1)
		expectNoBodyText(envelope)
	})

	it("classifies a truncated decoy verdict as truncated", async () => {
		const envelope = await runCases({ answer: ANSWER, decoy: TRUNCATED }, true)
		expect(envelope.caseResults[0]?.error).toBe("decoy-judge: truncated")
		expectNoBodyText(envelope)
	})

	it("reports an unparseable verdict with a fixed status and logs no body text", async () => {
		const envelope = await runCases({
			answer: ANSWER,
			judge: {
				content: `{"correct": ${CANARY}`,
				responseMeta: { shape: "ok", finishReason: "stop" },
			},
		})
		expect(envelope.caseResults[0]?.error).toBe("answer-judge: invalid-json")
		expect(logged.join("\n")).toContain("invalid-json")
		expectNoBodyText(envelope)
	})

	it("reports a judge transport failure with a fixed status only", async () => {
		const provider = fixtureProvider({ answer: ANSWER })
		const answerOnly = provider.chatCompletion
		provider.chatCompletion = vi.fn<EnrichmentProvider["chatCompletion"]>(
			async (request) => {
				const user =
					request.messages.find((m) => m.role === "user")?.content ?? ""
				if (user.includes("GOLD ANSWER:")) {
					throw new Error(`gateway echoed ${CANARY}`)
				}
				return answerOnly(request)
			},
		)
		const envelope = await runE2eQa({
			provider,
			model: "fixture-answer-model",
			judgeModel: "fixture-judge-model",
			cases: [
				{
					caseId: "fixture-case",
					question: "Where did the fictional bakery move?",
					goldAnswer: "Lisbon",
					contextPassages: ["The fictional bakery moved to Lisbon."],
				},
			],
		})
		expect(envelope.caseResults[0]?.error).toBe(
			"answer-judge: transport-failure",
		)
		expectNoBodyText(envelope)
	})

	it("fails a judge call the envelope refused", async () => {
		const envelope = await runCases({
			answer: ANSWER,
			judge: {
				content: VERDICT,
				responseMeta: { shape: "refusal", finishReason: "stop", refusal: true },
			},
		})
		expect(envelope.caseResults[0]?.error).toBe("answer-judge: refusal")
	})

	it("keeps a parsed verdict scored as before", async () => {
		const envelope = await runCases({
			answer: ANSWER,
			judge: {
				content: JSON.stringify({ correct: true, rationale: "fixture" }),
				responseMeta: { shape: "length", finishReason: "length" },
			},
		})
		expect(envelope.caseResults[0]).toMatchObject({ correct: true })
		expect(envelope.caseResults[0]?.error).toBeUndefined()
	})
})

describe("per-call outcomes reach the operation observer (B5)", () => {
	it("reports status and finish reason for every ended call, per operation", async () => {
		const calls: Array<{
			operation: string
			outcome: string
			call?: { status: string; finishReason?: string }
		}> = []
		await runE2eQa({
			provider: fixtureProvider({
				answer: {
					...ANSWER,
					responseMeta: { shape: "length", finishReason: "length" },
				},
				judge: {
					content: JSON.stringify({ rationale: "no verdict field" }),
					responseMeta: { shape: "ok", finishReason: "STOP" },
				},
				decoy: {
					content: `{"correct":${CANARY}`,
					responseMeta: { shape: "ok", finishReason: "MAX_TOKENS" },
				},
			}),
			model: "fixture-answer-model",
			judgeModel: "fixture-judge-model",
			cases: [
				{
					caseId: "fixture-case",
					question: "Where did the fictional bakery move?",
					goldAnswer: "Lisbon",
					contextPassages: ["The fictional bakery moved to Lisbon."],
				},
				{
					caseId: "decoy-source",
					question: "Where did the fictional florist move?",
					goldAnswer: "Porto",
					contextPassages: ["The fictional florist moved to Porto."],
				},
			],
			onProviderCall: (operation, outcome, _usage, call) =>
				calls.push({ operation, outcome, ...(call ? { call } : {}) }),
		})
		const ended = calls.filter((entry) => entry.outcome !== "attempted")
		expect(ended.slice(0, 3)).toEqual([
			{
				operation: "answer-generation",
				outcome: "succeeded",
				call: { status: "answer", finishReason: "length" },
			},
			{
				operation: "answer-judge",
				outcome: "succeeded",
				call: { status: "missing-verdict", finishReason: "stop" },
			},
			{
				operation: "decoy-judge",
				outcome: "succeeded",
				call: { status: "truncated", finishReason: "max_tokens" },
			},
		])
		expect(JSON.stringify(calls)).not.toContain(CANARY)
	})

	it("reports a transport failure as a failed call with a fixed status", async () => {
		const calls: Array<{ operation: string; outcome: string; call?: unknown }> =
			[]
		await runE2eQa({
			provider: {
				name: "fixture",
				chatCompletion: async () => {
					throw new Error(`gateway echoed ${CANARY}`)
				},
			},
			model: "fixture-answer-model",
			cases: [
				{
					caseId: "fixture-case",
					question: "Where did the fictional bakery move?",
					goldAnswer: "Lisbon",
					contextPassages: ["The fictional bakery moved to Lisbon."],
				},
			],
			onProviderCall: (operation, outcome, _usage, call) =>
				calls.push({ operation, outcome, ...(call ? { call } : {}) }),
		})
		expect(calls).toEqual([
			{ operation: "answer-generation", outcome: "attempted" },
			{
				operation: "answer-generation",
				outcome: "failed",
				call: { status: "transport-failure" },
			},
		])
	})
})
