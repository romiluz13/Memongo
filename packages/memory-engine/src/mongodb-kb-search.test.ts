/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import {
	runWithSearchBudget,
	runWithSearchReservation,
	tryReserveSearchBudget,
} from "./mongodb-search-budget.js"
import { searchKB } from "./mongodb-kb-search.js"
import { kbLaneCost } from "./search-lane-cost.js"
import { createKbFusionDouble } from "./test-helpers/kb-fusion-double.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockKBChunksCol(results: Document[] = []): Collection {
	return {
		aggregate: vi.fn(() => ({
			toArray: vi.fn(async () => results),
		})),
	} as unknown as Collection
}

function mockKBDocsCol(ids: Array<string | number> = []): Collection {
	return {
		find: vi.fn(() => ({
			limit: vi.fn(() => ({
				toArray: vi.fn(async () => ids.map((_id) => ({ _id }))),
			})),
		})),
	} as unknown as Collection
}

const baseOpts = {
	maxResults: 5,
	minScore: 0.1,
	scopeRef: "agent:test",
	vectorIndexName: "test_kb_chunks_vector",
	textIndexName: "test_kb_chunks_text",
	embeddingMode: "automated" as const,
}

// The post-Search re-check carries the chunk filter plus the retention clause.
function revalidatedBy(chunkFilter: Document): Document {
	return {
		$and: [
			chunkFilter,
			{
				$or: [
					{ expiresAt: { $exists: false } },
					{ expiresAt: { $gt: expect.any(Date) } },
				],
			},
		],
	}
}

function pipelinesOf(col: Collection): Document[][] {
	return (col.aggregate as ReturnType<typeof vi.fn>).mock.calls.map(
		([pipeline]) => pipeline as Document[],
	)
}

function scoreFusionInputs(pipeline: Document[]) {
	return pipeline[0].$scoreFusion.input.pipelines as {
		vector: Document[]
		text: Document[]
	}
}

