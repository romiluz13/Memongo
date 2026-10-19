/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	fixtureCases,
	runFixture,
} from "./mongodb-manager-benchmark-context-diagnostics.fixture.js"

// The answerer always says "violet"; the judge accepts exactly that.
const { answerProbe } = vi.hoisted(() => {
	const provider = {
		name: "synthetic-deterministic",
		chatCompletion: async (params: {
			messages: Array<{ role: string; content: string }>
		}) => {
			const user =
				params.messages.find((message) => message.role === "user")?.content ??
				""
			if (!user.includes("GOLD ANSWER:")) {
				return { content: JSON.stringify({ answer: "violet" }) }
			}
			const candidate = /CANDIDATE ANSWER: ?(.*)/.exec(user)?.[1]?.trim() ?? ""
			return {
				content: JSON.stringify({
					correct: candidate === "violet",
					rationale: "synthetic",
				}),
			}
		},
	}
	return { answerProbe: { provider } }
})

vi.mock(
	"../../packages/memory-engine/src/mongodb-llm-enrichment.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../packages/memory-engine/src/mongodb-llm-enrichment.js")
			>()
		return {
			...actual,
			resolveEnrichmentProvider: vi.fn(() => answerProbe.provider),
			createHttpProvider: vi.fn(() => answerProbe.provider),
		}
	},
)

vi.mock("../../packages/memory-engine/src/mongodb-events.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).eventsModuleMock(),
)

vi.mock("./benchmark-quality-contracts.js", async (importOriginal) =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).benchmarkQualityContractsModuleMock(importOriginal),
)

vi.mock("./benchmark-relevance.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./benchmark-relevance.js")>()),
	persistBenchmarkRegression: vi.fn().mockResolvedValue([]),
}))

vi.mock(
	"../../packages/memory-engine/src/mongodb-conversation-recall.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).conversationRecallModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-ops.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).opsModuleMock(),
)

vi.mock("./mongodb-benchmark-harness.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).benchmarkHarnessModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-retrieval-planner.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).retrievalPlannerModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-episodes.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).episodesModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-graph.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).graphModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-schema.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).schemaModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-query-cache.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).queryCacheModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-query-rewriter.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).queryRewriterModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-lane-coverage.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).laneCoverageModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-memory-jobs.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).memoryJobsModuleMock(),
)

vi.mock("../../packages/memory-engine/src/mongodb-consolidator.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).consolidatorModuleMock(),
)

vi.mock(
	"../../packages/memory-engine/src/mongodb-derived-memory.js",
	async () =>
		(
			await import(
				"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
			)
		).derivedMemoryModuleMock(),
)

vi.mock("./mongodb-benchmark-readiness.js", async (importOriginal) =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).benchmarkReadinessModuleMock(importOriginal),
)

