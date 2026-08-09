import {
	MongoServerError,
	type Collection,
	type Db,
	type Document,
} from "mongodb"
import { describe, expect, it, vi } from "vitest"
import {
	getProcedureHistoryByHandle,
	invalidateProcedureByHandle,
	recordProcedureOutcome,
	updateProcedureByHandle,
	writeProcedure,
} from "./mongodb-procedures.js"
import { MemoryLifecycleConflictError } from "./mongodb-structured-memory.js"
import type { MemoryProcedureStableHandle } from "./types.js"

const PREFIX = "test_"

function clone<T>(value: T): T {
	return structuredClone(value)
}

function matchesCondition(docValue: unknown, condition: unknown): boolean {
	if (
		condition !== null &&
		typeof condition === "object" &&
		!Array.isArray(condition) &&
		!(condition instanceof Date)
	) {
		const operators = condition as Record<string, unknown>
		if ("$exists" in operators) {
			return operators.$exists === false
				? docValue === undefined
				: docValue !== undefined
		}
	}
	return docValue === condition
}

function matchesFilter(doc: Document, filter: Document): boolean {
	return Object.entries(filter).every(([key, value]) =>
		matchesCondition(doc[key], value),
	)
}

type TransactionSession = {
	aborted: boolean
}

class StatefulCollection {
	docs: Document[]
	onBeforeUpdateOne?: (filter: Document, update: Document) => void
	deleteManyCalls: Document[] = []

	constructor(docs: Document[] = []) {
		this.docs = docs.map((doc) => clone(doc))
	}

	async findOne(filter: Document): Promise<Document | null> {
		const doc = this.docs.find((candidate) => matchesFilter(candidate, filter))
		return doc ? clone(doc) : null
	}

	async insertOne(
		doc: Document,
		options?: { session?: TransactionSession },
	): Promise<{ insertedId: string }> {
		if (
			doc._id !== undefined &&
			this.docs.some((existing) => existing._id === doc._id)
		) {
			if (options?.session) {
				options.session.aborted = true
			}
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
		options?: { upsert?: boolean; session?: TransactionSession },
	): Promise<{
		matchedCount: number
		modifiedCount: number
		upsertedCount: number
		upsertedId?: string
	}> {
		if (options?.session?.aborted) {
			throw new Error("transaction aborted by an earlier write error")
		}
		this.onBeforeUpdateOne?.(filter, update)
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
			this.docs.push(clone(inserted))
			return {
				matchedCount: 0,
				modifiedCount: 0,
				upsertedCount: 1,
				upsertedId: String(inserted._id ?? this.docs.length),
			}
		}
		if (update.$set) {
			Object.assign(this.docs[index], clone(update.$set))
		}
		return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
	}

