import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
	CORPUS_SEED,
	CORPUS_VERSION,
	FROZEN_CORPUS_SHA256,
	JEV_RERANK_CORPUS,
	JEV_RERANK_CORPUS_MANIFEST,
	JEV_RERANK_STRATA,
	computeJevRerankCorpusManifest,
	generateJevRerankCorpus,
	type JevRerankRelevance,
	type JevRerankSplit,
} from "./test-fixtures/jev-rerank/corpus.js"

const DEV_FIXTURES = 50
const HELDOUT_FIXTURES = 200
const TOTAL_FIXTURES = 250

function splitFixtures(split: JevRerankSplit) {
	return JEV_RERANK_CORPUS.filter((fixture) => fixture.split === split)
}

describe("jev rerank corpus: counts and splits", () => {
	it("contains exactly 250 fixtures: 50 dev and 200 heldout", () => {
		expect(JEV_RERANK_CORPUS).toHaveLength(TOTAL_FIXTURES)
		expect(splitFixtures("dev")).toHaveLength(DEV_FIXTURES)
		expect(splitFixtures("heldout")).toHaveLength(HELDOUT_FIXTURES)
		expect(JEV_RERANK_CORPUS_MANIFEST.fixtureCount).toBe(TOTAL_FIXTURES)
		expect(JEV_RERANK_CORPUS_MANIFEST.splitCounts.dev).toBe(DEV_FIXTURES)
		expect(JEV_RERANK_CORPUS_MANIFEST.splitCounts.heldout).toBe(
			HELDOUT_FIXTURES,
		)
	})

	it("covers every stratum in both splits", () => {
		for (const split of ["dev", "heldout"] as const) {
			for (const stratum of JEV_RERANK_STRATA) {
				const count = JEV_RERANK_CORPUS_MANIFEST.stratumCounts[split][stratum]
				expect(count, `${split}/${stratum} count`).toBeGreaterThan(0)
				const actual = JEV_RERANK_CORPUS.filter(
					(fixture) => fixture.split === split && fixture.stratum === stratum,
				).length
				expect(actual).toBe(count)
			}
		}
	})
})

describe("jev rerank corpus: identifiers", () => {
	it("has unique fixture ids matching their split and stratum", () => {
		const ids = new Set(JEV_RERANK_CORPUS.map((fixture) => fixture.id))
		expect(ids.size).toBe(TOTAL_FIXTURES)
		for (const fixture of JEV_RERANK_CORPUS) {
			expect(
				fixture.id.startsWith(`${fixture.split}-${fixture.stratum}-`),
			).toBe(true)
		}
	})

	it("never reuses a template family across splits", () => {
		const devFamilies = new Set(
			splitFixtures("dev").map((fixture) => fixture.familyId),
		)
		const heldoutFamilies = new Set(
			splitFixtures("heldout").map((fixture) => fixture.familyId),
		)
		for (const family of devFamilies) {
			expect(
				heldoutFamilies.has(family),
				`family ${family} crosses splits`,
			).toBe(false)
		}
		expect(JEV_RERANK_CORPUS_MANIFEST.familyCount).toBe(
			devFamilies.size + heldoutFamilies.size,
		)
	})

	it("has unique candidate ids within each fixture", () => {
		for (const fixture of JEV_RERANK_CORPUS) {
			const ids = new Set(fixture.candidates.map((candidate) => candidate.id))
			expect(ids.size, `${fixture.id} candidate ids`).toBe(
				fixture.candidates.length,
			)
		}
	})
})

