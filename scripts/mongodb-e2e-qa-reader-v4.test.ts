import { describe, expect, it } from "vitest"
import type {
	EnrichmentChatResponse,
	EnrichmentProvider,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import {
	buildReaderContext,
	estimateTokens,
} from "./benchmark/reader-budget.js"
import { runE2eQa } from "./mongodb-e2e-qa.js"
import { V4_READER_CONTRACT } from "./mongodb-e2e-qa-calls.js"
import {
	type Call,
	heronCase,
	recordingProvider,
	unit,
} from "./mongodb-e2e-qa-reader-budget.fixture.js"

// custom-v4: custom-v3's reader content under the v4 reader contract.
// Fictional strings only.

// Copied byte for byte from the grilled plan (1256-plan.md).
const V4_SYSTEM_PROMPT = [
	"You answer the QUESTION from the user's memory: the dated chat sessions in the context.",
	"Work in two steps. First take notes: for each passage that bears on the question, record its session date and what it says. Then reason over your notes and answer.",
	"Rules:",
	"- Answer what the question asks, in the form it asks for.",
	"- What the user or the assistant said comes only from the context. Use general knowledge only to work with it: count, add, compare or order dates, or apply what the user said to the request.",
	"- When sessions disagree, the most recently dated statement is current.",
	'- Resolve relative time ("last week", "recently") against the session date or the current date.',
	"- If the context does not state a fact the answer depends on, return an empty answer string. A value you can work out from the context (a count, a date difference, a suggestion built on what the user said) is not missing: give it.",
	'Return JSON only: {"notes":[{"date":"...","fact":"..."}],"reasoning":"...","answer":"<concise answer, or empty string>"}',
].join("\n")
const V4_RETURN_LINE =
	'Return only {"notes":[...],"reasoning":"...","answer":"..."}.'

const isJudgeCall = (call: Call) =>
	call.messages.find((m) => m.role === "user")?.content.includes("GOLD ANSWER:")

async function runProtocol(protocol: "custom-v3" | "custom-v4") {
	const { provider, calls } = recordingProvider([])
	const envelope = await runE2eQa({
		provider,
		model: "fixture-answer-model",
		answerModel: "fixture-answer-model",
		judgeModel: "fixture-judge-model",
		cases: [heronCase()],
		protocol,
	})
	return {
		envelope,
		answers: calls.filter((call) => !isJudgeCall(call)),
		judges: calls.filter(isJudgeCall),
	}
}

describe("custom-v4 reader contract", () => {
	it("sends the v4 system prompt and ends the user content with the v4 return line", async () => {
		const { answers } = await runProtocol("custom-v4")
		expect(answers).toHaveLength(1)
		expect(answers[0]?.messages[0]).toEqual({
			role: "system",
			content: V4_SYSTEM_PROMPT,
		})
		const user = answers[0]?.messages[1]?.content ?? ""
		expect(user.split("\n").at(-1)).toBe(V4_RETURN_LINE)
	})

	it("sends the same answer-judge and decoy-judge requests as custom-v3 and reports judgeVersion v4", async () => {
		const decoy = heronCase({
			caseId: "wren",
			question: "Which reeds are tall?",
			goldAnswer: "Brindlewick",
		})
		const judged = async (protocol: "custom-v3" | "custom-v4") => {
			const { provider, calls } = recordingProvider([])
			const envelope = await runE2eQa({
				provider,
				model: "fixture-answer-model",
				answerModel: "fixture-answer-model",
				judgeModel: "fixture-judge-model",
				cases: [heronCase(), decoy],
				protocol,
			})
			return { envelope, judges: calls.filter(isJudgeCall) }
		}
		const v3 = await judged("custom-v3")
		const v4 = await judged("custom-v4")
		expect(v4.judges).toHaveLength(4)
		expect(v4.judges).toEqual(v3.judges)
		expect(v3.envelope.judgeVersion).toBe("v3")
		expect(v4.envelope.judgeVersion).toBe("v4")
	})
})

describe("custom-v4 admission parity", () => {
	const units = [
		unit("single:event:k1", 1, "sess-lane", 1, "User: The lantern is green.", [
			"2031/01/05 (Sun) 08:00",
		]),
		unit("single:event:k2", 2, "sess-lane", 2, "User: The gate is blue.", [
			"2031/01/05 (Sun) 08:00",
		]),
		unit("single:event:k3", 3, "sess-dock", 1, "User: The boat is red.", [
			"2031/01/09 (Thu) 17:15",
		]),
	]
	const build = (budget: number, returnLine?: string) =>
		buildReaderContext({
			units,
			question: "Which color is the gate?",
			questionDate: "2031/02/01 (Sat) 12:00",
			budget,
			...(returnLine ? { returnLine } : {}),
		})
	// The v3 serialization of the first two units fills the budget exactly,
	// so the longer v4 return line would not fit if it counted.
	const budget = buildReaderContext({
		units: units.slice(0, 2),
		question: "Which color is the gate?",
		questionDate: "2031/02/01 (Sat) 12:00",
		budget: 100_000,
	}).estimatedContextTokens

	it("admits on custom-v3's serialization and renders the v4 return line", () => {
		const v3 = build(budget)
		const v4 = build(budget, V4_READER_CONTRACT.returnLine)
		expect(v3.admitted.map((u) => u.id)).toEqual([
			"single:event:k1",
			"single:event:k2",
		])
		expect(v4.admitted.map((u) => u.id)).toEqual(v3.admitted.map((u) => u.id))
		expect(v4.counts).toEqual(v3.counts)
		expect(v4.skippedRanks).toEqual(v3.skippedRanks)
		expect(v4.admittedOffsets).toEqual(v3.admittedOffsets)
		const v3Lines = v3.userContent.split("\n")
		expect(v4.userContent).toBe(
			[...v3Lines.slice(0, -1), V4_READER_CONTRACT.returnLine].join("\n"),
		)
	})

	it("records the estimate of the content actually sent, over the budget by the return-line difference", () => {
		const v4 = build(budget, V4_READER_CONTRACT.returnLine)
		expect(v4.estimatedContextTokens).toBe(estimateTokens(v4.userContent))
		expect(v4.estimatedContextTokens).toBeGreaterThan(budget)
		expect(v4.budgetEstimatedTokens).toBe(budget)
	})
})

describe("custom-v4 reader budget records", () => {
	it("counts the v4 system prompt in the calibration's request estimate", async () => {
		const { provider, calls } = recordingProvider([
			{ inputTokens: 400, outputTokens: 9 },
		])
		const envelope = await runE2eQa({
			provider,
			model: "fixture-answer-model",
			answerModel: "fixture-answer-model",
			judgeModel: "fixture-judge-model",
			cases: [heronCase()],
			protocol: "custom-v4",
		})
		const [answer] = calls.filter((call) => !isJudgeCall(call))
		const user = estimateTokens(answer?.messages[1]?.content ?? "")
		const request = estimateTokens(V4_SYSTEM_PROMPT) + user
		expect(envelope.caseResults[0]?.readerBudget).toMatchObject({
			estimatedContextTokens: user,
			estimatedRequestTokens: request,
		})
		expect(envelope.readerBudgetCalibration).toMatchObject({
			answerCalls: 1,
			estimatedContextTokens: user,
			estimatedRequestTokens: request,
			ratio: 400 / request,
		})
		expect(envelope.readerPositionTerciles?.positionRule).toBe(
			"earliest-gold-turn-percentile",
		)
	})
})

describe("custom-v4 answer bodies", () => {
	// Notes and reasoning quote memory text, so a canary in them must never
	// reach the case result.
	const CANARY = "OTTER-CANARY-72"
	const notes = [{ date: "2031/01/20 (Mon) 10:00", fact: `nest ${CANARY}` }]
	const answerWith = async (body: Record<string, unknown>) => {
		const provider: EnrichmentProvider = {
			name: "v4-bodies",
			chatCompletion: async (call: Call): Promise<EnrichmentChatResponse> =>
				isJudgeCall(call)
					? {
							content: JSON.stringify({ correct: true, rationale: "fixture" }),
							responseMeta: { shape: "ok", finishReason: "stop" },
						}
					: {
							content: JSON.stringify(body),
							responseMeta: { shape: "ok", finishReason: "stop" },
						},
		}
		const envelope = await runE2eQa({
			provider,
			model: "fixture-answer-model",
			answerModel: "fixture-answer-model",
			judgeModel: "fixture-judge-model",
			cases: [heronCase()],
			protocol: "custom-v4",
		})
		return envelope.caseResults[0]
	}

	it("classifies notes and reasoning plus an answer as answer and records only the answer", async () => {
		const result = await answerWith({
			notes,
			reasoning: `the nest is by the pond ${CANARY}`,
			answer: " Quillmarsh pond ",
		})
		expect(result?.answerAttempt?.status).toBe("answer")
		expect(result?.candidateAnswer).toBe("Quillmarsh pond")
		expect(result?.error).toBeUndefined()
		expect(result?.answerAttempt?.contentSha256).toMatch(/^[0-9a-f]{64}$/)
		expect(result?.answerAttempt?.contentBytes).toBeGreaterThan(0)
		expect(JSON.stringify(result)).not.toContain(CANARY)
	})

	it("classifies an empty answer string as empty-answer", async () => {
		const result = await answerWith({ notes, reasoning: CANARY, answer: "" })
		expect(result?.answerAttempt?.status).toBe("empty-answer")
		expect(result?.candidateAnswer).toBe("")
		expect(result?.error).toBeUndefined()
		expect(JSON.stringify(result)).not.toContain(CANARY)
	})

	it("classifies a body with no answer key as missing-answer, a case error", async () => {
		const result = await answerWith({ notes, reasoning: CANARY })
		expect(result?.answerAttempt?.status).toBe("missing-answer")
		expect(result?.candidateAnswer).toBe("")
		expect(result?.error).toBe("answer-generation: missing-answer")
		expect(JSON.stringify(result)).not.toContain(CANARY)
	})
})
