// Stateful in-memory MongoDB fake for the manager write path and the
// consolidator (fix-plan-2026-08-03 P4.2). The seam suites mock every
// collection accessor and therefore assert call wiring, not data; this fake
// IS the database, so tests can assert collection STATE after a write or a
// consolidation run.
//
// Scope is deliberately minimal — it implements only the driver surface the
// write path (mongodb-events.ts, mongodb-manager-write.ts,
// mongodb-memory-jobs.ts, mongodb-lane-coverage.ts, mongodb-ops.ts) and the
// consolidator (mongodb-consolidator.ts + adjudication/contradiction/
// structured-memory helpers) actually call:
//
//   - insertOne / insertMany (unordered bulk semantics with writeErrors)
//   - updateOne / updateMany / bulkWrite (updateOne+upsert ops)
//   - findOne / find(…).sort/limit/skip/project/toArray
//   - findOneAndUpdate (classic AND aggregation-pipeline updates, upsert)
//   - deleteMany, createIndex/dropIndex (unique index registration)
//   - aggregate with the stages on those paths: $match, $sort, $limit,
//     $count, $group ($sum/$max), $facet, $addFields, $project, and a
//     token-Jaccard $vectorSearch stand-in for the autoEmbed indexes
//
// Semantics that matter for the P0/P2 bugs:
//   - unique-index enforcement: a repeated unique key throws a
//     DuplicateKeyError-shaped error (code 11000, "E11000" message) — the
//     P0.1 idempotency replay path and the consolidation gate lease both
//     depend on this;
//   - filter operators $eq/$ne/$in/$nin/$exists/$gt/$gte/$lt/$lte/$or/$and
//     plus dotted paths ("lanes.raw-window.count", "provenance.origin");
//   - update operators $set/$setOnInsert/$inc/$unset/$addToSet and the
//     pipeline-update expressions $$NOW/$add/$ifNull used by the lease
//     claims (consolidation gate, memory jobs).
//
// NOT implemented (callers degrade or the paths are out of scope): sessions/
// transactions, change streams, real text/vector indexes, TTL sweeps,
// ordered bulk semantics.
import type { Db, Document } from "mongodb"

// ---------------------------------------------------------------------------
// Errors (shaped so isDuplicateKeyError / asBulkWriteFailure recognize them)
// ---------------------------------------------------------------------------

export class FakeDuplicateKeyError extends Error {
	readonly code = 11000
	constructor(collectionName: string, indexName: string, key: Document) {
		super(
			`E11000 duplicate key error collection: ${collectionName} index: ${indexName} dup key: ${JSON.stringify(key)}`,
		)
		this.name = "MongoServerError"
	}
}

export type FakeWriteError = {
	index: number
	code: number
	errmsg: string
}

export class FakeBulkWriteError extends Error {
	readonly writeErrors: FakeWriteError[]
	readonly result: { insertedIds: Record<number, unknown> }
	constructor(params: {
		message: string
		writeErrors: FakeWriteError[]
		insertedIds: Record<number, unknown>
	}) {
		super(params.message)
		this.name = "MongoBulkWriteError"
		this.writeErrors = params.writeErrors
		this.result = { insertedIds: params.insertedIds }
	}
}

// ---------------------------------------------------------------------------
// Document utilities (dotted paths, deep clone/equality)
// ---------------------------------------------------------------------------

function getPath(doc: unknown, path: string): unknown {
	let current = doc
	for (const part of path.split(".")) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		) {
			return undefined
		}
		current = (current as Record<string, unknown>)[part]
	}
	return current
}

function hasPath(doc: unknown, path: string): boolean {
	let current = doc
	for (const part of path.split(".")) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		) {
			return false
		}
		if (!(part in (current as Record<string, unknown>))) {
			return false
		}
		current = (current as Record<string, unknown>)[part]
	}
	return true
}

function setPath(doc: Document, path: string, value: unknown): void {
	const parts = path.split(".")
	let current = doc
	for (const part of parts.slice(0, -1)) {
		const next = current[part]
		if (next === null || next === undefined || typeof next !== "object") {
			current[part] = {}
		}
		current = current[part] as Document
	}
	current[parts[parts.length - 1]] = value
}

function unsetPath(doc: Document, path: string): void {
	const parts = path.split(".")
	let current = doc
	for (const part of parts.slice(0, -1)) {
		const next = current[part]
		if (next === null || next === undefined || typeof next !== "object") {
			return
		}
		current = next as Document
	}
	delete current[parts[parts.length - 1]]
}

