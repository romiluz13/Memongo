import { vi } from "vitest"
import { MongoDBMemoryManager } from "../../packages/memory-engine/src/mongodb-manager.js"
import type { MongoDBManagerHost } from "../../packages/memory-engine/src/mongodb-manager-host.js"
import {
	mocked,
	testOperationRunContext,
} from "../../packages/memory-engine/src/test-helpers/manager-test-kit.js"
import type {
	BenchmarkE2eQaEnvelope,
	MemoryBenchmarkDataset,
	MemoryBenchmarkScenario,
	MemorySearchResult,
} from "../../packages/memory-engine/src/types.js"
import { MongoDBManagerBenchmarkOps } from "./mongodb-manager-benchmark.js"

type FixtureTurn = { text: string; hasAnswer?: boolean }
export type FixtureCase = {
	caseId: string
	sessions: Array<{ id: string; turns: FixtureTurn[] }>
	goldSessions: string[]
	abstention?: boolean
	/** A has_answer turn id the scenario conversations do not contain. */
	phantomGoldTurnId?: string
	results: MemorySearchResult[]
}

const turnId = (sessionId: string, n: number) => `${sessionId}::turn_${n}`
const eventId = (sessionId: string, n: number) => `evt::${turnId(sessionId, n)}`
export const queryFor = (caseId: string) => `query for ${caseId}`

function hit(
	rank: number,
	text: string,
	score: number,
	extra: Partial<MemorySearchResult> = {},
): MemorySearchResult {
	return {
		path: `memory://hit-${rank}`,
		startLine: 1,
		endLine: 1,
		score,
		snippet: text,
		text,
		source: "conversation",
		...extra,
	}
}

const GOLD = {
	witness: "I adopted a cat named Miso last spring.",
	exclusion: "My passport expires in March 2031.",
	paraphrase: "I moved to Lisbon in 2019.",
	unresolved: "My dentist is Dr. Okafor.",
	partial: "I run five kilometers every morning before work.",
	cap: "The wifi password is hunter2.",
	captext: "The garage code is 4417.",
	mixedA: "I teach pottery on Tuesdays.",
	mixedB: "My brother is named Tomas.",
}

