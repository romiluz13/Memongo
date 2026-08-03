import type { Collection, Db, Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import {
	MemoryLifecycleConflictError,
	invalidateStructuredMemoryByHandle,
	updateStructuredMemoryByHandle,
	writeStructuredMemory,
} from "./mongodb-structured-memory.js"
import type { MemoryStructuredStableHandle } from "./types.js"

const PREFIX = "test_"

function clone<T>(value: T): T {
	return structuredClone(value)
}

function matchesFilter(doc: Document, filter: Document): boolean {
	return Object.entries(filter).every(([key, value]) => doc[key] === value)
}

function isDuplicateKeyError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === 11000
	)
}

/**
 * Stateful fake emulating MongoDB findOne/updateOne/insertOne filter
 * semantics — including atomic compare-and-swap behavior: an updateOne whose
 * filter does not match the CURRENT document state matches nothing, which is
 * exactly the guarantee the revision CAS relies on.
 */
class StatefulCollection {
	docs: Document[]
	/** Optional script for findOne: return a custom doc for the Nth call. */
	onFindOne?: (call: number, filter: Document) => Document | null | undefined
	private findOneCallCount = 0

	constructor(docs: Document[] = []) {
		this.docs = docs.map((doc) => clone(doc))
	}

	async findOne(filter: Document): Promise<Document | null> {
		this.findOneCallCount += 1
		if (this.onFindOne) {
			const scripted = this.onFindOne(this.findOneCallCount, filter)
			if (scripted !== undefined) {
				return scripted ? clone(scripted) : null
			}
		}
		const doc = this.docs.find((candidate) => matchesFilter(candidate, filter))
		return doc ? clone(doc) : null
	}

	async insertOne(doc: Document): Promise<{ insertedId: string }> {
		if (
			doc._id !== undefined &&
			this.docs.some((existing) => existing._id === doc._id)
		) {
			throw Object.assign(
				new Error(`E11000 duplicate key error: _id ${String(doc._id)}`),
				{ code: 11000 },
			)
		}
		this.docs.push(clone(doc))
		return { insertedId: String(doc._id ?? this.docs.length) }
	}

	async updateOne(
		filter: Document,
		update: Document,
		options?: { upsert?: boolean },
	): Promise<{
		matchedCount: number
		modifiedCount: number
		upsertedCount: number
		upsertedId?: string
	}> {
		const index = this.docs.findIndex((doc) => matchesFilter(doc, filter))
		if (index === -1) {
			if (!options?.upsert) {
				return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
			}
			const inserted: Document = {
				...Object.fromEntries(
					Object.entries(filter).filter(([, value]) =>
						["string", "number", "boolean"].includes(typeof value),
					),
				),
				...(update.$setOnInsert ?? {}),
				...(update.$set ?? {}),
			}
			// Emulate the unique identity index uq_structured_agent_scope_scoperef_type_key.
			if (
				this.docs.some(
					(doc) =>
						doc.agentId === inserted.agentId &&
						doc.scope === inserted.scope &&
						doc.scopeRef === inserted.scopeRef &&
						doc.type === inserted.type &&
						doc.key === inserted.key,
				)
			) {
				throw Object.assign(
					new Error("E11000 duplicate key error: uq_structured identity"),
					{ code: 11000 },
				)
			}
			if (update.$inc) {
				for (const [key, amount] of Object.entries(update.$inc)) {
					inserted[key] = Number(inserted[key] ?? 0) + Number(amount)
				}
			}
			this.docs.push(clone(inserted))
			return {
				matchedCount: 0,
				modifiedCount: 0,
				upsertedCount: 1,
				upsertedId: String(inserted._id ?? this.docs.length),
			}
		}
		const current = this.docs[index]
		if (update.$set) {
			Object.assign(current, clone(update.$set))
		}
		if (update.$inc) {
			for (const [key, amount] of Object.entries(update.$inc)) {
				current[key] = Number(current[key] ?? 0) + Number(amount)
			}
		}
		if (update.$unset) {
			for (const key of Object.keys(update.$unset)) {
				delete current[key]
			}
		}
		return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
	}

	async findOneAndUpdate(
		filter: Document,
		update: Document,
		options?: { returnDocument?: "before" | "after" },
	): Promise<Document | null> {
		const existing = await this.findOne(filter)
		if (!existing) {
			return null
		}
		await this.updateOne(filter, update)
		if (options?.returnDocument === "after") {
			return this.findOne(filter)
		}
		return existing
	}

