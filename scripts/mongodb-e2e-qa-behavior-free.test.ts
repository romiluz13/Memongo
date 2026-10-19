import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { EnrichmentProvider } from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type { Pass0ContextDiagnostics } from "./benchmark/benchmark-context-diagnostics.js"
import { type E2eQaCase, runE2eQa } from "./mongodb-e2e-qa.js"

type Call = Parameters<EnrichmentProvider["chatCompletion"]>[0]

// A provider spy whose replies depend on the exact request, so any drift in
// numbering, order, cap or model changes the answer as well as the recorded
// request.
function spyProvider() {
	const calls: Call[] = []
	const provider: EnrichmentProvider = {
		name: "spy",
		chatCompletion: async (call: Call) => {
			calls.push(structuredClone(call))
			const user = call.messages.find((m) => m.role === "user")?.content ?? ""
			if (user.includes("GOLD ANSWER:")) {
				const candidate = /CANDIDATE ANSWER: (.*)/.exec(user)?.[1] ?? ""
				return {
					content: JSON.stringify({
						correct: candidate.includes("[20]"),
						rationale: "spy",
					}),
				}
			}
			const numbered = user.split("\n").filter((line) => /^\[\d+\] /.test(line))
			return {
				content: JSON.stringify({ answer: numbered.at(-1) ?? "" }),
			}
		},
	}
	return { provider, calls }
}

const UNICODE = [
	"Zoë’s café ☕ — 日本語",
	"👩‍👩‍👧 family and 😀",
	"right-to-left: שלום עולם",
	"nb sp em sep",
	"é combining",
]

function passageFixture(): string[] {
	const passages = Array.from({ length: 24 }, (_, i) => `filler ${i}`)
	passages[3] = ""
	passages[5] = passages[4] as string
	UNICODE.forEach((text, i) => {
		passages[6 + i] = text
	})
	passages[12] = "  padded\t "
	return passages
}

function diagnosticsFor(passages: string[]): Pass0ContextDiagnostics {
	return {
		sentCandidates: passages.map((_, i) => ({
			retrievedRank: i + 1,
			memoryId: `memory-${i + 1}`,
			score: 1 / (i + 1),
			sessionIds: ["q::s1"],
			turnIds: [`q::s1::turn_${i + 1}`],
			provenance: "complete" as const,
		})),
		retrievedSessionRanks: new Map([["q::s1", 1]]),
		retrievedTurnRanks: new Map([["q::s1::turn_30", 30]]),
		gold: {
			applicable: true,
			sessions: [{ admittedSessionIndex: 0, sessionId: "q::s1" }],
			turns: [
				{
					admittedSessionIndex: 0,
					sessionId: "q::s1",
					turnIndex: 29,
					turnId: "q::s1::turn_30",
					text: "the gold turn body",
				},
			],
		},
	}
}

function throwingDiagnostics(): Pass0ContextDiagnostics {
	return {
		get sentCandidates(): never {
			throw new Error("diagnostics exploded")
		},
		retrievedSessionRanks: new Map(),
		retrievedTurnRanks: new Map(),
		gold: { applicable: false, reason: "abstention" },
	}
}

function casesWith(
	diagnostics: (passages: string[]) => Pass0ContextDiagnostics | undefined,
): E2eQaCase[] {
	const passages = passageFixture()
	const attach = (list: string[]) => {
		const value = diagnostics(list)
		return value ? { diagnostics: value } : {}
	}
	return [
		{
			caseId: "many",
			question: "Which passage is last?",
			goldAnswer: "[20] filler 19",
			contextPassages: passages,
			...attach(passages),
		},
		{
			caseId: "abstain",
			question: "What is the secret?",
			goldAnswer: "",
			abstention: true,
			contextPassages: passages,
			...attach(passages),
		},
		{
			caseId: "short",
			question: "What is the short one?",
			goldAnswer: "[2] two",
			contextPassages: ["one", "two"],
			...attach(["one", "two"]),
		},
	]
}

