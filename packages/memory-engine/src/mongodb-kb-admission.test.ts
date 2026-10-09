// KB admission fencing and settlement behavior.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Db } from "mongodb"
import { chunkMarkdown, hashText } from "./internal.js"
import { ingestFilesToKB, ingestToKB } from "./mongodb-kb.js"
import type { KBDocument } from "./mongodb-kb.js"
import { ErasureGateConflictError } from "./mongodb-erasure-epoch.js"
import type { AdmissionToken } from "./mongodb-erasure-epoch.js"

const SCOPE = { agentId: "test-agent", scope: "agent" } as const
const SCOPE_REF = "agent:test-agent"
const ADMISSION: AdmissionToken = {
	kind: "admission",
	agentId: "test-agent",
	epoch: 0,
}
const mockDb = { databaseName: "test" } as Db

const h = vi.hoisted(() => {
	type AnyDoc = Record<string, unknown>
	type Rec = {
		method: string
		filter: AnyDoc | null
		session: unknown
		args: unknown[]
	}
	// The unique chunk-identity index columns (kb.ts chunk upsert filter).
	const identityKeys = ["scopeRef", "path", "startLine", "endLine", "ordinal"]

	const state = {
		kbDocs: [] as AnyDoc[],
		chunkDocs: [] as AnyDoc[],
		kbCalls: [] as Rec[],
		chunkCalls: [] as Rec[],
		fence: {
			calls: [] as Array<{ db: unknown; prefix: unknown; token: unknown }>,
			sessions: [] as AnyDoc[],
			inFn: false,
			fnInvocations: 0,
			// Knobs.
			invokeCount: 1,
			retryFirstOnly: true,
			conflictError: null as unknown,
		},
		spend: {
			void: [] as unknown[][],
			inSession: [] as Array<Record<string, unknown>>,
			// Knobs.
			holdLedger: false,
			ledgerReleased: null as Promise<void> | null,
			releaseLedger: () => {},
			rejectInSession: false,
		},
		invalidate: [] as Array<Record<string, unknown>>,
		fsx: { calls: [] as string[] },
		chunking: { zeroChunks: false },
		knobs: {
			kbInsertDuplicate: false,
			kbVanishInFence: false,
			kbDeleteOneCount: undefined as number | undefined,
			kbUpdateOneMatched: undefined as number | undefined,
			chunksBulkError: null as unknown,
		},
	}

	const getDotted = (doc: AnyDoc, key: string): unknown =>
		key.split(".").reduce<unknown>((acc, part) => {
			if (acc && typeof acc === "object") {
				return (acc as AnyDoc)[part]
			}
			return undefined
		}, doc)

	// Faithful logical-predicate matching: dotted paths, $or, $ne, $in,
	// $exists and RegExp conditions (needed for the $or foreign-child
	// guards in §4.2 — a plain equality matcher cannot see them).
	const matchesFilter = (doc: AnyDoc, filter: AnyDoc): boolean =>
		Object.entries(filter).every(([key, cond]) => {
			if (key === "$or") {
				return (cond as AnyDoc[]).some((sub) => matchesFilter(doc, sub))
			}
			const value = getDotted(doc, key)
			if (
				cond !== null &&
				typeof cond === "object" &&
				!Array.isArray(cond) &&
				Object.keys(cond).length > 0 &&
				Object.keys(cond).every((op) => op.startsWith("$"))
			) {
				const ops = cond as AnyDoc
				if ("$ne" in ops && value === ops.$ne) {
					return false
				}
				if ("$in" in ops) {
					const list = ops.$in as unknown[]
					if (!Array.isArray(list) || !list.includes(value)) {
						return false
					}
				}
				if ("$exists" in ops) {
					const exists = value !== undefined
					if (ops.$exists ? !exists : exists) {
						return false
					}
				}
				return true
			}
			if (cond instanceof RegExp) {
				return cond.test(String(value))
			}
			return value === cond
		})

	const sessionOf = (options?: { session?: unknown }): unknown =>
		options?.session ?? null

	const kbFake = {
		findOne: async (filter: AnyDoc, options?: { session?: unknown }) => {
			state.kbCalls.push({
				method: "findOne",
				filter,
				session: sessionOf(options),
				args: [filter, options],
			})
			// Knob: an in-fence (session-bound) revalidation read finds the
			// parent GONE while the pre-fence plan still saw it.
			if (options?.session !== undefined && state.knobs.kbVanishInFence) {
				return null
			}
			return state.kbDocs.find((doc) => matchesFilter(doc, filter)) ?? null
		},
		insertOne: async (doc: AnyDoc, options?: { session?: unknown }) => {
			state.kbCalls.push({
				method: "insertOne",
				filter: null,
				session: sessionOf(options),
				args: [doc, options],
			})
			if (state.knobs.kbInsertDuplicate) {
				const err = new Error(
					"E11000 duplicate key error collection: test_kb index: uq_kb_scope_hash",
				) as Error & { code: number }
				err.code = 11000
				throw err
			}
			state.kbDocs.push({ ...doc })
			return { acknowledged: true, insertedId: doc._id }
		},
		deleteOne: async (filter: AnyDoc, options?: { session?: unknown }) => {
			state.kbCalls.push({
				method: "deleteOne",
				filter,
				session: sessionOf(options),
				args: [filter, options],
			})
			// Knob: force a deletedCount outcome without touching the store.
			if (state.knobs.kbDeleteOneCount !== undefined) {
				return {
					acknowledged: true,
					deletedCount: state.knobs.kbDeleteOneCount,
				}
			}
			const index = state.kbDocs.findIndex((doc) => matchesFilter(doc, filter))
			const removed = index >= 0 ? state.kbDocs.splice(index, 1)[0] : null
			return { acknowledged: true, deletedCount: removed ? 1 : 0 }
		},
		updateOne: async (
			filter: AnyDoc,
			update: { $set?: AnyDoc },
			options?: { session?: unknown },
		) => {
			state.kbCalls.push({
				method: "updateOne",
				filter,
				session: sessionOf(options),
				args: [filter, update, options],
			})
			// Knob: force a matchedCount outcome without touching the store.
			if (state.knobs.kbUpdateOneMatched !== undefined) {
				return {
					acknowledged: true,
					matchedCount: state.knobs.kbUpdateOneMatched,
					modifiedCount: state.knobs.kbUpdateOneMatched,
				}
			}
			const doc = state.kbDocs.find((entry) => matchesFilter(entry, filter))
			if (doc && update.$set) {
				Object.assign(doc, update.$set)
			}
			return {
				acknowledged: true,
				matchedCount: doc ? 1 : 0,
				modifiedCount: doc ? 1 : 0,
			}
		},
	}

	const kbChunksFake = {
		findOne: async (filter: AnyDoc, options?: { session?: unknown }) => {
			state.chunkCalls.push({
				method: "findOne",
				filter,
				session: sessionOf(options),
				args: [filter, options],
			})
			return state.chunkDocs.find((doc) => matchesFilter(doc, filter)) ?? null
		},
		deleteMany: async (filter: AnyDoc, options?: { session?: unknown }) => {
			state.chunkCalls.push({
				method: "deleteMany",
				filter,
				session: sessionOf(options),
				args: [filter, options],
			})
			const before = state.chunkDocs.length
			state.chunkDocs = state.chunkDocs.filter(
				(doc) => !matchesFilter(doc, filter),
			)
			return {
				acknowledged: true,
				deletedCount: before - state.chunkDocs.length,
			}
		},
		bulkWrite: async (
			ops: Array<{
				updateOne: {
					filter: AnyDoc
					update: { $set?: AnyDoc }
					upsert: boolean
				}
			}>,
			options?: { session?: unknown; ordered?: boolean },
		) => {
			state.chunkCalls.push({
				method: "bulkWrite",
				filter: null,
				session: sessionOf(options),
				args: [ops, options],
			})
			if (state.knobs.chunksBulkError) {
				throw state.knobs.chunksBulkError
			}
			for (const op of ops) {
				const filter = op.updateOne.filter
				// The unique chunk-identity index is on the identity tuple, NOT
				// on the full (owned) filter: a row that holds the identity but
				// does not match the filter is a duplicate-key collision, not
				// an upsert target — model that instead of silently overwriting
				// a foreign row.
				const identityMatch = state.chunkDocs.find((doc) =>
					identityKeys.every((key) => doc[key] === filter[key]),
				)
				const fullMatch =
					identityMatch !== undefined && matchesFilter(identityMatch, filter)
				if (identityMatch !== undefined && !fullMatch) {
					const err = new Error(
						"E11000 duplicate key error collection: test_kb_chunks index: uq_chunk_identity",
					) as Error & { code: number }
					err.code = 11000
					throw err
				}
				if (identityMatch !== undefined) {
					Object.assign(identityMatch, op.updateOne.update.$set ?? {})
				} else {
					state.chunkDocs.push({ ...op.updateOne.update.$set })
				}
			}
			return { acknowledged: true, upsertedCount: ops.length, modifiedCount: 0 }
		},
	}

	const metaFake = {
		findOne: async () => null,
		updateOne: async () => ({
			acknowledged: true,
			matchedCount: 0,
			modifiedCount: 0,
		}),
		findOneAndUpdate: async () => null,
	}

	const queryCacheFake = {
		deleteMany: async () => ({ acknowledged: true, deletedCount: 0 }),
	}

	const withFencedWriteFake = async (params: {
		db: unknown
		prefix: unknown
		token: unknown
		fn: (session: unknown) => Promise<unknown>
	}) => {
		// Each fence mints its own session, exactly like a real
		// client.startSession() per withFencedWrite call.
		const session = { __fenceSession: state.fence.calls.length + 1 }
		state.fence.calls.push({
			db: params.db,
			prefix: params.prefix,
			token: params.token,
		})
		state.fence.sessions.push(session)
		// Knob: a gate conflict aborts the fence before the callback runs.
		if (state.fence.conflictError) {
			throw state.fence.conflictError
		}
		// Knob: withTransaction RETRY — re-invocations of the callback start
		// from the pre-attempt snapshot (the earlier attempt was aborted,
		// not committed), so retried writes land exactly once.
		const invokes =
			state.fence.calls.length === 1 || !state.fence.retryFirstOnly
				? state.fence.invokeCount
				: 1
		const kbSnapshot = state.kbDocs.map((doc) => ({ ...doc }))
		const chunkSnapshot = state.chunkDocs.map((doc) => ({ ...doc }))
		let last: unknown
		for (let attempt = 0; attempt < invokes; attempt++) {
			if (attempt > 0) {
				state.kbDocs.length = 0
				state.kbDocs.push(...kbSnapshot.map((doc) => ({ ...doc })))
				state.chunkDocs.length = 0
				state.chunkDocs.push(...chunkSnapshot.map((doc) => ({ ...doc })))
			}
			state.fence.fnInvocations++
			state.fence.inFn = true
			try {
				last = await params.fn(session)
			} finally {
				state.fence.inFn = false
			}
		}
		return last
	}

	const fsFake = {
		lstat: async (target: string) => {
			state.fsx.calls.push(`lstat:${target}`)
			return {
				isSymbolicLink: () => false,
				isDirectory: () => false,
				isFile: () => true,
			}
		},
		readdir: async (target: string) => {
			state.fsx.calls.push(`readdir:${target}`)
			return []
		},
		readFile: async (target: string) => {
			state.fsx.calls.push(`readFile:${target}`)
			return "# File\n\nfile body content"
		},
	}

	return {
		state,
		matchesFilter,
		kbFake,
		kbChunksFake,
		metaFake,
		queryCacheFake,
		withFencedWriteFake,
		fsFake,
	}
})

