import { describe, expect, it, vi } from "vitest"
import {
	E2E_QA_JUDGE_VERSION,
	generateAnswer,
	judgeAnswer,
	runE2eQa,
} from "./mongodb-e2e-qa.js"
import type { EnrichmentProvider } from "../packages/memory-engine/src/mongodb-llm-enrichment.js"

// A scripted provider whose response depends on the system prompt, so answer
// generation and judging can be driven independently in one mock. Optional
// usage simulates a transport that reports billed tokens (C-017).
function scriptedProvider(
	route: (systemPrompt: string, userPrompt: string) => string,
	usage?: { inputTokens: number; outputTokens: number },
): EnrichmentProvider {
	return {
		name: "mock",
		chatCompletion: vi.fn(async ({ messages }) => {
			const sys = messages.find((m) => m.role === "system")?.content ?? ""
			const user = messages.find((m) => m.role === "user")?.content ?? ""
			return { content: route(sys, user), ...(usage ? { usage } : {}) }
		}),
	}
}

describe("generateAnswer", () => {
	it("returns the model's answer text from the provided context", async () => {
		const provider = scriptedProvider(() =>
			JSON.stringify({ answer: "Berlin" }),
		)
		const answer = await generateAnswer({
			provider,
			model: "m",
			question: "Where does the user live?",
			contextPassages: ["The user lives in Berlin."],
		})
		expect(answer).toBe("Berlin")
	})

	it("returns an empty string when the model cannot answer", async () => {
		const provider = scriptedProvider(() => JSON.stringify({ answer: "" }))
		const answer = await generateAnswer({
			provider,
			model: "m",
			question: "Q",
			contextPassages: [],
		})
		expect(answer).toBe("")
	})

	it("records transport success with reported usage BEFORE parsing, so malformed model JSON keeps billed usage and is not double-counted as a transport failure", async () => {
		const usage = { inputTokens: 11, outputTokens: 7 }
		const provider = scriptedProvider(() => "not-json", usage)
		const calls: Array<{
			outcome: "attempted" | "succeeded" | "failed"
			usage?: { inputTokens: number; outputTokens: number }
		}> = []
		const failures: Error[] = []
		const answer = await generateAnswer({
			provider,
			model: "m",
			question: "Q",
			contextPassages: ["p"],
			onProviderCall: (outcome, reported) =>
				calls.push({ outcome, usage: reported }),
			onFailure: (error) => failures.push(error),
		})
		// The transport DID succeed and its usage is retained; the parse failure
		// fails the case below but adds no second provider outcome.
		expect(answer).toBe("")
		expect(calls).toEqual([
			{ outcome: "attempted", usage: undefined },
			{ outcome: "succeeded", usage },
		])
		expect(failures).toHaveLength(1)
	})

	it("records transport failure with no usage when the transport throws", async () => {
		const provider = scriptedProvider(() => {
			throw new Error("synthetic transport outage")
		})
		const calls: Array<{
			outcome: "attempted" | "succeeded" | "failed"
			usage?: { inputTokens: number; outputTokens: number }
		}> = []
		const failures: Error[] = []
		const answer = await generateAnswer({
			provider,
			model: "m",
			question: "Q",
			contextPassages: ["p"],
			onProviderCall: (outcome, reported) =>
				calls.push({ outcome, usage: reported }),
			onFailure: (error) => failures.push(error),
		})
		expect(answer).toBe("")
		expect(calls).toEqual([
			{ outcome: "attempted", usage: undefined },
			{ outcome: "failed", usage: undefined },
		])
		expect(failures).toHaveLength(1)
	})

	it("keeps a single provider attempt and a usable answer when the observer itself throws", async () => {
		const provider = scriptedProvider(() =>
			JSON.stringify({ answer: "Berlin" }),
		)
		let throwOnce = true
		const answer = await generateAnswer({
			provider,
			model: "m",
			question: "Where?",
			contextPassages: ["Berlin"],
			onProviderCall: () => {
				if (throwOnce) {
					throwOnce = false
					throw new Error("synthetic observer outage")
				}
			},
		})
		// An observer error must neither fail the call nor trigger retries.
		expect(answer).toBe("Berlin")
		expect(provider.chatCompletion).toHaveBeenCalledTimes(1)
	})
})