function deepClone<T>(value: T): T {
	if (value instanceof Date) {
		return new Date(value.getTime()) as T
	}
	if (Array.isArray(value)) {
		return value.map((entry) => deepClone(entry)) as T
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			out[key] = deepClone(entry)
		}
		return out as T
	}
	return value
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a instanceof Date || b instanceof Date) {
		return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((entry, index) => deepEqual(entry, b[index]))
		)
	}
	if (
		a !== null &&
		b !== null &&
		typeof a === "object" &&
		typeof b === "object"
	) {
		const aKeys = Object.keys(a as Record<string, unknown>)
		const bKeys = Object.keys(b as Record<string, unknown>)
		return (
			aKeys.length === bKeys.length &&
			aKeys.every((key) =>
				deepEqual(
					(a as Record<string, unknown>)[key],
					(b as Record<string, unknown>)[key],
				),
			)
		)
	}
	return a === b
}

// BSON-ish type order for sort comparisons (MinKey < null < numbers < strings
// < objects < arrays < ObjectId < bool < Date). Tests never mix exotic types
// in one sort key, so a compact ranking is enough.
function typeRank(value: unknown): number {
	if (value === null || value === undefined) return 0
	if (typeof value === "number") return 1
	if (typeof value === "string") return 2
	if (Array.isArray(value)) return 4
	if (value instanceof Date) return 7
	if (typeof value === "boolean") return 6
	return 3
}

function compareValues(a: unknown, b: unknown): number {
	const rankA = typeRank(a)
	const rankB = typeRank(b)
	if (rankA !== rankB) {
		return rankA - rankB
	}
	if (a instanceof Date && b instanceof Date) {
		return a.getTime() - b.getTime()
	}
	if (typeof a === "number" && typeof b === "number") {
		return a - b
	}
	if (typeof a === "string" && typeof b === "string") {
		return a < b ? -1 : a > b ? 1 : 0
	}
	if (typeof a === "boolean" && typeof b === "boolean") {
		return Number(a) - Number(b)
	}
	return 0
}

function matchesCondition(
	doc: Document,
	path: string,
	condition: unknown,
): boolean {
	const value = getPath(doc, path)
	const exists = hasPath(doc, path)
	if (condition instanceof RegExp) {
		return typeof value === "string" && condition.test(value)
	}
	if (
		condition !== null &&
		typeof condition === "object" &&
		!Array.isArray(condition) &&
		!(condition instanceof Date) &&
		Object.keys(condition as Record<string, unknown>).some((key) =>
			key.startsWith("$"),
		)
	) {
		for (const [op, operand] of Object.entries(
			condition as Record<string, unknown>,
		)) {
			switch (op) {
				case "$eq":
					if (!deepEqual(value, operand)) return false
					break
				case "$ne":
					if (deepEqual(value, operand)) return false
					break
				case "$in": {
					const candidates = operand as unknown[]
					const matched = candidates.some((candidate) =>
						Array.isArray(value)
							? value.some((entry) => deepEqual(entry, candidate))
							: deepEqual(value, candidate),
					)
					if (!matched) return false
					break
				}
				case "$nin": {
					const candidates = operand as unknown[]
					const matched = candidates.some((candidate) =>
						Array.isArray(value)
							? value.some((entry) => deepEqual(entry, candidate))
							: deepEqual(value, candidate),
					)
					if (matched) return false
					break
				}
				case "$exists":
					if (Boolean(operand) !== exists) return false
					break
				case "$gt":
					if (!(compareValues(value, operand) > 0)) return false
					break
				case "$gte":
					if (!(compareValues(value, operand) >= 0)) return false
					break
				case "$lt":
					if (!(compareValues(value, operand) < 0)) return false
					break
				case "$lte":
					if (!(compareValues(value, operand) <= 0)) return false
					break
				case "$regex": {
					const re =
						operand instanceof RegExp ? operand : new RegExp(String(operand))
					if (typeof value !== "string" || !re.test(value)) return false
					break
				}
				default:
					throw new Error(`fake filter: unsupported operator ${op}`)
			}
		}
		return true
	}
	// Implicit equality; a queried array field matches on element membership.
	if (Array.isArray(value) && !Array.isArray(condition)) {
		return value.some((entry) => deepEqual(entry, condition))
	}
	return deepEqual(value, condition)
}

export function matchesFilter(doc: Document, filter: Document): boolean {
	for (const [key, condition] of Object.entries(filter)) {
		if (key === "$and") {
			if (
				!(condition as Document[]).every((clause) => matchesFilter(doc, clause))
			) {
				return false
			}
			continue
		}
		if (key === "$or") {
			if (
				!(condition as Document[]).some((clause) => matchesFilter(doc, clause))
			) {
				return false
			}
			continue
		}
		if (!matchesCondition(doc, key, condition)) {
			return false
		}
	}
	return true
}

