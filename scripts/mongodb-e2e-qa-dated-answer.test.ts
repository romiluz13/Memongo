import { describe, expect, it } from "vitest"
import type { EnrichmentProvider } from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { type E2eQaCase, runE2eQa } from "./mongodb-e2e-qa.js"

type Call = Parameters<EnrichmentProvider["chatCompletion"]>[0]

const RETURN_LINE = 'Return only {"answer":"..."}.'

function recordingProvider() {
	const calls: Call[] = []
	const provider: EnrichmentProvider = {
		name: "recording",
		chatCompletion: async (call: Call) => {
			calls.push(structuredClone(call))
			const user = call.messages.find((m) => m.role === "user")?.content ?? ""
			if (user.includes("GOLD ANSWER:")) {
				return {
					content: JSON.stringify({ correct: true, rationale: "fixture" }),
					responseMeta: { shape: "ok", finishReason: "stop" },
				}
			}
			return {
				content: JSON.stringify({ answer: "Quillmarsh" }),
				responseMeta: { shape: "ok", finishReason: "stop" },
			}
		},
	}
	return { provider, calls }
}

async function run(
	cases: E2eQaCase[],
	protocol?: "custom-v1" | "custom-v2",
): Promise<{
	calls: Call[]
	answers: Call[]
	envelope: Awaited<ReturnType<typeof runE2eQa>>
}> {
	const { provider, calls } = recordingProvider()
	const envelope = await runE2eQa({
		provider,
		model: "fixture-answer-model",
		answerModel: "fixture-answer-model",
		judgeModel: "fixture-judge-model",
		cases,
		...(protocol ? { protocol } : {}),
	})
	const answers = calls.filter(
		(call) =>
			!call.messages
				.find((m) => m.role === "user")
				?.content.includes("GOLD ANSWER:"),
	)
	return { calls, answers, envelope }
}

function answerUser(call: Call | undefined): string {
	return call?.messages.find((m) => m.role === "user")?.content ?? ""
}

function datedCase(overrides: Partial<E2eQaCase> = {}): E2eQaCase {
	return {
		caseId: "heron",
		question: "Where did the heron nest?",
		goldAnswer: "Quillmarsh",
		questionDate: "2031/02/14 (Fri) 09:30",
		contextPassages: [
			"The heron nested by Quillmarsh pond",
			"The heron nested in Brindlewick reeds",
		],
		passageDates: [["2031/01/20 (Mon) 10:00"], ["2030/11/02 (Sat) 18:45"]],
		passageRoles: ["user", "assistant"],
		...overrides,
	}
}