describe("judgeAnswer", () => {
	it("marks a semantically-correct answer correct", async () => {
		const provider = scriptedProvider(() =>
			JSON.stringify({ correct: true, rationale: "same city" }),
		)
		const verdict = await judgeAnswer({
			provider,
			model: "m",
			question: "Where?",
			goldAnswer: "Berlin",
			candidateAnswer: "They live in Berlin.",
		})
		expect(verdict.correct).toBe(true)
	})

	it("marks a wrong answer incorrect", async () => {
		const provider = scriptedProvider(() =>
			JSON.stringify({ correct: false, rationale: "different city" }),
		)
		const verdict = await judgeAnswer({
			provider,
			model: "m",
			question: "Where?",
			goldAnswer: "Berlin",
			candidateAnswer: "London",
		})
		expect(verdict.correct).toBe(false)
	})

	it("degrades to incorrect (not a silent pass) when the judge output is unparseable", async () => {
		const provider = scriptedProvider(() => "garbage")
		const verdict = await judgeAnswer({
			provider,
			model: "m",
			question: "Q",
			goldAnswer: "g",
			candidateAnswer: "c",
		})
		expect(verdict.correct).toBe(false)
	})
})

describe("runE2eQa", () => {
	// Route by prompt role: the generator echoes the gold from context; the judge
	// returns correct iff the candidate matches the gold in the prompt.
	function benchProvider(): EnrichmentProvider {
		return scriptedProvider((sys, user) => {
			if (sys.includes("answer the QUESTION")) {
				// generator: echo the fact from the single context passage
				const m = user.match(/<context>\n([\s\S]*?)\n<\/context>/)
				return JSON.stringify({ answer: (m?.[1] ?? "").trim() })
			}
			// judge: correct iff GOLD text appears within CANDIDATE text
			const gold = user.match(/GOLD ANSWER:\s*(.*)/)?.[1]?.trim() ?? "\0"
			const cand = user.match(/CANDIDATE ANSWER:\s*(.*)/)?.[1] ?? ""
			return JSON.stringify({ correct: cand.includes(gold), rationale: "x" })
		})
	}

	it("computes accuracy over cases and reports the judge identity", async () => {
		const provider = benchProvider()
		const envelope = await runE2eQa({
			provider,
			model: "judge-model",
			cases: [
				{
					caseId: "1",
					question: "Where does the user live?",
					goldAnswer: "Berlin",
					contextPassages: ["Berlin"],
				},
				{
					caseId: "2",
					question: "What DB?",
					goldAnswer: "MongoDB",
					contextPassages: ["MongoDB"],
				},
			],
		})
		// The generator echoes the gold, so both are judged correct.
		expect(envelope.accuracy).toBe(1)
		expect(envelope.judge).toBe("judge-model")
		expect(envelope.answerModel).toBe("judge-model")
		expect(envelope.judgeVersion).toBe(E2E_QA_JUDGE_VERSION)
		expect(typeof envelope.latencyMs).toBe("number")
		expect(envelope.cases).toEqual({
			eligible: 2,
			attempted: 2,
			completed: 2,
			failed: 0,
		})
		expect(envelope.attempts).toEqual({
			answerGeneration: 2,
			answerJudge: 2,
			decoyJudge: 2,
		})
		expect(envelope.caseResults).toHaveLength(2)
	})

	it("never scores a malformed answer as a correct abstention", async () => {
		const provider = scriptedProvider(() => "not-json")
		const providerCalls: Array<{
			operation: "answer-generation" | "answer-judge" | "decoy-judge"
			outcome: "attempted" | "succeeded" | "failed"
			usage?: { inputTokens: number; outputTokens: number }
		}> = []
		const envelope = await runE2eQa({
			provider,
			model: "judge-model",
			cases: [
				{
					caseId: "failed-case",
					question: "Where?",
					goldAnswer: "Berlin",
					contextPassages: ["Berlin"],
					abstention: true,
				},
			],
			onProviderCall: (operation, outcome, usage) =>
				providerCalls.push({ operation, outcome, usage }),
		})

		expect(envelope.cases).toEqual({
			eligible: 1,
			attempted: 1,
			completed: 0,
			failed: 1,
		})
		// Attempted-case accuracy: the failed case stays in the denominator
		// (attempted=1, correct=0) — a failure deflates accuracy to 0 instead of
		// vanishing from it. Null is reserved for the empty case set (below).
		expect(envelope.accuracy).toBe(0)
		expect(envelope.caseResults[0]).toEqual(
			expect.objectContaining({
				caseId: "failed-case",
				correct: false,
				error: expect.stringContaining("answer-generation"),
			}),
		)
		// The transport itself succeeded (malformed model text, not a transport
		// outage): the ledger records success, the QA case still fails, and the
		// call is never double-counted as a transport failure.
		expect(providerCalls).toEqual([
			{
				operation: "answer-generation",
				outcome: "attempted",
				usage: undefined,
			},
			{
				operation: "answer-generation",
				outcome: "succeeded",
				usage: undefined,
			},
		])
	})

	it("reflects wrong answers in a lower accuracy", async () => {
		const provider = benchProvider()
		const envelope = await runE2eQa({
			provider,
			model: "judge-model",
			cases: [
				{
					caseId: "1",
					question: "Q1",
					goldAnswer: "Berlin",
					contextPassages: ["Berlin"], // generator echoes -> correct
				},
				{
					caseId: "2",
					question: "Q2",
					goldAnswer: "MongoDB",
					contextPassages: ["Postgres"], // generator echoes wrong -> incorrect
				},
			],
		})
		expect(envelope.accuracy).toBe(0.5)
	})

	it("measures a lenient judge via the decoy false-positive probe", async () => {
		// A judge that ALWAYS says correct — accuracy looks perfect, but the decoy
		// probe must expose it as a false-positive rate of 1.
		const alwaysYes = scriptedProvider((sys) =>
			sys.includes("answer the QUESTION")
				? JSON.stringify({ answer: "whatever" })
				: JSON.stringify({ correct: true, rationale: "lenient" }),
		)
		const envelope = await runE2eQa({
			provider: alwaysYes,
			model: "m",
			cases: [
				{
					caseId: "1",
					question: "Q1",
					goldAnswer: "Berlin",
					contextPassages: ["x"],
				},
				{
					caseId: "2",
					question: "Q2",
					goldAnswer: "MongoDB",
					contextPassages: ["y"],
				},
			],
		})
		expect(envelope.accuracy).toBe(1)
		expect(envelope.judgeFalsePositiveRate).toBe(1)
	})

	it("returns a null envelope for an empty case set", async () => {
		const provider = benchProvider()
		const envelope = await runE2eQa({ provider, model: "m", cases: [] })
		expect(envelope.accuracy).toBeNull()
		expect(envelope.judgeFalsePositiveRate).toBeNull()
	})

	it("reports judgeFalsePositiveRate=null when no viable decoy exists (single case)", async () => {
		const envelope = await runE2eQa({
			provider: benchProvider(),
			model: "m",
			cases: [
				{
					caseId: "1",
					question: "Where does the user live?",
					goldAnswer: "Berlin",
					contextPassages: ["Berlin"],
				},
			],
		})
		// Vacuous probe must not read as a perfectly-calibrated judge.
		expect(envelope.judgeFalsePositiveRate).toBeNull()
		expect(envelope.accuracy).toBe(1)
	})

	it("grades an abstention case by refusal, not fact-match", async () => {
		// The model declines (empty answer); the fact-match judge would say
		// incorrect, but abstention grading recognizes the refusal as correct.
		const abstaining = scriptedProvider((sys) =>
			sys.includes("answer the QUESTION")
				? JSON.stringify({ answer: "" })
				: JSON.stringify({ correct: false, rationale: "no match" }),
		)
		const envelope = await runE2eQa({
			provider: abstaining,
			model: "m",
			cases: [
				{
					caseId: "1",
					question: "What is the user's blood type?",
					goldAnswer: "no information available",
					contextPassages: ["The user likes hiking."],
					abstention: true,
				},
			],
		})
		expect(envelope.accuracy).toBe(1)
		expect(envelope.judgeFalsePositiveRate).toBeNull()
	})

	it("keeps the primary verdict while a decoy failure remains failed coverage", async () => {
		// Accuracy uses all attempts, while coverage keeps its fail-closed
		// accounting for a failed calibration call.
		const provider = scriptedProvider((sys, user) => {
			if (sys.includes("answer the QUESTION")) {
				const answer = user.includes("case one") ? "violet" : "emerald"
				return JSON.stringify({ answer })
			}
			const isCaseOne = user.includes("case one")
			const candidate = /CANDIDATE ANSWER: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
			if (isCaseOne && candidate === "emerald") {
				throw new Error("synthetic decoy-judge failure for case-1")
			}
			const gold = isCaseOne ? "violet" : "emerald"
			return JSON.stringify({
				correct: candidate === gold,
				rationale: candidate === gold ? "candidate matches gold" : "wrong fact",
			})
		})
		const providerCalls: Array<{
			operation: "answer-generation" | "answer-judge" | "decoy-judge"
			outcome: "attempted" | "succeeded" | "failed"
		}> = []
		const envelope = await runE2eQa({
			provider,
			model: "m",
			cases: [
				{
					caseId: "case-1",
					question: "What color is the sky in case one?",
					goldAnswer: "violet",
					contextPassages: ["passage one says the sky is violet"],
				},
				{
					caseId: "case-2",
					question: "What color is the grass in case two?",
					goldAnswer: "emerald",
					contextPassages: ["passage two says the grass is emerald"],
				},
			],
			onProviderCall: (operation, outcome) =>
				providerCalls.push({ operation, outcome }),
		})

		expect(envelope.accuracy).toBe(1)
		expect(envelope.accuracy).toBeGreaterThanOrEqual(0)
		expect(envelope.accuracy).toBeLessThanOrEqual(1)
		expect(envelope.cases).toEqual({
			eligible: 2,
			attempted: 2,
			completed: 1,
			failed: 1,
		})
		expect(envelope.cases.completed / envelope.cases.eligible).toBe(0.5)
		expect(envelope.attempts).toEqual({
			answerGeneration: 2,
			answerJudge: 2,
			decoyJudge: 2,
		})
		const case1 = envelope.caseResults.find(
			(entry) => entry.caseId === "case-1",
		)
		const case2 = envelope.caseResults.find(
			(entry) => entry.caseId === "case-2",
		)
		expect(case1?.correct).toBe(true)
		expect(case1?.error).toContain("decoy-judge:")
		expect(case2?.correct).toBe(true)
		expect(case2?.error).toBeUndefined()
		// The failed probe is excluded from the FP denominator; the one
		// successful probe rejected its decoy.
		expect(envelope.judgeFalsePositiveRate).toBe(0)
		expect(
			providerCalls.filter(
				(call) => call.operation === "decoy-judge" && call.outcome === "failed",
			),
		).toHaveLength(1)
	})

	it("divides correct answers by attempted cases across a mixed failure set", async () => {
		// Five cases, one of each outcome: generation failure, answer-judge
		// failure, correct primary + decoy failure, incorrect primary, correct
		// primary. Attempted-denominator accuracy = 2/5 = 0.4; every failure is
		// visible on its case and in the attempt ledger.
		const provider = scriptedProvider((sys, user) => {
			if (sys.includes("answer the QUESTION")) {
				if (user.includes("Q-A genfail")) {
					throw new Error("synthetic answer-generation failure for A")
				}
				const m = user.match(/<context>\n([\s\S]*?)\n<\/context>/)
				// Strip the "[1] " numbering runE2eQa adds to context passages.
				return JSON.stringify({
					answer: (m?.[1] ?? "").replace(/^\[\d+\]\s*/, "").trim(),
				})
			}
			const gold = /GOLD ANSWER:\s*(.*)/.exec(user)?.[1]?.trim() ?? ""
			const candidate = /CANDIDATE ANSWER: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
			if (gold === "goldB" && candidate === "goldB") {
				throw new Error("synthetic answer-judge failure for B")
			}
			if (gold === "goldC" && candidate !== "goldC") {
				throw new Error("synthetic decoy-judge failure for C")
			}
			return JSON.stringify({
				correct: candidate === gold,
				rationale: candidate === gold ? "candidate matches gold" : "wrong fact",
			})
		})
		const envelope = await runE2eQa({
			provider,
			model: "m",
			cases: [
				{
					caseId: "A",
					question: "Q-A genfail?",
					goldAnswer: "goldA",
					contextPassages: ["goldA"],
				},
				{
					caseId: "B",
					question: "Q-B judgefail?",
					goldAnswer: "goldB",
					contextPassages: ["goldB"],
				},
				{
					caseId: "C",
					question: "Q-C decoyfail?",
					goldAnswer: "goldC",
					contextPassages: ["goldC"],
				},
				{
					caseId: "D",
					question: "Q-D wrong?",
					goldAnswer: "goldD",
					contextPassages: ["wrong-fact"],
				},
				{
					caseId: "E",
					question: "Q-E right?",
					goldAnswer: "goldE",
					contextPassages: ["goldE"],
				},
			],
		})

		expect(envelope.accuracy).toBe(0.4)
		expect(envelope.cases).toEqual({
			eligible: 5,
			attempted: 5,
			completed: 2,
			failed: 3,
		})
		expect(envelope.attempts).toEqual({
			answerGeneration: 5,
			answerJudge: 4,
			decoyJudge: 3,
		})
		const byCase = new Map(
			envelope.caseResults.map((entry) => [entry.caseId, entry]),
		)
		expect(byCase.get("A")?.error).toContain("answer-generation:")
		expect(byCase.get("A")?.correct).toBe(false)
		expect(byCase.get("B")?.error).toContain("answer-judge:")
		expect(byCase.get("B")?.correct).toBe(false)
		expect(byCase.get("C")?.error).toContain("decoy-judge:")
		expect(byCase.get("C")?.correct).toBe(true)
		expect(byCase.get("D")?.error).toBeUndefined()
		expect(byCase.get("D")?.correct).toBe(false)
		expect(byCase.get("E")?.error).toBeUndefined()
		expect(byCase.get("E")?.correct).toBe(true)
		// Two successful decoy probes (D, E), both rejected.
		expect(envelope.judgeFalsePositiveRate).toBe(0)
	})

	it("reports accuracy 0 (not null) when every attempted case fails", async () => {
		const provider = scriptedProvider(() => {
			throw new Error("synthetic total provider outage")
		})
		const envelope = await runE2eQa({
			provider,
			model: "m",
			cases: [
				{
					caseId: "A",
					question: "Q-A?",
					goldAnswer: "goldA",
					contextPassages: ["goldA"],
				},
				{
					caseId: "B",
					question: "Q-B?",
					goldAnswer: "goldB",
					contextPassages: ["goldB"],
				},
			],
		})
		expect(envelope.accuracy).toBe(0)
		expect(envelope.cases).toEqual({
			eligible: 2,
			attempted: 2,
			completed: 0,
			failed: 2,
		})
		expect(envelope.attempts).toEqual({
			answerGeneration: 2,
			answerJudge: 0,
			decoyJudge: 0,
		})
		expect(
			envelope.caseResults.every(
				(entry) =>
					entry.correct === false && entry.error?.includes("answer-generation"),
			),
		).toBe(true)
		expect(envelope.judgeFalsePositiveRate).toBeNull()
	})

	it("forwards the transport usage per operation to the observer", async () => {
		const usage = { inputTokens: 3, outputTokens: 5 }
		const provider = scriptedProvider((sys, user) => {
			if (sys.includes("answer the QUESTION")) {
				const m = user.match(/<context>\n([\s\S]*?)\n<\/context>/)
				return JSON.stringify({ answer: (m?.[1] ?? "").trim() })
			}
			const gold = user.match(/GOLD ANSWER:\s*(.*)/)?.[1]?.trim() ?? "\0"
			const cand = user.match(/CANDIDATE ANSWER:\s*(.*)/)?.[1] ?? ""
			return JSON.stringify({ correct: cand.includes(gold), rationale: "x" })
		}, usage)
		const providerCalls: Array<{
			operation: "answer-generation" | "answer-judge" | "decoy-judge"
			outcome: "attempted" | "succeeded" | "failed"
			usage?: { inputTokens: number; outputTokens: number }
		}> = []
		await runE2eQa({
			provider,
			model: "m",
			cases: [
				{
					caseId: "1",
					question: "Where does the user live?",
					goldAnswer: "Berlin",
					contextPassages: ["Berlin"],
				},
			],
			onProviderCall: (operation, outcome, reported) =>
				providerCalls.push({ operation, outcome, usage: reported }),
		})
		// Attempted carries no usage yet; each succeeded call carries the
		// transport-reported usage for its operation.
		expect(providerCalls).toEqual([
			{
				operation: "answer-generation",
				outcome: "attempted",
				usage: undefined,
			},
			{ operation: "answer-generation", outcome: "succeeded", usage },
			{ operation: "answer-judge", outcome: "attempted", usage: undefined },
			{ operation: "answer-judge", outcome: "succeeded", usage },
		])
	})

	it("routes distinct answer and judge models through the same provider per role", async () => {
		const modelsByRole = new Map<string, Set<string>>()
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn(
				async ({
					model,
					messages,
				}: {
					model: string
					messages: Array<{ role: string; content: string }>
				}) => {
					const sys = messages.find((m) => m.role === "system")?.content ?? ""
					const user = messages.find((m) => m.role === "user")?.content ?? ""
					const role = sys.includes("answer the QUESTION") ? "answer" : "judge"
					const seen = modelsByRole.get(role) ?? new Set<string>()
					seen.add(model)
					modelsByRole.set(role, seen)
					if (role === "answer") {
						const m = user.match(/<context>\n([\s\S]*?)\n<\/context>/)
						return {
							content: JSON.stringify({ answer: (m?.[1] ?? "").trim() }),
						}
					}
					const gold = user.match(/GOLD ANSWER:\s*(.*)/)?.[1]?.trim() ?? "\0"
					const cand = user.match(/CANDIDATE ANSWER:\s*(.*)/)?.[1] ?? ""
					return {
						content: JSON.stringify({
							correct: cand.includes(gold),
							rationale: "x",
						}),
					}
				},
			),
		}
		const envelope = await runE2eQa({
			provider,
			model: "answer-m",
			answerModel: "answer-m",
			judgeModel: "judge-m",
			cases: [
				{
					caseId: "1",
					question: "Where does the user live?",
					goldAnswer: "Berlin",
					contextPassages: ["Berlin"],
				},
				{
					caseId: "2",
					question: "What DB?",
					goldAnswer: "MongoDB",
					contextPassages: ["MongoDB"],
				},
			],
		})
		expect(envelope.answerModel).toBe("answer-m")
		expect(envelope.judge).toBe("judge-m")
		expect(modelsByRole.get("answer")).toEqual(new Set(["answer-m"]))
		// Both the primary verdict and the decoy probe judge with judge-m.
		expect(modelsByRole.get("judge")).toEqual(new Set(["judge-m"]))
	})
})
