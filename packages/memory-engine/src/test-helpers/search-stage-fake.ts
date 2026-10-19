// A collection double for the M2 Search-native lanes. It evaluates the
// aggregate a lane emits against an in-memory document set so a test can
// assert what the lane RETURNS, not only the pipeline it built.
//
// Two properties make the double honest about how mongot behaves:
//
//   1. The `$search` stage matches against the INDEXED copy of each document,
//      and the stages after it run on the document mongod holds NOW. A test
//      can therefore index a document, change it afterwards and watch whether
//      the lane's post-Search revalidation drops it (the "lifecycle change
//      after indexing" case).
//   2. Operators are validated against the index definition the manifest
//      declares (`equals` needs a token mapping, `text` and `phrase` a string
//      mapping, `autocomplete` an autocomplete mapping). A query whose mapping
//      is missing from the manifest throws instead of matching, so the double
//      fails exactly where mongot would return nothing or reject the query.
//
// The analyzer is a stand-in: lowercase, then split on anything that is not a
// letter or digit. It models the documented behavior of lucene.standard well
// enough to exercise our code; it does not prove mongot's analyzer. Real
// analyzer behavior is exercised only by the e2e suite against a live mongot.
//
// Only the operators the store lanes emit are implemented. Anything else
// throws, so a lane cannot quietly depend on behavior the double lacks.
import type { Collection, Document } from "mongodb"
import { buildRequiredIndexManifest } from "../mongodb-required-index-manifest.js"
import { matchesFilter } from "./stateful-mongo-fake.js"

export type SearchStageFakeEntry = {
	/** The copy mongot indexed; the Search stage matches against it. */
	indexed: Document
	/**
	 * The document mongod holds now. Defaults to `indexed`; null means the
	 * document was deleted after it was indexed.
	 */
	current?: Document | null
}

export type SearchStageFake = {
	collection: Collection
	/** Every pipeline the lane ran, in order. */
	pipelines: Document[][]
	/** Options passed to each aggregate. */
	options: Array<Document | undefined>
	/** Every `find` call; lanes under test must make none with content filters. */
	findCalls: Document[]
}

type FieldType = { type: string; normalizer?: string }

function fieldTypes(definition: Document, path: string): FieldType[] {
	const mapping = (definition.mappings as Document | undefined)?.fields?.[path]
	if (mapping === undefined) return []
	return (Array.isArray(mapping) ? mapping : [mapping]) as FieldType[]
}

function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length > 0)
}

function valuesAt(doc: Document, path: string): unknown[] {
	const value = path.split(".").reduce<unknown>((current, part) => {
		if (current === null || typeof current !== "object") return undefined
		return (current as Record<string, unknown>)[part]
	}, doc)
	if (value === undefined || value === null) return []
	return Array.isArray(value) ? value : [value]
}

function asArray<T>(value: T | T[]): T[] {
	return Array.isArray(value) ? value : [value]
}

function requireMapping(
	definition: Document,
	path: string,
	type: string,
	operator: string,
): FieldType {
	const found = fieldTypes(definition, path).find(
		(candidate) => candidate.type === type,
	)
	if (!found) {
		throw new Error(
			`search double: ${operator} on "${path}" needs a ${type} mapping in the index definition`,
		)
	}
	return found
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
	return a === b
}

function containsSequence(haystack: string[], needle: string[]): boolean {
	if (needle.length === 0) return false
	for (let start = 0; start + needle.length <= haystack.length; start++) {
		if (needle.every((token, offset) => haystack[start + offset] === token)) {
			return true
		}
	}
	return false
}

function evaluate(
	operator: Document,
	doc: Document,
	definition: Document,
): boolean {
	const [name] = Object.keys(operator)
	const spec = operator[name] as Document
	switch (name) {
		case "compound":
			return evaluateCompound(spec, doc, definition)
		case "equals": {
			const mapping = requireMapping(definition, spec.path, "token", "equals")
			const lower = mapping.normalizer === "lowercase"
			const wanted =
				lower && typeof spec.value === "string"
					? spec.value.toLowerCase()
					: spec.value
			return valuesAt(doc, spec.path).some((value) =>
				sameValue(
					lower && typeof value === "string" ? value.toLowerCase() : value,
					wanted,
				),
			)
		}
		case "in": {
			const mapping = requireMapping(definition, spec.path, "token", "in")
			const lower = mapping.normalizer === "lowercase"
			const normalize = (value: unknown) =>
				lower && typeof value === "string" ? value.toLowerCase() : value
			const wanted = asArray<unknown>(spec.value).map(normalize)
			return valuesAt(doc, spec.path).some((value) =>
				wanted.some((candidate) => sameValue(normalize(value), candidate)),
			)
		}
		case "text": {
			const paths = asArray<string>(spec.path)
			for (const path of paths) requireMapping(definition, path, "string", name)
			const terms = asArray<string>(spec.query).flatMap(tokens)
			const fieldTokens = new Set(
				paths.flatMap((path) =>
					valuesAt(doc, path).flatMap((value) => tokens(String(value))),
				),
			)
			if (terms.length === 0) return false
			return spec.matchCriteria === "all"
				? terms.every((term) => fieldTokens.has(term))
				: terms.some((term) => fieldTokens.has(term))
		}
		case "phrase": {
			const paths = asArray<string>(spec.path)
			for (const path of paths) requireMapping(definition, path, "string", name)
			if (spec.slop !== undefined && spec.slop !== 0) {
				throw new Error(
					"search double: phrase slop other than 0 is not modeled",
				)
			}
			return asArray<string>(spec.query).some((phrase) =>
				paths.some((path) =>
					valuesAt(doc, path).some((value) =>
						containsSequence(tokens(String(value)), tokens(phrase)),
					),
				),
			)
		}
		case "autocomplete": {
			requireMapping(definition, spec.path, "autocomplete", name)
			const terms = tokens(String(spec.query))
			if (terms.length === 0) return false
			const fieldTokens = valuesAt(doc, spec.path).flatMap((value) =>
				tokens(String(value)),
			)
			return terms.every((term) =>
				fieldTokens.some((token) => term.length >= 2 && token.startsWith(term)),
			)
		}
		default:
			throw new Error(`search double: operator ${name} is not modeled`)
	}
}

