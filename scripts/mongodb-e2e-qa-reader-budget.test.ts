import { describe, expect, it } from "vitest"
import type {
	Pass0ContextDiagnostics,
	ResultLineage,
} from "./benchmark/benchmark-context-diagnostics.js"
import { estimateTokens, type ReaderUnit } from "./benchmark/reader-budget.js"
import { runE2eQa } from "./mongodb-e2e-qa.js"
import {
	type Call,
	HERON_UNITS,
	heronCase,
	recordingProvider,
	run,
	unit,
} from "./mongodb-e2e-qa-reader-budget.fixture.js"

// custom-v3: round units under the reader token budget, official session
// serialization. Fictional strings only.

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
		expect(call.maxTokens).toBe(8192)
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
			admittedRoundPartnerMissing: {},
		})
	})

	it("counts admitted units by why they have no round partner", async () => {
		const notRequested = (u: ReaderUnit): ReaderUnit => ({
			...u,
			roundPartnerMissing: "not-requested",
		})
		const { envelope } = await run([
			heronCase({
				readerUnits: [
					notRequested(HERON_UNITS[0] as ReaderUnit),
					notRequested(HERON_UNITS[1] as ReaderUnit),
					{
						...(HERON_UNITS[1] as ReaderUnit),
						id: "single:event:u8",
						rank: 3,
						passage: "User: The pond froze in winter.",
						roundPartnerMissing: "session-end",
					},
				],
			}),
		])
		expect(envelope.caseResults[0]?.readerBudget).toMatchObject({
			admittedRoundPartnerMissing: { "not-requested": 2, "session-end": 1 },
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
