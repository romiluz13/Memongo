// M2 T5 (#114): no production code path calls the Voyage rerank endpoint or
// reaches the removed cross-encoder, its config module or its provider keys.
// This is a source check: it reads every production TypeScript and JavaScript
// file under packages, apps and scripts, so a reintroduced reranker fails here
// even when no runtime test happens to run it.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const SCANNED_ROOTS = ["packages", "apps", "scripts"]
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	".next",
	".turbo",
	"coverage",
	".open-next",
])
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|cjs)$/
const TEST_FILE = /\.(?:test|spec|e2e\.test)\.[cm]?[jt]sx?$/

function productionSources(directory: string, found: string[] = []): string[] {
	for (const entry of readdirSync(directory)) {
		if (SKIPPED_DIRECTORIES.has(entry)) continue
		const path = join(directory, entry)
		const stats = statSync(path)
		if (stats.isDirectory()) {
			productionSources(path, found)
		} else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) {
			found.push(path)
		}
	}
	return found
}

const sources = SCANNED_ROOTS.flatMap((root) =>
	productionSources(join(REPO_ROOT, root)),
)

function filesContaining(token: string): string[] {
	return sources
		.filter((path) => readFileSync(path, "utf8").includes(token))
		.map((path) => relative(REPO_ROOT, path))
}

describe("the HTTP reranker is gone from production code", () => {
	it("scans a real source tree", () => {
		expect(sources.length).toBeGreaterThan(300)
		expect(sources.some((path) => path.endsWith("mongodb-search-v2.ts"))).toBe(
			true,
		)
	})

	it.each([
		["the Voyage rerank endpoints", "/v1/rerank"],
		["the cross-encoder entry point", "crossEncoderRerank"],
		["the HTTP rerank config module", "http-rerank-config"],
		["the reranker module", "mongodb-reranker"],
		["the HTTP rerank top-N helper", "resolveEffectiveRerankTopN"],
		["a read of the reranker provider key", ".voyageApiKey"],
		["the reranker timeout", "RERANK_TIMEOUT_MS"],
		["the post-cross-encoder recency and access boost", "BoostAfterRerank"],
		["the unwired JEV reranker", "mongodb-jev-reranker"],
		["the JEV vendor endpoint", "api.typesafe.ai"],
	])("references %s nowhere", (_label, token) => {
		expect(filesContaining(token)).toEqual([])
	})

	it("keeps the reranking.temporalProximityBoost setting, which belongs to the raw-window lane", () => {
		expect(filesContaining("temporalProximityBoost").length).toBeGreaterThan(0)
	})
})
