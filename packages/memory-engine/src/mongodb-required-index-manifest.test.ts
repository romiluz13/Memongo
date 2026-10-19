import type { Document } from "mongodb"
import { describe, expect, it } from "vitest"
import { definitionServes } from "./mongodb-index-assessment.js"
import { buildRequiredIndexManifest } from "./mongodb-required-index-manifest.js"

function entry(name: string, env: NodeJS.ProcessEnv = {}) {
	const found = buildRequiredIndexManifest({ prefix: "t_", env }).find(
		(candidate) => candidate.name === name,
	)
	if (!found) {
		throw new Error(`${name} is not in the manifest`)
	}
	return found
}

function fieldTypes(definition: Document, path: string): string[] {
	const raw = definition.mappings.fields[path]
	return (Array.isArray(raw) ? raw : [raw]).map((m: Document) => m.type)
}

describe("T8 discovery Search mappings in the required-index manifest", () => {
	it("maps every path discovery matches with text as an analyzed string", () => {
		const structured = entry("t_structured_mem_text").definition
		for (const path of ["key", "value", "context", "tags"]) {
			expect(fieldTypes(structured, path), `structured ${path}`).toContain(
				"string",
			)
		}
		const entities = entry("entity_autocomplete").definition
		for (const path of ["name", "aliases", "type"]) {
			expect(fieldTypes(entities, path), `entities ${path}`).toContain("string")
		}
		const episodes = entry("episode_autocomplete").definition
		for (const path of ["title", "summary", "topics", "tags"]) {
			expect(fieldTypes(episodes, path), `episodes ${path}`).toContain("string")
		}
		const procedures = entry("t_procedures_text").definition
		for (const path of ["name", "searchText"]) {
			expect(fieldTypes(procedures, path), `procedures ${path}`).toContain(
				"string",
			)
		}
		expect(fieldTypes(entry("t_events_text").definition, "body")).toContain(
			"string",
		)
	})

	it("keeps the autocomplete and token mappings other lanes depend on", () => {
		expect(
			fieldTypes(entry("entity_autocomplete").definition, "name"),
		).toContain("autocomplete")
		expect(
			fieldTypes(entry("episode_autocomplete").definition, "title"),
		).toContain("autocomplete")
		expect(
			fieldTypes(entry("t_structured_mem_text").definition, "tags"),
		).toContain("token")
		expect(
			fieldTypes(entry("t_structured_mem_text").definition, "key"),
		).toContain("token")
	})

	it("declares the filter and window fields discovery pushes into compound.filter", () => {
		for (const name of [
			"t_structured_mem_text",
			"t_structured_mem_revisions_text",
			"t_procedures_text",
			"t_events_text",
			"entity_autocomplete",
			"episode_autocomplete",
		]) {
			const definition = entry(name).definition
			for (const path of ["agentId", "scope", "scopeRef"]) {
				expect(fieldTypes(definition, path), `${name} ${path}`).toEqual([
					"token",
				])
			}
		}
		expect(
			fieldTypes(entry("t_structured_mem_text").definition, "state"),
		).toEqual(["token"])
		expect(fieldTypes(entry("t_procedures_text").definition, "state")).toEqual([
			"token",
		])
		expect(
			fieldTypes(entry("t_procedures_text").definition, "updatedAt"),
		).toEqual(["date"])
		expect(fieldTypes(entry("t_events_text").definition, "timestamp")).toEqual([
			"date",
		])
		expect(
			fieldTypes(entry("episode_autocomplete").definition, "status"),
		).toEqual(["token"])
	})

	it("adds a revisions Search index on structured_mem_revisions with a date window field", () => {
		const revisions = entry("t_structured_mem_revisions_text")
		expect(revisions.collectionName).toBe("t_structured_mem_revisions")
		expect(revisions.type).toBe("search")
		expect(fieldTypes(revisions.definition, "supersededAt")).toEqual(["date"])
		for (const path of ["key", "value", "context", "tags"]) {
			expect(fieldTypes(revisions.definition, path)).toContain("string")
		}
	})

	it("serves the revisions index only on the full profile, like entities and episodes", () => {
		const lme = buildRequiredIndexManifest({
			prefix: "t_",
			env: { MEMONGO_BENCHMARK_SEARCH_INDEX_PROFILE: "longmemeval" },
		}).map((candidate) => candidate.name)
		expect(lme).not.toContain("t_structured_mem_revisions_text")
		expect(lme).not.toContain("entity_autocomplete")
		const full = buildRequiredIndexManifest({ prefix: "t_", env: {} }).map(
			(candidate) => candidate.name,
		)
		expect(full).toContain("t_structured_mem_revisions_text")
	})

	it("treats the previous definitions as drift, so boot updates them rather than dropping", () => {
		const previous = {
			mappings: {
				dynamic: false,
				fields: {
					name: { type: "autocomplete" },
					aliases: { type: "autocomplete" },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
				},
			},
		}
		const intended = entry("entity_autocomplete").definition
		expect(definitionServes(intended, previous)).toBe(false)
		expect(definitionServes(previous, intended)).toBe(false)
		expect(definitionServes(intended, intended)).toBe(true)
	})

	it("keeps the dual identifier mapping whole when the folding strategy is selected", () => {
		const key = entry("t_structured_mem_text", {
			MEMONGO_SEARCH_TEXT_ANALYZER: "folding",
		}).definition.mappings.fields.key
		expect(key).toMatchObject({ type: "string", analyzer: "lucene.keyword" })
		expect(Array.isArray(key)).toBe(false)
	})
})
