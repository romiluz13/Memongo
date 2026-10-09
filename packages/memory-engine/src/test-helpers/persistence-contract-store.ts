import { MongoServerError, type Db } from "mongodb"

export type Row = Record<string, unknown>
export const BODY = "My pickup label is NARU-617-QP."
export const FACT = "The user's pickup label is NARU-617-QP."
export const event = {
	eventId: "a",
	agentId: "offline",
	scope: "agent" as const,
	scopeRef: "offline",
	sessionId: "same",
	body: BODY,
	role: "user" as const,
	timestamp: new Date(0),
}

function equal(actual: unknown, expected: unknown): boolean {
	if (actual instanceof Date && expected instanceof Date) {
		return actual.getTime() === expected.getTime()
	}
	if (Array.isArray(actual)) return actual.some((item) => equal(item, expected))
	return actual === expected || (expected === null && actual === undefined)
}

// Only terminal query operators emitted by this seam are supported. Fail closed
// if the production query changes; this is not a MongoDB server emulator.
function matches(row: Row, query: Row): boolean {
	return Object.entries(query).every(([field, clause]) => {
		if (field === "$and" || field === "$or") {
			if (!Array.isArray(clause)) throw new Error("Invalid logical clause")
			const results = clause.map((part) => matches(row, part as Row))
			return field === "$and" ? results.every(Boolean) : results.some(Boolean)
		}
		if (field.startsWith("$")) throw new Error(`Unsupported operator ${field}`)
		const actual = row[field]
		if (
			clause === null ||
			typeof clause !== "object" ||
			clause instanceof Date
		) {
			return equal(actual, clause)
		}
		return Object.entries(clause).every(([operator, operand]) => {
			switch (operator) {
				case "$exists":
					return (actual !== undefined) === operand
				case "$ne":
					return !equal(actual, operand)
				case "$in":
					if (!Array.isArray(operand)) throw new Error("Invalid $in")
					return operand.some((item) => equal(actual, item))
				case "$nin":
					if (!Array.isArray(operand)) throw Error("Invalid $nin")
					return !operand.some((item) => equal(actual, item))
				case "$regex":
					if (!(operand instanceof RegExp)) throw new Error("Invalid regex")
					return typeof actual === "string" && operand.test(actual)
				case "$lte":
				case "$gt": {
					if (!(actual instanceof Date) || !(operand instanceof Date))
						return false
					return operator === "$lte" ? +actual <= +operand : +actual > +operand
				}
				default:
					throw new Error(`Unsupported operator ${operator}`)
			}
		})
	})
}