vi.mock("./mongodb-schema.js", () => ({
	kbCollection: () => h.kbFake,
	kbChunksCollection: () => h.kbChunksFake,
	metaCollection: () => h.metaFake,
	queryCacheCollection: () => h.queryCacheFake,
}))

vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-write-fence.js")>()
	return {
		...actual,
		withFencedWrite:
			h.withFencedWriteFake as unknown as typeof actual.withFencedWrite,
	}
})

vi.mock("./internal.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./internal.js")>()
	return {
		...actual,
		chunkMarkdown: ((
			content: string,
			chunking: { tokens: number; overlap: number },
		) =>
			h.state.chunking.zeroChunks
				? []
				: actual.chunkMarkdown(
						content,
						chunking,
					)) as typeof actual.chunkMarkdown,
	}
})

vi.mock("./mongodb-cost-ledger.js", () => ({
	recordEmbeddingSpend: (...args: unknown[]) => {
		h.state.spend.void.push(args)
	},
	recordEmbeddingSpendInSession: async (params: Record<string, unknown>) => {
		h.state.spend.inSession.push({ ...params, inFn: h.state.fence.inFn })
		if (h.state.spend.rejectInSession) {
			throw new Error("mock ledger failure in transaction")
		}
		if (h.state.spend.holdLedger && h.state.spend.ledgerReleased) {
			await h.state.spend.ledgerReleased
		}
	},
}))