	find(filter: Document, options?: { sort?: Document; limit?: number }) {
		let results = this.docs
			.filter((doc) => matchesFilter(doc, filter))
			.map((doc) => clone(doc))
		if (typeof options?.sort?.revision === "number") {
			const direction = Number(options.sort.revision)
			results = results.toSorted(
				(a, b) =>
					(Number(a.revision ?? 0) - Number(b.revision ?? 0)) * direction,
			)
		}
		if (typeof options?.limit === "number") {
			results = results.slice(0, options.limit)
		}
		return { toArray: vi.fn().mockResolvedValue(results) }
	}

	async deleteMany(): Promise<{ deletedCount: number }> {
		return { deletedCount: 0 }
	}
}

function createDb(collections: Record<string, StatefulCollection>): Db {
	return {
		collection: vi.fn((name: string) => {
			const collection = collections[name] ?? new StatefulCollection()
			collections[name] = collection
			return collection as unknown as Collection
		}),
	} as unknown as Db
}

function baseDoc(overrides: Document = {}): Document {
	const t0 = new Date("2026-04-09T10:00:00.000Z")
	return {
		type: "decision",
		key: "db",
		value: "Use Postgres",
		agentId: "agent-1",
		scope: "agent",
		// P2.3 canonical scope identity: an agent-scope write without an
		// explicit scopeRef resolves to `agent:<agentId>`.
		scopeRef: "agent:agent-1",
		state: "active",
		revision: 1,
		reinforcementCount: 1,
		sourceEventIds: ["evt-0"],
		validFrom: t0,
		createdAt: t0,
		updatedAt: t0,
		...overrides,
	}
}

function baseEntry(value: string, overrides: Document = {}) {
	return {
		type: "decision" as const,
		key: "db",
		value,
		agentId: "agent-1",
		...overrides,
	}
}

function handleFor(
	doc: { type: string; key: string },
	overrides: Partial<MemoryStructuredStableHandle> = {},
): MemoryStructuredStableHandle {
	return {
		family: "structured",
		id: `structured:${doc.type}:${doc.key}`,
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
		revision: 1,
		state: "active",
		structured: { type: doc.type, key: doc.key },
		...overrides,
	}
}

function createStructuredDb(
	structured: StatefulCollection,
	revisions: StatefulCollection,
): Db {
	return createDb({
		[`${PREFIX}structured_mem`]: structured,
		[`${PREFIX}structured_mem_revisions`]: revisions,
		[`${PREFIX}memory_mutations`]: new StatefulCollection(),
		[`${PREFIX}query_cache`]: new StatefulCollection(),
	})
}

describe("P2.5(a) writeStructuredMemory revision CAS", () => {
	it("two concurrent writers on one identity cannot both claim revision N+1", async () => {
		const structured = new StatefulCollection([baseDoc()])
		const revisions = new StatefulCollection()
		const db = createStructuredDb(structured, revisions)

		const [first, second] = await Promise.all([
			writeStructuredMemory({
				db,
				prefix: PREFIX,
				entry: baseEntry("Use MongoDB"),
				embeddingMode: "automated",
			}),
			writeStructuredMemory({
				db,
				prefix: PREFIX,
				entry: baseEntry("Use Atlas"),
				embeddingMode: "automated",
			}),
		])

		expect(first.upserted).toBe(false)
		expect(second.upserted).toBe(false)
		const finalDoc = structured.docs[0]
		// Exactly one writer lands revision 2; the loser must re-read and land
		// revision 3 instead of blindly overwriting with its own stale N+1.
		expect(finalDoc.revision).toBe(3)
		expect(revisions.docs.map((doc) => doc.revision).toSorted()).toEqual([1, 2])
		// History must record both superseded states exactly once.
		expect(new Set(revisions.docs.map((doc) => doc._id)).size).toBe(
			revisions.docs.length,
		)
	})

	it("a concurrent re-run carrying the same event receipt applies no side effect twice", async () => {
		const structured = new StatefulCollection([baseDoc()])
		const revisions = new StatefulCollection()
		const db = createStructuredDb(structured, revisions)

		const [first, second] = await Promise.all([
			writeStructuredMemory({
				db,
				prefix: PREFIX,
				entry: baseEntry("Use Postgres", { sourceEventIds: ["evt-1"] }),
				embeddingMode: "automated",
				eventReceiptIds: ["evt-1"],
			}),
			writeStructuredMemory({
				db,
				prefix: PREFIX,
				entry: baseEntry("Use Postgres", { sourceEventIds: ["evt-1"] }),
				embeddingMode: "automated",
				eventReceiptIds: ["evt-1"],
			}),
		])

		const outcomes = [first, second]
		// One writer applies; the re-run short-circuits on the receipt.
		expect(outcomes).toContainEqual({ upserted: false, id: "db" })
		const finalDoc = structured.docs[0]
		expect(finalDoc.revision).toBe(2)
		// The same-value re-mention must not $inc reinforcementCount twice and
		// must not duplicate the revision snapshot.
		expect(finalDoc.reinforcementCount).toBe(1)
		expect(revisions.docs).toHaveLength(1)
		expect(finalDoc.sourceEventIds).toEqual(["evt-0", "evt-1"])
	})
})