function evaluateCompound(
	spec: Document,
	doc: Document,
	definition: Document,
): boolean {
	const must = (spec.must ?? []) as Document[]
	const filter = (spec.filter ?? []) as Document[]
	const mustNot = (spec.mustNot ?? []) as Document[]
	const should = (spec.should ?? []) as Document[]
	if (!must.every((clause) => evaluate(clause, doc, definition))) return false
	if (!filter.every((clause) => evaluate(clause, doc, definition))) return false
	if (mustNot.some((clause) => evaluate(clause, doc, definition))) return false
	const required =
		must.length === 0 && filter.length === 0 && should.length > 0
			? Math.max(1, Number(spec.minimumShouldMatch ?? 0))
			: Number(spec.minimumShouldMatch ?? 0)
	const matched = should.filter((clause) =>
		evaluate(clause, doc, definition),
	).length
	return matched >= required
}

function applyStage(docs: Document[], stage: Document): Document[] {
	const [name] = Object.keys(stage)
	const spec = stage[name]
	switch (name) {
		case "$match":
			return docs.filter((doc) => matchesFilter(doc, spec as Document))
		case "$sort": {
			const entries = Object.entries(spec as Document)
			return [...docs].sort((a, b) => {
				for (const [path, direction] of entries) {
					const left = valuesAt(a, path)[0]
					const right = valuesAt(b, path)[0]
					const l = left instanceof Date ? left.getTime() : (left as number)
					const r = right instanceof Date ? right.getTime() : (right as number)
					if (l === r) continue
					const order = l < r ? -1 : 1
					return direction === -1 ? -order : order
				}
				return 0
			})
		}
		case "$limit":
			return docs.slice(0, spec as number)
		case "$project": {
			const projection = spec as Document
			return docs.map((doc) => {
				const out: Document = {}
				for (const [key, value] of Object.entries(projection)) {
					if (key === "_id") continue
					if (value === 1 || value === true) {
						if (key in doc) out[key] = doc[key]
					} else if (
						value !== null &&
						typeof value === "object" &&
						(value as Document).$meta === "searchScore"
					) {
						out[key] = 1
					} else {
						throw new Error(
							`search double: projection of ${key} is not modeled`,
						)
					}
				}
				if (projection._id !== 0) out._id = doc._id
				return out
			})
		}
		default:
			throw new Error(`search double: stage ${name} is not modeled`)
	}
}

/**
 * Evaluates one lane pipeline against a document set: the `$search` stage
 * matches the indexed copies, the later stages run on the current documents.
 * For a hand-rolled collection double whose rows change during a test; pass
 * the rows as they are at the moment of the call.
 */
export function runSearchPipeline(params: {
	indexName: string
	definition: Document
	entries: SearchStageFakeEntry[]
	pipeline: Document[]
}): Document[] {
	const [first, ...rest] = params.pipeline
	const search = first?.$search as Document | undefined
	if (!search) {
		throw new Error("search double: the first stage must be $search")
	}
	if (search.index !== params.indexName) {
		throw new Error(
			`search double: $search names index ${String(search.index)}, expected ${params.indexName}`,
		)
	}
	const operator = Object.fromEntries(
		Object.entries(search).filter(([key]) => key !== "index"),
	)
	const hydrated: Document[] = []
	params.entries.forEach((entry, position) => {
		if (!evaluate(operator, entry.indexed, params.definition)) return
		const current = entry.current === undefined ? entry.indexed : entry.current
		if (current === null) return
		hydrated.push({ _id: position, ...current })
	})
	return rest.reduce(applyStage, hydrated)
}

/**
 * @param definition the index definition the manifest declares for the index
 *   the lane queries
 * @param indexName the index name the lane must pass to `$search`
 */
export function createSearchStageFake(params: {
	indexName: string
	definition: Document
	entries: SearchStageFakeEntry[]
	/** A failure the aggregate raises instead of answering. */
	failure?: Error
}): SearchStageFake {
	const pipelines: Document[][] = []
	const options: Array<Document | undefined> = []
	const findCalls: Document[] = []
	const collection = {
		find: (filter: Document) => {
			findCalls.push(filter)
			throw new Error("search double: a content find is not allowed")
		},
		aggregate: (pipeline: Document[], aggregateOptions?: Document) => {
			pipelines.push(pipeline)
			options.push(aggregateOptions)
			return {
				toArray: async () => {
					if (params.failure) throw params.failure
					return runSearchPipeline({ ...params, pipeline })
				},
			}
		},
	} as unknown as Collection
	return { collection, pipelines, options, findCalls }
}

/**
 * The definition boot requires for one manifest index, so a lane test queries
 * the mapping the engine will actually have built.
 */
export function manifestDefinition(
	prefix: string,
	indexName: string,
): Document {
	const entry = buildRequiredIndexManifest({
		prefix,
		serverVersionArray: [8, 3, 0, 0],
		env: {},
	}).find((candidate) => candidate.name === indexName)
	if (!entry) throw new Error(`manifest has no index named ${indexName}`)
	return entry.definition
}