function sortDocuments(docs: Document[], spec: Document): Document[] {
	const entries = Object.entries(spec)
	return [...docs].sort((a, b) => {
		for (const [path, direction] of entries) {
			const cmp = compareValues(getPath(a, path), getPath(b, path))
			if (cmp !== 0) {
				return direction === -1 ? -cmp : cmp
			}
		}
		return 0
	})
}

function projectDocument(doc: Document, projection: Document): Document {
	const entries = Object.entries(projection).filter(([key]) => key !== "_id")
	const includeMode = entries.some(([, value]) => value === 1 || value === true)
	const out: Document = {}
	if (projection._id !== 0) {
		out._id = doc._id
	}
	if (includeMode) {
		for (const [key, value] of entries) {
			if (value === 1 || value === true) {
				if (hasPath(doc, key)) {
					setPath(out, key, getPath(doc, key))
				}
			} else if (
				value !== null &&
				typeof value === "object" &&
				(value as Document).$meta === "vectorSearchScore"
			) {
				out[key] = doc.__vsscore ?? 0
			}
		}
		return out
	}
	// Exclusion mode.
	const clone = deepClone(doc) as Document
	for (const [key, value] of entries) {
		if (value === 0) {
			unsetPath(clone, key)
		}
	}
	return projection._id === 0 ? clone : clone
}

// ---------------------------------------------------------------------------
// Update application (classic operators + aggregation-pipeline updates)
// ---------------------------------------------------------------------------

function evalPipelineExpression(expr: unknown, doc: Document): unknown {
	if (typeof expr === "string") {
		if (expr === "$$NOW") {
			return new Date()
		}
		if (expr.startsWith("$")) {
			return getPath(doc, expr.slice(1))
		}
		return expr
	}
	if (Array.isArray(expr)) {
		return expr.map((entry) => evalPipelineExpression(entry, doc))
	}
	if (expr !== null && typeof expr === "object" && !(expr instanceof Date)) {
		const record = expr as Record<string, unknown>
		const keys = Object.keys(record)
		if (keys.length === 1 && keys[0] === "$add") {
			const operands = (record.$add as unknown[]).map((entry) =>
				evalPipelineExpression(entry, doc),
			)
			let totalMs = 0
			let sawDate = false
			for (const operand of operands) {
				if (operand instanceof Date) {
					sawDate = true
					totalMs += operand.getTime()
				} else {
					totalMs += Number(operand ?? 0)
				}
			}
			return sawDate ? new Date(totalMs) : totalMs
		}
		if (keys.length === 1 && keys[0] === "$ifNull") {
			const [candidate, fallback] = (record.$ifNull as unknown[]).map((entry) =>
				evalPipelineExpression(entry, doc),
			)
			return candidate ?? fallback
		}
		// Literal subdocument: evaluate expressions at its leaves.
		const out: Document = {}
		for (const [key, value] of Object.entries(record)) {
			out[key] = evalPipelineExpression(value, doc)
		}
		return out
	}
	return expr
}

function applyUpdateOperators(
	doc: Document,
	update: Document,
	isInsert: boolean,
): void {
	const operators = Object.keys(update)
	const isOperatorUpdate = operators.some((key) => key.startsWith("$"))
	if (!isOperatorUpdate) {
		// Full-document replacement (not used on the covered paths).
		for (const key of Object.keys(doc)) {
			if (key !== "_id") delete doc[key]
		}
		Object.assign(doc, deepClone(update))
		return
	}
	for (const [op, rawSpec] of Object.entries(update)) {
		const spec = rawSpec as Document
		switch (op) {
			case "$set":
				for (const [path, value] of Object.entries(spec)) {
					setPath(doc, path, deepClone(value))
				}
				break
			case "$setOnInsert":
				if (isInsert) {
					for (const [path, value] of Object.entries(spec)) {
						setPath(doc, path, deepClone(value))
					}
				}
				break
			case "$inc":
				for (const [path, value] of Object.entries(spec)) {
					const current = getPath(doc, path)
					setPath(
						doc,
						path,
						(typeof current === "number" ? current : 0) + Number(value),
					)
				}
				break
			case "$unset":
				for (const path of Object.keys(spec)) {
					unsetPath(doc, path)
				}
				break
			case "$addToSet": {
				for (const [path, value] of Object.entries(spec)) {
					const current = getPath(doc, path)
					const array = Array.isArray(current) ? current : []
					if (!array.some((entry) => deepEqual(entry, value))) {
						setPath(doc, path, [...array, deepClone(value)])
					}
				}
				break
			}
			default:
				throw new Error(`fake update: unsupported operator ${op}`)
		}
	}
}

