import { describe, expect, it } from "vitest"
import type {
	EnrichmentChatUsage,
	EnrichmentProvider,
} from "../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type {
	Pass0ContextDiagnostics,
	ResultLineage,
} from "./benchmark/benchmark-context-diagnostics.js"
import type {
	BenchmarkE2eQaEnvelope,
	BenchmarkGoldSentStatus,
} from "../packages/memory-engine/src/types.js"
import { estimateTokens, type ReaderUnit } from "./benchmark/reader-budget.js"
import {
	type E2eQaCase,
	type E2eQaEnvelope,
	runE2eQa,
} from "./mongodb-e2e-qa.js"
import { readerPositionTerciles } from "./mongodb-e2e-qa-reader-budget.js"

// custom-v3: round units under the reader token budget, official session
// serialization. Fictional strings only.

type Call = Parameters<EnrichmentProvider["chatCompletion"]>[0]

function recordingProvider(
	answerUsage: Array<EnrichmentChatUsage | undefined>,
) {
	const calls: Call[] = []
	let answers = 0
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
			const usage = answerUsage[answers++]
			return {
				content: JSON.stringify({ answer: "Quillmarsh" }),
				responseMeta: { shape: "ok", finishReason: "stop" },
				...(usage ? { usage } : {}),
			}
		},
	}
	return { provider, calls }
}

function unit(
	id: string,
	rank: number,
	sessionId: string,
	turnOrder: number,
	passage: string,
	sessionDates: string[],
): ReaderUnit {
	return { id, rank, sessionId, turnOrder, passage, sessionDates }
}

const HERON_UNITS: ReaderUnit[] = [
	unit(
		"round:event:u2|event:a2",
		1,
		"sess-pond",
		2,
		"User: Where did the heron nest?\nAssistant: By Quillmarsh pond.",
		["2031/01/20 (Mon) 10:00"],
	),
	unit(
		"single:event:u7",
		2,
		"sess-reeds",
		1,
		"User: Brindlewick reeds are tall.",
		["2030/11/02 (Sat) 18:45"],
	),
]

function heronCase(overrides: Partial<E2eQaCase> = {}): E2eQaCase {
	return {
		caseId: "heron",
		question: "Where did the heron nest?",
		goldAnswer: "Quillmarsh",
		questionDate: "2031/02/14 (Fri) 09:30",
		contextPassages: [],
		readerUnits: HERON_UNITS,
		...overrides,
	}
}

async function run(
	cases: E2eQaCase[],
	answerUsage: Array<EnrichmentChatUsage | undefined> = [],
) {
	const { provider, calls } = recordingProvider(answerUsage)
	const envelope = await runE2eQa({
		provider,
		model: "fixture-answer-model",
		answerModel: "fixture-answer-model",
		judgeModel: "fixture-judge-model",
		cases,
		protocol: "custom-v3",
	})
	const answers = calls.filter(
		(call) =>
			!call.messages
				.find((m) => m.role === "user")
				?.content.includes("GOLD ANSWER:"),
	)
	return { calls, answers, envelope }
}

describe("custom-v3 answer request", () => {
	it("sends the official session form with custom-v1's system prompt and token cap", async () => {
		const { answers, envelope } = await run([heronCase()])
		expect(answers).toHaveLength(1)
		const call = answers[0] as Call
		expect(call.messages[1]).toEqual({
			role: "user",
			content: [
				"History Chats:",
				"",
				"### Session 1:",
				"Session Date: 2030/11/02 (Sat) 18:45",
				"Session Content:",
				"User: Brindlewick reeds are tall.",
				"",
				"### Session 2:",
				"Session Date: 2031/01/20 (Mon) 10:00",
				"Session Content:",
				"User: Where did the heron nest?",
				"Assistant: By Quillmarsh pond.",
				"",
				"Current Date: 2031/02/14 (Fri) 09:30",
				"Question: Where did the heron nest?",
				'Return only {"answer":"..."}.',
			].join("\n"),
		})
		expect(call.messages[0]?.content).toMatch(
			/^You answer the QUESTION using ONLY the provided context passages/,
		)
		expect(call.maxTokens).toBe(512)
		expect(call.responseFormat).toEqual({ type: "json_object" })
		expect(envelope.judgeVersion).toBe("v3")
		expect(envelope.caseResults[0]?.correct).toBe(true)
	})
})