vi.mock("./mongodb-query-cache.js", () => ({
	invalidateQueryCache: async (params: Record<string, unknown>) => {
		h.state.invalidate.push({ ...params, inFn: h.state.fence.inFn })
	},
}))

vi.mock("node:fs/promises", () => ({
	default: h.fsFake,
	lstat: h.fsFake.lstat,
	readdir: h.fsFake.readdir,
	readFile: h.fsFake.readFile,
}))

const resetState = () => {
	h.state.kbDocs.length = 0
	h.state.chunkDocs.length = 0
	h.state.kbCalls.length = 0
	h.state.chunkCalls.length = 0
	h.state.fence.calls.length = 0
	h.state.fence.sessions.length = 0
	h.state.fence.inFn = false
	h.state.fence.fnInvocations = 0
	h.state.fence.invokeCount = 1
	h.state.fence.retryFirstOnly = true
	h.state.fence.conflictError = null
	h.state.spend.void.length = 0
	h.state.spend.inSession.length = 0
	h.state.spend.holdLedger = false
	h.state.spend.ledgerReleased = null
	h.state.spend.releaseLedger()
	h.state.spend.releaseLedger = () => {}
	h.state.spend.rejectInSession = false
	h.state.invalidate.length = 0
	h.state.fsx.calls.length = 0
	h.state.chunking.zeroChunks = false
	h.state.knobs.kbInsertDuplicate = false
	h.state.knobs.kbVanishInFence = false
	h.state.knobs.kbDeleteOneCount = undefined
	h.state.knobs.kbUpdateOneMatched = undefined
	h.state.knobs.chunksBulkError = null
}

beforeEach(resetState)

const fileDoc = (path: string, content: string): KBDocument => ({
	title: path.split("/").pop() ?? path,
	content,
	source: { type: "file", path, importedBy: "agent" },
	hash: hashText(content),
})

const ingest = (documents: KBDocument[], extra: Record<string, unknown> = {}) =>
	ingestToKB({
		db: mockDb,
		prefix: "test_",
		scope: SCOPE,
		documents,
		embeddingMode: "automated",
		...extra,
	} as unknown as Parameters<typeof ingestToKB>[0])

const mutationsOf = (logs: Array<{ method: string; session: unknown }>) =>
	logs.filter((entry) => entry.method !== "findOne")

const attempt = async (promise: Promise<unknown>) => {
	try {
		const resolved = await promise
		return { threw: false, error: null as unknown, resolved }
	} catch (error) {
		return { threw: true, error, resolved: null }
	}
}

const ingestFiles = (extra: Record<string, unknown> = {}) =>
	ingestFilesToKB({
		db: mockDb,
		prefix: "test_",
		scope: SCOPE,
		paths: ["/docs/file.md"],
		importedBy: "agent",
		embeddingMode: "automated",
		...extra,
	} as unknown as Parameters<typeof ingestFilesToKB>[0])