	async findOneAndUpdate(
		filter: Document,
		update: Document,
		options?: { returnDocument?: "before" | "after" },
	): Promise<Document | null> {
		const index = this.docs.findIndex((doc) => matchesFilter(doc, filter))
		if (index === -1) {
			return null
		}
		const before = clone(this.docs[index])
		if (update.$inc) {
			for (const [key, amount] of Object.entries(update.$inc)) {
				this.docs[index][key] =
					Number(this.docs[index][key] ?? 0) + Number(amount)
			}
		}
		if (update.$set) {
			Object.assign(this.docs[index], clone(update.$set))
		}
		return options?.returnDocument === "after"
			? clone(this.docs[index])
			: before
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

	async deleteMany(filter: Document): Promise<{ deletedCount: number }> {
		this.deleteManyCalls.push(clone(filter))
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
		procedureId: "deploy",
		name: "Deploy safely",
		steps: ["Run tests", "Deploy"],
		searchText: "Deploy safely\nRun tests\nDeploy",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
		state: "active",
		revision: 1,
		validFrom: t0,
		createdAt: t0,
		updatedAt: t0,
		...overrides,
	}
}

function handleFor(
	overrides: Partial<MemoryProcedureStableHandle> = {},
): MemoryProcedureStableHandle {
	return {
		family: "procedure",
		id: "procedure:deploy",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent:agent-1",
		revision: 1,
		state: "active",
		procedure: { procedureId: "deploy" },
		...overrides,
	}
}

function createProcedureDb(
	procedures: StatefulCollection,
	revisions: StatefulCollection,
	mutations = new StatefulCollection(),
	queryCache = new StatefulCollection(),
): Db {
	return createDb({
		[`${PREFIX}procedures`]: procedures,
		[`${PREFIX}procedure_revisions`]: revisions,
		[`${PREFIX}memory_mutations`]: mutations,
		[`${PREFIX}query_cache`]: queryCache,
	})
}

describe("procedure lifecycle revision concurrency", () => {
	it("serializes two concurrent creates instead of overwriting revision one", async () => {
		const procedures = new StatefulCollection()
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)

		const outcomes = await Promise.all([
			writeProcedure({
				db,
				prefix: PREFIX,
				entry: {
					procedureId: "deploy",
					name: "Deploy safely",
					steps: ["Run tests", "Deploy canary"],
					agentId: "agent-1",
				},
				embeddingMode: "automated",
			}),
			writeProcedure({
				db,
				prefix: PREFIX,
				entry: {
					procedureId: "deploy",
					name: "Deploy safely",
					steps: ["Run tests", "Deploy globally"],
					agentId: "agent-1",
				},
				embeddingMode: "automated",
			}),
		])

		expect(outcomes.map((outcome) => outcome.upserted).toSorted()).toEqual([
			false,
			true,
		])
		expect(procedures.docs[0].revision).toBe(2)
		expect(revisions.docs.map((doc) => doc.revision)).toEqual([1])
		expect(
			[procedures.docs[0].steps[1], revisions.docs[0].steps[1]].toSorted(),
		).toEqual(["Deploy canary", "Deploy globally"])
	})

	it("does not collapse two concurrent revision writes into the same revision", async () => {
		const procedures = new StatefulCollection([baseDoc()])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)

		const [first, second] = await Promise.all([
			writeProcedure({
				db,
				prefix: PREFIX,
				entry: {
					procedureId: "deploy",
					name: "Deploy safely",
					steps: ["Run tests", "Deploy canary"],
					agentId: "agent-1",
				},
				embeddingMode: "automated",
			}),
			writeProcedure({
				db,
				prefix: PREFIX,
				entry: {
					procedureId: "deploy",
					name: "Deploy safely",
					steps: ["Run tests", "Deploy globally"],
					agentId: "agent-1",
				},
				embeddingMode: "automated",
			}),
		])

		expect(first.upserted).toBe(false)
		expect(second.upserted).toBe(false)
		expect(procedures.docs[0].revision).toBe(3)
		expect(revisions.docs.map((doc) => doc.revision).toSorted()).toEqual([1, 2])
		expect(new Set(revisions.docs.map((doc) => doc._id)).size).toBe(
			revisions.docs.length,
		)
	})