const aHit = {
	path: "guide.md",
	startLine: 1,
	endLine: 10,
	text: "KB content about architecture",
	docId: "doc-1",
	score: 0.85,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchKB: one configured native fusion", () => {
	it("maps a fused hit to a reference result", async () => {
		const col = mockKBChunksCol([aHit])

		const results = await searchKB(col, "architecture", null, baseOpts)

		expect(results).toHaveLength(1)
		expect(results[0].source).toBe("reference")
		// RET-09: KB chunks are verbatim spans of ingested documents —
		// cited reference material, not conversation authorship.
		expect(results[0].derivation).toBe("reference")
		expect(results[0].score).toBe(0.85)
		expect(results[0].snippet).toContain("KB content about architecture")
	})

	it("runs exactly one $scoreFusion aggregate by default", async () => {
		const col = mockKBChunksCol([aHit])

		await searchKB(col, "architecture", null, baseOpts)

		const pipelines = pipelinesOf(col)
		expect(pipelines).toHaveLength(1)
		expect(Object.keys(pipelines[0][0])).toEqual(["$scoreFusion"])
	})

	it("keeps the $scoreFusion settings: minMaxScaler, avg, 0.7/0.3 weights", async () => {
		const col = mockKBChunksCol([aHit])

		await searchKB(col, "architecture", null, baseOpts)

		const fusion = pipelinesOf(col)[0][0].$scoreFusion
		expect(fusion.input.normalization).toBe("minMaxScaler")
		expect(fusion.combination).toEqual({
			weights: { vector: 0.7, text: 0.3 },
			method: "avg",
		})
		const { vector, text } = scoreFusionInputs(pipelinesOf(col)[0])
		expect(vector[0].$vectorSearch.index).toBe("test_kb_chunks_vector")
		expect(vector[0].$vectorSearch.query).toEqual({ text: "architecture" })
		expect(text[0].$search.index).toBe("test_kb_chunks_text")
	})

	it("runs exactly one $rankFusion aggregate with the existing weights when configured", async () => {
		const col = mockKBChunksCol([aHit])

		await searchKB(col, "architecture", null, {
			...baseOpts,
			fusionMethod: "rankFusion",
		})

		const pipelines = pipelinesOf(col)
		expect(pipelines).toHaveLength(1)
		expect(Object.keys(pipelines[0][0])).toEqual(["$rankFusion"])
		const fusion = pipelines[0][0].$rankFusion
		expect(fusion.combination).toEqual({
			weights: { vector: 0.7, text: 0.3 },
		})
		expect(fusion.input.pipelines.vector[0].$vectorSearch).toBeDefined()
		expect(fusion.input.pipelines.text[0].$search).toBeDefined()
	})

	it("does not consult the deployment capabilities: it runs the fusion either way", async () => {
		const col = mockKBChunksCol([aHit])

		const results = await searchKB(col, "architecture", null, {
			...baseOpts,
			// A leftover caller still passing the removed option changes nothing.
			...({
				capabilities: {
					vectorSearch: false,
					textSearch: false,
					scoreFusion: false,
					rankFusion: false,
					storedSource: false,
					vectorIndexMethod: false,
				},
			} as object),
		})

		expect(results).toHaveLength(1)
		expect(Object.keys(pipelinesOf(col)[0][0])).toEqual(["$scoreFusion"])
	})

	it("projects the retention deadline in the fused $project (RET-11 followup)", async () => {
		// Wave-3e §5 discovery: the KB mapper carried expiresAt since wave
		// 3d but no KB $project included the field, so the carry was dead.
		const col = mockKBChunksCol([aHit])

		await searchKB(col, "architecture", null, baseOpts)

		// Pipeline: fusion, $limit, $project
		const projectStage = pipelinesOf(col)[0][2].$project
		expect(projectStage.expiresAt).toBe(1)
	})

	it("carries the source retention deadline onto the result shape (RET-11)", async () => {
		// The KB mapper preserves a source retention deadline for provenance;
		// a non-Date value is dropped, matching the mapper's defensive
		// instanceof style for other date fields.
		const expiresAt = new Date("2026-09-01T00:00:00.000Z")
		const col = mockKBChunksCol([
			{ ...aHit, expiresAt },
			{
				path: "stale-shape.md",
				startLine: 1,
				endLine: 5,
				text: "Non-Date deadline is dropped",
				docId: "doc-2",
				score: 0.8,
				expiresAt: "2026-09-01T00:00:00.000Z",
			},
		])

		const results = await searchKB(col, "retention", null, {
			...baseOpts,
			minScore: 0,
		})

		expect(results[0].expiresAt).toEqual(expiresAt)
		expect(results[0].expiresAt instanceof Date).toBe(true)
		expect(results[1].expiresAt).toBeUndefined()
	})

	it("filters results below minScore threshold", async () => {
		const col = mockKBChunksCol([{ ...aHit, score: 0.05 }])

		const results = await searchKB(col, "content", null, {
			...baseOpts,
			minScore: 0.3,
		})

		expect(results).toHaveLength(0)
	})

	it("caps numCandidates at 10000 in KB search (F1)", async () => {
		const col = mockKBChunksCol([aHit])

		await searchKB(col, "test", null, { ...baseOpts, numCandidates: 15000 })

		const { vector } = scoreFusionInputs(pipelinesOf(col)[0])
		expect(vector[0].$vectorSearch.numCandidates).toBeLessThanOrEqual(10000)
	})

	it("bounds the fused output with $limit before projecting (F7)", async () => {
		const col = mockKBChunksCol([aHit])

		await searchKB(col, "test", null, { ...baseOpts, maxResults: 3 })

		// Pipeline: fusion, $limit, $project
		expect(pipelinesOf(col)[0][1].$limit).toBe(3)
	})

	it("normalizes raw $rankFusion scores into [0,1] before applying minScore (P0.10)", async () => {
		// Raw RRF output ceiling is (0.7+0.3) * rrfScore(1) = 1/61 ≈ 0.0164;
		// half of the ceiling must read as a 0.5 relevance, not 0.008.
		const col = mockKBChunksCol([{ ...aHit, score: 0.0082 }])

		const results = await searchKB(col, "test", null, {
			...baseOpts,
			minScore: 0.4,
			fusionMethod: "rankFusion",
		})

		expect(results).toHaveLength(1)
		expect(results[0].score).toBeCloseTo(0.5002, 4)
	})

	it("keeps the native minMaxScaler score of $scoreFusion without a local rescale", async () => {
		const col = mockKBChunksCol([{ ...aHit, score: 0.62 }])

		const results = await searchKB(col, "test", null, {
			...baseOpts,
			fusionMethod: "scoreFusion",
		})

		expect(results).toHaveLength(1)
		expect(results[0].score).toBeCloseTo(0.62, 4)
	})
})