describe("custom-v3 per-case record", () => {
	it("records the estimate, budget, unit counts, skipped ranks and provider input tokens", async () => {
		const huge = unit(
			"single:event:u9",
			3,
			"sess-reeds",
			4,
			`User: ${"Reed warblers sing at dusk. ".repeat(3000)}`,
			["2030/11/02 (Sat) 18:45"],
		)
		const { answers, envelope } = await run(
			[
				heronCase({
					readerUnits: [...HERON_UNITS, HERON_UNITS[0] as ReaderUnit, huge],
				}),
			],
			[{ inputTokens: 171, outputTokens: 9 }],
		)
		const system = answers[0]?.messages[0]?.content ?? ""
		const sent = answers[0]?.messages[1]?.content ?? ""
		expect(sent).not.toContain("Reed warblers")
		expect(envelope.caseResults[0]?.readerBudget).toEqual({
			tokenizer: "js-tiktoken@1.0.21/o200k_base",
			budgetEstimatedTokens: 16_000,
			estimatedContextTokens: estimateTokens(sent),
			estimatedRequestTokens: estimateTokens(system) + estimateTokens(sent),
			budgetExceededByFirstUnit: false,
			units: { candidates: 4, admitted: 2, deduplicated: 1, skipped: 1 },
			skippedRanks: [3],
			providerInputTokens: 171,
			providerUsageReported: true,
			goldTurnPositions: [],
		})
	})

	it("records missing provider usage as unreported, never as zero", async () => {
		const { envelope } = await run([heronCase()], [undefined])
		expect(envelope.caseResults[0]?.readerBudget).toMatchObject({
			providerInputTokens: null,
			providerUsageReported: false,
		})
	})
})

function lineage(unitOf: ReaderUnit, turnIds: string[]): ResultLineage {
	return {
		retrievedRank: unitOf.rank,
		memoryId: unitOf.id,
		score: 1 / unitOf.rank,
		sessionIds: [unitOf.sessionId],
		turnIds,
		provenance: "complete",
	}
}

describe("custom-v3 context diagnostics", () => {
	const warblers = unit(
		"single:event:u9",
		3,
		"sess-reeds",
		4,
		`User: ${"Reed warblers sing at dusk. ".repeat(3000)}`,
		["2030/11/02 (Sat) 18:45"],
	)
	const units = [...HERON_UNITS, warblers]
	const diagnostics: Pass0ContextDiagnostics = {
		sentCandidates: [
			lineage(units[0] as ReaderUnit, [
				"sess-pond::turn_2",
				"sess-pond::turn_3",
			]),
			lineage(units[1] as ReaderUnit, ["sess-reeds::turn_1"]),
			lineage(warblers, ["sess-reeds::turn_4"]),
		],
		retrievedSessionRanks: new Map([
			["sess-pond", 1],
			["sess-reeds", 2],
		]),
		retrievedTurnRanks: new Map([
			["sess-pond::turn_3", 1],
			["sess-reeds::turn_4", 3],
		]),
		gold: {
			applicable: true,
			sessions: [
				{ admittedSessionIndex: 0, sessionId: "sess-pond" },
				{ admittedSessionIndex: 1, sessionId: "sess-reeds" },
			],
			turns: [
				{
					admittedSessionIndex: 0,
					sessionId: "sess-pond",
					turnIndex: 2,
					turnId: "sess-pond::turn_3",
					text: "By Quillmarsh pond.",
				},
				{
					admittedSessionIndex: 1,
					sessionId: "sess-reeds",
					turnIndex: 3,
					turnId: "sess-reeds::turn_4",
					text: "Reed warblers sing at dusk.",
				},
			],
		},
	}

	it("describes the admitted units in presentation order and places each present gold turn", async () => {
		const { answers, envelope } = await run([
			heronCase({ readerUnits: units, diagnostics }),
		])
		const sent = answers[0]?.messages[1]?.content ?? ""
		const result = envelope.caseResults[0]
		expect(
			result?.contextPassages?.map((p) => [
				p.sentRank,
				p.retrievedRank,
				p.memoryId,
			]),
		).toEqual([
			[1, 2, "single:event:u7"],
			[2, 1, "round:event:u2|event:a2"],
		])
		expect(result?.passagesSentCount).toBe(2)
		expect(
			result?.gold?.turns.map((t) => [t.turnId, t.sentStatus, t.sentRank]),
		).toEqual([
			["sess-pond::turn_3", "present", 2],
			["sess-reeds::turn_4", "absent", null],
		])
		const prefix = [
			"History Chats:",
			"",
			"### Session 1:",
			"Session Date: 2030/11/02 (Sat) 18:45",
			"Session Content:",
			"User: Brindlewick reeds are tall.",
			"",
			"### Session 2:",
			"Session Date: 2031/01/20 (Mon) 10:00",
			"Session Content:",
			"",
		].join("\n")
		expect(sent.startsWith(prefix)).toBe(true)
		expect(result?.readerBudget?.goldTurnPositions).toEqual([
			{
				turnId: "sess-pond::turn_3",
				positionPercentile:
					(100 * estimateTokens(prefix)) / estimateTokens(sent),
			},
		])
	})
})

