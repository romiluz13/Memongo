// A stateful Db whose `$search` stage is MODELED, not real. It exists so unit
// tests can exercise the analyzer-dependent behavior the discovery and
// context-bundle reads now delegate to Search (near-matches, punctuation,
// numbers, mixed case, tenant isolation, lifecycle changes after indexing)
// without Docker or a live cluster.
//
// What is modeled:
//   - index definitions come from the REAL required-index manifest, so a query
//     against a path the manifest does not map to the needed type fails loudly
//     (real mongot answers such a query with silent zero hits);
//   - each index holds a SNAPSHOT of the documents taken by refresh(); the
//     search matches the snapshot and then returns the LIVE document by _id,
//     which is how mongod resolves search hits, so a document changed or
//     deleted after indexing still surfaces as a candidate and the caller's
//     canonical re-check is what must drop it;
//   - operators: text (any-term), equals, in, range, exists, compound
//     (must/filter/mustNot/should/minimumShouldMatch). Anything else throws.
//
// What is NOT modeled: the real lucene analyzers (the standard analyzer is
// approximated by UAX#29-style word splitting, lowercasing, no stop words),
// scoring, fuzzy/synonyms, eventual-consistency timing, and index readiness.
// Passing here is evidence about our pipelines and mappings, not about mongot.
import type { Db, Document } from "mongodb"
import { buildRequiredIndexManifest } from "../mongodb-required-index-manifest.js"
import {
	createStatefulMongoFake,
	type StatefulMongoFake,
} from "./stateful-mongo-fake.js"

export class SearchModelError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SearchModelError"
	}
}

export type RecordedCall = {
	collection: string
	method: string
	args: unknown[]
}

type FieldMapping = { type: string; analyzer?: string; normalizer?: string }

type SearchIndex = {
	collectionName: string
	name: string
	fields: Record<string, FieldMapping[]>
	snapshot: Map<string, Document>
}

const isL = (char: string | undefined) => !!char && /\p{L}/u.test(char)
const isN = (char: string | undefined) => !!char && /\p{N}/u.test(char)

function standardTokens(text: string): string[] {
	const chars = [...text.toLowerCase()]
	const tokens: string[] = []
	let current = ""
	for (let index = 0; index < chars.length; index += 1) {
		const char = chars[index]
		if (isL(char) || isN(char) || char === "_") {
			current += char
			continue
		}
		if (current && [".", "'", "’", ","].includes(char)) {
			const previous = chars[index - 1]
			const next = chars[index + 1]
			const joinsLetters = char !== "," && isL(previous) && isL(next)
			const joinsDigits = isN(previous) && isN(next)
			if (joinsLetters || joinsDigits) {
				current += char
				continue
			}
		}
		if (current) {
			tokens.push(current)
			current = ""
		}
	}
	if (current) {
		tokens.push(current)
	}
	return tokens
}

function analyze(value: unknown, analyzer: string): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => analyze(entry, analyzer))
	}
	if (typeof value !== "string") {
		return []
	}
	switch (analyzer) {
		case "lucene.standard":
			return standardTokens(value)
		case "lucene.keyword":
			return [value]
		case "lucene.folding":
			return standardTokens(value.normalize("NFD").replace(/\p{M}/gu, ""))
		default:
			throw new SearchModelError(`analyzer ${analyzer} is not modeled`)
	}
}

function getPath(doc: Document, path: string): unknown {
	let current: unknown = doc
	for (const part of path.split(".")) {
		if (current === null || typeof current !== "object") {
			return undefined
		}
		current = (current as Record<string, unknown>)[part]
	}
	return current
}

function normalizeMappings(raw: unknown): FieldMapping[] {
	const list = Array.isArray(raw) ? raw : [raw]
	return list
		.filter((entry): entry is Document => !!entry && typeof entry === "object")
		.map((entry) => ({
			type: String(entry.type),
			...(typeof entry.analyzer === "string"
				? { analyzer: entry.analyzer }
				: {}),
			...(typeof entry.normalizer === "string"
				? { normalizer: entry.normalizer }
				: {}),
		}))
}

function requireMapping(
	index: SearchIndex,
	path: string,
	types: string[],
	operator: string,
): FieldMapping {
	const mapping = (index.fields[path] ?? []).find((entry) =>
		types.includes(entry.type),
	)
	if (!mapping) {
		throw new SearchModelError(
			`${operator} on "${path}" needs a ${types.join("/")} mapping in ${index.name}; real mongot would return zero hits silently`,
		)
	}
	return mapping
}

function asList(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [value]
}

function pathsOf(path: unknown): string[] {
	if (typeof path === "string") return [path]
	if (Array.isArray(path) && path.every((entry) => typeof entry === "string")) {
		return path as string[]
	}
	throw new SearchModelError("only string path or string[] path is modeled")
}

type Verdict = { match: boolean; score: number }

