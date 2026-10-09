import type { Db } from "mongodb"
import { describe, expect, it } from "vitest"
import {
	persistPreparedDerivedMemoryPromotion,
	prepareDerivedMemoryPromotion,
	resolveStructuredCandidatesForPromotion,
} from "./mongodb-derived-memory.js"

type Row = Record<string, unknown>
const BODY = "My pickup label is NARU-617-QP."
const FACT = "The user's pickup label is NARU-617-QP."
const event = {
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

function fixture(
	support: Row[] = [{ ...event, eventId: "b", timestamp: new Date(1) }],
) {
	const rows = new Map<string, Row[]>([
		["test_events", [{ ...event }, ...support]],
	])
	const table = (name: string) => {
		if (!rows.has(name)) rows.set(name, [])
		return rows.get(name) as Row[]
	}
	const db = {
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
				async updateOne(query: Row, update: Row) {
					if (Object.keys(update).some((key) => key !== "$setOnInsert")) {
						throw new Error("Unexpected update operator")
					}
					if (table(name).some((row) => matches(row, query))) {
						return { upsertedCount: 0, matchedCount: 1, modifiedCount: 0 }
					}
					table(name).push({
						...(update.$setOnInsert as Row),
						_id: "offline-row",
					})
					return {
						upsertedCount: 1,
						upsertedId: "offline-row",
						matchedCount: 0,
					}
				},
				async insertOne(row: Row) {
					table(name).push(row)
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
	} as unknown as Db
	return { db, rows, table }
}

async function promote(
	f: ReturnType<typeof fixture>,
	fact = FACT,
	current = event,
) {
	const args = {
		db: f.db,
		prefix: "test_",
		event: current,
		prefetchedLlmFacts: [fact],
	}
	const resolved = await resolveStructuredCandidatesForPromotion(args)
	const prepared = await prepareDerivedMemoryPromotion(args)
	const result = await persistPreparedDerivedMemoryPromotion({
		...args,
		prepared,
		embeddingMode: "automated",
	})
	return { resolved, prepared, result }
}

describe("possessive fact grounding through actual promotion and persistence", () => {
	it("promotes a third-person possessive fact from repeated first-person evidence", async () => {
		const f = fixture()
		const { resolved, prepared, result } = await promote(f)
		expect(resolved).toHaveLength(1)
		expect(prepared.structuredCandidates).toHaveLength(1)
		expect(result.structuredCreated).toBe(1)
		const stored = f.table("test_structured_mem")[0]
		expect(stored.value).toBe(FACT)
		expect(stored.key).toBe("fact-a4987a5af5c6")
		expect(stored.source).toBe("user")
		expect(stored.sourceEventIds).toEqual(["a", "b"])
		expect(stored.reinforcementCount).toBe(2)
		expect(stored.provenance).toMatchObject({
			origin: "user_event",
			promotionTrigger: "repeated-evidence",
			supportingEventCount: 1,
			supportingEventIds: ["b"],
		})
	})
	it.each([
		["literal first person", BODY, BODY],
		["literal third person", FACT, FACT],
		["reverse possessive", BODY, FACT],
		["existing embedded literal", FACT, `Earlier evidence: ${FACT}`],
		[
			"existing case-insensitive remainder",
			FACT,
			"my pickup label is naru-617-qp.",
		],
		[
			"literal metacharacters",
			"The user's label is [A].*+?^$()|{B}\\C.",
			"My label is [A].*+?^$()|{B}\\C.",
		],
		[
			"exact negation",
			"The user's label is not NARU-617-QP.",
			"My label is not NARU-617-QP.",
		],
		[
			"exact date and quantity",
			"The user's pickup has 3 boxes on 2026-10-08.",
			"My pickup has 3 boxes on 2026-10-08.",
		],
	])("preserves %s", async (_name, fact, body) => {
		const f = fixture([
			{ ...event, eventId: "b", body, timestamp: new Date(1) },
		])
		const { result } = await promote(f, fact)
		expect(result.structuredCreated).toBe(1)
		expect(f.table("test_structured_mem")[0].value).toBe(fact)
	})

	it.each([
		["different value", FACT, "My pickup label is OTHER-617-QP."],
		[
			"value extension",
			"The user's pickup label is NARU-617-QP",
			"My pickup label is NARU-617-QP2",
		],
		["trailing denial", FACT, `${BODY} That statement is false.`],
		["extra predicate", FACT, `${BODY} My other label differs.`],
		["negated object", FACT, "My pickup label is not NARU-617-QP."],
		["negated prefix", FACT, "Not my pickup label is NARU-617-QP."],
		["named third party", FACT, "Alice's pickup label is NARU-617-QP."],
		["named speaker", FACT, `Alice says: ${BODY}`],
		["word suffix", FACT, "Amy pickup label is NARU-617-QP."],
		["quoted statement", FACT, `"${BODY}"`],
		["embedded new equivalent", FACT, `For example: ${BODY}`],
		["unrelated paraphrase", FACT, "My pickup identifier equals NARU-617-QP."],
		["context-prefixed candidate", `From pickup context: ${FACT}`, BODY],
		["curly possessive", "The user’s pickup label is NARU-617-QP.", BODY],
		[
			"different quantity",
			"The user's pickup has 3 boxes.",
			"My pickup has 4 boxes.",
		],
		[
			"different date",
			"The user's pickup is on 2026-10-08.",
			"My pickup is on 2026-10-09.",
		],
		[
			"regex wildcard substitution",
			"The user's label is A.*B.",
			"My label is AxxxB.",
		],
		[
			"regex alternation substitution",
			"The user's label is (A|B).",
			"My label is A.",
		],
	])("rejects %s", async (_name, fact, body) => {
		const f = fixture([
			{ ...event, eventId: "b", body, timestamp: new Date(1) },
		])
		const { resolved, prepared, result } = await promote(f, fact)
		expect(resolved).toEqual([])
		expect(prepared.structuredCandidates).toEqual([])
		expect(result.structuredCreated).toBe(0)
		expect(f.table("test_structured_mem")).toEqual([])
	})

	it.each([
		["different agent", { agentId: "other" }],
		["different scope", { scope: "session" }],
		["different scopeRef", { scopeRef: "other" }],
		["same event is not reinforcement", { eventId: "a" }],
		["expired evidence", { expiresAt: new Date(0) }],
		["invalidated evidence", { invalidAt: new Date(0) }],
		["future-valid evidence", { validAt: new Date("2099-01-01") }],
	])("rejects %s in the actual lifecycle/scope query", async (_name, patch) => {
		const f = fixture([
			{ ...event, eventId: "b", timestamp: new Date(1), ...patch },
		])
		const { resolved, result } = await promote(f)
		expect(resolved).toEqual([])
		expect(result.structuredCreated).toBe(0)
	})

	it("requires a second eligible event", async () => {
		const { resolved, result } = await promote(fixture([]))
		expect(resolved).toEqual([])
		expect(result.structuredCreated).toBe(0)
	})

	it("retains explicit null open validity windows", async () => {
		const f = fixture([
			{ ...event, eventId: "b", timestamp: new Date(1), invalidAt: null },
		])
		expect((await promote(f)).result.structuredCreated).toBe(1)
	})

	it.each([
		["body changed", { body: "My pickup label is DIFFERENT." }],
		["timestamp changed", { timestamp: new Date(2) }],
		["agent changed", { agentId: "other" }],
		["scope changed", { scope: "session" }],
		["scopeRef changed", { scopeRef: "other" }],
		["expired", { expiresAt: new Date(0) }],
		["invalidated", { invalidAt: new Date(0) }],
		["future-valid", { validAt: new Date("2099-01-01") }],
	])("refuses persistence when prepared evidence is %s", async (_name, patch) => {
		const f = fixture()
		const args = {
			db: f.db,
			prefix: "test_",
			event,
			prefetchedLlmFacts: [FACT],
		}
		const prepared = await prepareDerivedMemoryPromotion(args)
		expect(prepared.structuredCandidates).toHaveLength(1)
		Object.assign(f.table("test_events")[1], patch)
		const result = await persistPreparedDerivedMemoryPromotion({
			...args,
			prepared,
			embeddingMode: "automated",
		})
		expect(result.structuredCreated).toBe(0)
		expect(f.table("test_structured_mem")).toEqual([])
	})

	it("refuses persistence when prepared evidence was removed", async () => {
		const f = fixture()
		const args = {
			db: f.db,
			prefix: "test_",
			event,
			prefetchedLlmFacts: [FACT],
		}
		const prepared = await prepareDerivedMemoryPromotion(args)
		expect(prepared.structuredCandidates).toHaveLength(1)
		f.rows.set("test_events", [{ ...event }])
		const result = await persistPreparedDerivedMemoryPromotion({
			...args,
			prepared,
			embeddingMode: "automated",
		})
		expect(result.structuredCreated).toBe(0)
	})

	it("keeps the event receipt idempotent", async () => {
		const f = fixture()
		const args = {
			db: f.db,
			prefix: "test_",
			event,
			prefetchedLlmFacts: [FACT],
		}
		const prepared = await prepareDerivedMemoryPromotion(args)
		const params = { ...args, prepared, embeddingMode: "automated" as const }
		expect(
			(await persistPreparedDerivedMemoryPromotion(params)).structuredCreated,
		).toBe(1)
		expect(
			(await persistPreparedDerivedMemoryPromotion(params)).structuredCreated,
		).toBe(0)
		expect(f.table("test_structured_mem")).toHaveLength(1)
	})
})