describe("KB admission fence (plan e5ec10dc) — checkpoint 1: U5 + U6", () => {
	it("U5 (RED on current bytes): admission routes the ingest through TWO fences (document + cache) with revalidation, child guard, persist ops, and the AWAITED ledger all on the document fence session", async () => {
		h.state.kbDocs.push({
			_id: "old-parent-1",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
			hash: hashText("stale content"),
			chunksComplete: true,
			chunkScheme: 2,
			source: { type: "file", path: "/docs/guide.md", importedBy: "agent" },
		})
		// The old chunk set carries A's canonical ownership/namespace, so the
		// owned child guard and the owned deleteMany can both see it.
		h.state.chunkDocs.push({
			docId: "old-parent-1",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
			path: "/docs/guide.md",
			startLine: 1,
			endLine: 3,
			ordinal: 0,
			text: "stale content",
		})
		const doc = fileDoc("/docs/guide.md", "# Fresh\n\nfenced body content")

		// Bounded deferred-promise observation: hold the session ledger until
		// the test releases it. The ingest must have ENTERED the ledger inside
		// the fence and must not SETTLE while the ledger promise is held.
		h.state.spend.holdLedger = true
		h.state.spend.ledgerReleased = new Promise<void>((resolve) => {
			h.state.spend.releaseLedger = resolve
		})
		const pending = ingest([doc], { admission: ADMISSION })
		// Outcome observer attached IMMEDIATELY when the ingest starts: any
		// settlement — including a rejection during the poll window below —
		// is recorded here and can never surface as an unhandled rejection.
		let ingestOutcome:
			| { status: "fulfilled"; value: Awaited<ReturnType<typeof ingest>> }
			| { status: "rejected"; reason: unknown }
			| undefined
		const observed = pending.then(
			(value) => {
				ingestOutcome = { status: "fulfilled", value }
				return value
			},
			(reason) => {
				ingestOutcome = { status: "rejected", reason }
				throw reason
			},
		)
		// Permanently handled settlement awaiter: awaiting it waits for the
		// ingest to settle without ever rethrowing, so the unconditional
		// release-and-await in finally cannot mask an assertion failure.
		const settlement = observed.catch(() => undefined)
		let ledgerEntered = false
		for (let i = 0; i < 100 && !ledgerEntered; i++) {
			if (h.state.spend.inSession.length > 0) {
				ledgerEntered = true
			} else {
				await new Promise((resolve) => setTimeout(resolve, 10))
			}
		}
		try {
			// RED-first: on unfixed bytes the legacy fire-and-forget void spend
			// runs instead, the session ledger is never entered, and this is
			// the meaningful refusal.
			expect(ledgerEntered).toBe(true)
			expect(h.state.spend.inSession[0]?.inFn).toBe(true)
			// Hold-and-observe: a bounded window in which the ingest must NOT
			// settle while the ledger promise is held.
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(ingestOutcome).toBeUndefined()
		} finally {
			// Release AND await settlement unconditionally — also on the RED
			// path, where the assertion above has already thrown. The
			// settlement awaiter never rethrows, so it cannot mask that
			// original assertion failure.
			h.state.spend.releaseLedger()
			await settlement
		}
		// After the unconditional settlement the ingest must have SUCCEEDED;
		// on unfixed bytes this is unreachable (the RED refusal fired above).
		if (ingestOutcome?.status !== "fulfilled") {
			throw new Error(
				`U5: ingest settled ${
					ingestOutcome?.status ?? "never"
				} after ledger release`,
			)
		}
		const result = ingestOutcome.value

		// TWO fences under the SAME admission token: the document fence,
		// then the post-primary cache fence (C3).
		expect(h.state.fence.calls.length).toBe(2)
		expect(h.state.fence.calls[0]?.token).toEqual(ADMISSION)
		expect(h.state.fence.calls[1]?.token).toEqual(ADMISSION)
		const docSession = h.state.fence.sessions[0]
		const cacheSession = h.state.fence.sessions[1]

		// Positive control: the pre-fence dedup lookup ran OUTSIDE the fence.
		const outsideLookups = h.state.kbCalls.filter(
			(entry) => entry.method === "findOne" && entry.session === null,
		)
		expect(outsideLookups.length).toBeGreaterThan(0)

		// In-fence identity+ownership revalidation: a session-bound findOne
		// with the owned filter {_id, agentId, scope, scopeRef}.
		const revalidation = h.state.kbCalls.find(
			(entry) =>
				entry.method === "findOne" &&
				entry.session === docSession &&
				entry.filter !== null &&
				entry.filter._id === "old-parent-1" &&
				entry.filter.agentId === "test-agent" &&
				entry.filter.scope === "agent" &&
				entry.filter.scopeRef === SCOPE_REF,
		)
		expect(revalidation).toBeDefined()

		// In-fence foreign-child guard for the old chunk set: the owned
		// predicate with the $or wrong-owner/wrong-namespace clauses.
		const childGuard = h.state.chunkCalls.find(
			(entry) =>
				entry.method === "findOne" &&
				entry.session === docSession &&
				entry.filter !== null &&
				entry.filter.docId === "old-parent-1" &&
				entry.filter.$or !== undefined,
		)
		expect(childGuard).toBeDefined()

		// Every persist op on both collections ran on the DOCUMENT fence
		// session — the reIngestAtomically/standalone branch is not reachable.
		for (const entry of mutationsOf(h.state.kbCalls).concat(
			mutationsOf(h.state.chunkCalls),
		)) {
			expect(entry.session).toBe(docSession)
		}

		// The old parent's chunk set was cleaned INSIDE the fence with the
		// owned predicate, leaving only the new chunk row.
		const chunkClean = h.state.chunkCalls.find(
			(entry) => entry.method === "deleteMany" && entry.session === docSession,
		)
		expect(chunkClean?.filter).toEqual({
			docId: "old-parent-1",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
		})
		expect(h.state.chunkDocs.length).toBe(1)
		expect(h.state.chunkDocs[0]?.agentId).toBe("test-agent")

		// Chunk upserts carry the owned predicate.
		const bulk = h.state.chunkCalls.find(
			(entry) => entry.method === "bulkWrite" && entry.session === docSession,
		)
		const ops = bulk?.args[0] as
			| Array<{ updateOne: { filter: Record<string, unknown> } }>
			| undefined
		expect(ops?.[0]?.updateOne.filter).toMatchObject({
			scopeRef: SCOPE_REF,
			agentId: "test-agent",
			scope: "agent",
		})

		// Ledger: awaited, session-bound, INSIDE the document fence — and no
		// fire-and-forget spend on the admission path.
		expect(h.state.spend.inSession.length).toBe(1)
		expect(h.state.spend.inSession[0]?.inFn).toBe(true)
		expect(h.state.spend.inSession[0]?.session).toBe(docSession)
		expect(h.state.spend.inSession[0]?.kind).toBe("indexing")
		expect(h.state.spend.inSession[0]?.units).toBe(1)
		expect(h.state.spend.inSession[0]?.db).toBe(mockDb)
		expect(h.state.spend.inSession[0]?.prefix).toBe("test_")
		expect(h.state.spend.inSession[0]?.agentId).toBe("test-agent")
		expect(h.state.spend.void.length).toBe(0)

		// Cache fence: invalidateQueryCache runs INSIDE the second fence, on
		// the cache fence's OWN session, with throwOnError.
		expect(h.state.invalidate.length).toBe(1)
		expect(h.state.invalidate[0]?.inFn).toBe(true)
		expect(h.state.invalidate[0]?.session).toBe(cacheSession)
		expect(h.state.invalidate[0]?.throwOnError).toBe(true)

		// The ingest itself still succeeds end to end.
		expect(result.documentsProcessed).toBe(1)
		expect(result.chunksCreated).toBe(1)
	})

	it("U6 (passing control): absent admission preserves byte-exact legacy behavior — unfenced ops, fire-and-forget spend, unfenced invalidation, P1-2 swallow, standalone re-ingest, client-backed re-ingest, legacy shared-scope repair", async () => {
		// A. Fresh ingest: unfenced, session-free ops, void spend, unfenced
		// cache invalidation.
		const fresh = await ingest([fileDoc("/docs/new.md", "# New\n\nnew body")])
		expect(fresh.documentsProcessed).toBe(1)
		expect(h.state.fence.calls.length).toBe(0)
		for (const entry of mutationsOf(h.state.kbCalls).concat(
			mutationsOf(h.state.chunkCalls),
		)) {
			expect(entry.session).toBeNull()
		}
		expect(h.state.spend.void.length).toBe(1)
		expect(h.state.spend.void[0]?.[1]).toBe("test_")
		expect(h.state.spend.void[0]?.[2]).toBe("test-agent")
		expect(h.state.spend.void[0]?.[3]).toBe("indexing")
		expect(h.state.spend.void[0]?.[4]).toBeGreaterThan(0)
		expect(h.state.spend.inSession.length).toBe(0)
		expect(h.state.invalidate.length).toBe(1)
		expect(h.state.invalidate[0]?.inFn).toBe(false)
		expect(h.state.invalidate[0]?.session).toBeUndefined()
		expect(h.state.invalidate[0]?.agentId).toBe("test-agent")
		expect(h.state.invalidate[0]?.scopeRef).toBe(SCOPE_REF)

		resetState()

		// B. P1-2: a concurrent winner of the unique-index race is a skip,
		// not an error — and no chunk writes or invalidation follow.
		h.state.knobs.kbInsertDuplicate = true
		const dup = await ingest([fileDoc("/docs/dup.md", "# Dup\n\ndup body")])
		expect(dup.skipped).toBe(1)
		expect(dup.errors.length).toBe(0)
		expect(dup.documentsProcessed).toBe(0)
		expect(h.state.chunkCalls.length).toBe(0)
		expect(h.state.invalidate.length).toBe(0)

		resetState()

		// C. Replacement with no client: sequential standalone fallback —
		// delete-old + insert-new + chunk batch + completion, all unfenced.
		h.state.kbDocs.push({
			_id: "old-parent-2",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
			hash: hashText("stale content 2"),
			chunksComplete: true,
			chunkScheme: 2,
			source: { type: "file", path: "/docs/replace.md", importedBy: "agent" },
		})
		const replaced = await ingest([
			fileDoc("/docs/replace.md", "# Replaced\n\nnew body"),
		])
		expect(replaced.documentsProcessed).toBe(1)
		expect(h.state.fence.calls.length).toBe(0)
		expect(h.state.kbCalls.some((entry) => entry.method === "deleteOne")).toBe(
			true,
		)
		expect(h.state.kbCalls.some((entry) => entry.method === "insertOne")).toBe(
			true,
		)
		for (const entry of mutationsOf(h.state.kbCalls).concat(
			mutationsOf(h.state.chunkCalls),
		)) {
			expect(entry.session).toBeNull()
		}

		resetState()

		// D. Foreign-authored parent in a shared scope: legacy repair — no
		// ownership rejection, no owner-bound chunk predicate, no re-insert.
		h.state.kbDocs.push({
			_id: "foreign-parent-1",
			agentId: "agent-b",
			scope: "global",
			scopeRef: "global",
			hash: hashText("# Shared\n\nshared body"),
			chunksComplete: false,
			chunkScheme: 2,
			source: { type: "file", path: "/shared/notes.md", importedBy: "agent" },
		})
		const shared = await ingest(
			[fileDoc("/shared/notes.md", "# Shared\n\nshared body")],
			{
				scope: { agentId: "test-agent", scope: "global" },
			},
		)
		expect(shared.documentsProcessed).toBe(1)
		expect(shared.errors.length).toBe(0)
		expect(
			h.state.kbCalls.some(
				(entry) => entry.method === "deleteOne" || entry.method === "insertOne",
			),
		).toBe(false)
		const chunkClean = h.state.chunkCalls.find(
			(entry) => entry.method === "deleteMany",
		)
		expect(chunkClean?.filter).toEqual({ docId: "foreign-parent-1" })
		const bulk = h.state.chunkCalls.find(
			(entry) => entry.method === "bulkWrite",
		)
		const ops = bulk?.args[0] as
			| Array<{ updateOne: { filter: Record<string, unknown> } }>
			| undefined
		expect(ops?.[0]?.updateOne.filter).not.toHaveProperty("agentId")
		expect(h.state.fence.calls.length).toBe(0)

		resetState()

		// E. Replacement WITH a client: byte-preserved client-transactional
		// branch — the client session binds every persist op, the fence is
		// unused, and the writes run sequentially inside withTransaction.
		h.state.kbDocs.push({
			_id: "old-parent-3",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
			hash: hashText("stale content 3"),
			chunksComplete: true,
			chunkScheme: 2,
			source: { type: "file", path: "/docs/client.md", importedBy: "agent" },
		})
		const clientSession: Record<string, unknown> = { __clientSession: true }
		clientSession.withTransaction = async (
			callback: (session: unknown) => Promise<unknown>,
		) => callback(clientSession)
		clientSession.endSession = async () => {}
		const mockClient = { startSession: () => clientSession }
		const clientBacked = await ingest(
			[fileDoc("/docs/client.md", "# Client\n\nclient body")],
			{ client: mockClient },
		)
		expect(clientBacked.documentsProcessed).toBe(1)
		expect(h.state.fence.calls.length).toBe(0)
		for (const entry of mutationsOf(h.state.kbCalls).concat(
			mutationsOf(h.state.chunkCalls),
		)) {
			expect(entry.session).toBe(clientSession)
		}
		const deleteAt = h.state.kbCalls.findIndex(
			(entry) => entry.method === "deleteOne",
		)
		const insertAt = h.state.kbCalls.findIndex(
			(entry) => entry.method === "insertOne",
		)
		const bulkAt = h.state.chunkCalls.findIndex(
			(entry) => entry.method === "bulkWrite",
		)
		const completeAt = h.state.kbCalls.findIndex(
			(entry) => entry.method === "updateOne",
		)
		expect(deleteAt).toBeGreaterThanOrEqual(0)
		expect(insertAt).toBeGreaterThan(deleteAt)
		expect(bulkAt).toBeGreaterThanOrEqual(0)
		expect(completeAt).toBeGreaterThan(bulkAt)
	})
})