function applyPipelineUpdate(doc: Document, pipeline: Document[]): void {
	for (const stage of pipeline) {
		if (stage.$set && typeof stage.$set === "object") {
			for (const [path, value] of Object.entries(stage.$set as Document)) {
				setPath(doc, path, evalPipelineExpression(value, doc))
			}
			continue
		}
		if (stage.$unset !== undefined) {
			const fields = Array.isArray(stage.$unset)
				? (stage.$unset as string[])
				: Object.keys(stage.$unset as Document)
			for (const path of fields) {
				unsetPath(doc, path)
			}
			continue
		}
		throw new Error(
			`fake pipeline update: unsupported stage ${JSON.stringify(Object.keys(stage))}`,
		)
	}
}

function applyUpdate(
	doc: Document,
	update: Document | Document[],
	isInsert: boolean,
): void {
	if (Array.isArray(update)) {
		applyPipelineUpdate(doc, update)
		return
	}
	applyUpdateOperators(doc, update, isInsert)
}

/** Equality fields a real upsert copies from the filter into the insert. */
function seedFromFilter(filter: Document): Document {
	const seed: Document = {}
	for (const [key, condition] of Object.entries(filter)) {
		if (key.startsWith("$")) continue
		if (
			condition === null ||
			typeof condition !== "object" ||
			condition instanceof Date ||
			condition instanceof RegExp ||
			Array.isArray(condition)
		) {
			setPath(seed, key, condition)
			continue
		}
		const record = condition as Record<string, unknown>
		if ("$eq" in record) {
			setPath(seed, key, record.$eq)
		}
	}
	return seed
}

// ---------------------------------------------------------------------------
// Token-Jaccard similarity backing the fake $vectorSearch stage. The real
// deployment uses server-side autoEmbed indexes; tests only need a
// deterministic similarity where identical text scores 1.0 and unrelated
// text scores low.
// ---------------------------------------------------------------------------

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean),
	)
}

export function fakeTextSimilarity(a: string, b: string): number {
	const tokensA = tokenize(a)
	const tokensB = tokenize(b)
	if (tokensA.size === 0 && tokensB.size === 0) {
		return 1
	}
	let intersection = 0
	for (const token of tokensA) {
		if (tokensB.has(token)) {
			intersection++
		}
	}
	const union = tokensA.size + tokensB.size - intersection
	return union === 0 ? 1 : intersection / union
}

// ---------------------------------------------------------------------------
// Unique index registry
// ---------------------------------------------------------------------------

type UniqueSpec = {
	name: string
	keys: string[]
	/** Mirrors partialFilterExpression { <field>: { $type: "string" } }. */
	partialStringField?: string
}

// ---------------------------------------------------------------------------
// Fault injection — deterministic post-persist failures (P0.1 regression)
// ---------------------------------------------------------------------------