export const fixtureCases: FixtureCase[] = [
	{
		caseId: "witness",
		sessions: [
			{
				id: "witness::s1",
				turns: [
					{ text: "We talked about gardening" },
					{ text: GOLD.witness, hasAnswer: true },
					{ text: "Nice weather today" },
				],
			},
		],
		goldSessions: ["witness::s1"],
		results: [
			hit(1, "", 0.9, {
				snippet: "",
				sourceEventIds: [eventId("witness::s1", 3)],
			}),
			hit(2, "We talked about gardening", 0.8, {
				canonicalId: "event:witness-t1",
				sourceEventIds: [eventId("witness::s1", 1)],
			}),
			hit(3, "  Note:\n  I  adopted a cat\tnamed Miso   last spring.  ", 0.7),
		],
	},
	{
		caseId: "exclusion",
		sessions: [
			{
				id: "exclusion::s1",
				turns: [
					{ text: "chat one" },
					{ text: "chat two" },
					{ text: GOLD.exclusion, hasAnswer: true },
					{ text: "chat four" },
				],
			},
		],
		goldSessions: ["exclusion::s1"],
		results: [
			hit(1, "", 0.9, {
				snippet: "",
				sourceEventIds: [eventId("exclusion::s1", 3)],
			}),
			hit(2, "chat one", 0.8, {
				sourceEventIds: [eventId("exclusion::s1", 1)],
			}),
			hit(3, "chat four", 0.7, {
				sourceEventIds: [eventId("exclusion::s1", 4)],
			}),
		],
	},
	{
		caseId: "paraphrase",
		sessions: [
			{
				id: "paraphrase::s1",
				turns: [
					{ text: "small talk" },
					{ text: GOLD.paraphrase, hasAnswer: true },
				],
			},
		],
		goldSessions: ["paraphrase::s1"],
		results: [
			hit(1, "small talk", 0.9, {
				sourceEventIds: [eventId("paraphrase::s1", 1)],
			}),
			hit(2, "You mentioned relocating to Lisbon around 2019", 0.8),
		],
	},
	{
		caseId: "unresolved",
		sessions: [
			{
				id: "unresolved::s1",
				turns: [
					{ text: "small talk" },
					{ text: GOLD.unresolved, hasAnswer: true },
				],
			},
		],
		goldSessions: ["unresolved::s1"],
		results: [
			hit(1, "small talk", 0.9, {
				sourceEventIds: [eventId("unresolved::s1", 1), "evt::missing"],
			}),
		],
	},
	{
		caseId: "emptyid",
		sessions: [
			{
				id: "emptyid::s1",
				turns: [
					{ text: "small talk" },
					{ text: "My cat is named Miso.", hasAnswer: true },
				],
			},
		],
		goldSessions: ["emptyid::s1"],
		results: [
			hit(1, "small talk", 0.9, {
				sourceEventIds: ["", eventId("emptyid::s1", 1)],
			}),
		],
	},
	{
		caseId: "partial",
		sessions: [
			{
				id: "partial::s1",
				turns: [
					{ text: "small talk" },
					{ text: GOLD.partial, hasAnswer: true },
				],
			},
		],
		goldSessions: ["partial::s1"],
		results: [
			hit(1, "I run five kilometers", 0.9, {
				sourceEventIds: [eventId("partial::s1", 2)],
			}),
		],
	},
	{
		caseId: "late_abs",
		sessions: [{ id: "late_abs::s1", turns: [{ text: "small talk" }] }],
		goldSessions: ["late_abs::s1"],
		abstention: true,
		results: [
			hit(1, "small talk", 0.9, {
				sourceEventIds: [eventId("late_abs::s1", 1)],
			}),
		],
	},
	{
		caseId: "brokengold",
		sessions: [{ id: "brokengold::s1", turns: [{ text: "small talk" }] }],
		goldSessions: ["brokengold::s1"],
		phantomGoldTurnId: "brokengold::s1::turn_7",
		results: [
			hit(1, "small talk", 0.9, {
				sourceEventIds: [eventId("brokengold::s1", 1)],
			}),
		],
	},
	{
		caseId: "nomarker",
		sessions: [{ id: "nomarker::s1", turns: [{ text: "small talk" }] }],
		goldSessions: ["nomarker::s1"],
		results: [
			hit(1, "small talk", 0.9, {
				sourceEventIds: [eventId("nomarker::s1", 1)],
			}),
		],
	},
	{
		caseId: "cap",
		sessions: [
			{
				id: "cap::s1",
				turns: Array.from({ length: 30 }, (_, i) =>
					i === 2
						? { text: GOLD.cap, hasAnswer: true }
						: { text: `filler turn ${i + 1}` },
				),
			},
		],
		goldSessions: ["cap::s1"],
		results: Array.from({ length: 25 }, (_, i) =>
			hit(i + 1, `filler passage ${i + 1}`, 1 - i / 100, {
				sourceEventIds: [eventId("cap::s1", i === 21 ? 3 : i + 5)],
			}),
		),
	},
	...(["captext", "captextunk"] as const).map(
		(caseId): FixtureCase => ({
			caseId,
			sessions: [
				{
					id: `${caseId}::s1`,
					turns: Array.from({ length: 30 }, (_, i) =>
						i === 2
							? { text: GOLD.captext, hasAnswer: true }
							: { text: `filler turn ${i + 1}` },
					),
				},
			],
			goldSessions: [`${caseId}::s1`],
			results: Array.from({ length: 25 }, (_, i) =>
				i === 21
					? hit(i + 1, `Reminder: ${GOLD.captext}`, 1 - i / 100)
					: caseId === "captextunk" && i === 6
						? hit(i + 1, `filler passage ${i + 1}`, 1 - i / 100)
						: hit(i + 1, `filler passage ${i + 1}`, 1 - i / 100, {
								sourceEventIds: [eventId(`${caseId}::s1`, i + 5)],
							}),
			),
		}),
	),
	{
		caseId: "mixed",
		sessions: [
			{
				id: "mixed::a",
				turns: [{ text: "a one" }, { text: GOLD.mixedA, hasAnswer: true }],
			},
			{
				id: "mixed::b",
				turns: [{ text: GOLD.mixedB, hasAnswer: true }, { text: "b two" }],
			},
		],
		goldSessions: ["mixed::a", "mixed::b"],
		results: [
			hit(1, `Note: ${GOLD.mixedA}`, 0.9, {
				sourceEventIds: [eventId("mixed::a", 2)],
			}),
			hit(2, "a one", 0.8, { sourceEventIds: [eventId("mixed::a", 1)] }),
		],
	},
]

export function scenarioFor(fixture: FixtureCase): MemoryBenchmarkScenario {
	const expectedTurnIds = fixture.sessions.flatMap((session) =>
		session.turns.flatMap((turn, index) =>
			turn.hasAnswer ? [turnId(session.id, index + 1)] : [],
		),
	)
	return {
		scenarioId: fixture.caseId,
		conversations: fixture.sessions.map((session) => ({
			conversationId: fixture.caseId,
			sessionId: session.id,
			turns: session.turns.map((turn, index) => ({
				role: "user" as const,
				body: turn.text,
				metadata: {
					benchmarkTurnId: turnId(session.id, index + 1),
					...(turn.hasAnswer ? { benchmarkHasAnswer: true } : {}),
				},
			})),
		})),
		evaluations: [
			{
				caseId: fixture.caseId,
				query: queryFor(fixture.caseId),
				expectedSessionIds: fixture.goldSessions,
				expectedTurnIds: fixture.phantomGoldTurnId
					? [...expectedTurnIds, fixture.phantomGoldTurnId]
					: expectedTurnIds,
				answer: fixture.abstention ? "no answer" : "violet",
				questionType: fixture.abstention ? "abstention" : "single-session",
				abstention: fixture.abstention === true,
			},
		],
	}
}