	it("retries a concurrent duplicate-key snapshot upsert and serializes the write", async () => {
		const procedures = new StatefulCollection([baseDoc()])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)
		let raced = false
		revisions.onBeforeUpdateOne = (_filter, update) => {
			if (raced || !update.$setOnInsert) {
				return
			}
			raced = true
			revisions.docs.push(
				clone({
					...baseDoc(),
					_id: "procedure:agent-1:agent:agent%3Aagent-1:deploy:r1",
				}),
			)
			Object.assign(procedures.docs[0], {
				steps: ["Run tests", "Deploy canary"],
				searchText: "Deploy safely\nRun tests\nDeploy canary",
				revision: 2,
			})
			throw Object.assign(new Error("E11000 duplicate snapshot key"), {
				code: 11000,
			})
		}

		const outcome = await writeProcedure({
			db,
			prefix: PREFIX,
			entry: {
				procedureId: "deploy",
				name: "Deploy safely",
				steps: ["Run tests", "Deploy globally"],
				agentId: "agent-1",
			},
			embeddingMode: "automated",
		})

		expect(outcome).toEqual({ upserted: false, id: "deploy" })
		expect(raced).toBe(true)
		expect(procedures.docs[0].revision).toBe(3)
		expect(procedures.docs[0].steps).toEqual(["Run tests", "Deploy globally"])
		expect(revisions.docs.map((doc) => doc.revision).toSorted()).toEqual([1, 2])
		expect(revisions.docs.find((doc) => doc.revision === 1)?.steps).toEqual([
			"Run tests",
			"Deploy",
		])
		expect(revisions.docs.find((doc) => doc.revision === 2)?.steps).toEqual([
			"Run tests",
			"Deploy canary",
		])
	})

	it("rejects an update carrying a stale handle revision", async () => {
		const procedures = new StatefulCollection([baseDoc({ revision: 2 })])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)

		await expect(
			updateProcedureByHandle({
				db,
				prefix: PREFIX,
				handle: handleFor({ revision: 1 }),
				patch: { steps: ["Skip tests", "Deploy"] },
				embeddingMode: "automated",
			}),
		).rejects.toThrow(MemoryLifecycleConflictError)

		expect(procedures.docs[0].steps).toEqual(["Run tests", "Deploy"])
		expect(procedures.docs[0].revision).toBe(2)
		expect(revisions.docs).toHaveLength(0)
	})

	it("updates a revisionless legacy procedure through its lifecycle handle", async () => {
		const legacy = baseDoc()
		delete legacy.revision
		const procedures = new StatefulCollection([legacy])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)

		const updated = await updateProcedureByHandle({
			db,
			prefix: PREFIX,
			handle: handleFor({ revision: 1 }),
			patch: { steps: ["Run tests", "Deploy canary"] },
			embeddingMode: "automated",
		})

		expect(updated?.handle.revision).toBe(2)
		expect(updated?.data.steps).toEqual(["Run tests", "Deploy canary"])
		expect(procedures.docs[0].revision).toBe(2)
		expect(revisions.docs.map((doc) => doc.revision)).toEqual([1])
	})

	it("keeps raced outcome metrics current but out of semantic revision history", async () => {
		const lastSuccessAt = new Date("2026-04-09T11:00:00.000Z")
		const lastFailureAt = new Date("2026-04-09T12:00:00.000Z")
		const originalSourceAgent = {
			id: "agent-1",
			name: "extractor",
			runId: "extract-run-1",
		}
		const procedures = new StatefulCollection([
			baseDoc({
				sourceAgent: originalSourceAgent,
				successCount: 4,
				failCount: 2,
				lastSuccessAt,
				lastFailureAt,
			}),
		])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)

		const semanticUpdate = updateProcedureByHandle({
			db,
			prefix: PREFIX,
			handle: handleFor(),
			patch: {
				sourceAgent: {
					id: "agent-1",
					name: "dreamer",
					runId: "dream-run-2",
				},
			},
			embeddingMode: "automated",
		})
		const outcomeUpdate = recordProcedureOutcome({
			db,
			prefix: PREFIX,
			procedureId: "deploy",
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent:agent-1",
			success: true,
		})
		const [updated, recorded] = await Promise.all([
			semanticUpdate,
			outcomeUpdate,
		])
		const history = await getProcedureHistoryByHandle({
			db,
			prefix: PREFIX,
			handle: updated?.handle ?? handleFor({ revision: 2 }),
		})

		expect(recorded).toBe(true)
		expect(updated?.handle.revision).toBe(2)
		expect(updated?.data.sourceAgent).toEqual({
			id: "agent-1",
			name: "dreamer",
			runId: "dream-run-2",
		})
		expect(updated?.data.successCount).toBe(5)
		expect(history).toHaveLength(2)
		expect(history[0]).toMatchObject({
			historyKind: "revision",
			handle: { revision: 1 },
			data: {
				sourceAgent: originalSourceAgent,
			},
		})
		expect(history[0].data).not.toHaveProperty("successCount")
		expect(history[0].data).not.toHaveProperty("failCount")
		expect(history[0].data).not.toHaveProperty("lastSuccessAt")
		expect(history[0].data).not.toHaveProperty("lastFailureAt")
		expect(history[1]).toMatchObject({
			historyKind: "current",
			handle: { revision: 2 },
			data: { successCount: 5, failCount: 2 },
		})
	})

	it("does not write, invalidate, or audit identical procedure content", async () => {
		const original = baseDoc()
		const procedures = new StatefulCollection([original])
		const revisions = new StatefulCollection()
		const mutations = new StatefulCollection()
		const queryCache = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions, mutations, queryCache)

		const result = await writeProcedure({
			db,
			prefix: PREFIX,
			entry: {
				procedureId: "deploy",
				name: "Deploy safely",
				steps: ["Run tests", "Deploy"],
				agentId: "agent-1",
			},
			embeddingMode: "automated",
		})
		await Promise.resolve()

		expect(result).toEqual({ upserted: false, id: "deploy" })
		expect(procedures.docs).toEqual([original])
		expect(revisions.docs).toEqual([])
		expect(queryCache.deleteManyCalls).toEqual([])
		expect(mutations.docs).toEqual([])
	})

	it("treats newly merged source attribution as a revisioned change", async () => {
		const procedures = new StatefulCollection([
			baseDoc({ sourceEventIds: ["evt-original"] }),
		])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)

		await writeProcedure({
			db,
			prefix: PREFIX,
			entry: {
				procedureId: "deploy",
				name: "Deploy safely",
				steps: ["Run tests", "Deploy"],
				agentId: "agent-1",
				sourceEventIds: ["evt-new"],
			},
			embeddingMode: "automated",
			eventReceiptIds: ["evt-new"],
		})

		expect(procedures.docs[0]).toMatchObject({
			revision: 2,
			sourceEventIds: ["evt-original", "evt-new"],
		})
		expect(revisions.docs.map((doc) => doc.revision)).toEqual([1])
	})

	it("keeps a preexisting revision snapshot immutable in a transaction", async () => {
		const procedures = new StatefulCollection([baseDoc()])
		const revisions = new StatefulCollection([
			{
				_id: "procedure:agent-1:agent:agent%3Aagent-1:deploy:r1",
				procedureId: "deploy",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent:agent-1",
				revision: 1,
				name: "Original immutable snapshot",
				steps: ["Run tests", "Deploy"],
			},
		])
		const db = createProcedureDb(procedures, revisions)
		const session = {
			aborted: false,
			withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
			endSession: vi.fn(async () => {}),
		}
		const client = {
			startSession: vi.fn(() => session),
		}

		const updated = await updateProcedureByHandle({
			db,
			prefix: PREFIX,
			handle: handleFor(),
			patch: { steps: ["Run tests", "Deploy canary"] },
			embeddingMode: "automated",
			client: client as unknown as import("mongodb").MongoClient,
		})

		expect(updated?.handle.revision).toBe(2)
		expect(procedures.docs[0].steps).toEqual(["Run tests", "Deploy canary"])
		expect(revisions.docs).toHaveLength(1)
		expect(revisions.docs[0].name).toBe("Original immutable snapshot")
		expect(session.aborted).toBe(false)
	})

	it("retries the complete transaction after an application CAS conflict", async () => {
		const procedures = new StatefulCollection([baseDoc({ version: 1 })])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)
		let raced = false
		procedures.onBeforeUpdateOne = (_filter, update) => {
			if (!raced && update.$set?.revision === 2) {
				raced = true
				Object.assign(procedures.docs[0], {
					steps: ["Run tests", "Deploy competitor"],
					searchText: "Deploy safely\nRun tests\nDeploy competitor",
					revision: 2,
				})
			}
		}
		const sessions: Array<{
			aborted: boolean
			withTransaction: ReturnType<typeof vi.fn>
			endSession: ReturnType<typeof vi.fn>
		}> = []
		const client = {
			startSession: vi.fn(() => {
				const session = {
					aborted: false,
					withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
					endSession: vi.fn(async () => {}),
				}
				sessions.push(session)
				return session
			}),
		}

		await writeProcedure({
			db,
			prefix: PREFIX,
			entry: {
				procedureId: "deploy",
				name: "Deploy safely",
				steps: ["Run tests", "Deploy canary"],
				agentId: "agent-1",
			},
			embeddingMode: "automated",
			client: client as unknown as import("mongodb").MongoClient,
		})

		expect(client.startSession).toHaveBeenCalledTimes(2)
		expect(
			sessions.every((session) => session.endSession.mock.calls.length === 1),
		).toBe(true)
		expect(procedures.docs[0]).toMatchObject({
			revision: 3,
			steps: ["Run tests", "Deploy canary"],
		})
		expect(revisions.docs.map((doc) => doc.revision)).toEqual([1, 2])
	})

	it("surfaces exhausted application CAS conflicts as non-driver errors", async () => {
		const procedures = new StatefulCollection([baseDoc()])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)
		procedures.onBeforeUpdateOne = (_filter, update) => {
			if (typeof update.$set?.revision === "number") {
				procedures.docs[0].revision = Number(update.$set.revision)
			}
		}

		let thrown: unknown
		try {
			await writeProcedure({
				db,
				prefix: PREFIX,
				entry: {
					procedureId: "deploy",
					name: "Deploy safely",
					steps: ["Run tests", "Deploy canary"],
					agentId: "agent-1",
				},
				embeddingMode: "automated",
			})
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(Error)
		expect(thrown).not.toBeInstanceOf(MongoServerError)
	})

	it("uses a fresh semantic timestamp after a CAS retry", async () => {
		vi.useFakeTimers()
		const initialNow = new Date("2026-04-09T12:00:00.000Z")
		const concurrentNow = new Date("2026-04-09T12:01:00.000Z")
		vi.setSystemTime(initialNow)
		try {
			const procedures = new StatefulCollection([baseDoc()])
			const revisions = new StatefulCollection()
			const db = createProcedureDb(procedures, revisions)
			let raced = false
			procedures.onBeforeUpdateOne = (_filter, update) => {
				if (!raced && update.$set?.revision === 2) {
					raced = true
					vi.setSystemTime(concurrentNow)
					Object.assign(procedures.docs[0], {
						steps: ["Run tests", "Deploy competitor"],
						searchText: "Deploy safely\nRun tests\nDeploy competitor",
						revision: 2,
						validFrom: concurrentNow,
						updatedAt: concurrentNow,
					})
				}
			}

			await writeProcedure({
				db,
				prefix: PREFIX,
				entry: {
					procedureId: "deploy",
					name: "Deploy safely",
					steps: ["Run tests", "Deploy canary"],
					agentId: "agent-1",
				},
				embeddingMode: "automated",
			})

			expect(procedures.docs[0].validFrom).toEqual(concurrentNow)
			expect(revisions.docs.find((doc) => doc.revision === 2)?.validTo).toEqual(
				concurrentNow,
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("uses a fresh invalidation timestamp after a CAS retry", async () => {
		vi.useFakeTimers()
		const initialNow = new Date("2026-04-09T12:00:00.000Z")
		const concurrentNow = new Date("2026-04-09T12:01:00.000Z")
		vi.setSystemTime(initialNow)
		try {
			const procedures = new StatefulCollection([baseDoc()])
			const revisions = new StatefulCollection()
			const db = createProcedureDb(procedures, revisions)
			let raced = false
			procedures.onBeforeUpdateOne = (_filter, update) => {
				if (!raced && update.$set?.state === "invalidated") {
					raced = true
					vi.setSystemTime(concurrentNow)
					Object.assign(procedures.docs[0], {
						revision: 2,
						validFrom: concurrentNow,
						updatedAt: concurrentNow,
					})
				}
			}

			await invalidateProcedureByHandle({
				db,
				prefix: PREFIX,
				handle: handleFor({ revision: 0 }),
				invalidatedBy: { reason: "user-delete" },
			})

			expect(procedures.docs[0]).toMatchObject({
				state: "invalidated",
				revision: 3,
				validTo: concurrentNow,
				updatedAt: concurrentNow,
			})
			expect(revisions.docs.find((doc) => doc.revision === 2)?.validTo).toEqual(
				concurrentNow,
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("rejects invalidation from a stale handle revision", async () => {
		const procedures = new StatefulCollection([baseDoc({ revision: 2 })])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)

		await expect(
			invalidateProcedureByHandle({
				db,
				prefix: PREFIX,
				handle: handleFor({ revision: 1 }),
				invalidatedBy: { reason: "user-delete" },
			}),
		).rejects.toThrow(MemoryLifecycleConflictError)

		expect(procedures.docs[0].state).toBe("active")
		expect(procedures.docs[0].revision).toBe(2)
		expect(revisions.docs).toHaveLength(0)
	})

	it("does not let invalidation overwrite a concurrent revision", async () => {
		const procedures = new StatefulCollection([baseDoc()])
		const revisions = new StatefulCollection()
		const db = createProcedureDb(procedures, revisions)
		let raced = false
		procedures.onBeforeUpdateOne = (_filter, update) => {
			if (!raced && update.$set?.state === "invalidated") {
				raced = true
				Object.assign(procedures.docs[0], {
					steps: ["Run tests", "Deploy canary"],
					revision: 2,
				})
			}
		}

		await expect(
			invalidateProcedureByHandle({
				db,
				prefix: PREFIX,
				handle: handleFor({ revision: 1 }),
				invalidatedBy: { reason: "user-delete" },
			}),
		).rejects.toThrow(MemoryLifecycleConflictError)

		expect(procedures.docs[0].state).toBe("active")
		expect(procedures.docs[0].steps).toEqual(["Run tests", "Deploy canary"])
		expect(procedures.docs[0].revision).toBe(2)
	})
})