describe("KB admission fence (plan e5ec10dc) — checkpoint 2: U8 + U9 + U10", () => {
	it("U8 (RED on current bytes): a token whose agentId differs from the resolved scope owner is a typed KBAdmissionError at BOTH entries, before any collection or filesystem work", async () => {
		const FOREIGN_TOKEN = { kind: "admission", agentId: "agent-b", epoch: 0 }

		// Entry 1 — ingestToKB: the guard fires before any collection call.
		const docEntry = await attempt(
			ingest([fileDoc("/docs/guide.md", "# Guide\n\nbody")], {
				admission: FOREIGN_TOKEN,
			}),
		)
		expect(docEntry.threw).toBe(true)
		expect((docEntry.error as Error)?.name).toBe("KBAdmissionError")
		expect(h.state.kbCalls.length).toBe(0)
		expect(h.state.chunkCalls.length).toBe(0)
		expect(h.state.fence.calls.length).toBe(0)

		resetState()

		// Entry 2 — ingestFilesToKB: the guard fires before any filesystem
		// work (no lstat/readFile) and before any collection call.
		const filesEntry = await attempt(ingestFiles({ admission: FOREIGN_TOKEN }))
		expect(filesEntry.threw).toBe(true)
		expect((filesEntry.error as Error)?.name).toBe("KBAdmissionError")
		expect(h.state.fsx.calls.length).toBe(0)
		expect(h.state.kbCalls.length).toBe(0)
		expect(h.state.chunkCalls.length).toBe(0)
	})

	it("U9 (RED on current bytes): non-canonical agent scope or a non-admission token kind is a typed KBAdmissionError at BOTH entries before any collection or filesystem work; an explicit CANONICAL scopeRef stays allowed", async () => {
		// The plan requires every invalid category refused at BOTH entries —
		// ingestToKB AND ingestFilesToKB — before any collection or
		// filesystem work. The compact matrix below keeps every check from
		// the single-entry version and extends each category to both
		// entries.
		const invalidVariants = [
			{
				label: "non-canonical scopeRef override",
				extra: {
					admission: ADMISSION,
					scope: {
						agentId: "test-agent",
						scope: "agent",
						scopeRef: "other-namespace",
					},
				},
			},
			{
				label: "non-agent memory scope",
				extra: {
					admission: ADMISSION,
					scope: { agentId: "test-agent", scope: "global" },
				},
			},
			{
				label: "non-admission token kind",
				extra: {
					admission: { kind: "erasure", agentId: "test-agent", epoch: 0 },
				},
			},
		]

		for (const variant of invalidVariants) {
			// Document entry (ingestToKB): typed refusal before any
			// collection work.
			resetState()
			const docEntry = await attempt(
				ingest([fileDoc("/docs/u9.md", "# U9\n\nbody")], variant.extra),
			)
			expect(docEntry.threw).toBe(true)
			expect((docEntry.error as Error)?.name).toBe("KBAdmissionError")
			expect(h.state.kbCalls.length).toBe(0)
			expect(h.state.chunkCalls.length).toBe(0)

			// Files entry (ingestFilesToKB): the same refusal fires before
			// any filesystem OR collection work.
			resetState()
			const filesEntry = await attempt(ingestFiles(variant.extra))
			expect(filesEntry.threw).toBe(true)
			expect((filesEntry.error as Error)?.name).toBe("KBAdmissionError")
			expect(h.state.fsx.calls.length).toBe(0)
			expect(h.state.kbCalls.length).toBe(0)
			expect(h.state.chunkCalls.length).toBe(0)
		}

		resetState()

		// Positive control: an explicit scopeRef that EQUALS the canonical
		// derivation for the agent is not an override violation — the ingest
		// proceeds at BOTH entries (green before and after the product
		// change).
		const canonicalDoc = await ingest(
			[fileDoc("/docs/u9-canonical.md", "# Canonical\n\nbody")],
			{
				admission: ADMISSION,
				scope: { agentId: "test-agent", scope: "agent", scopeRef: SCOPE_REF },
			},
		)
		expect(canonicalDoc.documentsProcessed).toBe(1)

		resetState()

		const canonicalFiles = await ingestFiles({
			admission: ADMISSION,
			scope: { agentId: "test-agent", scope: "agent", scopeRef: SCOPE_REF },
		})
		expect(canonicalFiles.documentsProcessed).toBe(1)
	})

	it("U10 (RED on current bytes): with admission, a foreign-owned parent found by path, hash, or force dedup errors the document with ZERO mutations and no skip claim — the lookups themselves are reached", async () => {
		// A foreign parent: wrong OWNER inside A's namespace (explicit
		// scopeRef callers can create exactly this row).
		const seedForeignParent = (id: string, path: string, content: string) => {
			h.state.kbDocs.push({
				_id: id,
				agentId: "agent-b",
				scope: "agent",
				scopeRef: SCOPE_REF,
				hash: hashText(content),
				chunksComplete: true,
				chunkScheme: 2,
				source: { type: "file", path, importedBy: "agent" },
			})
		}

		// A. Path dedup: same source path, changed hash — a replacement plan
		// against a foreign parent must fail closed, not mutate it.
		seedForeignParent("foreign-path-1", "/docs/foreign.md", "foreign stale")
		const byPath = await ingest(
			[fileDoc("/docs/foreign.md", "# Fresh\n\nchanged body")],
			{ admission: ADMISSION },
		)
		expect(
			h.state.kbCalls.filter((entry) => entry.method === "findOne").length,
		).toBeGreaterThan(0)
		expect(byPath.errors.length).toBe(1)
		expect(byPath.skipped).toBe(0)
		expect(byPath.documentsProcessed).toBe(0)
		expect(
			mutationsOf(h.state.kbCalls).concat(mutationsOf(h.state.chunkCalls))
				.length,
		).toBe(0)

		resetState()

		// B. Hash dedup: same content under a different path — a skip would
		// claim A ingested a parent B owns; it must error instead.
		seedForeignParent(
			"foreign-hash-1",
			"/docs/foreign-hash.md",
			"# Same\n\nsame body",
		)
		const byHash = await ingest(
			[fileDoc("/docs/own-hash.md", "# Same\n\nsame body")],
			{
				admission: ADMISSION,
			},
		)
		expect(
			h.state.kbCalls.filter((entry) => entry.method === "findOne").length,
		).toBeGreaterThan(0)
		expect(byHash.errors.length).toBe(1)
		expect(byHash.skipped).toBe(0)
		expect(byHash.documentsProcessed).toBe(0)
		expect(
			mutationsOf(h.state.kbCalls).concat(mutationsOf(h.state.chunkCalls))
				.length,
		).toBe(0)

		resetState()

		// C. Force dedup: force re-ingest of a hash-matched foreign parent
		// must not delete or replace B's row.
		seedForeignParent(
			"foreign-force-1",
			"/docs/foreign-force.md",
			"# Forced\n\nforced body",
		)
		const byForce = await ingest(
			[fileDoc("/docs/own-force.md", "# Forced\n\nforced body")],
			{ admission: ADMISSION, force: true },
		)
		expect(
			h.state.kbCalls.filter((entry) => entry.method === "findOne").length,
		).toBeGreaterThan(0)
		expect(byForce.errors.length).toBe(1)
		expect(byForce.skipped).toBe(0)
		expect(byForce.documentsProcessed).toBe(0)
		expect(
			mutationsOf(h.state.kbCalls).concat(mutationsOf(h.state.chunkCalls))
				.length,
		).toBe(0)
		// B's parent row is untouched.
		expect(h.state.kbDocs.length).toBe(1)
		expect(h.state.kbDocs[0]?.agentId).toBe("agent-b")
	})
})

