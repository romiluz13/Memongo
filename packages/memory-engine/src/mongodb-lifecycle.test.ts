import type { Collection, Db, Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"
import {
	getProcedureHistoryByHandle,
	invalidateProcedureByHandle,
	reportProcedureOutcomeByHandle,
	updateProcedureByHandle,
} from "./mongodb-procedures.js"
import {
	applyStructuredMemoryFeedbackByHandle,
	getStructuredMemoryHistoryByHandle,
	invalidateStructuredMemoryByHandle,
	updateStructuredMemoryByHandle,
} from "./mongodb-structured-memory.js"
import type {
	MemoryProcedureStableHandle,
	MemoryStructuredStableHandle,
} from "./types.js"

const PREFIX = "test_"

function clone<T>(value: T): T {
	return structuredClone(value)
}

function matchesFilter(doc: Document, filter: Document): boolean {
	return Object.entries(filter).every(([key, value]) => doc[key] === value)
}

class MemoryCollection {
	docs: Document[]

	constructor(docs: Document[] = []) {
		this.docs = docs.map((doc) => clone(doc))
	}

	async findOne(filter: Document): Promise<Document | null> {
		const doc = this.docs.find((candidate) => matchesFilter(candidate, filter))
		return doc ? clone(doc) : null
	}

	async insertOne(doc: Document): Promise<{ insertedId: string }> {
		this.docs.push(clone(doc))
		return { insertedId: String(doc._id ?? this.docs.length) }
	}

	async updateOne(
		filter: Document,
		update: Document,
		options?: { upsert?: boolean },
	): Promise<{
		matchedCount: number
		upsertedCount: number
		upsertedId?: string
	}> {
		const index = this.docs.findIndex((doc) => matchesFilter(doc, filter))
		if (index === -1) {
			if (!options?.upsert) {
				return { matchedCount: 0, upsertedCount: 0 }
			}
			const inserted = {
				...filter,
				...(update.$setOnInsert ?? {}),
				...(update.$set ?? {}),
			}
			if (update.$inc) {
				for (const [key, amount] of Object.entries(update.$inc)) {
					inserted[key] = Number(inserted[key] ?? 0) + Number(amount)
				}
			}
			this.docs.push(clone(inserted))
			return {
				matchedCount: 0,
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
		return { matchedCount: 1, upsertedCount: 0 }
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
		if (options?.sort?.revision === 1 || options?.sort?.revision === -1) {
			const direction = Number(options.sort.revision)
			results = results.toSorted(
				(a, b) =>
					(Number(a.revision ?? 0) - Number(b.revision ?? 0)) * direction,
			)
		}
		if (typeof options?.limit === "number") {
			results = results.slice(0, options.limit)
		}
		return {
			toArray: vi.fn().mockResolvedValue(results),
		}
	}
}

function createDb(collections: Record<string, MemoryCollection>): Db {
	return {
		collection: vi.fn((name: string) => {
			const collection = collections[name] ?? new MemoryCollection()
			collections[name] = collection
			return collection as unknown as Collection
		}),
	} as unknown as Db
}

function structuredHandle(): MemoryStructuredStableHandle {
	return {
		family: "structured",
		id: "structured:decision:db",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent-1",
		revision: 1,
		state: "active",
		structured: { type: "decision", key: "db" },
	}
}

function procedureHandle(): MemoryProcedureStableHandle {
	return {
		family: "procedure",
		id: "procedure:proc-1",
		agentId: "agent-1",
		scope: "agent",
		scopeRef: "agent-1",
		revision: 1,
		state: "active",
		procedure: { procedureId: "proc-1" },
	}
}

describe("lifecycle ergonomics", () => {
	it("updates structured memory through the existing revision path", async () => {
		const now = new Date("2026-04-10T10:00:00.000Z")
		const structured = new MemoryCollection([
			{
				type: "decision",
				key: "db",
				value: "Use MongoDB",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent-1",
				state: "active",
				revision: 1,
				validFrom: now,
				updatedAt: now,
				sourceEventIds: ["evt-1"],
			},
		])
		const revisions = new MemoryCollection()
		const db = createDb({
			test_structured_mem: structured,
			test_structured_mem_revisions: revisions,
			test_memory_mutations: new MemoryCollection(),
		})

		const updated = await updateStructuredMemoryByHandle({
			db,
			prefix: PREFIX,
			handle: structuredHandle(),
			patch: { value: "Use MongoDB Atlas Local" },
			embeddingMode: "automated",
		})

		expect(updated?.handle.revision).toBe(2)
		expect(updated?.data.value).toBe("Use MongoDB Atlas Local")
		expect(updated?.data.sourceEventIds).toEqual(["evt-1"])
		expect(revisions.docs).toHaveLength(1)
		expect(revisions.docs[0].revision).toBe(1)
		expect(revisions.docs[0].value).toBe("Use MongoDB")
	})

	it("invalidates structured memory without hard-deleting history", async () => {
		const structured = new MemoryCollection([
			{
				type: "fact",
				key: "launch",
				value: "Launch is Monday",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent-1",
				state: "active",
				revision: 1,
				validFrom: new Date("2026-04-09T10:00:00.000Z"),
				updatedAt: new Date("2026-04-09T10:00:00.000Z"),
			},
		])
		const revisions = new MemoryCollection()
		const mutations = new MemoryCollection()
		const db = createDb({
			test_structured_mem: structured,
			test_structured_mem_revisions: revisions,
			test_memory_mutations: mutations,
		})
		const handle: MemoryStructuredStableHandle = {
			...structuredHandle(),
			id: "structured:fact:launch",
			structured: { type: "fact", key: "launch" },
		}

		const invalidated = await invalidateStructuredMemoryByHandle({
			db,
			prefix: PREFIX,
			handle,
			invalidatedBy: { reason: "user-delete" },
		})
		await vi.waitFor(() => expect(mutations.docs).toHaveLength(1))

		expect(invalidated?.handle.state).toBe("invalidated")
		expect(invalidated?.handle.revision).toBe(2)
		expect(revisions.docs).toHaveLength(1)
		expect(structured.docs).toHaveLength(1)
		expect(mutations.docs[0].operation).toBe("invalidate")

		const history = await getStructuredMemoryHistoryByHandle({
			db,
			prefix: PREFIX,
			handle,
		})
		expect(history.map((entry) => entry.historyKind)).toEqual([
			"revision",
			"current",
		])
		expect(history.at(-1)?.handle.state).toBe("invalidated")
	})

	it("updates and invalidates procedures through revision history", async () => {
		const procedures = new MemoryCollection([
			{
				procedureId: "proc-1",
				name: "Deploy",
				steps: ["Build", "Ship"],
				searchText: "Deploy\nBuild\nShip",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent-1",
				state: "active",
				revision: 1,
				validFrom: new Date("2026-04-09T10:00:00.000Z"),
				updatedAt: new Date("2026-04-09T10:00:00.000Z"),
			},
		])
		const revisions = new MemoryCollection()
		const mutations = new MemoryCollection()
		const db = createDb({
			test_procedures: procedures,
			test_procedure_revisions: revisions,
			test_memory_mutations: mutations,
		})

		const updated = await updateProcedureByHandle({
			db,
			prefix: PREFIX,
			handle: procedureHandle(),
			patch: { steps: ["Build", "Test", "Ship"] },
			embeddingMode: "automated",
		})

		expect(updated?.handle.revision).toBe(2)
		expect(updated?.data.steps).toEqual(["Build", "Test", "Ship"])
		expect(revisions.docs).toHaveLength(1)

		const invalidated = await invalidateProcedureByHandle({
			db,
			prefix: PREFIX,
			handle: { ...procedureHandle(), revision: 2 },
			invalidatedBy: { reason: "obsolete" },
		})
		await vi.waitFor(() => expect(mutations.docs).toHaveLength(2))

		expect(invalidated?.handle.state).toBe("invalidated")
		expect(invalidated?.handle.revision).toBe(3)
		expect(procedures.docs).toHaveLength(1)
		expect(revisions.docs).toHaveLength(2)
		expect(mutations.docs.map((doc) => doc.operation)).toEqual([
			"update",
			"invalidate",
		])

		const history = await getProcedureHistoryByHandle({
			db,
			prefix: PREFIX,
			handle: procedureHandle(),
		})
		expect(history.map((entry) => entry.handle.revision)).toEqual([1, 2, 3])
		expect(history.at(-1)?.handle.state).toBe("invalidated")
	})

	it("reinforces structured memory through feedback without bypassing lifecycle state", async () => {
		const structured = new MemoryCollection([
			{
				type: "fact",
				key: "launch",
				value: "Launch is Monday",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent-1",
				state: "active",
				revision: 1,
				reinforcementCount: 2,
				validFrom: new Date("2026-04-09T10:00:00.000Z"),
				updatedAt: new Date("2026-04-09T10:00:00.000Z"),
			},
		])
		const mutations = new MemoryCollection()
		const db = createDb({
			test_structured_mem: structured,
			test_memory_mutations: mutations,
		})
		const handle: MemoryStructuredStableHandle = {
			...structuredHandle(),
			id: "structured:fact:launch",
			structured: { type: "fact", key: "launch" },
		}

		const updated = await applyStructuredMemoryFeedbackByHandle({
			db,
			prefix: PREFIX,
			handle,
			signal: "confirm",
			note: "Still true after retesting",
			embeddingMode: "automated",
			actorRole: "user",
		})
		await vi.waitFor(() => expect(mutations.docs).toHaveLength(1))

		expect(updated?.data.reinforcementCount).toBe(3)
		expect(updated?.data.lastConfirmedAt).toBeInstanceOf(Date)
		expect(updated?.handle.revision).toBe(1)
		expect(mutations.docs[0].meta).toEqual({
			source: "memory-feedback",
			signal: "confirm",
			note: "Still true after retesting",
		})
	})

	it("records procedure outcomes with provenance on the current procedure handle", async () => {
		const procedures = new MemoryCollection([
			{
				procedureId: "deploy",
				name: "Deploy",
				steps: ["Build", "Ship"],
				searchText: "Deploy\nBuild\nShip",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent-1",
				state: "active",
				revision: 2,
				successCount: 1,
				failCount: 0,
				validFrom: new Date("2026-04-09T10:00:00.000Z"),
				updatedAt: new Date("2026-04-09T10:00:00.000Z"),
			},
		])
		const mutations = new MemoryCollection()
		const db = createDb({
			test_procedures: procedures,
			test_memory_mutations: mutations,
		})
		const handle: MemoryProcedureStableHandle = {
			...procedureHandle(),
			id: "procedure:agent-1:agent:agent-1:deploy",
			procedure: { procedureId: "deploy" },
			revision: 2,
		}

		const updated = await reportProcedureOutcomeByHandle({
			db,
			prefix: PREFIX,
			handle,
			success: true,
			note: "Deployment completed cleanly",
			actorRole: "assistant",
		})
		await vi.waitFor(() => expect(mutations.docs).toHaveLength(1))

		expect(updated?.data.successCount).toBe(2)
		expect(updated?.data.failCount).toBe(0)
		expect(updated?.data.lastSuccessAt).toBeInstanceOf(Date)
		expect(updated?.handle.revision).toBe(2)
		expect(mutations.docs[0].meta).toEqual({
			source: "procedure-outcome",
			success: true,
			note: "Deployment completed cleanly",
		})
	})

	it("manager lifecycle dispatch reads by stable handle", async () => {
		const structured = new MemoryCollection([
			{
				type: "preference",
				key: "editor",
				value: "Use Vim",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent-1",
				state: "active",
				revision: 1,
				validFrom: new Date("2026-04-09T10:00:00.000Z"),
				updatedAt: new Date("2026-04-09T10:00:00.000Z"),
			},
		])
		const db = createDb({ test_structured_mem: structured })
		const manager = {
			db,
			prefix: PREFIX,
		} as unknown as MongoDBMemoryManager
		const handle: MemoryStructuredStableHandle = {
			...structuredHandle(),
			id: "structured:preference:editor",
			structured: { type: "preference", key: "editor" },
		}

		const item = await MongoDBMemoryManager.prototype.getLifecycleItem.call(
			manager,
			handle,
		)

		expect(item).toEqual(
			expect.objectContaining({
				family: "structured",
				data: expect.objectContaining({ value: "Use Vim" }),
			}),
		)
	})
})