async function observe(
	diagnostics: (passages: string[]) => Pass0ContextDiagnostics | undefined,
) {
	const { provider, calls } = spyProvider()
	const cases = casesWith(diagnostics)
	const passagesBefore = cases.map((c) => [...c.contextPassages])
	const envelope = await runE2eQa({
		provider,
		model: "answer-model",
		answerModel: "answer-model",
		judgeModel: "judge-model",
		cases,
	})
	// The diagnostics step reads its input only.
	expect(cases.map((c) => c.contextPassages)).toEqual(passagesBefore)
	return { envelope, calls }
}

function verdicts(envelope: Awaited<ReturnType<typeof observe>>["envelope"]) {
	return envelope.caseResults.map((r) => ({
		caseId: r.caseId,
		candidateAnswer: r.candidateAnswer,
		correct: r.correct,
		abstention: r.abstention,
		error: r.error,
	}))
}

describe("runE2eQa diagnostics are behavior free", () => {
	it("sends the identical answerer and judge requests with and without diagnostics, including when the diagnostics step throws", async () => {
		const without = await observe(() => undefined)
		const withDiagnostics = await observe(diagnosticsFor)
		const throwing = await observe(() => throwingDiagnostics())

		const request = without.calls.find((c) =>
			c.messages.some((m) => m.content.includes("[20] ")),
		)
		const user = request?.messages.find((m) => m.role === "user")?.content ?? ""
		expect(user).toContain("[20] ")
		expect(user).not.toContain("[21] ")
		expect(without.calls.length).toBeGreaterThan(3)

		expect(withDiagnostics.calls).toEqual(without.calls)
		expect(throwing.calls).toEqual(without.calls)
		expect(verdicts(withDiagnostics.envelope)).toEqual(
			verdicts(without.envelope),
		)
		expect(verdicts(throwing.envelope)).toEqual(verdicts(without.envelope))
		for (const run of [withDiagnostics, throwing]) {
			expect(run.envelope.accuracy).toBe(without.envelope.accuracy)
			expect(run.envelope.attempts).toEqual(without.envelope.attempts)
			expect(run.envelope.cases).toEqual(without.envelope.cases)
			expect(run.envelope.judgeFalsePositiveRate).toBe(
				without.envelope.judgeFalsePositiveRate,
			)
		}
	})

	it("records a throwing diagnostics step as a diagnostics error on the case and nothing else", async () => {
		const { envelope } = await observe(() => throwingDiagnostics())
		for (const result of envelope.caseResults) {
			expect(result.diagnosticsError).toContain("diagnostics exploded")
			expect(result.contextPassages).toBeUndefined()
			expect(result.gold).toBeUndefined()
			expect(result.error).toBeUndefined()
		}
	})

	it("describes exactly the passages numbered in the answerer request", async () => {
		const { envelope, calls } = await observe(diagnosticsFor)
		const answerCall = calls.find((c) =>
			c.messages.some((m) => m.content.includes("QUESTION: Which passage")),
		)
		const user =
			answerCall?.messages.find((m) => m.role === "user")?.content ?? ""
		const lines = (/<context>\n([\s\S]*)\n<\/context>/.exec(user)?.[1] ?? "")
			.split("\n")
			.map((line) => /^\[(\d+)\] ([\s\S]*)$/.exec(line))
		const sent = envelope.caseResults[0]?.contextPassages ?? []
		expect(sent).toHaveLength(20)
		expect(lines).toHaveLength(sent.length)
		sent.forEach((entry, index) => {
			const line = lines[index]
			expect(Number(line?.[1])).toBe(entry.sentRank)
			expect(entry.sha256).toBe(
				createHash("sha256")
					.update(line?.[2] ?? "", "utf8")
					.digest("hex"),
			)
		})
		expect(envelope.caseResults[0]?.passagesSentCount).toBe(20)
		expect(envelope.caseResults[2]?.passagesSentCount).toBe(2)
	})
})