export function fixture(
	support: Row[] = [{ ...event, eventId: "b", timestamp: new Date(1) }],
) {
	const rows = new Map<string, Row[]>([
		["test_events", [{ ...event }, ...support]],
	])
	const table = (name: string) => {
		if (!rows.has(name)) rows.set(name, [])
		return rows.get(name) as Row[]
	}
	const transactions = { committed: 0, aborted: 0, ended: 0, retried: 0 }
	const controls = { failStructuredWrites: 0, transientStructuredWrites: 0 }
	type UpdateResult = {
		matchedCount: number
		modifiedCount?: number
		upsertedCount: number
		upsertedId?: unknown
	}
	type Cursor = {
		sort: (order: Record<string, number>) => Cursor
		limit: (n: number) => Cursor
		toArray: () => Promise<Row[]>
	}
	type FakeCollection = {
		find: (q: Row) => Cursor
		findOne: (q: Row) => Promise<Row | null>
		updateOne: (
			q: Row,
			u: Row | Row[],
			o?: { upsert?: boolean },
		) => Promise<UpdateResult>
		findOneAndUpdate: (
			q: Row,
			u: Row,
			o?: { upsert?: boolean },
		) => Promise<Row | null>
		insertOne: (
			r: Row,
		) => Promise<{ acknowledged: boolean; insertedId: string }>
		insertMany: (r: Row[]) => Promise<{
			acknowledged: boolean
			insertedCount: number
			insertedIds: Record<number, string>
		}>
		updateMany: (
			q: Row,
			u: Row,
		) => Promise<{ matchedCount: number; modifiedCount: number }>
		bulkWrite: (
			ops: { updateOne: { filter: Row; update: Row; upsert?: boolean } }[],
		) => Promise<{
			upsertedIds: Record<number, unknown>
			upsertedCount: number
			matchedCount: number
			modifiedCount: number
		}>
		deleteMany: (q: Row) => Promise<{ deletedCount: number }>
	}
	const db: {
		collection: (name: string) => FakeCollection
		client: {
			startSession: () => {
				inTransaction: () => boolean
				withTransaction: <T>(fn: () => Promise<T>) => Promise<T>
				endSession: () => Promise<void>
			}
		}
	} = {
		client: {
			startSession() {
				let active = false
				return {
					inTransaction: () => active,
					async withTransaction<T>(fn: () => Promise<T>) {
						for (let attempt = 0; attempt < 2; attempt++) {
							const before = structuredClone(rows)
							active = true
							try {
								const value = await fn()
								transactions.committed++
								return value
							} catch (e) {
								rows.clear()
								for (const [k, v] of before) rows.set(k, v)
								transactions.aborted++
								if (
									attempt === 0 &&
									e instanceof MongoServerError &&
									e.hasErrorLabel("TransientTransactionError")
								) {
									transactions.retried++
									continue
								}
								throw e
							} finally {
								active = false
							}
						}
						throw Error("fixture retry bound")
					},
					async endSession() {
						transactions.ended++
					},
				}
			},
		},
		collection(name: string) {
			return {
				find(query: Row) {
					let selected = table(name).filter((row) => matches(row, query))
					const cursor = {
						sort(order: Record<string, number>) {
							selected = selected.toSorted((a, b) => {
								for (const [field, direction] of Object.entries(order)) {
									const av = a[field] instanceof Date ? +(a[field] as Date) : 0
									const bv = b[field] instanceof Date ? +(b[field] as Date) : 0
									if (av !== bv) return (av - bv) * direction
								}
								return 0
							})
							return cursor
						},
						limit(count: number) {
							selected = selected.slice(0, count)
							return cursor
						},
						async toArray() {
							return selected
						},
					}
					return cursor
				},
				async findOne(query: Row) {
					return table(name).find((row) => matches(row, query)) ?? null
				},
				async updateOne(
					query: Row,
					update: Row | Row[],
					options?: { upsert?: boolean },
				) {
					if (name === "test_structured_mem") {
						if (controls.failStructuredWrites > 0) {
							controls.failStructuredWrites--
							throw Error("offline structured write failure")
						}
						if (controls.transientStructuredWrites > 0) {
							controls.transientStructuredWrites--
							const e = new MongoServerError({
								message: "offline transient write",
							})
							e.addErrorLabel("TransientTransactionError")
							throw e
						}
					}
					let row = table(name).find((r) => matches(r, query))
					const exists = Boolean(row)
					if (!row && !options?.upsert)
						return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
					if (!row) {
						row = {
							...query,
							_id: query._id ?? `offline-${table(name).length}`,
						}
						table(name).push(row)
					}
					const ops = Array.isArray(update) ? update : [update]
					for (const op of ops)
						for (const [operator, fields] of Object.entries(op)) {
							for (const [key, value] of Object.entries(fields as Row)) {
								switch (operator) {
									case "$setOnInsert":
										if (!exists) row[key] = value
										break
									case "$set":
										row[key] =
											value === "$$NOW"
												? new Date()
												: value && typeof value === "object" && "$add" in value
													? new Date(
															Date.now() +
																Number((value as { $add: unknown[] }).$add[1]),
														)
													: value
										break
									case "$unset":
										delete row[key]
										break
									case "$max":
										if (
											typeof value !== "number" ||
											(row[key] !== undefined && typeof row[key] !== "number")
										)
											throw Error("Unsupported nonnumeric $max")
										row[key] =
											row[key] === undefined
												? value
												: Math.max(row[key] as number, value)
										break
									case "$inc":
										row[key] = Number(row[key] ?? 0) + Number(value)
										break
									case "$currentDate":
										row[key] = new Date()
										break
									case "$addToSet": {
										const values = Array.isArray(row[key])
											? (row[key] as unknown[])
											: []
										const additions =
											value && typeof value === "object" && "$each" in value
												? (value as { $each: unknown[] }).$each
												: [value]
										row[key] = [...new Set([...values, ...additions])]
										break
									}
									default:
										throw Error(`Unsupported update ${operator}`)
								}
							}
						}
					return {
						matchedCount: exists ? 1 : 0,
						modifiedCount: exists ? 1 : 0,
						upsertedCount: exists ? 0 : 1,
						upsertedId: exists ? null : row._id,
					}
				},
				async insertMany(docs: Row[]) {
					const ids: Record<number, string> = {}
					docs.forEach((row, i) => {
						const id = `offline-${table(name).length}`
						table(name).push({ ...row, _id: row._id ?? id })
						ids[i] = id
					})
					return {
						acknowledged: true,
						insertedCount: docs.length,
						insertedIds: ids,
					}
				},
				async updateMany(query: Row, update: Row) {
					const selected = table(name).filter((r) => matches(r, query))
					for (const row of selected)
						await db.collection(name).updateOne({ _id: row._id }, update)
					return {
						matchedCount: selected.length,
						modifiedCount: selected.length,
					}
				},
				async bulkWrite(
					ops: { updateOne: { filter: Row; update: Row; upsert?: boolean } }[],
				) {
					const ids: Record<number, unknown> = {}
					let matched = 0
					for (const [i, op] of ops.entries()) {
						const r = await db
							.collection(name)
							.updateOne(op.updateOne.filter, op.updateOne.update, {
								upsert: op.updateOne.upsert,
							})
						matched += r.matchedCount
						if (r.upsertedCount) ids[i] = r.upsertedId
					}
					return {
						upsertedIds: ids,
						upsertedCount: Object.keys(ids).length,
						matchedCount: matched,
						modifiedCount: matched,
					}
				},
				async findOneAndUpdate(
					query: Row,
					update: Row,
					options?: { upsert?: boolean },
				) {
					const r = await db.collection(name).updateOne(query, update, options)
					return r.matchedCount || r.upsertedCount
						? (table(name).find((row) => matches(row, query)) ?? null)
						: null
				},
				async insertOne(row: Row) {
					table(name).push({
						...row,
						_id: row._id ?? `offline-${table(name).length}`,
					})
					return { acknowledged: true, insertedId: "offline-row" }
				},
				async deleteMany(query: Row) {
					const existing = table(name)
					const retained = existing.filter((row) => !matches(row, query))
					rows.set(name, retained)
					return { deletedCount: existing.length - retained.length }
				},
			}
		},
	}
	return { db: db as unknown as Db, rows, table, transactions, controls }
}