describe("jev rerank corpus: candidates and labels", () => {
	it("keeps candidate counts within [8, 20] for every fixture", () => {
		for (const fixture of JEV_RERANK_CORPUS) {
			expect(
				fixture.candidates.length,
				`${fixture.id} candidate count`,
			).toBeGreaterThanOrEqual(8)
			expect(fixture.candidates.length).toBeLessThanOrEqual(20)
		}
		expect(JEV_RERANK_CORPUS_MANIFEST.candidateCountMin).toBeGreaterThanOrEqual(
			8,
		)
		expect(JEV_RERANK_CORPUS_MANIFEST.candidateCountMax).toBeLessThanOrEqual(20)
	})

	it("has non-empty, trimmed text for every query and candidate", () => {
		for (const fixture of JEV_RERANK_CORPUS) {
			expect(
				fixture.query.trim().length,
				`${fixture.id} query`,
			).toBeGreaterThan(0)
			for (const candidate of fixture.candidates) {
				expect(
					candidate.text.trim().length,
					`${fixture.id}/${candidate.id} text`,
				).toBeGreaterThan(0)
			}
		}
	})

	it("uses only relevance labels 0-4 assigned by construction", () => {
		const valid = new Set<JevRerankRelevance>([0, 1, 2, 3, 4])
		for (const fixture of JEV_RERANK_CORPUS) {
			for (const candidate of fixture.candidates) {
				expect(
					valid.has(candidate.relevance),
					`${fixture.id}/${candidate.id} label`,
				).toBe(true)
			}
		}
	})

	it("includes at least one level-0 generic distractor in every fixture", () => {
		for (const fixture of JEV_RERANK_CORPUS) {
			const hasZero = fixture.candidates.some(
				(candidate) => candidate.relevance === 0,
			)
			expect(hasZero, `${fixture.id} has a level-0 candidate`).toBe(true)
		}
	})

	it("includes at least one top-relevant candidate in every non-no-relevant fixture", () => {
		for (const fixture of JEV_RERANK_CORPUS) {
			if (fixture.stratum === "no-relevant") continue
			const hasTop = fixture.candidates.some(
				(candidate) => candidate.relevance >= 3,
			)
			expect(hasTop, `${fixture.id} has a level>=3 candidate`).toBe(true)
		}
	})
})

describe("jev rerank corpus: determinism and freeze", () => {
	it("regenerates an identical corpus from the seed", () => {
		const regenerated = generateJevRerankCorpus(CORPUS_SEED)
		expect(regenerated).toEqual(JEV_RERANK_CORPUS)
		expect(
			computeJevRerankCorpusManifest(regenerated, CORPUS_SEED).sha256,
		).toBe(JEV_RERANK_CORPUS_MANIFEST.sha256)
	})

	it("produces a different corpus from a different seed", () => {
		const other = generateJevRerankCorpus(CORPUS_SEED + 1)
		expect(other).not.toEqual(JEV_RERANK_CORPUS)
	})

	it("matches the frozen sha256 once recorded", () => {
		const canonical = JSON.stringify({
			corpusVersion: CORPUS_VERSION,
			seed: CORPUS_SEED,
			fixtures: [...JEV_RERANK_CORPUS]
				.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
				.map((fixture) => ({
					id: fixture.id,
					split: fixture.split,
					familyId: fixture.familyId,
					stratum: fixture.stratum,
					query: fixture.query,
					candidates: fixture.candidates.map((candidate) => ({
						id: candidate.id,
						text: candidate.text,
						relevance: candidate.relevance,
					})),
				})),
		})
		const digest = createHash("sha256").update(canonical, "utf8").digest("hex")
		if (FROZEN_CORPUS_SHA256 === "") {
			// Freeze step: print the digest to record it in the corpus module.
			console.info(`[jev-rerank-corpus] sha256 to freeze: ${digest}`)
			expect(digest).toMatch(/^[0-9a-f]{64}$/)
		} else {
			expect(FROZEN_CORPUS_SHA256).toBe(digest)
		}
	})
})

describe("jev rerank corpus: disclosure", () => {
	it("records the heldout correlation caveat", () => {
		const disclosure = JEV_RERANK_CORPUS_MANIFEST.disclosure.toLowerCase()
		expect(disclosure).toContain("correlated")
		expect(disclosure).toContain("not independent")
		expect(disclosure).toContain("template")
	})

	it("carries the corpus version and seed in the manifest", () => {
		expect(JEV_RERANK_CORPUS_MANIFEST.corpusVersion).toBe(CORPUS_VERSION)
		expect(JEV_RERANK_CORPUS_MANIFEST.seed).toBe(CORPUS_SEED)
	})
})