describe("searchKB: tenant scope and metadata filters", () => {
	it("constrains the vector input, the text input and the freshness re-check to the caller's scopeRef", async () => {
		const col = mockKBChunksCol([aHit])

		await searchKB(col, "architecture", null, baseOpts)

		const { vector, text } = scoreFusionInputs(pipelinesOf(col)[0])
		expect(vector[0].$vectorSearch.filter).toEqual({ scopeRef: "agent:test" })
		expect(text[0].$search.compound.filter).toEqual([
			{ equals: { path: "scopeRef", value: "agent:test" } },
		])
		expect(vector[1].$match).toEqual(revalidatedBy({ scopeRef: "agent:test" }))
		expect(text[1].$match).toEqual(revalidatedBy({ scopeRef: "agent:test" }))
	})

	it("short-circuits when the KB metadata filter resolves to no matching documents", async () => {
		const col = mockKBChunksCol([aHit])
		const kbDocs = mockKBDocsCol([])
		const rows: Document[] = []

		const results = await searchKB(col, "vector", null, {
			...baseOpts,
			filter: { tags: ["missing"], category: "none", source: "file" },
			kbDocs,
			onTierOutcome: (row) => rows.push(row),
		})

		expect(results).toHaveLength(0)
		expect(col.aggregate).not.toHaveBeenCalled()
		expect(rows).toEqual([
			{
				stage: "filter",
				outcome: "ok-empty",
				reason: "zero-hits",
				resultCount: 0,
			},
		])
	})

	it("applies the resolved KB document ids to both fusion inputs", async () => {
		const col = mockKBChunksCol([aHit])
		const kbDocs = mockKBDocsCol(["doc-a", "doc-b"])

		await searchKB(col, "filtered", null, {
			...baseOpts,
			filter: { tags: ["docs"], category: "architecture", source: "file" },
			kbDocs,
		})

		const { vector, text } = scoreFusionInputs(pipelinesOf(col)[0])
		const chunkFilter = {
			scopeRef: "agent:test",
			docId: { $in: ["doc-a", "doc-b"] },
		}
		expect(vector[0].$vectorSearch.filter).toEqual(chunkFilter)
		expect(text[0].$search.compound.filter).toEqual([
			// Tenant isolation pre-filter is always present (issue #27).
			{ equals: { path: "scopeRef", value: "agent:test" } },
			{ in: { path: "docId", value: ["doc-a", "doc-b"] } },
		])
		// The full chunk filter is re-validated post-search against the
		// hydrated document — the compound filter runs against the indexed
		// copy, which can lag the latest write.
		expect(vector[1].$match).toEqual(revalidatedBy(chunkFilter))
		expect(text[1].$match).toEqual(revalidatedBy(chunkFilter))
	})

	it("treats a filter that normalizes to nothing as no filter, with or without kbDocs", async () => {
		const col = mockKBChunksCol([aHit])

		const results = await searchKB(col, "architecture", null, {
			...baseOpts,
			filter: { tags: [" "], category: " ", source: "" },
		})

		expect(results).toHaveLength(1)
		const { vector } = scoreFusionInputs(pipelinesOf(col)[0])
		expect(vector[0].$vectorSearch.filter).toEqual({ scopeRef: "agent:test" })
	})
})