describe("custom-v3 input contract", () => {
	it("refuses a case without reader units before any provider call", async () => {
		const { provider, calls } = recordingProvider([])
		await expect(
			runE2eQa({
				provider,
				model: "fixture-answer-model",
				judgeModel: "fixture-judge-model",
				cases: [
					heronCase(),
					heronCase({ caseId: "bare", readerUnits: undefined }),
				],
				protocol: "custom-v3",
			}),
		).rejects.toThrow("custom-v3 case bare has no reader units")
		expect(calls).toHaveLength(0)
	})
})

describe("custom-v3 per-run calibration", () => {
	const second = () =>
		heronCase({
			caseId: "wren",
			question: "Which reeds are tall?",
			goldAnswer: "Brindlewick",
			readerUnits: [HERON_UNITS[1] as ReaderUnit],
		})

	const userTokens = (call: Call | undefined) =>
		estimateTokens(call?.messages[1]?.content ?? "")
	const requestTokens = (call: Call | undefined) =>
		estimateTokens(call?.messages[0]?.content ?? "") + userTokens(call)

	it("divides provider input tokens by the estimated system plus user tokens over calls with usage", async () => {
		const { answers, envelope } = await run(
			[heronCase(), second()],
			[
				{ inputTokens: 300, outputTokens: 5 },
				{ inputTokens: 120, outputTokens: 5 },
			],
		)
		const context = userTokens(answers[0]) + userTokens(answers[1])
		const request = requestTokens(answers[0]) + requestTokens(answers[1])
		expect(request).toBeGreaterThan(context)
		expect(envelope.readerBudgetCalibration).toEqual({
			tokenizer: "js-tiktoken@1.0.21/o200k_base",
			budgetEstimatedTokens: 16_000,
			answerCalls: 2,
			callsWithUsage: 2,
			callsMissingUsage: 0,
			providerInputTokens: 420,
			estimatedContextTokens: context,
			estimatedRequestTokens: request,
			ratio: 420 / request,
			complete: true,
		})
	})

	it("marks the calibration incomplete when any answer call lacked usage", async () => {
		const { answers, envelope } = await run(
			[heronCase(), second()],
			[{ inputTokens: 300, outputTokens: 5 }, undefined],
		)
		expect(envelope.readerBudgetCalibration).toMatchObject({
			answerCalls: 2,
			callsWithUsage: 1,
			callsMissingUsage: 1,
			providerInputTokens: 300,
			estimatedContextTokens: userTokens(answers[0]),
			estimatedRequestTokens: requestTokens(answers[0]),
			ratio: 300 / requestTokens(answers[0]),
			complete: false,
		})
	})
})