vi.mock("../../packages/memory-engine/src/mongodb-telemetry.js", async () =>
	(
		await import(
			"../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
		)
	).telemetryModuleMock(),
)

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("pass-0 context diagnostics reach each legacy e2eQa case result", () => {
	async function caseResults() {
		const envelope = await runFixture(fixtureCases)
		const byId = new Map(
			envelope.caseResults.map((result) => [result.caseId, result]),
		)
		const get = (caseId: string) => {
			const result = byId.get(caseId)
			if (!result) throw new Error(`missing case result ${caseId}`)
			return result
		}
		return { envelope, get }
	}

	it("records the passages sent, with sent rank apart from retrieved rank, and a full-text witness as present", async () => {
		const { envelope, get } = await caseResults()
		expect(envelope.cases.eligible).toBe(fixtureCases.length)
		const result = get("witness")
		expect(result.matchRule).toBe("containment-v2")
		expect(result.passagesSentCount).toBe(2)
		expect(result.contextPassages).toEqual([
			{
				sentRank: 1,
				retrievedRank: 2,
				memoryId: "event:witness-t1",
				sessionIds: ["witness::s1"],
				turnIds: ["witness::s1::turn_1"],
				provenance: "complete",
				score: 0.8,
				sha256:
					"eb354420cf60e9223735a47c608bca414fc60389674617d0e62fb92357822143",
				preview: "We talked about gardening",
			},
			{
				sentRank: 2,
				retrievedRank: 3,
				memoryId: "memory://hit-3",
				sessionIds: [],
				turnIds: [],
				provenance: "none",
				score: 0.7,
				sha256:
					"7248891ae08e1c5f8c6221cf8c33ccdd3a1a70b6b54ce2510c742a8889c39a36",
				preview: "  Note:\n  I  adopted a cat\tnamed Miso   last spring.  ",
			},
		])
		expect(result.gold).toMatchObject({
			status: "applicable",
			sessions: [
				{
					admittedSessionIndex: 0,
					sessionId: "witness::s1",
					retrieved: true,
					sentStatus: "present",
				},
			],
			turns: [
				{
					admittedSessionIndex: 0,
					sessionId: "witness::s1",
					turnIndex: 1,
					turnId: "witness::s1::turn_2",
					retrieved: true,
					retrievedRank: 3,
					sentRank: 2,
					sentStatus: "present",
					sessionRetrieved: true,
					candidateDefect: false,
				},
			],
			counts: {
				candidate: 0,
				present: 1,
				unknown: 0,
				absentSessionNotRetrieved: 0,
			},
		})
		expect(result.goldSessionInContext).toEqual({ any: true, all: true })
		expect(result.goldTurnInContext).toEqual({ any: true, all: true })
		expect(result.diagnosticsError).toBeUndefined()
	})

	it("proves a retrieved turn absent when every sent passage has complete provenance, even if the turn's own result carried no text", async () => {
		const { get } = await caseResults()
		const result = get("exclusion")
		expect(result.passagesSentCount).toBe(2)
		expect(result.contextPassages?.map((p) => p.provenance)).toEqual([
			"complete",
			"complete",
		])
		expect(result.gold).toMatchObject({
			turns: [
				{
					turnId: "exclusion::s1::turn_3",
					retrieved: true,
					retrievedRank: 1,
					sentRank: null,
					sentStatus: "absent",
					sessionRetrieved: true,
					candidateDefect: true,
				},
			],
			counts: { candidate: 1, present: 0, unknown: 0 },
		})
		expect(result.goldTurnInContext).toEqual({ any: false, all: false })
	})

	it.each([
		["paraphrase", "none", null],
		["unresolved", "partial", null],
		["emptyid", "partial", null],
		["partial", "complete", 1],
	] as const)("leaves the %s case unknown, not absent", async (caseId, lastProvenance, sentRank) => {
		const { get } = await caseResults()
		const result = get(caseId)
		expect(result.contextPassages?.at(-1)?.provenance).toBe(lastProvenance)
		expect(result.gold).toMatchObject({
			turns: [{ sentStatus: "unknown", sentRank, candidateDefect: false }],
			counts: { candidate: 0, present: 0, unknown: 1 },
		})
		expect(result.goldTurnInContext).toEqual({
			any: "unknown",
			all: "unknown",
		})
	})

	it("keeps abstention and no-marker cases in the results as not-applicable with their real verdict", async () => {
		const { envelope, get } = await caseResults()
		const abstain = get("late_abs")
		expect(abstain.gold).toEqual({
			status: "not-applicable",
			reason: "abstention",
			sessions: [],
			turns: [],
		})
		expect(abstain.abstention).toBe(true)
		expect(abstain.correct).toBe(false)
		expect(abstain.passagesSentCount).toBe(1)
		expect(abstain.goldTurnInContext).toBeUndefined()

		const plain = get("nomarker")
		expect(plain.gold).toEqual({
			status: "not-applicable",
			reason: "no-has-answer-marker",
			sessions: [],
			turns: [],
		})
		expect(plain.correct).toBe(true)
		expect(plain.goldSessionInContext).toBeUndefined()
		expect(envelope.cases.eligible).toBe(fixtureCases.length)
	})

	it("records a diagnostics error when the gold turn cannot be found, and leaves the case verdict alone", async () => {
		const { get } = await caseResults()
		const result = get("brokengold")
		expect(result.diagnosticsError).toContain(
			"gold turn brokengold::s1::turn_7 is not in the scenario conversations",
		)
		expect(result.contextPassages).toBeUndefined()
		expect(result.gold).toBeUndefined()
		expect(result.correct).toBe(true)
		expect(result.error).toBeUndefined()
	})

	it("reports a gold turn retrieved at rank 22 as absent from the 20 passages sent", async () => {
		const { get } = await caseResults()
		const result = get("cap")
		expect(result.passagesSentCount).toBe(20)
		expect(result.contextPassages?.at(-1)).toMatchObject({
			sentRank: 20,
			retrievedRank: 20,
		})
		expect(result.gold).toMatchObject({
			turns: [
				{
					turnId: "cap::s1::turn_3",
					turnIndex: 2,
					retrieved: true,
					retrievedRank: 22,
					sentRank: null,
					sentStatus: "absent",
					candidateDefect: true,
				},
			],
		})
	})

	it.each([
		["captext", "absent", true],
		["captextunk", "unknown", false],
	] as const)("never reads %s as present when the turn's full text appears only in retrieved result 22, beyond the cap", async (caseId, sentStatus, candidateDefect) => {
		const { get } = await caseResults()
		const result = get(caseId)
		expect(result.passagesSentCount).toBe(20)
		expect(result.contextPassages?.map((p) => p.preview)).not.toContain(
			"Reminder: The garage code is 4417.",
		)
		expect(result.gold).toMatchObject({
			turns: [
				{
					turnId: `${caseId}::s1::turn_3`,
					retrieved: true,
					retrievedRank: 22,
					sentRank: null,
					sentStatus,
					sessionRetrieved: true,
					candidateDefect,
				},
			],
		})
	})

	it("keeps each target's status when gold session A is retrieved with its turn present and gold session B is not retrieved", async () => {
		const { get } = await caseResults()
		const result = get("mixed")
		expect(result.gold).toMatchObject({
			sessions: [
				{
					admittedSessionIndex: 0,
					sessionId: "mixed::a",
					retrieved: true,
					sentStatus: "present",
				},
				{
					admittedSessionIndex: 1,
					sessionId: "mixed::b",
					retrieved: false,
					sentStatus: "absent",
				},
			],
			turns: [
				{
					turnId: "mixed::a::turn_2",
					sentStatus: "present",
					retrievedRank: 1,
					sentRank: 1,
					candidateDefect: false,
				},
				{
					admittedSessionIndex: 1,
					turnId: "mixed::b::turn_1",
					turnIndex: 0,
					retrieved: false,
					sessionRetrieved: false,
					sentStatus: "absent",
					candidateDefect: false,
				},
			],
			counts: {
				candidate: 0,
				present: 1,
				unknown: 0,
				absentSessionNotRetrieved: 1,
			},
		})
		expect(result.goldSessionInContext).toEqual({ any: true, all: false })
		expect(result.goldTurnInContext).toEqual({ any: true, all: false })
	})
})