function evaluate(index: SearchIndex, op: Document, doc: Document): Verdict {
	const keys = Object.keys(op).filter((key) => key !== "score")
	if (keys.length !== 1) {
		throw new SearchModelError(
			`operator clause must have one operator, got ${keys.join(",")}`,
		)
	}
	const name = keys[0]
	const spec = op[name] as Document
	switch (name) {
		case "text": {
			for (const key of Object.keys(spec)) {
				if (!["query", "path", "score"].includes(key)) {
					throw new SearchModelError(`text option ${key} is not modeled`)
				}
			}
			let score = 0
			for (const path of pathsOf(spec.path)) {
				const mapping = requireMapping(index, path, ["string"], "text")
				const analyzer = mapping.analyzer ?? "lucene.standard"
				const fieldTokens = new Set(analyze(getPath(doc, path), analyzer))
				for (const query of asList(spec.query)) {
					for (const token of analyze(query, analyzer)) {
						if (fieldTokens.has(token)) score += 1
					}
				}
			}
			return { match: score > 0, score }
		}
		case "equals":
		case "in": {
			const path = pathsOf(spec.path)[0]
			const mapping = requireMapping(
				index,
				path,
				["token", "boolean", "number", "date", "objectId"],
				name,
			)
			const wanted = name === "equals" ? [spec.value] : asList(spec.value)
			const fold = (value: unknown) =>
				mapping.type === "token" &&
				mapping.normalizer === "lowercase" &&
				typeof value === "string"
					? value.toLowerCase()
					: value
			const actual = asList(getPath(doc, path)).map(fold)
			const match = wanted.some((candidate) =>
				actual.some((entry) =>
					entry instanceof Date && candidate instanceof Date
						? entry.getTime() === candidate.getTime()
						: entry === fold(candidate),
				),
			)
			return { match, score: 0 }
		}
		case "range": {
			const path = pathsOf(spec.path)[0]
			requireMapping(index, path, ["date", "number", "token"], "range")
			const actual = asList(getPath(doc, path)).filter(
				(entry) => entry !== null && entry !== undefined,
			) as Array<Date | number | string>
			const value = (entry: unknown) =>
				entry instanceof Date ? entry.getTime() : (entry as number | string)
			const match = actual.some((entry) => {
				const current = value(entry)
				return (
					(spec.gt === undefined || current > value(spec.gt)) &&
					(spec.gte === undefined || current >= value(spec.gte)) &&
					(spec.lt === undefined || current < value(spec.lt)) &&
					(spec.lte === undefined || current <= value(spec.lte))
				)
			})
			return { match, score: 0 }
		}
		case "exists": {
			const path = pathsOf(spec.path)[0]
			const present = getPath(doc, path)
			return {
				match: present !== undefined && present !== null,
				score: 0,
			}
		}
		case "compound": {
			const must = (spec.must as Document[] | undefined) ?? []
			const filter = (spec.filter as Document[] | undefined) ?? []
			const mustNot = (spec.mustNot as Document[] | undefined) ?? []
			const should = (spec.should as Document[] | undefined) ?? []
			if (must.length + filter.length + should.length === 0) {
				throw new SearchModelError(
					"compound with only mustNot is not modeled; its mongot behavior is unverified",
				)
			}
			for (const key of Object.keys(spec)) {
				if (
					![
						"must",
						"filter",
						"mustNot",
						"should",
						"minimumShouldMatch",
					].includes(key)
				) {
					throw new SearchModelError(`compound option ${key} is not modeled`)
				}
			}
			let score = 0
			for (const clause of must) {
				const verdict = evaluate(index, clause, doc)
				if (!verdict.match) return { match: false, score: 0 }
				score += verdict.score
			}
			for (const clause of filter) {
				if (!evaluate(index, clause, doc).match)
					return { match: false, score: 0 }
			}
			for (const clause of mustNot) {
				if (evaluate(index, clause, doc).match)
					return { match: false, score: 0 }
			}
			const shouldVerdicts = should.map((clause) =>
				evaluate(index, clause, doc),
			)
			const shouldHits = shouldVerdicts.filter((verdict) => verdict.match)
			const minimum =
				typeof spec.minimumShouldMatch === "number"
					? spec.minimumShouldMatch
					: must.length + filter.length === 0
						? 1
						: 0
			if (shouldHits.length < minimum) return { match: false, score: 0 }
			score += shouldHits.reduce((total, verdict) => total + verdict.score, 0)
			return { match: true, score }
		}
		default:
			throw new SearchModelError(`$search operator ${name} is not modeled`)
	}
}

export type SearchModelDb = {
	db: Db
	fake: StatefulMongoFake
	prefix: string
	calls: RecordedCall[]
	modelErrors: SearchModelError[]
	/** Insert documents; they become searchable after refreshIndexes(). */
	seed(collectionSuffix: string, docs: Document[]): Promise<void>
	/** Re-snapshot the search indexes of the given collections (default: all). */
	refreshIndexes(collectionSuffixes?: string[]): void
	searchPipelines(collectionSuffix: string): Document[][]
	expectNoModelErrors(): void
}