describe("KB admission fence (plan e5ec10dc) — checkpoint 3: U11 + U12 + U13", () => {
	it("U11 (RED on current bytes): foreign-child guards with faithful predicate matching — a wrong-owner child sharing the replacement docId is rejected before any mutation, a B row holding the prepared unique chunk identity surfaces a collision WITHOUT being changed, and a raw parent insert collision is an error, not a skip", async () => {
		// A. A B-owned child under the replacement target's old docId: the
		// in-fence owned child guard ($or wrong-owner/wrong-namespace) must
		// reject the replacement BEFORE any parent or chunk mutation.
		h.state.kbDocs.push({
			_id: "old-parent-11",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
			hash: hashText("stale content 11"),
			chunksComplete: true,
			chunkScheme: 2,
			source: { type: "file", path: "/docs/guide11.md", importedBy: "agent" },
		})
		h.state.chunkDocs.push({
			docId: "old-parent-11",
			agentId: "agent-b",
			scope: "agent",
			scopeRef: SCOPE_REF,
			path: "/docs/guide11.md",
			startLine: 1,
			endLine: 3,
			ordinal: 0,
			text: "foreign child body",
		})
		const guardResult = await ingest(
			[fileDoc("/docs/guide11.md", "# Fresh\n\nreplaced body")],
			{ admission: ADMISSION },
		)
		expect(guardResult.errors.length).toBe(1)
		expect(guardResult.documentsProcessed).toBe(0)
		expect(
			mutationsOf(h.state.kbCalls).concat(mutationsOf(h.state.chunkCalls))
				.length,
		).toBe(0)
		// The wrong-owner child predicate was actually evaluated in-fence.
		const childGuard = h.state.chunkCalls.find(
			(entry) =>
				entry.method === "findOne" &&
				entry.filter !== null &&
				entry.filter.docId === "old-parent-11" &&
				entry.filter.$or !== undefined,
		)
		expect(childGuard).toBeDefined()
		// B's child row is untouched.
		expect(h.state.chunkDocs.length).toBe(1)
		expect(h.state.chunkDocs[0]?.agentId).toBe("agent-b")

		resetState()

		// B. B's row occupies the prepared unique chunk IDENTITY (same
		// scopeRef/path/startLine/endLine/ordinal) but has a different docId
		// and owner: the owned upsert predicate cannot match it, the insert
		// collides on the unique index, and B's row is NOT overwritten.
		h.state.kbDocs.push({
			_id: "old-parent-12",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
			hash: hashText("stale content 12"),
			chunksComplete: true,
			chunkScheme: 2,
			source: { type: "file", path: "/docs/guide12.md", importedBy: "agent" },
		})
		const content12 = "# Fresh\n\nreplaced body twelve"
		const parts = chunkMarkdown(content12, { tokens: 600, overlap: 100 })
		expect(parts.length).toBeGreaterThan(0)
		h.state.chunkDocs.push({
			docId: "other-doc-b",
			agentId: "agent-b",
			scope: "agent",
			scopeRef: SCOPE_REF,
			path: "/docs/guide12.md",
			startLine: parts[0]?.startLine,
			endLine: parts[0]?.endLine,
			ordinal: parts[0]?.ordinal,
			text: "B holds this identity",
		})
		const collisionResult = await ingest(
			[fileDoc("/docs/guide12.md", content12)],
			{
				admission: ADMISSION,
			},
		)
		expect(collisionResult.errors.length).toBe(1)
		expect(collisionResult.documentsProcessed).toBe(0)
		// The chunk upsert predicate is OWNER-BOUND (agentId/scope/scopeRef on
		// top of the identity tuple), so it cannot match B's row.
		const bulk = h.state.chunkCalls.find(
			(entry) => entry.method === "bulkWrite",
		)
		const ops = bulk?.args[0] as
			| Array<{ updateOne: { filter: Record<string, unknown> } }>
			| undefined
		expect(ops?.[0]?.updateOne.filter).toHaveProperty("agentId")
		expect(ops?.[0]?.updateOne.filter).toHaveProperty("scope")
		expect(ops?.[0]?.updateOne.filter).toHaveProperty("scopeRef")
		// B's identity-holding row is unchanged — the collision surfaced
		// instead of silently overwriting a foreign row.
		const bRow = h.state.chunkDocs.find((doc) => doc.docId === "other-doc-b")
		expect(bRow?.agentId).toBe("agent-b")
		expect(bRow?.text).toBe("B holds this identity")

		resetState()

		// C. Raw parent insert collision on the admission path: a duplicate
		// unique-key error is recorded as a document ERROR, never the P1-2
		// legacy skip claim.
		h.state.knobs.kbInsertDuplicate = true
		const rawCollision = await ingest(
			[fileDoc("/docs/raw-collision.md", "# Raw\n\ncollision body")],
			{ admission: ADMISSION },
		)
		expect(rawCollision.errors.length).toBe(1)
		expect(rawCollision.skipped).toBe(0)
		expect(rawCollision.documentsProcessed).toBe(0)
	})

	it("U12 (RED on current bytes): in-fence disappearance and completion mismatches reject the transaction — vanished revalidation target, zero deletedCount, zero completion matchedCount, and a zero-chunk repair still cleans the owned old chunk set before completion", async () => {
		const seedOwnedParent = (id: string, path: string, content: string) => {
			h.state.kbDocs.push({
				_id: id,
				agentId: "test-agent",
				scope: "agent",
				scopeRef: SCOPE_REF,
				hash: hashText(content),
				chunksComplete: true,
				chunkScheme: 2,
				source: { type: "file", path, importedBy: "agent" },
			})
		}

		// A. The revalidation read (session-bound) finds the parent GONE: the
		// replacement is rejected BEFORE any chunk write, with no committed
		// result counts.
		seedOwnedParent("vanish-1", "/docs/vanish.md", "stale vanish")
		h.state.knobs.kbVanishInFence = true
		const vanished = await ingest(
			[fileDoc("/docs/vanish.md", "# Fresh\n\nvanish body")],
			{ admission: ADMISSION },
		)
		expect(vanished.errors.length).toBe(1)
		expect(vanished.documentsProcessed).toBe(0)
		expect(vanished.chunksCreated).toBe(0)
		expect(
			mutationsOf(h.state.kbCalls).concat(mutationsOf(h.state.chunkCalls))
				.length,
		).toBe(0)

		resetState()

		// B. deleteOne reports deletedCount 0 (the replacement parent
		// disappeared mid-transaction): reject BEFORE the insert.
		seedOwnedParent("gone-1", "/docs/gone.md", "stale gone")
		h.state.knobs.kbDeleteOneCount = 0
		const deletedZero = await ingest(
			[fileDoc("/docs/gone.md", "# Fresh\n\ngone body")],
			{ admission: ADMISSION },
		)
		expect(deletedZero.errors.length).toBe(1)
		expect(deletedZero.documentsProcessed).toBe(0)
		expect(h.state.kbCalls.some((entry) => entry.method === "insertOne")).toBe(
			false,
		)

		resetState()

		// C. The completion updateOne matches 0 rows (the completion parent
		// disappeared): reject AFTER the chunk batch was attempted, with the
		// ledger unreached and no committed counts.
		seedOwnedParent(
			"complete-gone-1",
			"/docs/complete-gone.md",
			"stale complete",
		)
		h.state.knobs.kbUpdateOneMatched = 0
		const completeZero = await ingest(
			[fileDoc("/docs/complete-gone.md", "# Fresh\n\ncomplete body")],
			{ admission: ADMISSION },
		)
		expect(
			h.state.chunkCalls.some((entry) => entry.method === "bulkWrite"),
		).toBe(true)
		expect(completeZero.errors.length).toBe(1)
		expect(completeZero.documentsProcessed).toBe(0)
		expect(h.state.spend.inSession.length).toBe(0)

		resetState()

		// D. Zero-chunk repair: even with NO new chunk ops, the owned old
		// chunk set is cleaned (owned deleteMany) BEFORE the completion
		// flip — a zero-chunk completion must not freeze stale chunks.
		h.state.kbDocs.push({
			_id: "repair-zero-1",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
			hash: hashText("# Same\n\nrepair body"),
			chunksComplete: false,
			chunkScheme: 2,
			source: {
				type: "file",
				path: "/docs/repair-zero.md",
				importedBy: "agent",
			},
		})
		h.state.chunkDocs.push({
			docId: "repair-zero-1",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
			path: "/docs/repair-zero.md",
			startLine: 1,
			endLine: 3,
			ordinal: 0,
			text: "stale repair chunk",
		})
		h.state.chunking.zeroChunks = true
		const zeroChunk = await ingest(
			[fileDoc("/docs/repair-zero.md", "# Same\n\nrepair body")],
			{ admission: ADMISSION },
		)
		const repairClean = h.state.chunkCalls.find(
			(entry) => entry.method === "deleteMany",
		)
		expect(repairClean?.filter).toEqual({
			docId: "repair-zero-1",
			agentId: "test-agent",
			scope: "agent",
			scopeRef: SCOPE_REF,
		})
		expect(h.state.chunkDocs.length).toBe(0)
		expect(zeroChunk.documentsProcessed).toBe(1)
	})

	it("U13 (RED on current bytes): a withTransaction callback RETRY recomputes callback-local counts and the committed result is counted exactly once after acknowledgment", async () => {
		h.state.fence.invokeCount = 2
		const retried = await ingest(
			[fileDoc("/docs/retry.md", "# Retry\n\nretried body")],
			{ admission: ADMISSION },
		)
		// The document fence callback ran TWICE (the retry), each attempt
		// starting from the pre-attempt snapshot.
		// fnInvocations is GLOBAL across fences, so the total is 3: two
		// document-fence callback runs (the initial attempt plus the
		// withTransaction retry) + one cache-fence callback run.
		expect(h.state.fence.fnInvocations).toBe(3)
		// The TWO fence ENTRIES remain: the document fence (however many
		// callback attempts its retry took) and the post-primary cache fence.
		expect(h.state.fence.calls.length).toBe(2)
		expect(h.state.fence.calls[0]?.token).toEqual(ADMISSION)
		// Counters are committed exactly once, not doubled by the retry.
		expect(retried.documentsProcessed).toBe(1)
		expect(retried.chunksCreated).toBe(1)
		// The store holds exactly one parent and one chunk — the retried
		// attempt's writes landed once.
		expect(h.state.kbDocs.length).toBe(1)
		expect(h.state.chunkDocs.length).toBe(1)
	})
})

