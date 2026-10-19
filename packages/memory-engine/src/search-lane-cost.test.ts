// #101 decision 18: the per-lane cost table that sizes a required lane's
// reservation. Each real lane function runs on zero-hit fakes (so it reaches
// every tier it can) inside a reservation sized by the table. The test fails
// when a lane charges more than its reservation, or when the table reserves
// more than the lane can ever charge.
import type { Collection, Db, Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { searchKB } from "./mongodb-kb-search.js"
import { searchProcedures } from "./mongodb-procedures.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { mongoSearch } from "./mongodb-search.js"
import {
	runWithSearchBudget,
	runWithSearchReservation,
	type SearchWorkCost,
	tryReserveSearchBudget,
} from "./mongodb-search-budget.js"
import { searchConversationEvidenceEvents } from "./mongodb-search-lanes.js"
import { searchStructuredMemory } from "./mongodb-structured-memory.js"
import {
	conversationEvidenceLaneCost,
	kbLaneCost,
	nativeFusionCost,
	structuredLaneCost,
} from "./search-lane-cost.js"

function zeroHits() {
	const aggregate = vi.fn((_pipeline: Document[]) => ({
		toArray: async () => [],
	}))
	return { aggregate, find: vi.fn() } as unknown as Collection
}

function capabilities(
	vector: boolean,
	text: boolean,
	extra: Partial<DetectedCapabilities> = {},
): DetectedCapabilities {
	return {
		vectorSearch: vector,
		textSearch: text,
		scoreFusion: false,
		rankFusion: false,
		storedSource: false,
		vectorIndexMethod: false,
		...extra,
	}
}

/** Charges of `run` inside a reservation of `cost`; fails on any overspend. */
async function chargedWithin(
	cost: SearchWorkCost,
	run: () => Promise<unknown>,
): Promise<SearchWorkCost> {
	const { budget } = await runWithSearchBudget(
		{ maxAggregations: 12, maxEmbeds: 5 },
		async () => {
			const reservation = tryReserveSearchBudget(cost)
			if (!reservation) throw new Error("fixture reservation refused")
			await runWithSearchReservation(reservation, () =>
				run().catch(() => undefined),
			)
		},
	)
	return { aggregations: budget.aggregations, embeds: budget.embeds }
}

const capabilityMatrix = [
	["vector and text", capabilities(true, true)],
	["vector only", capabilities(true, false)],
	["text only", capabilities(false, true)],
] as const

beforeEach(() => {
	vi.stubEnv("MEMONGO_BENCHMARK_STRICT", "false")
	vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("per-lane cost table (decision 18)", () => {
	for (const [label, base] of capabilityMatrix) {
		for (const listed of [true, false]) {
			const caps = {
				...base,
				queryableSearchIndexes: listed ? ["t_structured_mem_text"] : [],
			}
			it(`structured, ${label}, text index ${listed ? "listed" : "absent"}: charges exactly its reservation`, async () => {
				const cost = structuredLaneCost({
					capabilities: caps,
					embeddingMode: "automated",
					textIndexName: "t_structured_mem_text",
				})
				const charged = await chargedWithin(cost, () =>
					searchStructuredMemory(zeroHits(), "what did we decide", null, {
						maxResults: 5,
						minScore: 0,
						capabilities: caps,
						vectorIndexName: "t_structured_mem_vector",
						textIndexName: "t_structured_mem_text",
						embeddingMode: "automated",
					}),
				)
				expect(charged).toEqual(cost)
			})
			it(`procedural, ${label}, text index ${listed ? "listed" : "absent"}: charges exactly its reservation`, async () => {
				const procCaps = {
					...base,
					queryableSearchIndexes: listed ? ["t_procedures_text"] : [],
				}
				const cost = structuredLaneCost({
					capabilities: procCaps,
					embeddingMode: "automated",
					textIndexName: "t_procedures_text",
				})
				const charged = await chargedWithin(cost, () =>
					searchProcedures(zeroHits(), "how do we deploy", null, {
						maxResults: 5,
						minScore: 0,
						capabilities: procCaps,
						vectorIndexName: "t_procedures_vector",
						textIndexName: "t_procedures_text",
						embeddingMode: "automated",
					}),
				)
				expect(charged).toEqual(cost)
			})
		}
	}

	for (const fusionMethod of ["scoreFusion", "rankFusion"] as const) {
		it(`kb, ${fusionMethod}: charges exactly its reservation`, async () => {
			const cost = kbLaneCost({ embeddingMode: "automated" })
			const charged = await chargedWithin(cost, () =>
				searchKB(zeroHits(), "rotation policy", null, {
					maxResults: 5,
					minScore: 0,
					scopeRef: "agent:agent-1",
					vectorIndexName: "t_kb_chunks_vector",
					textIndexName: "t_kb_chunks_text",
					embeddingMode: "automated",
					fusionMethod,
				}),
			)
			expect(charged).toEqual(cost)
		})
	}

	for (const fusionMethod of ["scoreFusion", "rankFusion"] as const) {
		for (const vectorInputs of [1, 2] as const) {
			it(`mongoSearch native fusion, ${fusionMethod}, ${vectorInputs} vector input(s): charges exactly its reservation`, async () => {
				const cost = nativeFusionCost({
					embeddingMode: "automated",
					vectorInputs,
				})
				expect(cost).toEqual({ aggregations: 1, embeds: vectorInputs })
				const charged = await chargedWithin(cost, () =>
					mongoSearch(zeroHits(), "garden plan", null, {
						maxResults: 5,
						minScore: 0,
						fusionMethod,
						vectorIndexName: "t_chunks_vector",
						textIndexName: "t_chunks_text",
						embeddingMode: "automated",
						...(vectorInputs === 2
							? { sibling: { filter: { source: "memory" }, maxResults: 3 } }
							: {}),
					}),
				)
				expect(charged).toEqual(cost)
			})
		}
	}

	for (const [label, caps] of capabilityMatrix) {
		it(`conversation-evidence, ${label}: charges exactly its reservation`, async () => {
			const cost = conversationEvidenceLaneCost({
				capabilities: caps,
				embeddingMode: "automated",
			})
			const db = {
				collection: () => zeroHits(),
			} as unknown as Db
			const charged = await chargedWithin(cost, () =>
				searchConversationEvidenceEvents({
					db,
					prefix: "t_",
					query: "what did I say about the garden plan",
					agentId: "agent-1",
					scope: "agent",
					scopeRef: "agent:agent-1",
					maxResults: 5,
					numCandidates: 100,
					capabilities: caps,
					embeddingMode: "automated",
					queryEmbeddingModel: "voyage-4-large",
				}),
			)
			expect(charged).toEqual(cost)
		})
	}
})