describe("custom-v2 dated answer context", () => {
	it("tells the answerer when the question was asked", async () => {
		const { answers } = await run([datedCase()], "custom-v2")
		expect(answerUser(answers[0]).split("\n")[0]).toBe(
			"QUESTION (asked on 2031/02/14 (Fri) 09:30): Where did the heron nest?",
		)
	})

	it("renders dates and roles in rank order with the custom-v1 return line", async () => {
		const { answers } = await run([datedCase()], "custom-v2")
		expect(answerUser(answers[0])).toBe(
			[
				"QUESTION (asked on 2031/02/14 (Fri) 09:30): Where did the heron nest?",
				"<context>",
				"[1] [2031/01/20 (Mon) 10:00] User: The heron nested by Quillmarsh pond",
				"[2] [2030/11/02 (Sat) 18:45] Assistant: The heron nested in Brindlewick reeds",
				"</context>",
				RETURN_LINE,
			].join("\n"),
		)
	})

	it("keeps each occurrence of one session under its own dates", async () => {
		// Fictional session "sess-heron" occurs twice: one passage carries both
		// occurrence dates, another passage from it carries only the later one.
		const { answers } = await run(
			[
				datedCase({
					contextPassages: [
						"sess-heron: the heron returned",
						"sess-heron: the heron left",
					],
					passageDates: [
						["2030/11/02 (Sat) 18:45", "2030/12/01 (Mon) 08:00"],
						["2030/12/01 (Mon) 08:00"],
					],
					passageRoles: ["user", "user"],
				}),
			],
			"custom-v2",
		)
		const user = answerUser(answers[0])
		expect(user).toContain(
			"[1] [2030/11/02 (Sat) 18:45; 2030/12/01 (Mon) 08:00] User: sess-heron: the heron returned",
		)
		expect(user).toContain(
			"[2] [2030/12/01 (Mon) 08:00] User: sess-heron: the heron left",
		)
	})

	it("labels the same sentence with whoever said it", async () => {
		const { answers } = await run(
			[
				datedCase({
					contextPassages: ["I like teal herons", "I like teal herons"],
					passageDates: [
						["2030/11/02 (Sat) 18:45"],
						["2030/11/02 (Sat) 18:45"],
					],
					passageRoles: ["user", "assistant"],
				}),
			],
			"custom-v2",
		)
		const user = answerUser(answers[0])
		expect(user).toContain(
			"[1] [2030/11/02 (Sat) 18:45] User: I like teal herons",
		)
		expect(user).toContain(
			"[2] [2030/11/02 (Sat) 18:45] Assistant: I like teal herons",
		)
	})

	it("renders a passage without its date or role bare, with no invented value", async () => {
		const { answers } = await run(
			[
				datedCase({
					questionDate: undefined,
					contextPassages: [
						"undated heron note",
						"roleless heron note",
						"bare heron note",
					],
					passageDates: [[], ["2030/11/02 (Sat) 18:45"], []],
					passageRoles: ["user", undefined, undefined],
				}),
			],
			"custom-v2",
		)
		expect(answerUser(answers[0])).toBe(
			[
				"QUESTION: Where did the heron nest?",
				"<context>",
				"[1] User: undated heron note",
				"[2] [2030/11/02 (Sat) 18:45] roleless heron note",
				"[3] bare heron note",
				"</context>",
				RETURN_LINE,
			].join("\n"),
		)
	})

	it("renders bare passages when the case has no dates or roles at all", async () => {
		const { answers } = await run(
			[
				datedCase({
					passageDates: undefined,
					passageRoles: undefined,
				}),
			],
			"custom-v2",
		)
		expect(answerUser(answers[0])).toContain(
			"<context>\n[1] The heron nested by Quillmarsh pond\n[2] The heron nested in Brindlewick reeds\n</context>",
		)
	})

	it("does not double a role label the passage already carries (B9-2)", async () => {
		const { answers } = await run(
			[
				datedCase({
					contextPassages: [
						"User: the heron nested by Quillmarsh pond",
						"Assistant: the user said Brindlewick",
					],
					passageRoles: ["user", "user"],
				}),
			],
			"custom-v2",
		)
		const user = answerUser(answers[0])
		expect(user).toContain(
			"[1] [2031/01/20 (Mon) 10:00] User: the heron nested by Quillmarsh pond",
		)
		expect(user).toContain(
			"[2] [2030/11/02 (Sat) 18:45] User: Assistant: the user said Brindlewick",
		)
		expect(user).not.toContain("User: User:")
	})

	it("keeps rank order and alignment when the input order changes", async () => {
		const base = datedCase({
			contextPassages: ["heron alpha", "heron beta", "heron gamma"],
			passageDates: [
				["2031/01/03 (Fri) 10:00"],
				["2030/10/01 (Wed) 10:00"],
				[],
			],
			passageRoles: ["user", "assistant", undefined],
		})
		const reordered = datedCase({
			contextPassages: ["heron gamma", "heron alpha", "heron beta"],
			passageDates: [
				[],
				["2031/01/03 (Fri) 10:00"],
				["2030/10/01 (Wed) 10:00"],
			],
			passageRoles: [undefined, "user", "assistant"],
		})
		const first = answerUser((await run([base], "custom-v2")).answers[0])
		const second = answerUser((await run([reordered], "custom-v2")).answers[0])
		expect(first).toContain(
			[
				"[1] [2031/01/03 (Fri) 10:00] User: heron alpha",
				"[2] [2030/10/01 (Wed) 10:00] Assistant: heron beta",
				"[3] heron gamma",
			].join("\n"),
		)
		expect(second).toContain(
			[
				"[1] heron gamma",
				"[2] [2031/01/03 (Fri) 10:00] User: heron alpha",
				"[3] [2030/10/01 (Wed) 10:00] Assistant: heron beta",
			].join("\n"),
		)
	})

	it("keeps dates and roles aligned through the 20-passage cap", async () => {
		const count = 23
		const { answers } = await run(
			[
				datedCase({
					contextPassages: Array.from(
						{ length: count },
						(_, i) => `heron note ${i}`,
					),
					passageDates: Array.from({ length: count }, (_, i) =>
						i % 4 === 0 ? [] : [`2030/01/${String(i + 1).padStart(2, "0")}`],
					),
					passageRoles: Array.from({ length: count }, (_, i) =>
						i % 3 === 0 ? undefined : i % 3 === 1 ? "user" : "assistant",
					),
				}),
			],
			"custom-v2",
		)
		const lines = answerUser(answers[0]).split("\n")
		const passageLines = lines.slice(
			lines.indexOf("<context>") + 1,
			lines.indexOf("</context>"),
		)
		expect(passageLines).toHaveLength(20)
		expect(passageLines[0]).toBe("[1] heron note 0")
		expect(passageLines[1]).toBe("[2] [2030/01/02] User: heron note 1")
		expect(passageLines[2]).toBe("[3] [2030/01/03] Assistant: heron note 2")
		expect(passageLines[3]).toBe("[4] [2030/01/04] heron note 3")
		expect(passageLines[19]).toBe("[20] [2030/01/20] User: heron note 19")
		expect(answerUser(answers[0])).not.toContain("heron note 20")
	})

	it("changes only the answer user content and records its own version", async () => {
		const cases: E2eQaCase[] = [
			datedCase(),
			{ ...datedCase({ caseId: "second", goldAnswer: "Brindlewick" }) },
			{
				...datedCase({ caseId: "abstain", goldAnswer: "" }),
				abstention: true,
			},
		]
		const v1 = await run(cases)
		const v2 = await run(cases, "custom-v2")
		const withoutAnswerUser = (calls: Call[]) =>
			calls.map((call) =>
				call.messages.some(
					(m) => m.role === "user" && m.content.includes("GOLD ANSWER:"),
				)
					? call
					: {
							...call,
							messages: call.messages.filter((m) => m.role !== "user"),
						},
			)
		expect(withoutAnswerUser(v2.calls)).toEqual(withoutAnswerUser(v1.calls))
		expect(answerUser(v2.answers[0])).not.toBe(answerUser(v1.answers[0]))
		expect(answerUser(v1.answers[0])).toBe(
			[
				"QUESTION: Where did the heron nest?",
				"<context>",
				"[1] The heron nested by Quillmarsh pond",
				"[2] The heron nested in Brindlewick reeds",
				"</context>",
				RETURN_LINE,
			].join("\n"),
		)
		expect(v1.envelope.judgeVersion).toBe("v1")
		expect(v2.envelope.judgeVersion).toBe("v2")
		const outcomes = (envelope: typeof v1.envelope) =>
			envelope.caseResults.map(({ latencyMs: _latency, ...rest }) => rest)
		expect(outcomes(v2.envelope)).toEqual(outcomes(v1.envelope))
		expect(v2.envelope.caseResults[0]?.answerAttempt).toBeDefined()
	})
})