describe("KB admission fence (plan e5ec10dc) — checkpoint 4: U14 + U18", () => {
	it("U14 (RED on current bytes): failure propagation and ordering — a raw chunk-batch failure rejects BEFORE the completion update and the ledger; a ledger failure rejects AFTER the completion update was attempted; neither commits result counts and no op error is swallowed inside the callback", async () => {
		// A. Raw chunk-batch failure inside the fence: the callback rejects,
		// the completion updateOne is never reached, the session ledger is
		// never entered, and no counters are committed.
		h.state.knobs.chunksBulkError = new Error("mock chunk bulk failure")
		const bulkFailed = await ingest(
			[fileDoc("/docs/bulk-fail.md", "# Bulk\n\nfailing body")],
			{ admission: ADMISSION },
		)
		// The document fence was entered (and only it — no cache fence
		// follows a fully failed loop).
		expect(h.state.fence.calls.length).toBe(1)
		expect(h.state.fence.calls[0]?.token).toEqual(ADMISSION)
		expect(bulkFailed.errors.length).toBe(1)
		expect(bulkFailed.documentsProcessed).toBe(0)
		expect(bulkFailed.chunksCreated).toBe(0)
		expect(h.state.kbCalls.some((entry) => entry.method === "updateOne")).toBe(
			false,
		)
		expect(h.state.spend.inSession.length).toBe(0)

		resetState()

		// B. Session-ledger failure AFTER the completion update was
		// attempted: the completion updateOne ran on the fence session, the
		// ledger was entered and rejected, the document errors, and no
		// counters are committed.
		h.state.spend.rejectInSession = true
		const ledgerFailed = await ingest(
			[fileDoc("/docs/ledger-fail.md", "# Ledger\n\nfailing body")],
			{ admission: ADMISSION },
		)
		expect(h.state.fence.calls.length).toBe(1)
		const completion = h.state.kbCalls.find(
			(entry) => entry.method === "updateOne" && entry.session !== null,
		)
		expect(completion).toBeDefined()
		expect(h.state.spend.inSession.length).toBe(1)
		expect(h.state.spend.inSession[0]?.inFn).toBe(true)
		expect(ledgerFailed.errors.length).toBe(1)
		expect(ledgerFailed.documentsProcessed).toBe(0)
		expect(ledgerFailed.chunksCreated).toBe(0)
	})

	it("U18 (RED on current bytes): an ErasureGateConflictError thrown from a per-document fence is RETHROWN through the per-document catch — the ingest rejects, no further document is processed, and no cache fence is attempted", async () => {
		h.state.fence.conflictError = new ErasureGateConflictError("test-agent")
		const conflict = await attempt(
			ingest(
				[
					fileDoc("/docs/conflict-1.md", "# One\n\nfirst body"),
					fileDoc("/docs/conflict-2.md", "# Two\n\nsecond body"),
				],
				{ admission: ADMISSION },
			),
		)
		expect(conflict.threw).toBe(true)
		expect(conflict.error).toBeInstanceOf(ErasureGateConflictError)
		// Exactly ONE fence was entered (the first document's); the second
		// document never reached a fence and no cache fence followed.
		expect(h.state.fence.calls.length).toBe(1)
		expect(h.state.fence.calls[0]?.token).toEqual(ADMISSION)
		// The gate conflict is NOT recorded as a per-document error — it
		// propagates and aborts the whole ingest.
		expect(h.state.invalidate.length).toBe(0)
	})
})