describe("searchKB: ledger", () => {
	// #101 decision 18: the manager reserves kbLaneCost before the lane runs,
	// so the lane must charge exactly what the table says. The old cascade
	// reserved and charged up to three aggregations and two embeds.
	async function chargedWithin(
		fusionMethod: "scoreFusion" | "rankFusion",
		results: Document[],
	) {
		const cost = kbLaneCost({ embeddingMode: "automated" })
		const { budget } = await runWithSearchBudget(
			{ maxAggregations: 12, maxEmbeds: 5 },
			async () => {
				const reservation = tryReserveSearchBudget(cost)
				if (!reservation) throw new Error("fixture reservation refused")
				await runWithSearchReservation(reservation, () =>
					searchKB(mockKBChunksCol(results), "rotation policy", null, {
						...baseOpts,
						fusionMethod,
					}),
				)
			},
		)
		return { cost, charged: budget }
	}

	it.each([
		"scoreFusion",
		"rankFusion",
	] as const)("%s: a healthy zero hit charges exactly one aggregation and one embed", async (fusionMethod) => {
		const { cost, charged } = await chargedWithin(fusionMethod, [])

		expect(cost).toEqual({ aggregations: 1, embeds: 1 })
		expect(charged).toMatchObject({ aggregations: 1, embeds: 1 })
	})
})

describe("searchKB: lifecycle of a chunk past its retention deadline", () => {
	// M2 T13 (review F2): kb_chunks carry an optional Date `expiresAt` and no
	// TTL index sweeps it, so the read itself must exclude an expired chunk.
	// The Search prefilters cannot (expiresAt is not an indexed filter field),
	// so the hydrated `$match` after each Search stage carries the clause.
	const day = 24 * 60 * 60 * 1000
	const chunk = (path: string, expiresAt?: unknown): Document => ({
		scopeRef: "agent:test",
		docId: "doc-1",
		path,
		startLine: 1,
		endLine: 2,
		text: `text of ${path}`,
		...(expiresAt === undefined ? {} : { expiresAt }),
	})

	it.each([
		"scoreFusion",
		"rankFusion",
	] as const)("%s: an expired chunk is excluded; a future and an absent deadline are kept", async (fusionMethod) => {
		const double = createKbFusionDouble([
			chunk("expired.md", new Date(Date.now() - day)),
			chunk("future.md", new Date(Date.now() + day)),
			chunk("permanent.md"),
		])

		const results = await searchKB(double.collection, "policy", null, {
			...baseOpts,
			fusionMethod,
		})

		expect(results.map((result) => result.filePath).toSorted()).toEqual([
			"future.md",
			"permanent.md",
		])
	})

	it.each([
		"scoreFusion",
		"rankFusion",
	] as const)("%s: the vector and the text input both re-check expiry on the hydrated document", async (fusionMethod) => {
		const double = createKbFusionDouble([chunk("permanent.md")])

		await searchKB(double.collection, "policy", null, {
			...baseOpts,
			fusionMethod,
		})

		const fusion =
			double.pipelines[0][0].$scoreFusion ?? double.pipelines[0][0].$rankFusion
		for (const input of Object.values(
			fusion.input.pipelines as Record<string, Document[]>,
		)) {
			const match = input.find((stage) => stage.$match)?.$match
			expect(JSON.stringify(match)).toContain('"expiresAt"')
		}
	})

	it("keeps the scopeRef tenant predicate and the Search prefilters unchanged", async () => {
		const double = createKbFusionDouble([chunk("permanent.md")])

		await searchKB(double.collection, "policy", null, baseOpts)

		const inputs = double.pipelines[0][0].$scoreFusion.input.pipelines
		expect(inputs.vector[0].$vectorSearch.filter).toEqual({
			scopeRef: "agent:test",
		})
		expect(inputs.text[0].$search.compound.filter).toEqual([
			{ equals: { path: "scopeRef", value: "agent:test" } },
		])
	})

	it("does not return a chunk of another scopeRef, expired or not", async () => {
		const double = createKbFusionDouble([
			{ ...chunk("foreign.md"), scopeRef: "agent:other" },
		])

		const results = await searchKB(double.collection, "policy", null, baseOpts)

		expect(results).toEqual([])
	})
})