export function evidenceFor(fixtures: FixtureCase[]) {
	const evidence = {
		sessionIds: new Map<string, string>(),
		turnIds: new Map<string, string>(),
		dialogIds: new Map<string, string>(),
	}
	for (const fixture of fixtures) {
		for (const session of fixture.sessions) {
			session.turns.forEach((_, index) => {
				evidence.sessionIds.set(eventId(session.id, index + 1), session.id)
				evidence.turnIds.set(
					eventId(session.id, index + 1),
					turnId(session.id, index + 1),
				)
			})
		}
	}
	return evidence
}

const ACKNOWLEDGED_CLEANUP = {
	status: "acknowledged" as const,
	agentId: "benchmark-test-agent",
	registry: { version: 1 as const, digest: "0".repeat(64), collections: 0 },
	collections: [],
}

function benchmarkOps(
	manager: MongoDBMemoryManager,
): MongoDBManagerBenchmarkOps {
	const ops = new MongoDBManagerBenchmarkOps(
		manager as unknown as MongoDBManagerHost,
	)
	const managerRecord = manager as unknown as Record<string, unknown>
	const opsRecord = ops as unknown as Record<string, unknown>
	for (const method of [
		"createBenchmarkScenarioManager",
		"settleBenchmarkScenarioManager",
		"listBenchmarkEventEvidence",
		"waitForBenchmarkSearchConvergence",
		"cleanupBenchmarkScenarioData",
	]) {
		const override = managerRecord[method]
		if (typeof override === "function") {
			opsRecord[method] = override
		}
	}
	return ops
}

export async function runFixture(
	fixtures: FixtureCase[],
): Promise<BenchmarkE2eQaEnvelope> {
	vi.stubEnv("MEMONGO_ENRICHMENT_API_KEY", "synthetic")
	vi.stubEnv("MEMONGO_ENRICHMENT_MODEL", "synthetic-model")
	vi.stubEnv("MEMONGO_BENCHMARK_JUDGE_MODEL", "synthetic-judge-model")
	const { ingestBenchmarkConversations } = await import(
		"./mongodb-benchmark-harness.js"
	)
	mocked(ingestBenchmarkConversations).mockResolvedValue({
		datasetPath: "/tmp/benchmark.json",
		datasetName: "context-diagnostics",
		conversationsIngested: 1,
		turnsIngested: 1,
		skippedConversations: 0,
		failedLines: 0,
		failedTurns: 0,
		rejectedTurns: 0,
		rejectedConversations: 0,
		startedAt: new Date("2026-04-09T12:00:00.000Z"),
		completedAt: new Date("2026-04-09T12:00:01.000Z"),
	})
	const search = vi.fn(async (query: string) => {
		const fixture = fixtures.find((entry) => queryFor(entry.caseId) === query)
		if (!fixture) throw new Error(`unexpected query ${query}`)
		return fixture.results
	})
	const scenarioManager = {
		agentId: "benchmark-context-diagnostics",
		search,
		close: vi.fn(async () => {}),
	} as unknown as MongoDBMemoryManager
	const evidence = evidenceFor(fixtures)
	const manager = Object.assign(Object.create(MongoDBMemoryManager.prototype), {
		db: {
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
			})),
		},
		prefix: "test_",
		agentId: "benchmark-parent",
		config: { mongodb: {} },
		relevance: { persistRegression: vi.fn(async () => []) },
		createBenchmarkScenarioManager: vi.fn(() => scenarioManager),
		settleBenchmarkScenarioManager: vi.fn(async () => {}),
		listBenchmarkEventEvidence: vi.fn(async () => evidence),
		waitForBenchmarkSearchConvergence: vi.fn(async () => {}),
		cleanupBenchmarkScenarioData: vi.fn(async () => ACKNOWLEDGED_CLEANUP),
	}) as MongoDBMemoryManager
	const dataset: MemoryBenchmarkDataset = {
		name: "context diagnostics fixture",
		datasetKind: "longmemeval",
		conversations: [],
		evaluations: [],
		scenarios: fixtures.map(scenarioFor),
	}
	const outcome = await benchmarkOps(manager).runScenarioBenchmarkDataset({
		datasetPath: "/tmp/benchmark.json",
		dataset,
		datasetVersion: "context-diagnostics-v1",
		maxResults: 50,
		minScore: 0.01,
		retrievalLane: "native",
		executionProfile: "shipped",
		runContext: testOperationRunContext("context-diagnostics"),
	})
	if (!outcome.e2eQa) throw new Error("expected a judged answer envelope")
	return outcome.e2eQa
}
