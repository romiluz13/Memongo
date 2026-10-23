import { describe, expect, it } from "vitest"
import { runE2eQa } from "./mongodb-e2e-qa.js"
import {
	type Call,
	heronCase,
	recordingProvider,
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
})