describe("P2.5(d) updateStructuredMemoryByHandle expected revision", () => {
	it("rejects an update carrying a stale handle revision", async () => {
		const structured = new StatefulCollection([baseDoc({ revision: 2 })])
		const revisions = new StatefulCollection()
		const db = createStructuredDb(structured, revisions)

		await expect(
			updateStructuredMemoryByHandle({
				db,
				prefix: PREFIX,
				handle: handleFor({ type: "decision", key: "db" }, { revision: 1 }),
				patch: { value: "Use MongoDB" },
				embeddingMode: "automated",
			}),
		).rejects.toThrow(MemoryLifecycleConflictError)

		// The stale handle must not silently overwrite the newer revision.
		expect(structured.docs[0].value).toBe("Use Postgres")
		expect(structured.docs[0].revision).toBe(2)
		expect(revisions.docs).toHaveLength(0)
	})

	it("rejects when a concurrent writer bumps the revision between the by-handle read and the write", async () => {
		const staleDoc = baseDoc({ revision: 2, value: "Use Postgres" })
		const bumpedDoc = baseDoc({
			revision: 3,
			value: "Use MongoDB",
			updatedAt: new Date("2026-04-10T10:00:00.000Z"),
		})
		const structured = new StatefulCollection([bumpedDoc])
		// First read (by-handle) sees revision 2; every later read sees the
		// concurrent winner's revision 3.
		let findOneCalls = 0
		structured.onFindOne = () => {
			findOneCalls += 1
			return findOneCalls === 1 ? staleDoc : bumpedDoc
		}
		const revisions = new StatefulCollection()
		const db = createStructuredDb(structured, revisions)

		await expect(
			updateStructuredMemoryByHandle({
				db,
				prefix: PREFIX,
				handle: handleFor({ type: "decision", key: "db" }, { revision: 2 }),
				patch: { value: "Use Something Else" },
				embeddingMode: "automated",
			}),
		).rejects.toThrow(MemoryLifecycleConflictError)

		expect(structured.docs[0].value).toBe("Use MongoDB")
		expect(structured.docs[0].revision).toBe(3)
	})
})

describe("P2.5(f) lifecycle handles enforce state and revision", () => {
	it("rejects an update on an invalidated record instead of resurrecting it", async () => {
		const structured = new StatefulCollection([
			baseDoc({ state: "invalidated", revision: 2 }),
		])
		const revisions = new StatefulCollection()
		const db = createStructuredDb(structured, revisions)

		await expect(
			updateStructuredMemoryByHandle({
				db,
				prefix: PREFIX,
				handle: handleFor(
					{ type: "decision", key: "db" },
					{ revision: 2, state: "invalidated" },
				),
				patch: { value: "Use MongoDB" },
				embeddingMode: "automated",
			}),
		).rejects.toThrow(MemoryLifecycleConflictError)

		// Not applied: the invalidated record keeps its state and value.
		expect(structured.docs[0].state).toBe("invalidated")
		expect(structured.docs[0].value).toBe("Use Postgres")
		expect(revisions.docs).toHaveLength(0)
	})

	it("rejects invalidation from a stale handle revision", async () => {
		const structured = new StatefulCollection([baseDoc({ revision: 2 })])
		const revisions = new StatefulCollection()
		const db = createStructuredDb(structured, revisions)

		await expect(
			invalidateStructuredMemoryByHandle({
				db,
				prefix: PREFIX,
				handle: handleFor({ type: "decision", key: "db" }, { revision: 1 }),
				invalidatedBy: { reason: "user-delete" },
			}),
		).rejects.toThrow(MemoryLifecycleConflictError)

		expect(structured.docs[0].state).toBe("active")
		expect(structured.docs[0].revision).toBe(2)
	})

	it("keeps invalidation working for internal callers that carry no revision (revision 0)", async () => {
		const structured = new StatefulCollection([baseDoc({ revision: 2 })])
		const revisions = new StatefulCollection()
		const db = createStructuredDb(structured, revisions)

		const result = await invalidateStructuredMemoryByHandle({
			db,
			prefix: PREFIX,
			handle: handleFor({ type: "decision", key: "db" }, { revision: 0 }),
			invalidatedBy: { reason: "contradiction" },
		})

		expect(result?.handle.state).toBe("invalidated")
		expect(structured.docs[0].state).toBe("invalidated")
		expect(structured.docs[0].revision).toBe(3)
	})
})

// Re-exported for type-check visibility of the duplicate-key helper used above.
void isDuplicateKeyError