describe("custom-v3 accuracy by gold position tercile", () => {
	type CaseResult = BenchmarkE2eQaEnvelope["caseResults"][number]
	const budget = (percentiles: number[]) => ({
		readerBudget: {
			tokenizer: "fixture",
			budgetEstimatedTokens: 100,
			estimatedContextTokens: 100,
			budgetExceededByFirstUnit: false,
			units: { candidates: 1, admitted: 1, deduplicated: 0, skipped: 0 },
			skippedRanks: [],
			providerInputTokens: null,
			providerUsageReported: false,
			goldTurnPositions: percentiles.map((positionPercentile, index) => ({
				turnId: `t-${index}`,
				positionPercentile,
			})),
		},
	})
	const gold = (statuses: BenchmarkGoldSentStatus[]) => ({
		gold: {
			status: "applicable" as const,
			sessions: [],
			turns: statuses.map((sentStatus, turnIndex) => ({
				admittedSessionIndex: 0,
				sessionId: "s-1",
				turnIndex,
				turnId: `t-${turnIndex}`,
				retrieved: true,
				retrievedRank: 1,
				sentRank: sentStatus === "present" ? 1 : null,
				sentStatus,
				sessionRetrieved: true,
				candidateDefect: false,
			})),
			counts: {
				candidate: 0,
				present: 0,
				unknown: 0,
				absentSessionNotRetrieved: 0,
			},
		},
	})
	const result = (
		caseId: string,
		correct: boolean,
		fields: Partial<CaseResult> = {},
	): CaseResult => ({
		caseId,
		candidateAnswer: "a fictional answer",
		correct,
		abstention: false,
		latencyMs: 1,
		...fields,
	})

	it("buckets each case by its earliest in-context gold turn and keeps the rest apart", () => {
		const report = readerPositionTerciles([
			result("a", true, {
				...gold(["present", "present"]),
				...budget([50, 10]),
			}),
			result("b", false, { ...gold(["present"]), ...budget([33.4]) }),
			result("c", false, { ...gold(["present"]), ...budget([33.3]) }),
			result("d", true, { ...gold(["present"]), ...budget([66.7]) }),
			result("e", true, { ...gold(["present"]), ...budget([66.6]) }),
			result("f", true, { ...gold(["absent", "absent"]), ...budget([]) }),
			result("g", true, {
				abstention: true,
				gold: {
					status: "not-applicable",
					reason: "abstention",
					sessions: [],
					turns: [],
				},
				...budget([]),
			}),
			result("h", true, { ...gold(["unknown", "absent"]), ...budget([]) }),
			result("i", false, { diagnosticsError: "fixture", ...budget([]) }),
			result("j", false, { error: "retrieval: fixture" }),
		])
		expect(report).toEqual({
			positionRule: "earliest-gold-turn-percentile",
			terciles: {
				start: { cases: 2, correct: 1, accuracy: 0.5 },
				middle: { cases: 2, correct: 1, accuracy: 0.5 },
				end: { cases: 1, correct: 1, accuracy: 1 },
			},
			noGoldTurnInContext: { cases: 2, correct: 2, accuracy: 1 },
			unmeasured: { cases: 3, correct: 1, accuracy: 1 / 3 },
		})
	})

	it("reports a null accuracy for an empty bucket, never zero", () => {
		expect(readerPositionTerciles([]).terciles.start).toEqual({
			cases: 0,
			correct: 0,
			accuracy: null,
		})
	})

	it("is attached to the custom-v3 envelope from the judged case results", async () => {
		const { envelope } = await run([heronCase(), heronCase({ caseId: "wren" })])
		expect(
			(envelope as E2eQaEnvelope).readerPositionTerciles?.unmeasured,
		).toEqual({ cases: 2, correct: 2, accuracy: 1 })
	})
})
