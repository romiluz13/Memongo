// T7 (#116): the Search mappings the store lanes query are part of T1's
// required-index manifest, so boot verifies them and repairs a deployment that
// still serves the mappings it had before the lanes moved to Search. A repair
// is an in-place update; boot never drops an index.
import type { Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { enforceBootContract } from "./mongodb-boot-contract.js"
import { MemongoBootError } from "./mongodb-boot-errors.js"
import {
	type RequiredSearchIndex,
	buildRequiredIndexManifest,
} from "./mongodb-required-index-manifest.js"
import {
	type FakeSearchIndex,
	createFakeSearchDb,
	readyIndex,
	writeCalls,
} from "./test-helpers/fake-search-db.js"

const PREFIX = "t_"
const ENV = {} as NodeJS.ProcessEnv

function manifest(env: NodeJS.ProcessEnv = ENV): RequiredSearchIndex[] {
	return buildRequiredIndexManifest({
		prefix: PREFIX,
		serverVersionArray: [8, 3, 0, 0],
		env,
	})
}

function entry(
	name: string,
	env: NodeJS.ProcessEnv = ENV,
): RequiredSearchIndex {
	const found = manifest(env).find((candidate) => candidate.name === name)
	if (!found) throw new Error(`manifest has no ${name}`)
	return found
}

function fields(name: string, env: NodeJS.ProcessEnv = ENV): Document {
	return entry(name, env).definition.mappings.fields
}

const LOWERCASE_TOKEN = { type: "token", normalizer: "lowercase" }

// The definitions the three indexes had before T7, kept literal so the repair
// test starts from what a deployed cluster really serves.
const PRE_T7: Record<string, (current: Document) => Document> = {
	t_procedures_text: (current) => {
		const { triggerQueries: _dropped, ...rest } = current.mappings.fields
		return {
			mappings: {
				dynamic: false,
				fields: { ...rest, name: current.mappings.fields.name[0] },
			},
		}
	},
	entity_autocomplete: (current) => ({
		mappings: {
			dynamic: false,
			fields: {
				...current.mappings.fields,
				name: { type: "autocomplete" },
				aliases: { type: "autocomplete" },
			},
		},
	}),
	episode_autocomplete: (current) => ({
		mappings: {
			dynamic: false,
			fields: {
				...current.mappings.fields,
				title: { type: "autocomplete" },
				summary: { type: "autocomplete" },
			},
		},
	}),
}

function serving(
	override?: (candidate: RequiredSearchIndex) => Document | undefined,
): Record<string, FakeSearchIndex[]> {
	const byCollection: Record<string, FakeSearchIndex[]> = {}
	for (const candidate of manifest()) {
		const definition = override?.(candidate) ?? candidate.definition
		byCollection[candidate.collectionName] = [
			...(byCollection[candidate.collectionName] ?? []),
			readyIndex(candidate.name, candidate.type, definition),
		]
	}
	return byCollection
}

function boot(fake: Parameters<typeof createFakeSearchDb>[0]) {
	const { db, calls, indexes } = createFakeSearchDb(fake)
	let at = 0
	const run = () =>
		enforceBootContract(db, {
			prefix: PREFIX,
			env: ENV,
			mode: "repair",
			deadlineMs: 5_000,
			pollMs: 1_000,
			now: () => at,
			sleep: vi.fn(async (ms: number) => {
				at += ms
			}),
		})
	return { calls, indexes, run }
}

describe("the manifest carries the mappings the store lanes query", () => {
	it("maps procedure name and trigger queries as lowercase tokens for equals", () => {
		const mapped = fields("t_procedures_text")
		expect(mapped.name).toEqual([
			{ type: "string", analyzer: "lucene.standard" },
			LOWERCASE_TOKEN,
		])
		expect(mapped.triggerQueries).toEqual(LOWERCASE_TOKEN)
		for (const path of ["agentId", "scope", "scopeRef", "state"]) {
			expect(mapped[path], path).toEqual({ type: "token" })
		}
	})

	it("keeps entity prefix lookup on autocomplete and adds lowercase tokens for equals", () => {
		const mapped = fields("entity_autocomplete")
		for (const path of ["name", "aliases"]) {
			expect(mapped[path], path).toEqual([
				{ type: "autocomplete" },
				LOWERCASE_TOKEN,
				{ type: "string", analyzer: "lucene.standard" },
			])
		}
		for (const path of ["agentId", "scope", "scopeRef"]) {
			expect(mapped[path], path).toEqual({ type: "token" })
		}
	})

	it("maps episode title and summary as analyzed strings for text", () => {
		const mapped = fields("episode_autocomplete")
		expect(mapped.title).toEqual({
			type: "string",
			analyzer: "lucene.standard",
		})
		expect(mapped.summary).toEqual({
			type: "string",
			analyzer: "lucene.standard",
		})
		expect(JSON.stringify(mapped)).not.toContain("autocomplete")
		for (const path of ["agentId", "scope", "scopeRef"]) {
			expect(mapped[path], path).toEqual({ type: "token" })
		}
	})

	it("serves derived-memory phrase and text from the events body and tenant tokens", () => {
		const mapped = fields("t_events_text")
		expect(mapped.body).toEqual({ type: "string", analyzer: "lucene.standard" })
		for (const path of ["agentId", "scope", "scopeRef"]) {
			expect(mapped[path], path).toEqual({ type: "token" })
		}
	})

	it("follows the configured text analyzer for the analyzed fields", () => {
		const env = { MEMONGO_SEARCH_TEXT_ANALYZER: "folding" } as NodeJS.ProcessEnv
		const analyzer = (fields("t_events_text", env).body as Document).analyzer
		expect(analyzer).toBe("lucene.folding")
		expect(fields("t_procedures_text", env).name[0].analyzer).toBe(analyzer)
		expect(fields("episode_autocomplete", env).title.analyzer).toBe(analyzer)
		expect(fields("episode_autocomplete", env).summary.analyzer).toBe(analyzer)
		expect(fields("t_procedures_text", env).name[1]).toEqual(LOWERCASE_TOKEN)
	})
})

describe("boot verifies the store-lane mappings", () => {
	it("resolves with no write when the cluster serves them", async () => {
		const { calls, run } = boot({ indexes: serving() })
		await expect(run()).resolves.toBeDefined()
		expect(writeCalls(calls)).toEqual([])
	})

	it.each(
		Object.keys(PRE_T7),
	)("updates %s in place when the cluster still serves its pre-T7 mapping", async (name) => {
		const { calls, indexes, run } = boot({
			indexes: serving((candidate) =>
				candidate.name === name
					? PRE_T7[name](candidate.definition)
					: undefined,
			),
		})
		await expect(run()).resolves.toBeDefined()
		const target = entry(name)
		expect(writeCalls(calls)).toEqual([
			{
				op: "updateSearchIndex",
				collection: target.collectionName,
				name,
			},
		])
		const repaired = (indexes[target.collectionName] ?? []).find(
			(index) => index.name === name,
		)
		expect(repaired?.latestDefinition).toEqual(target.definition)
	})

	it("repairs all three together and never drops", async () => {
		const { calls, run } = boot({
			indexes: serving((candidate) =>
				PRE_T7[candidate.name]?.(candidate.definition),
			),
		})
		await expect(run()).resolves.toBeDefined()
		expect(
			writeCalls(calls)
				.map((call) => `${call.op}:${"name" in call ? call.name : ""}`)
				.sort(),
		).toEqual([
			"updateSearchIndex:entity_autocomplete",
			"updateSearchIndex:episode_autocomplete",
			"updateSearchIndex:t_procedures_text",
		])
		expect(calls.some((call) => call.op === "dropSearchIndex")).toBe(false)
	})

	it("creates the three indexes with the new mappings on a cluster that has none", async () => {
		const { calls, indexes, run } = boot({ indexes: {} })
		await expect(run()).resolves.toBeDefined()
		for (const name of Object.keys(PRE_T7)) {
			const target = entry(name)
			expect(writeCalls(calls)).toContainEqual({
				op: "createSearchIndex",
				collection: target.collectionName,
				name,
			})
			expect(
				(indexes[target.collectionName] ?? []).find(
					(index) => index.name === name,
				)?.latestDefinition,
			).toEqual(target.definition)
		}
	})

	it("fails typed, and does not boot, when the cluster denies the repair", async () => {
		const { calls, run } = boot({
			indexes: serving((candidate) =>
				candidate.name === "entity_autocomplete"
					? PRE_T7.entity_autocomplete(candidate.definition)
					: undefined,
			),
			updateError: () =>
				Object.assign(new Error("not authorized to updateSearchIndex"), {
					code: 13,
					codeName: "Unauthorized",
				}),
		})
		const err = await run().then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(err).toBeInstanceOf(MemongoBootError)
		expect(err).toMatchObject({
			code: "search-privileges-denied",
			index: "entity_autocomplete",
		})
		expect(calls.some((call) => call.op === "dropSearchIndex")).toBe(false)
	})
})