export function createSearchModelDb(params?: {
	prefix?: string
	env?: NodeJS.ProcessEnv
}): SearchModelDb {
	const prefix = params?.prefix ?? "test_"
	const fake = createStatefulMongoFake({ prefix })
	const calls: RecordedCall[] = []
	const modelErrors: SearchModelError[] = []
	const indexes = buildRequiredIndexManifest({
		prefix,
		env: params?.env ?? {},
	})
		.filter((entry) => entry.type === "search")
		.map<SearchIndex>((entry) => ({
			collectionName: entry.collectionName,
			name: entry.name,
			fields: Object.fromEntries(
				Object.entries(
					(entry.definition.mappings?.fields ?? {}) as Record<string, unknown>,
				).map(([path, raw]) => [path, normalizeMappings(raw)]),
			),
			snapshot: new Map(),
		}))

	const runSearch = (
		collectionName: string,
		pipeline: Document[],
		options: unknown,
	) => {
		void options
		return {
			toArray: async (): Promise<Document[]> => {
				// Fires injected aggregate failures exactly like a real call would.
				fake.collection(collectionName.slice(prefix.length)).aggregate([])
				const stage = pipeline[0].$search as Document
				const indexName = String(stage.index ?? "default")
				const index = indexes.find(
					(entry) =>
						entry.collectionName === collectionName && entry.name === indexName,
				)
				try {
					if (!index) {
						throw new SearchModelError(
							`no search index "${indexName}" on ${collectionName} in the manifest`,
						)
					}
					const { index: _index, ...operator } = stage
					void _index
					const live = new Map(
						fake
							.collection(collectionName.slice(prefix.length))
							.docs.map((doc) => [String(doc._id), doc]),
					)
					const hits: Array<{ doc: Document; score: number }> = []
					for (const [id, snap] of index.snapshot) {
						const verdict = evaluate(index, operator, snap)
						const current = live.get(id)
						if (verdict.match && current) {
							hits.push({
								doc: structuredClone(current),
								score: verdict.score,
							})
						}
					}
					hits.sort((left, right) => right.score - left.score)
					const scratch = createStatefulMongoFake().collection("scratch")
					scratch.docs.push(...hits.map((hit) => hit.doc))
					return await scratch.aggregate(pipeline.slice(1)).toArray()
				} catch (error) {
					if (error instanceof SearchModelError) {
						modelErrors.push(error)
					}
					throw error
				}
			},
		}
	}

	// The shared fake cursor has no `next()`, which the real driver cursor has.
	const withNext = (cursor: object) =>
		new Proxy(cursor, {
			get(target, property) {
				if (property === "next") {
					return async () => {
						const rows = await (
							target as { toArray: () => Promise<Document[]> }
						).toArray()
						return rows[0] ?? null
					}
				}
				const value = Reflect.get(target, property, target)
				return typeof value === "function"
					? (...args: unknown[]) => {
							const out = value.apply(target, args)
							return out === target ? withNext(target) : out
						}
					: value
			},
		})

	const wrap = (collection: ReturnType<StatefulMongoFake["collection"]>) =>
		new Proxy(collection, {
			get(target, property) {
				const value = Reflect.get(target, property, target)
				if (typeof value !== "function") {
					return value
				}
				return (...args: unknown[]) => {
					calls.push({
						collection: target.name,
						method: String(property),
						args,
					})
					if (
						property === "aggregate" &&
						Array.isArray(args[0]) &&
						(args[0] as Document[])[0]?.$search
					) {
						return runSearch(target.name, args[0] as Document[], args[1])
					}
					const result = value.apply(target, args)
					return property === "find" ? withNext(result) : result
				}
			},
		})

	const innerDb = fake.db as unknown as {
		collection: (name: string) => ReturnType<StatefulMongoFake["collection"]>
		client: unknown
	}
	const db = {
		collection: (name: string) => wrap(innerDb.collection(name)),
		client: innerDb.client,
	} as unknown as Db

	return {
		db,
		fake,
		prefix,
		calls,
		modelErrors,
		seed: async (collectionSuffix, docs) => {
			await fake.collection(collectionSuffix).insertMany(docs)
		},
		refreshIndexes: (collectionSuffixes) => {
			for (const index of indexes) {
				const suffix = index.collectionName.slice(prefix.length)
				if (collectionSuffixes && !collectionSuffixes.includes(suffix)) {
					continue
				}
				index.snapshot = new Map(
					fake
						.collection(suffix)
						.docs.map((doc) => [String(doc._id), structuredClone(doc)]),
				)
			}
		},
		searchPipelines: (collectionSuffix) =>
			calls
				.filter(
					(call) =>
						call.collection === `${prefix}${collectionSuffix}` &&
						call.method === "aggregate" &&
						(call.args[0] as Document[])?.[0]?.$search,
				)
				.map((call) => call.args[0] as Document[]),
		expectNoModelErrors: () => {
			if (modelErrors.length > 0) {
				throw modelErrors[0]
			}
		},
	}
}