type InjectedFailure = {
	collection: string
	method: string
	error: Error
	times: number
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

class FakeCursor {
	private sortSpec: Document | undefined
	private limitCount: number | undefined
	private skipCount: number | undefined
	private projectionSpec: Document | undefined
	constructor(private readonly produce: () => Document[]) {}
	sort(spec: Document): this {
		this.sortSpec = spec
		return this
	}
	limit(count: number): this {
		this.limitCount = count
		return this
	}
	skip(count: number): this {
		this.skipCount = count
		return this
	}
	project(spec: Document): this {
		this.projectionSpec = spec
		return this
	}
	async toArray(): Promise<Document[]> {
		let docs = this.produce().map((doc) => deepClone(doc) as Document)
		if (this.sortSpec) {
			docs = sortDocuments(docs, this.sortSpec)
		}
		if (this.skipCount) {
			docs = docs.slice(this.skipCount)
		}
		if (this.limitCount !== undefined) {
			docs = docs.slice(0, this.limitCount)
		}
		if (this.projectionSpec) {
			docs = docs.map((doc) =>
				projectDocument(doc, this.projectionSpec as Document),
			)
		}
		return docs.map((doc) => {
			delete doc.__vsscore
			return doc
		})
	}
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

class FakeCollection {
	readonly docs: Document[] = []
	private readonly uniqueSpecs: UniqueSpec[] = []
	private idCounter = 0

	constructor(
		readonly name: string,
		private readonly failures: InjectedFailure[],
	) {}

	private gate(method: string): void {
		for (const failure of this.failures) {
			if (
				failure.times > 0 &&
				failure.method === method &&
				(failure.collection === this.name ||
					this.name.endsWith(`_${failure.collection}`) ||
					this.name === failure.collection)
			) {
				failure.times--
				throw failure.error
			}
		}
	}

	private nextId(): string {
		this.idCounter++
		return this.idCounter.toString(16).padStart(24, "0")
	}

	registerUnique(spec: UniqueSpec): void {
		this.uniqueSpecs.push(spec)
	}

	dropUnique(name: string): void {
		const index = this.uniqueSpecs.findIndex((spec) => spec.name === name)
		if (index >= 0) {
			this.uniqueSpecs.splice(index, 1)
		}
	}

	private enforceUnique(candidate: Document, ignore?: Document): void {
		// _id is always unique.
		for (const doc of this.docs) {
			if (doc !== ignore && deepEqual(doc._id, candidate._id)) {
				throw new FakeDuplicateKeyError(this.name, "_id_", {
					_id: candidate._id,
				})
			}
		}
		for (const spec of this.uniqueSpecs) {
			if (
				spec.partialStringField &&
				typeof getPath(candidate, spec.partialStringField) !== "string"
			) {
				continue
			}
			const values = spec.keys.map((key) => getPath(candidate, key))
			// Single-null trap avoidance: a missing key does not participate.
			if (values.some((value) => value === undefined)) {
				continue
			}
			for (const doc of this.docs) {
				if (doc === ignore) continue
				if (
					spec.partialStringField &&
					typeof getPath(doc, spec.partialStringField) !== "string"
				) {
					continue
				}
				const docValues = spec.keys.map((key) => getPath(doc, key))
				if (spec.keys.every((key, i) => deepEqual(docValues[i], values[i]))) {
					throw new FakeDuplicateKeyError(this.name, spec.name, {
						...Object.fromEntries(spec.keys.map((key, i) => [key, values[i]])),
					})
				}
			}
		}
	}

	private prepareInsert(input: Document): Document {
		const doc = deepClone(input) as Document
		if (doc._id === undefined) {
			doc._id = this.nextId()
		}
		this.enforceUnique(doc)
		return doc
	}

	async insertOne(doc: Document): Promise<{
		acknowledged: true
		insertedId: unknown
	}> {
		this.gate("insertOne")
		const prepared = this.prepareInsert(doc)
		this.docs.push(prepared)
		return { acknowledged: true, insertedId: prepared._id }
	}

	/**
	 * Unordered insertMany (the only mode the write path uses): every doc
	 * that does not violate a unique index is applied; the failures are
	 * reported on a BulkWriteError-shaped throw with per-index writeErrors.
	 */
	async insertMany(
		docs: Document[],
		options?: { ordered?: boolean },
	): Promise<{
		acknowledged: true
		insertedCount: number
		insertedIds: Record<number, unknown>
	}> {
		this.gate("insertMany")
		const insertedIds: Record<number, unknown> = {}
		const writeErrors: FakeWriteError[] = []
		for (const [index, input] of docs.entries()) {
			try {
				const prepared = this.prepareInsert(input)
				this.docs.push(prepared)
				insertedIds[index] = prepared._id
			} catch (err) {
				if (err instanceof FakeDuplicateKeyError) {
					writeErrors.push({ index, code: 11000, errmsg: err.message })
					if (options?.ordered) {
						break
					}
					continue
				}
				throw err
			}
		}
		if (writeErrors.length > 0) {
			throw new FakeBulkWriteError({
				message: writeErrors[0].errmsg,
				writeErrors,
				insertedIds,
			})
		}
		return { acknowledged: true, insertedCount: docs.length, insertedIds }
	}

	private matchingDocs(filter: Document): Document[] {
		return this.docs.filter((doc) => matchesFilter(doc, filter))
	}

	private applyUpdateOne(
		filter: Document,
		update: Document | Document[],
		upsert: boolean,
		sort?: Document,
	): {
		matched: Document | null
		inserted: Document | null
	} {
		let matches = this.matchingDocs(filter)
		if (sort) {
			matches = sortDocuments(matches, sort)
		}
		const target = matches[0]
		if (!target) {
			if (!upsert) {
				return { matched: null, inserted: null }
			}
			const doc = seedFromFilter(filter)
			applyUpdate(doc, update, true)
			if (doc._id === undefined) {
				doc._id = this.nextId()
			}
			this.enforceUnique(doc)
			this.docs.push(doc)
			return { matched: null, inserted: doc }
		}
		applyUpdate(target, update, false)
		return { matched: target, inserted: null }
	}

	async updateOne(
		filter: Document,
		update: Document | Document[],
		options?: { upsert?: boolean },
	): Promise<{
		acknowledged: true
		matchedCount: number
		modifiedCount: number
		upsertedCount: number
		upsertedId: unknown
	}> {
		this.gate("updateOne")
		const { matched, inserted } = this.applyUpdateOne(
			filter,
			update,
			Boolean(options?.upsert),
		)
		return {
			acknowledged: true,
			matchedCount: matched ? 1 : 0,
			modifiedCount: matched ? 1 : 0,
			upsertedCount: inserted ? 1 : 0,
			upsertedId: inserted ? inserted._id : null,
		}
	}

	async updateMany(
		filter: Document,
		update: Document | Document[],
	): Promise<{
		acknowledged: true
		matchedCount: number
		modifiedCount: number
	}> {
		this.gate("updateMany")
		const matches = this.matchingDocs(filter)
		for (const doc of matches) {
			applyUpdate(doc, update, false)
		}
		return {
			acknowledged: true,
			matchedCount: matches.length,
			modifiedCount: matches.length,
		}
	}

	/**
	 * The write path's only bulkWrite shape: updateOne+upsert ops, unordered.
	 * Mirrors the driver's upsertedIds index map that projectEventChunksBatch
	 * reads to decide which chunks were created.
	 */
	async bulkWrite(ops: Document[]): Promise<{
		acknowledged: true
		matchedCount: number
		modifiedCount: number
		upsertedCount: number
		upsertedIds: Record<number, unknown>
		insertedCount: number
		deletedCount: number
	}> {
		this.gate("bulkWrite")
		let matchedCount = 0
		let upsertedCount = 0
		const upsertedIds: Record<number, unknown> = {}
		const writeErrors: FakeWriteError[] = []
		for (const [index, op] of ops.entries()) {
			const updateOne = op.updateOne
			if (!updateOne) {
				throw new Error(
					`fake bulkWrite: unsupported op ${JSON.stringify(Object.keys(op))}`,
				)
			}
			try {
				const { matched, inserted } = this.applyUpdateOne(
					updateOne.filter as Document,
					updateOne.update as Document,
					Boolean(updateOne.upsert),
				)
				if (matched) matchedCount++
				if (inserted) {
					upsertedCount++
					upsertedIds[index] = inserted._id
				}
			} catch (err) {
				if (err instanceof FakeDuplicateKeyError) {
					writeErrors.push({ index, code: 11000, errmsg: err.message })
					continue
				}
				throw err
			}
		}
		if (writeErrors.length > 0) {
			throw new FakeBulkWriteError({
				message: writeErrors[0].errmsg,
				writeErrors,
				insertedIds: upsertedIds,
			})
		}
		return {
			acknowledged: true,
			matchedCount,
			modifiedCount: matchedCount,
			upsertedCount,
			upsertedIds,
			insertedCount: 0,
			deletedCount: 0,
		}
	}

	async findOne(
		filter: Document,
		options?: { projection?: Document; sort?: Document },
	): Promise<Document | null> {
		this.gate("findOne")
		let matches = this.matchingDocs(filter)
		if (options?.sort) {
			matches = sortDocuments(matches, options.sort)
		}
		const doc = matches[0]
		if (!doc) {
			return null
		}
		const clone = deepClone(doc) as Document
		delete clone.__vsscore
		return options?.projection
			? projectDocument(clone, options.projection)
			: clone
	}

	find(filter: Document = {}, options?: { projection?: Document }): FakeCursor {
		this.gate("find")
		return new FakeCursor(() => {
			let docs = this.matchingDocs(filter)
			if (options?.projection) {
				docs = docs.map((doc) =>
					projectDocument(doc, options.projection as Document),
				)
			}
			return docs
		})
	}

	async findOneAndUpdate(
		filter: Document,
		update: Document | Document[],
		options?: {
			upsert?: boolean
			returnDocument?: "before" | "after"
			sort?: Document
		},
	): Promise<Document | null> {
		this.gate("findOneAndUpdate")
		const { matched, inserted } = this.applyUpdateOne(
			filter,
			update,
			Boolean(options?.upsert),
			options?.sort,
		)
		const doc = matched ?? inserted
		if (!doc) {
			return null
		}
		// `matched` was updated in place; for returnDocument "before" we would
		// need a pre-image — the covered paths always ask for "after".
		return deepClone(doc) as Document
	}

	async deleteMany(filter: Document): Promise<{
		acknowledged: true
		deletedCount: number
	}> {
		this.gate("deleteMany")
		const keep = this.docs.filter((doc) => !matchesFilter(doc, filter))
		const deletedCount = this.docs.length - keep.length
		this.docs.length = 0
		this.docs.push(...keep)
		return { acknowledged: true, deletedCount }
	}

	async countDocuments(filter: Document = {}): Promise<number> {
		this.gate("countDocuments")
		return this.matchingDocs(filter).length
	}

	async createIndex(
		keys: Document,
		options?: {
			name?: string
			unique?: boolean
			partialFilterExpression?: Document
		},
	): Promise<string> {
		const name =
			options?.name ??
			`${Object.keys(keys).join("_")}_${Object.values(keys).join("_")}`
		if (options?.unique) {
			const partial = options.partialFilterExpression
				? Object.keys(options.partialFilterExpression)[0]
				: undefined
			this.registerUnique({
				name,
				keys: Object.keys(keys),
				...(partial ? { partialStringField: partial } : {}),
			})
		}
		return name
	}

	async dropIndex(name: string): Promise<void> {
		this.dropUnique(name)
	}

	/**
	 * Minimal aggregation pipeline runner. Supports exactly the stages the
	 * write path / consolidator issue; anything else throws so a new caller
	 * fails loudly instead of silently returning wrong state.
	 */
	aggregate(pipeline: Document[]): FakeCursor {
		this.gate("aggregate")
		return new FakeCursor(() => this.runPipeline(pipeline, this.docs))
	}

	private runPipeline(pipeline: Document[], input: Document[]): Document[] {
		let docs = input.map((doc) => deepClone(doc) as Document)
		for (const stage of pipeline) {
			if (stage.$match) {
				docs = docs.filter((doc) =>
					matchesFilter(doc, stage.$match as Document),
				)
			} else if (stage.$sort) {
				docs = sortDocuments(docs, stage.$sort as Document)
			} else if (stage.$limit !== undefined) {
				docs = docs.slice(0, Number(stage.$limit))
			} else if (stage.$skip !== undefined) {
				docs = docs.slice(Number(stage.$skip))
			} else if (stage.$count !== undefined) {
				docs = [{ [String(stage.$count)]: docs.length }]
			} else if (stage.$addFields) {
				docs = docs.map((doc) => {
					for (const [key, value] of Object.entries(
						stage.$addFields as Document,
					)) {
						if (
							value !== null &&
							typeof value === "object" &&
							(value as Document).$meta === "vectorSearchScore"
						) {
							doc[key] = doc.__vsscore ?? 0
						} else {
							doc[key] = deepClone(value)
						}
					}
					return doc
				})
			} else if (stage.$project) {
				docs = docs.map((doc) =>
					projectDocument(doc, stage.$project as Document),
				)
			} else if (stage.$group) {
				docs = groupDocuments(docs, stage.$group as Document)
			} else if (stage.$facet) {
				const faceted: Document = {}
				for (const [name, sub] of Object.entries(stage.$facet as Document)) {
					faceted[name] = this.runPipeline(sub as Document[], docs)
				}
				docs = [faceted]
			} else if (stage.$vectorSearch) {
				docs = runVectorSearch(docs, stage.$vectorSearch as Document)
			} else if (stage.$unset !== undefined) {
				const fields = Array.isArray(stage.$unset)
					? (stage.$unset as string[])
					: Object.keys(stage.$unset as Document)
				for (const doc of docs) {
					for (const path of fields) {
						unsetPath(doc, path)
					}
				}
			} else {
				throw new Error(
					`fake aggregate: unsupported stage ${JSON.stringify(Object.keys(stage))}`,
				)
			}
		}
		return docs
	}
}

function groupDocuments(docs: Document[], spec: Document): Document[] {
	const idExpr = spec._id
	const groups = new Map<string, { key: unknown; doc: Document }>()
	for (const doc of docs) {
		const key =
			typeof idExpr === "string" && idExpr.startsWith("$")
				? getPath(doc, idExpr.slice(1))
				: idExpr
		const mapKey = JSON.stringify(key ?? null)
		let group = groups.get(mapKey)
		if (!group) {
			group = { key: key ?? null, doc: { _id: key ?? null } }
			groups.set(mapKey, group)
		}
		for (const [field, accumulator] of Object.entries(spec)) {
			if (field === "_id") continue
			const [op, operand] = Object.entries(accumulator as Document)[0] as [
				string,
				unknown,
			]
			const value =
				typeof operand === "string" && operand.startsWith("$")
					? getPath(doc, operand.slice(1))
					: operand
			switch (op) {
				case "$sum":
					group.doc[field] = Number(group.doc[field] ?? 0) + Number(value ?? 0)
					break
				case "$max":
					if (
						group.doc[field] === undefined ||
						compareValues(value, group.doc[field]) > 0
					) {
						group.doc[field] = value
					}
					break
				case "$min":
					if (
						group.doc[field] === undefined ||
						compareValues(value, group.doc[field]) < 0
					) {
						group.doc[field] = value
					}
					break
				case "$first":
					if (group.doc[field] === undefined) {
						group.doc[field] = value
					}
					break
				default:
					throw new Error(`fake $group: unsupported accumulator ${op}`)
			}
		}
	}
	return [...groups.values()].map((group) => group.doc)
}

function runVectorSearch(docs: Document[], spec: Document): Document[] {
	const path = String(spec.path)
	const queryText =
		typeof spec.query === "object" && spec.query !== null
			? String((spec.query as Document).text ?? "")
			: ""
	const limit = Number(spec.limit ?? 10)
	const filter = (spec.filter as Document) ?? {}
	const scored = docs
		.filter((doc) => matchesFilter(doc, filter))
		.map((doc) => {
			doc.__vsscore = fakeTextSimilarity(
				queryText,
				String(getPath(doc, path) ?? ""),
			)
			return doc
		})
	scored.sort((a, b) => Number(b.__vsscore) - Number(a.__vsscore))
	return scored.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Fake Db + factory
// ---------------------------------------------------------------------------

export type StatefulMongoFake = {
	/** Cast-ready Db handle — pass straight into the engine seams. */
	readonly db: Db
	/** All documents currently held by a collection (suffix, e.g. "events"). */
	all(collectionSuffix: string): Document[]
	/** Single document lookup by filter (suffix + filter). */
	findDoc(collectionSuffix: string, filter: Document): Document | null
	/**
	 * Make the next `times` calls to `collection.method` throw `error`
	 * (default: once). The P0.1 regression test uses this to fail chunk
	 * projection AFTER the event insert has committed.
	 */
	injectFailure(params: {
		collection: string
		method: string
		error: Error
		times?: number
	}): void
	/** Direct collection access for seeding fixtures. */
	collection(collectionSuffix: string): FakeCollection
}

/**
 * Create the fake. `prefix` matches the engine's collection prefix so
 * collection names line up exactly (`${prefix}events`, …) and the unique
 * indexes that carry the P0/P2 semantics (event idempotency key, memory job
 * jobId, consolidation gateKey, structured_mem identity, chunk path) are
 * pre-registered — mirroring ensureStandardIndexes without running it.
 */
export function createStatefulMongoFake(params?: {
	prefix?: string
}): StatefulMongoFake {
	const prefix = params?.prefix ?? "test_"
	const failures: InjectedFailure[] = []
	const collections = new Map<string, FakeCollection>()

	const obtain = (name: string): FakeCollection => {
		let collection = collections.get(name)
		if (!collection) {
			collection = new FakeCollection(name, failures)
			collections.set(name, collection)
		}
		return collection
	}

	// Unique indexes the covered paths rely on (mongodb-schema-standard-indexes).
	const fullName = (suffix: string) => `${prefix}${suffix}`
	obtain(fullName("events")).registerUnique({
		name: "uq_events_eventid",
		keys: ["eventId"],
	})
	obtain(fullName("events")).registerUnique({
		name: "uq_events_agent_idempotency_key",
		keys: ["agentId", "idempotencyKey"],
		partialStringField: "idempotencyKey",
	})
	obtain(fullName("memory_jobs")).registerUnique({
		name: "uq_memory_jobs_jobid",
		keys: ["jobId"],
	})
	obtain(fullName("consolidation_runs")).registerUnique({
		name: "uq_consolidation_runs_gate",
		keys: ["gateKey"],
		partialStringField: "gateKey",
	})
	obtain(fullName("structured_mem")).registerUnique({
		name: "uq_structured_agent_scope_scoperef_type_key",
		keys: ["agentId", "scope", "scopeRef", "type", "key"],
	})
	obtain(fullName("chunks")).registerUnique({
		name: "uq_chunks_path",
		keys: ["path"],
	})

	const db = {
		collection: (name: string) => obtain(name),
	} as unknown as Db

	return {
		db,
		all: (collectionSuffix) =>
			obtain(fullName(collectionSuffix)).docs.map(
				(doc) => deepClone(doc) as Document,
			),
		findDoc: (collectionSuffix, filter) => {
			const doc = obtain(fullName(collectionSuffix)).docs.find((entry) =>
				matchesFilter(entry, filter),
			)
			return doc ? (deepClone(doc) as Document) : null
		},
		injectFailure: ({ collection, method, error, times }) => {
			failures.push({
				collection: fullName(collection),
				method,
				error,
				times: times ?? 1,
			})
		},
		collection: (collectionSuffix) => obtain(fullName(collectionSuffix)),
	}
}
