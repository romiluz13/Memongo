/**
 * U1-U9 fenced locator reads on `MongoDBManagerReadOps.readFile` (plan
 * `6c755bcf` §15, harness-plan.md File 1; corrected per Astra's
 * consolidated C1-C6 grant).
 *
 * The locator-read path touches tenant data with no erasure-fence
 * protection: an erasure worker that marks a gate can race a concurrent
 * `readFile` and stream soon-to-be-erased rows (and kb titles) out from
 * under the mark. These tests pin the missing behavior on the UNCHANGED
 * product bytes so the later product grant has an exact oracle.
 *
 * Harness (file-local, kb-refresh `vi.hoisted` precedent):
 * - `vi.mock("./mongodb-schema.js", importOriginal)` overrides ONLY the
 *   eight tenant-data collection factories plus `metaCollection`. The REAL
 *   `readFile`, the REAL `captureAdmissionToken`/`readErasureGate`/
 *   `parseErasureGateDoc` gate primitives, and the REAL error classes all
 *   run against the fakes.
 * - `vi.mock("./mongodb-write-fence.js", importOriginal)` overrides ONLY
 *   `withFencedWrite` with a fake that reproduces `applyGateFence` ordering
 *   (mongodb-write-fence.ts:42-78, applied at :93 BEFORE the callback): the
 *   in-session gate re-check and the serial `updateOne` run BEFORE the
 *   branch callback. Sessions are opaque identity tokens
 *   `{ __locatorReadFenceSession: true }` reused across retry attempts,
 *   like a real `withTransaction` retry. Tenant `updateOne` writes buffer
 *   per attempt (staged) and apply once on commit; the transient knob
 *   models a driver ABORT (staged writes discarded) and the
 *   indeterminate-commit knob plays BOTH scripted dispositions (staged
 *   writes applied or discarded) without claiming either is what a real
 *   driver persists — attempted-touch persistence stays native N5
 *   evidence, not a unit claim.
 * - C1 capture snapshots: the meta fake's `findOneAndUpdate` returns the
 *   gate document AS IT WAS at capture time while a scripted flip mutates
 *   the STORED entry, matching the real schedule
 *   (mongodb-erasure-epoch.ts:236-267: capture parses the RETURNED document
 *   and rejects an erasing gate only AFTER the call returns) — so a
 *   between-capture flip is observed by the in-fence re-check, never by
 *   the admission parse.
 * - RED discipline: every U case asserts the BEHAVIOR first (served vs
 *   suppressed miss shape, zero tenant-data access, session identity), so
 *   failures on unchanged bytes are meaningful — never a mock crash. The
 *   legacy miss shapes (U8 and the C6 conflict table run the SAME shape
 *   table), the empty-path guard, branch-error propagation, and the
 *   C1/C2/C4 harness controls are PASSING CONTROLS on both old and new
 *   bytes.
 *
 * This phase is read-only on product bytes: the files pin the missing
 * fence; the product grant that adds it lands later.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Db } from "mongodb"
import {
	captureAdmissionToken,
	ErasureGateConflictError,
	MalformedGateError,
} from "./mongodb-erasure-epoch.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import type { ManagerReadResult } from "./mongodb-manager-read.js"
import { MongoDBManagerReadOps } from "./mongodb-manager-read.js"
import { buildUnexpiredClause } from "./mongodb-temporal.js"
import { withFencedWrite } from "./mongodb-write-fence.js"

// ---------------------------------------------------------------------------
// File-local fakes (vi.hoisted so the vi.mock factories below can close over
// them)
// ---------------------------------------------------------------------------

const { metaFake, collections, fenceSeam } = vi.hoisted(() => {
	type CallRecord = {
		filter: Record<string, unknown>
		options?: Record<string, unknown>
	}
	type UpdateRecord = {
		filter: Record<string, unknown>
		update: Record<string, unknown>
		options?: Record<string, unknown>
	}

	// ---- meta collection: gate-document semantics only ----
	const metaFake = {
		calls: {
			findOne: [] as CallRecord[],
			findOneAndUpdate: [] as Array<
				CallRecord & { update: Record<string, unknown> }
			>,
			updateOne: [] as UpdateRecord[],
		},
		gateDocs: new Map<string, Record<string, unknown>>(),
		knobs: {
			/**
			 * Flip the STORED gate entry right after the admission capture read
			 * returns, while the capture still receives the PRE-FLIP snapshot
			 * (U2/U2b/U4b/U5 and the C1 harness controls).
			 */
			flipOnCapture: null as ((doc: Record<string, unknown>) => void) | null,
			/** Throw from the next findOneAndUpdate — a capture-site driver failure (U9). */
			failNextCapture: null as Error | null,
		},
		setFlipOnCapture(fn: (doc: Record<string, unknown>) => void) {
			metaFake.knobs.flipOnCapture = fn
		},
		reset() {
			metaFake.calls.findOne.length = 0
			metaFake.calls.findOneAndUpdate.length = 0
			metaFake.calls.updateOne.length = 0
			metaFake.gateDocs.clear()
			metaFake.knobs.flipOnCapture = null
			metaFake.knobs.failNextCapture = null
		},
		findOne: async (
			filter: Record<string, unknown>,
			options?: Record<string, unknown>,
		) => {
			metaFake.calls.findOne.push({ filter, options })
			const id = filter._id
			return typeof id === "string" ? (metaFake.gateDocs.get(id) ?? null) : null
		},
		findOneAndUpdate: async (
			filter: Record<string, unknown>,
			update: Record<string, unknown>,
			options?: Record<string, unknown>,
		) => {
			metaFake.calls.findOneAndUpdate.push({ filter, update, options })
			if (metaFake.knobs.failNextCapture) {
				const err = metaFake.knobs.failNextCapture
				metaFake.knobs.failNextCapture = null
				throw err
			}
			const id = filter._id
			const existing =
				typeof id === "string" ? metaFake.gateDocs.get(id) : undefined
			if (existing) {
				// captureAdmissionToken uses $setOnInsert only — no doc change —
				// but the read is still one durable round trip.
				if (metaFake.knobs.flipOnCapture) {
					const fn = metaFake.knobs.flipOnCapture
					metaFake.knobs.flipOnCapture = null
					// C1 capture-snapshot schedule: the REAL capture parses the
					// findOneAndUpdate RESULT and rejects an erasing gate only
					// AFTER the call returns (mongodb-erasure-epoch.ts:236-267).
					// The fake therefore returns the document as it was at
					// capture time (a snapshot copy) while the flip mutates the
					// STORED entry that the later in-fence readErasureGate
					// re-check observes.
					const snapshot: Record<string, unknown> = { ...existing }
					if (snapshot.erase !== undefined) {
						snapshot.erase = {
							...(snapshot.erase as Record<string, unknown>),
						}
					}
					fn(existing)
					return snapshot
				}
				return existing
			}
			if (options?.upsert) {
				const inserted = {
					_id: id,
					...(update.$setOnInsert as Record<string, unknown>),
				}
				if (typeof id === "string") {
					metaFake.gateDocs.set(id, inserted)
				}
				return inserted
			}
			return null
		},
		updateOne: async (
			filter: Record<string, unknown>,
			update: Record<string, unknown>,
			options?: Record<string, unknown>,
		) => {
			metaFake.calls.updateOne.push({ filter, update, options })
			const id = filter._id
			const doc = typeof id === "string" ? metaFake.gateDocs.get(id) : undefined
			const epochMatches =
				filter.epoch === undefined || doc?.epoch === filter.epoch
			const stateOpen =
				doc === undefined || doc.state === undefined || doc.state === "open"
			if (!doc || !epochMatches || !stateOpen) {
				return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
			}
			if (update.$inc) {
				for (const [field, delta] of Object.entries(update.$inc)) {
					doc[field] =
						(typeof doc[field] === "number" ? doc[field] : 0) +
						(delta as number)
				}
			}
			if (update.$set) {
				Object.assign(doc, update.$set)
			}
			return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
		},
	}

	// ---- tenant collection fakes: scripted reads, staged writes ----
	function applyUpdate(
		store: Map<string, Record<string, unknown>>,
		filter: Record<string, unknown>,
		update: Record<string, unknown>,
	) {
		const id = filter._id
		const doc = typeof id === "string" ? store.get(id) : undefined
		if (!doc) {
			return
		}
		if (update.$set) {
			Object.assign(doc, update.$set)
		}
		if (update.$inc) {
			for (const [field, delta] of Object.entries(update.$inc)) {
				doc[field] =
					(typeof doc[field] === "number" ? doc[field] : 0) + (delta as number)
			}
		}
	}

	const attempt = {
		staged: false,
		pending: [] as Array<{
			store: Map<string, Record<string, unknown>>
			filter: Record<string, unknown>
			update: Record<string, unknown>
		}>,
		/** Flip the stored gate while an attempt's writes are staged (U7b/U7c). */
		flipOnStage: null as
			| ((gateDocs: Map<string, Record<string, unknown>>) => void)
			| null,
	}

	function makeCollection() {
		const calls = {
			findOne: [] as CallRecord[],
			find: [] as CallRecord[],
			updateOne: [] as UpdateRecord[],
		}
		const store = new Map<string, Record<string, unknown>>()
		let findOneScript: Array<unknown> = []
		let findScript: Array<Array<unknown>> = []
		return {
			calls,
			store,
			seed(doc: Record<string, unknown> & { _id: string }) {
				store.set(doc._id, doc)
			},
			scriptFindOne(results: Array<unknown>) {
				findOneScript = [...results]
			},
			scriptFind(results: Array<Array<unknown>>) {
				findScript = [...results]
			},
			/**
			 * C2 isolation: clears the recorded call lists, the store, AND the
			 * private scripted queues — an unconsumed scripted result must not
			 * survive into a later case's natural miss.
			 */
			reset() {
				calls.findOne.length = 0
				calls.find.length = 0
				calls.updateOne.length = 0
				store.clear()
				findOneScript.length = 0
				findScript.length = 0
			},
			findOne: async (
				filter: Record<string, unknown>,
				options?: Record<string, unknown>,
			) => {
				calls.findOne.push({ filter, options })
				const next = findOneScript.shift()
				if (next instanceof Error) {
					throw next
				}
				return (next === undefined ? null : next) as unknown
			},
			find: (
				filter: Record<string, unknown>,
				options?: Record<string, unknown>,
			) => {
				calls.find.push({ filter, options })
				const docs = findScript.shift() ?? []
				const cursor = {
					sort: () => cursor,
					limit: () => cursor,
					toArray: async () => [...docs],
				}
				return cursor
			},
			updateOne: async (
				filter: Record<string, unknown>,
				update: Record<string, unknown>,
				options?: Record<string, unknown>,
			) => {
				calls.updateOne.push({ filter, update, options })
				if (attempt.staged) {
					if (attempt.flipOnStage) {
						const fn = attempt.flipOnStage
						attempt.flipOnStage = null
						fn(metaFake.gateDocs)
					}
					attempt.pending.push({ store, filter: { ...filter }, update })
				} else {
					applyUpdate(store, filter, update)
				}
				return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
			},
		}
	}

	const structured = makeCollection()
	const procedures = makeCollection()
	const entities = makeCollection()
	const episodes = makeCollection()
	const events = makeCollection()
	const kb = makeCollection()
	const chunks = makeCollection()
	const relations = makeCollection()
	const tenants = {
		structured,
		procedures,
		entities,
		episodes,
		events,
		kb,
		chunks,
		relations,
	}

	const collections = {
		tenants,
		attempt,
		reset() {
			for (const collection of Object.values(tenants)) {
				collection.reset()
			}
			attempt.staged = false
			attempt.pending.length = 0
			attempt.flipOnStage = null
		},
		discardAttempt() {
			attempt.pending.length = 0
			attempt.staged = false
		},
		commitAttempt() {
			for (const entry of attempt.pending) {
				applyUpdate(entry.store, entry.filter, entry.update)
			}
			attempt.pending.length = 0
			attempt.staged = false
		},
	}

	// ---- withFencedWrite seam state + knobs ----
	const fenceSeam = {
		state: {
			fenceCalls: [] as Array<{ db: unknown; prefix: unknown; token: unknown }>,
			sessions: [] as Array<{ __locatorReadFenceSession: true }>,
			attempts: 0,
		},
		knobs: {
			/** One transient commit failure after the callback ran (U7a/U7b/U7c). */
			transientOnce: false,
			/**
			 * One indeterminate commit failure after the callback ran (U9): the
			 * EXACT error to reject with, plus which scripted disposition the
			 * fixture plays with the staged writes (applied or discarded). A
			 * real indeterminate commit leaves the persisted-touch outcome
			 * UNKNOWN — neither disposition is claimed as the driver's real
			 * behavior; both must fail closed with the same injected error.
			 */
			failCommitOnce: null as { error: Error; applyStaged: boolean } | null,
		},
		reset() {
			fenceSeam.state.fenceCalls.length = 0
			fenceSeam.state.sessions.length = 0
			fenceSeam.state.attempts = 0
			fenceSeam.knobs.transientOnce = false
			fenceSeam.knobs.failCommitOnce = null
		},
	}

	return { metaFake, collections, fenceSeam }
})

vi.mock("./mongodb-schema.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-schema.js")>()
	return {
		...actual,
		structuredMemCollection: () => collections.tenants.structured,
		proceduresCollection: () => collections.tenants.procedures,
		entitiesCollection: () => collections.tenants.entities,
		episodesCollection: () => collections.tenants.episodes,
		eventsCollection: () => collections.tenants.events,
		kbCollection: () => collections.tenants.kb,
		chunksCollection: () => collections.tenants.chunks,
		relationsCollection: () => collections.tenants.relations,
		metaCollection: () => metaFake,
	}
})

vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-write-fence.js")>()

	/**
	 * Reproduces the REAL withFencedWrite/applyGateFence ordering
	 * (mongodb-write-fence.ts:42-78, applied at :93 BEFORE the callback):
	 * the in-session gate re-check and the serial updateOne run BEFORE the
	 * callback. The session is an opaque identity token reused across retry
	 * attempts, and tenant updateOnes are staged per attempt and applied
	 * once on commit. The transient knob models a driver ABORT (discard and
	 * retry); the failCommitOnce knob plays a scripted indeterminate commit
	 * under BOTH staged-write dispositions without claiming either is the
	 * driver's real persisted outcome.
	 */
	const withFencedWriteFake = async (params: {
		db: unknown
		prefix: string
		token: { kind: string; agentId: string; epoch: number }
		fn: (session: unknown) => Promise<unknown>
		session?: unknown
	}) => {
		const epoch = await import("./mongodb-erasure-epoch.js")
		fenceSeam.state.fenceCalls.push({
			db: params.db,
			prefix: params.prefix,
			token: params.token,
		})
		const session: { __locatorReadFenceSession: true } = {
			__locatorReadFenceSession: true,
		}
		fenceSeam.state.sessions.push(session)
		let transientSpent = false
		for (let attemptNo = 1; ; attemptNo++) {
			fenceSeam.state.attempts = attemptNo
			const gate = await epoch.readErasureGate({
				db: params.db as never,
				prefix: params.prefix,
				agentId: params.token.agentId,
				session: session as never,
			})
			if (!gate || gate.state !== "open" || gate.epoch !== params.token.epoch) {
				throw new epoch.ErasureGateConflictError(params.token.agentId)
			}
			const serial = await metaFake.updateOne(
				epoch.admissionGateFilter(params.token as never),
				{ $inc: { serial: 1 }, $set: { updatedAt: new Date() } },
				{ session },
			)
			if (serial.matchedCount === 0) {
				throw new epoch.ErasureGateConflictError(params.token.agentId)
			}
			collections.attempt.staged = true
			collections.attempt.pending.length = 0
			try {
				const value = await params.fn(session)
				if (fenceSeam.knobs.transientOnce && !transientSpent) {
					transientSpent = true
					fenceSeam.knobs.transientOnce = false
					collections.discardAttempt()
					continue
				}
				if (fenceSeam.knobs.failCommitOnce) {
					const { error, applyStaged } = fenceSeam.knobs.failCommitOnce
					fenceSeam.knobs.failCommitOnce = null
					// Scripted disposition only (C5): both possibilities are
					// played — a real indeterminate commit's persisted-touch
					// outcome is UNKNOWN and stays a native question. Either
					// way the read rejects with the exact injected error.
					if (applyStaged) {
						collections.commitAttempt()
					} else {
						collections.discardAttempt()
					}
					throw error
				}
				collections.commitAttempt()
				return value
			} catch (err) {
				collections.discardAttempt()
				throw err
			}
		}
	}

	return {
		...actual,
		withFencedWrite:
			withFencedWriteFake as unknown as typeof actual.withFencedWrite,
	}
})

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const FAKE_DB = {} as Db

/**
 * The ops methods gain an optional trailing `session` in the fenced-read
 * product grant (§8); today they take none, so the forwarding closures below
 * call through this widened view.
 */
type SessionForwardingOps = {
	readConversationChunk: (
		rawPath: string,
		from?: number,
		lines?: number,
		session?: unknown,
	) => Promise<ManagerReadResult>
	readCanonicalEvent: (
		eventId: string,
		rawPath: string,
		session?: unknown,
	) => Promise<ManagerReadResult>
	readBridgeChunk: (
		rawPath: string,
		from?: number,
		lines?: number,
		session?: unknown,
	) => Promise<ManagerReadResult>
	readEpisodeLocator: (params: {
		rawPath: string
		episodeId: string
		expandEvents: boolean
		session?: unknown
	}) => Promise<ManagerReadResult>
}

function makeOps(
	agentId = "agent-1",
): MongoDBManagerReadOps & SessionForwardingOps {
	const ops = new MongoDBManagerReadOps({
		db: FAKE_DB,
		prefix: "t_",
		agentId,
		agentScopeRef: agentId,
		workspaceScopeRef: "ws-1",
		resolveSearchIdentity: ({
			scope,
			scopeRef,
		}: {
			scope?: string
			scopeRef?: string
		}) => ({
			scope: scope ?? "agent",
			scopeRef: scopeRef ?? agentId,
		}),
		readConversationChunk: (
			rawPath: string,
			from?: number,
			lines?: number,
			session?: unknown,
		) => ops.readConversationChunk(rawPath, from, lines, session),
		readCanonicalEvent: (eventId: string, rawPath: string, session?: unknown) =>
			ops.readCanonicalEvent(eventId, rawPath, session),
		readBridgeChunk: (
			rawPath: string,
			from?: number,
			lines?: number,
			session?: unknown,
		) => ops.readBridgeChunk(rawPath, from, lines, session),
		readEpisodeLocator: (params: {
			rawPath: string
			episodeId: string
			expandEvents: boolean
			session?: unknown
		}) => ops.readEpisodeLocator(params),
	} as unknown as MongoDBManagerHost) as MongoDBManagerReadOps &
		SessionForwardingOps
	return ops
}

function seedGate(agentId: string, gate: Record<string, unknown>) {
	const id = `tenant-erasure-epoch:${agentId}`
	metaFake.gateDocs.set(id, { _id: id, agentId, ...gate })
}

function flipToErasing(epoch: number, runId: string) {
	return (doc: Record<string, unknown>) => {
		doc.epoch = epoch
		doc.state = "erasing"
		doc.erase = { runId, startedAt: new Date() }
	}
}

function flipToReopened(epoch: number) {
	return (doc: Record<string, unknown>) => {
		doc.epoch = epoch
		doc.state = "open"
		delete doc.erase
	}
}

/** The admission captures — findOneAndUpdate with $setOnInsert on the meta collection. */
function captureCalls() {
	return metaFake.calls.findOneAndUpdate.filter(
		(call) => call.update.$setOnInsert !== undefined,
	)
}

function expectSessionOn(
	records: Array<{ options?: Record<string, unknown> }>,
	session: unknown,
) {
	for (const [index, record] of records.entries()) {
		expect(
			record.options?.session,
			`read ${index} must run in the fence session`,
		).toBe(session)
	}
}

/**
 * The REAL buildUnexpiredClause shape (mongodb-temporal.ts:106-114): the
 * TTL/unexpired guard the branch filters must keep carrying.
 */
function expectUnexpiredTtl(clause: unknown) {
	expect(clause).toStrictEqual({
		$or: [
			{ expiresAt: { $exists: false } },
			{ expiresAt: { $gt: expect.any(Date) } },
		],
	})
}

function expectZeroTenantAccess() {
	for (const [name, collection] of Object.entries(collections.tenants)) {
		expect(collection.calls.findOne.length, `${name} findOne calls`).toBe(0)
		expect(collection.calls.find.length, `${name} find calls`).toBe(0)
		expect(collection.calls.updateOne.length, `${name} updateOne calls`).toBe(0)
	}
}

/** RED anchor for the U6(i) lane cases: one fenced call, one session, gate re-check in-session. */
function expectSingleFencedSession() {
	expect(fenceSeam.state.fenceCalls).toHaveLength(1)
	const session = fenceSeam.state.sessions[0]
	// C4: pin the expected count BEFORE the identity loop — an empty call
	// list must never satisfy a session assertion.
	expect(metaFake.calls.findOne).toHaveLength(1)
	expectSessionOn(metaFake.calls.findOne, session)
	return session
}

const STRUCTURED_LIVE = {
	_id: "s1",
	agentId: "agent-1",
	type: "fact",
	key: "sky",
	value: "blue",
}

const SUPPRESSED_STRUCTURED = {
	text: "",
	path: "structured:fact:sky",
	locator: "structured:fact:sky",
	source: "structured",
	sourceType: "structured",
}

/**
 * U8/C6 shape table (C6: BOTH describes run this SAME table): every branch
 * family's miss shape. The legacy reader's natural misses (U8) and the
 * suppressed classifier's output under admission/in-fence conflict (C6)
 * must agree on {text, path, locator, source, sourceType} with no
 * title/type/key extras. Outer whitespace trims to the same family shape
 * on both the legacy reader (readFile trims before dispatch,
 * mongodb-manager-read.ts:41-44) and the proposed classifier (plan §7
 * `rawPath.trim()`); `events/x` ≡ `conversation:events/x` pins the
 * conversation normalization (readConversationChunk strips ONE
 * `conversation:` prefix, mongodb-manager-read.ts:465-468) with no double
 * prefix.
 */
const SHAPE_TABLE: ReadonlyArray<{
	relPath: string
	path: string
	source: ManagerReadResult["source"]
}> = [
	{
		relPath: "structured:fact:sky",
		path: "structured:fact:sky",
		source: "structured",
	},
	{ relPath: "entity:ent-1", path: "entity:ent-1", source: "conversation" },
	{ relPath: "procedure:p1", path: "procedure:p1", source: "structured" },
	{ relPath: "event:evt-1", path: "event:evt-1", source: "conversation" },
	{ relPath: "episode:ep-1", path: "episode:ep-1", source: "conversation" },
	{ relPath: "relation:a-b", path: "relation:a-b", source: "conversation" },
	{ relPath: "kb:docs/x.md", path: "kb:docs/x.md", source: "reference" },
	{ relPath: "reference:x.md", path: "reference:x.md", source: "reference" },
	{
		relPath: "conversation:s/1",
		path: "conversation:s/1",
		source: "conversation",
	},
	{
		relPath: "events/evt-1",
		path: "conversation:events/evt-1",
		source: "conversation",
	},
	{
		relPath: "conversation:events/evt-1",
		path: "conversation:events/evt-1",
		source: "conversation",
	},
	{
		relPath: "conversation: sessions/x",
		path: "conversation:sessions/x",
		source: "conversation",
	},
	{
		relPath: "sessions/x",
		path: "conversation:sessions/x",
		source: "conversation",
	},
	{
		relPath: "bridge/fallthrough",
		path: "bridge/fallthrough",
		source: "reference",
	},
	{
		relPath: "  structured:fact:sky  ",
		path: "structured:fact:sky",
		source: "structured",
	},
	{
		relPath: "  events/evt-1  ",
		path: "conversation:events/evt-1",
		source: "conversation",
	},
]

beforeEach(() => {
	metaFake.reset()
	collections.reset()
	fenceSeam.reset()
})

// ---------------------------------------------------------------------------
// U1-U5: gate state machine vs the read
// ---------------------------------------------------------------------------

describe("fenced locator reads — gate state machine (U1-U5)", () => {
	it("U1: a gate already erasing at admission suppresses the read with zero tenant-data access", async () => {
		const ops = makeOps()
		seedGate("agent-1", {
			epoch: 1,
			state: "erasing",
			serial: 0,
			erase: { runId: "run-1", startedAt: new Date() },
		})
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])

		const result = await ops.readFile({ relPath: "structured:fact:sky" })

		// Behavior first: unchanged bytes serve the live record; fenced bytes
		// return the classifier miss shape with no title/type/key extras.
		expect(result).toStrictEqual(SUPPRESSED_STRUCTURED)
		// The suppression happens at admission — no tenant-data read at all.
		expectZeroTenantAccess()
		expect(captureCalls()).toHaveLength(1)
		expect(fenceSeam.state.fenceCalls).toHaveLength(0)
	})

	it("U2: a gate flipped to erasing between admission and the fence conflicts before any branch read", async () => {
		const ops = makeOps()
		seedGate("agent-1", { epoch: 5, state: "open", serial: 0 })
		metaFake.setFlipOnCapture(flipToErasing(6, "run-2"))
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])

		const result = await ops.readFile({ relPath: "structured:fact:sky" })

		expect(result).toStrictEqual(SUPPRESSED_STRUCTURED)
		expectZeroTenantAccess()
		// C1: the capture admitted the PRE-FLIP snapshot (open epoch 5) —
		// the token carries epoch 5 — and the stored gate the fence
		// re-checked had already flipped to erasing(6).
		expect(captureCalls()).toHaveLength(1)
		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		expect(fenceSeam.state.fenceCalls[0]?.token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{ epoch: 6, state: "erasing" },
		)
		// the actual in-fence gate read ran, inside the fence session
		expect(metaFake.calls.findOne).toHaveLength(1)
		expectSessionOn(metaFake.calls.findOne, fenceSeam.state.sessions[0])
	})

	it("U2b: a gate reopened at a newer epoch between admission and the fence conflicts, never recaptures", async () => {
		const ops = makeOps()
		seedGate("agent-1", { epoch: 5, state: "open", serial: 0 })
		metaFake.setFlipOnCapture(flipToReopened(7))
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])

		const result = await ops.readFile({ relPath: "structured:fact:sky" })

		expect(result).toStrictEqual(SUPPRESSED_STRUCTURED)
		expectZeroTenantAccess()
		// exactly one admission — a reopened gate must not trigger a fresh capture
		expect(captureCalls()).toHaveLength(1)
		// C1: the ORIGINAL token (captured at open epoch 5) conflicts with
		// the reopened-at-7 stored gate at the in-fence re-check.
		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		expect(fenceSeam.state.fenceCalls[0]?.token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{ epoch: 7, state: "open" },
		)
		expect(metaFake.calls.findOne).toHaveLength(1)
		expectSessionOn(metaFake.calls.findOne, fenceSeam.state.sessions[0])
	})

	it("U3: a missing gate is initialized open(0) by the real $setOnInsert upsert, then the read serves and the touch commits once", async () => {
		const ops = makeOps()
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])
		collections.tenants.structured.seed({ _id: "s1", openedCount: 0 })

		const result = await ops.readFile({ relPath: "structured:fact:sky" })

		// Passing-control half: both old and new bytes serve the live record.
		expect(result.text).toContain("value: blue")
		// RED half: the gate document must exist, open at epoch 0, created by
		// the real captureAdmissionToken upsert against the fake meta store.
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{
				agentId: "agent-1",
				epoch: 0,
				state: "open",
			},
		)
		expect(captureCalls()).toHaveLength(1)
		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		// the openedCount touch commits exactly once
		expect(collections.tenants.structured.calls.updateOne).toHaveLength(1)
		expect(collections.tenants.structured.store.get("s1")?.openedCount).toBe(1)
	})

	it("U4a: a malformed stored gate at admission fails loudly, never a silent miss", async () => {
		const ops = makeOps()
		seedGate("agent-1", { epoch: "x", state: "open" })
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])

		await expect(
			ops.readFile({ relPath: "structured:fact:sky" }),
		).rejects.toBeInstanceOf(MalformedGateError)

		expectZeroTenantAccess()
	})

	it("U4b: a gate that turns malformed between admission and the fence re-check fails loudly", async () => {
		const ops = makeOps()
		seedGate("agent-1", { epoch: 5, state: "open", serial: 0 })
		metaFake.setFlipOnCapture((doc) => {
			doc.epoch = "x"
		})
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])

		await expect(
			ops.readFile({ relPath: "structured:fact:sky" }),
		).rejects.toBeInstanceOf(MalformedGateError)

		expectZeroTenantAccess()
		expect(captureCalls()).toHaveLength(1)
		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		// C1: the capture admitted the PRE-FLIP snapshot; the malformed gate
		// was observed by the in-fence re-check of the STORED entry.
		expect(fenceSeam.state.fenceCalls[0]?.token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{ epoch: "x" },
		)
		expect(metaFake.calls.findOne).toHaveLength(1)
		expectSessionOn(metaFake.calls.findOne, fenceSeam.state.sessions[0])
	})

	it("U5: an in-fence conflict never reads the kb document, so a stored title cannot leak", async () => {
		const ops = makeOps()
		seedGate("agent-1", { epoch: 0, state: "open", serial: 0 })
		metaFake.setFlipOnCapture(flipToErasing(1, "run-3"))
		collections.tenants.kb.scriptFindOne([
			{
				_id: "k1",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent-1",
				source: { path: "docs/handbook.md" },
				title: "Leaked Title",
				content: "",
			},
		])

		const result = await ops.readFile({ relPath: "kb:docs/handbook.md" })

		// Unchanged bytes serve the record with its title — the empty-text
		// leak class. Fenced bytes return the reference miss shape.
		expect(result).toStrictEqual({
			text: "",
			path: "kb:docs/handbook.md",
			locator: "kb:docs/handbook.md",
			source: "reference",
			sourceType: "reference",
		})
		expect(collections.tenants.kb.calls.findOne).toHaveLength(0)
		expectZeroTenantAccess()
		// C1: the capture admitted the PRE-FLIP snapshot (open epoch 0); the
		// kb read was suppressed by the in-fence re-check of the flipped
		// stored gate — nothing ever read the document or its title.
		expect(captureCalls()).toHaveLength(1)
		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		expect(fenceSeam.state.fenceCalls[0]?.token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{ epoch: 1, state: "erasing" },
		)
		expect(metaFake.calls.findOne).toHaveLength(1)
		expectSessionOn(metaFake.calls.findOne, fenceSeam.state.sessions[0])
	})
})

// ---------------------------------------------------------------------------
// U6(i): every read lane runs inside the one fence session
// ---------------------------------------------------------------------------

describe("fenced locator reads — per-lane session identity (U6 i)", () => {
	it("structured lane: findOne, the openedCount touch, and the unexpired guard all run in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])
		collections.tenants.structured.seed({ _id: "s1", openedCount: 0 })

		const result = await ops.readFile({ relPath: "structured:fact:sky" })

		const session = expectSingleFencedSession()
		expect(result.text).toContain("value: blue")
		// C4: expected call counts BEFORE the identity loops — an empty call
		// list must never satisfy a session assertion.
		expect(collections.tenants.structured.calls.findOne).toHaveLength(1)
		expect(collections.tenants.structured.calls.updateOne).toHaveLength(1)
		expectSessionOn(collections.tenants.structured.calls.findOne, session)
		expectSessionOn(collections.tenants.structured.calls.updateOne, session)
		// the C-005 unexpired guard and the tenant scoping survive the fence plumbing
		const filter = collections.tenants.structured.calls.findOne[0]
			?.filter as Record<string, unknown>
		expect(filter).toMatchObject({
			agentId: "agent-1",
			type: "fact",
			key: "sky",
		})
		// the actual TTL/unexpired clause (buildUnexpiredClause,
		// mongodb-temporal.ts:106-114) — not just "some $or array"
		expectUnexpiredTtl({ $or: filter.$or })
	})

	it("procedure lane: findOne and the openedCount touch run in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.procedures.scriptFindOne([
			{
				_id: "p1",
				agentId: "agent-1",
				procedureId: "p1",
				name: "Deploy checklist",
			},
		])
		collections.tenants.procedures.seed({ _id: "p1", openedCount: 0 })

		const result = await ops.readFile({ relPath: "procedure:p1" })

		const session = expectSingleFencedSession()
		expect(result.text).toContain("procedureId: p1")
		expect(collections.tenants.procedures.calls.findOne).toHaveLength(1)
		expect(collections.tenants.procedures.calls.updateOne).toHaveLength(1)
		expectSessionOn(collections.tenants.procedures.calls.findOne, session)
		expectSessionOn(collections.tenants.procedures.calls.updateOne, session)
		// the tenant scoping survives the fence plumbing
		const filter = collections.tenants.procedures.calls.findOne[0]
			?.filter as Record<string, unknown>
		expect(filter).toMatchObject({
			agentId: "agent-1",
			procedureId: "p1",
		})
	})

	it("entity lane: findOne runs in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.entities.scriptFindOne([
			{ _id: "e1", agentId: "agent-1", entityId: "ent-1", name: "Milky Way" },
		])

		const result = await ops.readFile({ relPath: "entity:ent-1" })

		const session = expectSingleFencedSession()
		expect(result.text).toContain("name: Milky Way")
		expect(collections.tenants.entities.calls.findOne).toHaveLength(1)
		expectSessionOn(collections.tenants.entities.calls.findOne, session)
		// the tenant scoping survives the fence plumbing
		const filter = collections.tenants.entities.calls.findOne[0]
			?.filter as Record<string, unknown>
		expect(filter).toMatchObject({ agentId: "agent-1", entityId: "ent-1" })
	})

	it("kb lane: the identity-scoped findOne runs in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.kb.scriptFindOne([
			{
				_id: "k1",
				agentId: "agent-1",
				scope: "agent",
				scopeRef: "agent-1",
				source: { path: "docs/handbook.md" },
				title: "Handbook",
				content: "Galaxy classification guide",
			},
		])

		const result = await ops.readFile({ relPath: "kb:docs/handbook.md" })

		const session = expectSingleFencedSession()
		expect(result.text).toBe("Galaxy classification guide")
		expect(collections.tenants.kb.calls.findOne).toHaveLength(1)
		expectSessionOn(collections.tenants.kb.calls.findOne, session)
		const filter = collections.tenants.kb.calls.findOne[0]?.filter as Record<
			string,
			unknown
		>
		// the C-035 tenant scoping AND the identity triple's $or arms survive
		// the fence plumbing — path match and title match on the same
		// kbPath (mongodb-manager-read.ts:417-422)
		expect(filter).toMatchObject({
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
		})
		expect(filter.$or).toStrictEqual([
			{ "source.path": "docs/handbook.md" },
			{ title: "docs/handbook.md" },
		])
	})

	it("episode lane: the episode findOne runs in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.episodes.scriptFindOne([
			{
				_id: "ep1",
				agentId: "agent-1",
				episodeId: "ep-1",
				title: "Onboarding",
				summary: "First session",
			},
		])

		const result = await ops.readFile({ relPath: "episode:ep-1" })

		const session = expectSingleFencedSession()
		expect(result.text).toContain("episodeId: ep-1")
		expect(collections.tenants.episodes.calls.findOne).toHaveLength(1)
		expectSessionOn(collections.tenants.episodes.calls.findOne, session)
		// the status ≠ deleted clause survives the fence plumbing
		const filter = collections.tenants.episodes.calls.findOne[0]
			?.filter as Record<string, unknown>
		expect(filter).toMatchObject({
			agentId: "agent-1",
			episodeId: "ep-1",
			status: { $ne: "deleted" },
		})
	})

	it("episode expand lane: the episode findOne and the events find run in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.episodes.scriptFindOne([
			{
				_id: "ep1",
				agentId: "agent-1",
				episodeId: "ep-1",
				sourceEventIds: ["e1", "e2"],
			},
		])
		collections.tenants.events.scriptFind([
			[
				{ eventId: "e1", role: "user", body: "hello" },
				{ eventId: "e2", role: "assistant", body: "hi" },
			],
		])

		const result = await ops.readFile({ relPath: "episode:ep-1?expand=events" })

		const session = expectSingleFencedSession()
		expect(result.text).toContain("sourceEvents:")
		expect(collections.tenants.episodes.calls.findOne).toHaveLength(1)
		expect(collections.tenants.events.calls.find).toHaveLength(1)
		expectSessionOn(collections.tenants.episodes.calls.findOne, session)
		expectSessionOn(collections.tenants.events.calls.find, session)
		// the expand-events filter keeps the tenant scope and the TTL guard
		const filter = collections.tenants.events.calls.find[0]?.filter as Record<
			string,
			unknown
		>
		expect(filter).toMatchObject({
			agentId: "agent-1",
			eventId: { $in: ["e1", "e2"] },
		})
		expectUnexpiredTtl({ $or: filter.$or })
	})

	it("conversation lane: the chunks find runs in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.chunks.scriptFind([
			[{ path: "s/1", text: "hello transcript", startLine: 1, endLine: 5 }],
		])

		const result = await ops.readFile({ relPath: "conversation:s/1" })

		const session = expectSingleFencedSession()
		expect(result.text).toBe("hello transcript")
		expect(result.path).toBe("conversation:s/1")
		expect(collections.tenants.chunks.calls.find).toHaveLength(1)
		expectSessionOn(collections.tenants.chunks.calls.find, session)
		const filter = collections.tenants.chunks.calls.find[0]?.filter as Record<
			string,
			unknown
		>
		// the conversation scoping — path, tenant, source lanes — survives
		// the fence plumbing (mongodb-manager-read.ts:477-505)
		expect(filter).toMatchObject({
			path: "s/1",
			agentId: "agent-1",
			source: { $in: ["sessions", "conversation"] },
		})
		// no from/lines range clause, so $and carries exactly the TTL guard
		expect(filter.$and).toHaveLength(1)
		expectUnexpiredTtl((filter.$and as unknown[])[0])
	})

	it("events fallback lane: the chunks find and the canonical-event findOne run in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.chunks.scriptFind([[]])
		collections.tenants.events.scriptFindOne([null])

		const result = await ops.readFile({ relPath: "events/evt-1" })

		const session = expectSingleFencedSession()
		expect(result).toStrictEqual({
			text: "",
			path: "conversation:events/evt-1",
			locator: "conversation:events/evt-1",
			source: "conversation",
			sourceType: "conversation",
		})
		expect(collections.tenants.chunks.calls.find).toHaveLength(1)
		expect(collections.tenants.events.calls.findOne).toHaveLength(1)
		expectSessionOn(collections.tenants.chunks.calls.find, session)
		expectSessionOn(collections.tenants.events.calls.findOne, session)
		// the fallback chunks read keeps its scoping and the TTL guard
		const chunksFilter = collections.tenants.chunks.calls.find[0]
			?.filter as Record<string, unknown>
		expect(chunksFilter).toMatchObject({
			path: "events/evt-1",
			agentId: "agent-1",
			source: { $in: ["sessions", "conversation"] },
		})
		expect(chunksFilter.$and).toHaveLength(1)
		expectUnexpiredTtl((chunksFilter.$and as unknown[])[0])
		// and the canonical-event fallback read keeps its own TTL guard
		const eventFilter = collections.tenants.events.calls.findOne[0]
			?.filter as Record<string, unknown>
		expect(eventFilter).toMatchObject({ agentId: "agent-1", eventId: "evt-1" })
		expectUnexpiredTtl({ $or: eventFilter.$or })
	})

	it("bridge lane: the workspace-scoped chunks find runs in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.chunks.scriptFind([
			[
				{
					path: "bridge/notes.md",
					text: "bridge body",
					startLine: 1,
					endLine: 2,
				},
			],
		])

		const result = await ops.readFile({ relPath: "bridge/notes.md" })

		const session = expectSingleFencedSession()
		expect(result.text).toBe("bridge body")
		expect(collections.tenants.chunks.calls.find).toHaveLength(1)
		expectSessionOn(collections.tenants.chunks.calls.find, session)
		const filter = collections.tenants.chunks.calls.find[0]?.filter as Record<
			string,
			unknown
		>
		// the bridge workspace scoping — path, tenant, source lanes, scope —
		// survives the fence plumbing (mongodb-manager-read.ts:578-605)
		expect(filter).toMatchObject({
			path: "bridge/notes.md",
			agentId: "agent-1",
			source: { $in: ["conversation", "memory"] },
			scope: "workspace",
			scopeRef: "ws-1",
		})
		expect(filter.$and).toHaveLength(1)
		expectUnexpiredTtl((filter.$and as unknown[])[0])
	})

	it("relation lane: the real findRelationByLocatorId reads run in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.relations.scriptFindOne([
			{
				_id: "r1",
				agentId: "agent-1",
				relationId: "ent-a-ent-b",
				fromEntityId: "ent-a",
				toEntityId: "ent-b",
				type: "similar_to",
			},
		])

		const result = await ops.readFile({ relPath: "relation:ent-a-ent-b" })

		const session = expectSingleFencedSession()
		expect(result.text).toContain("fromEntityId: ent-a")
		expect(collections.tenants.relations.calls.findOne).toHaveLength(1)
		expectSessionOn(collections.tenants.relations.calls.findOne, session)
		// the typed locator read keeps its scoped filter
		// (mongodb-graph.ts:2385-2391) — the session claim for all three
		// relation read sites lives in the frozen graph spec
		const filter = collections.tenants.relations.calls.findOne[0]
			?.filter as Record<string, unknown>
		expect(filter).toMatchObject({
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
		})
	})

	it("event hit lane: a direct event: hit through readFile runs the canonical-event findOne in the fence session", async () => {
		const ops = makeOps()
		collections.tenants.events.scriptFindOne([
			{
				_id: "ev1",
				agentId: "agent-1",
				eventId: "evt-1",
				role: "user",
				body: "hello",
			},
		])

		const result = await ops.readFile({ relPath: "event:evt-1" })

		const session = expectSingleFencedSession()
		expect(result.text).toBe("user: hello")
		expect(result.type).toBe("event")
		expect(result.key).toBe("evt-1")
		expect(collections.tenants.events.calls.findOne).toHaveLength(1)
		expectSessionOn(collections.tenants.events.calls.findOne, session)
		// the canonical-event filter keeps the tenant scope and TTL guard
		const filter = collections.tenants.events.calls.findOne[0]
			?.filter as Record<string, unknown>
		expect(filter).toMatchObject({ agentId: "agent-1", eventId: "evt-1" })
		expectUnexpiredTtl({ $or: filter.$or })
	})
})

// ---------------------------------------------------------------------------
// U7: transient retry semantics
// ---------------------------------------------------------------------------

describe("fenced locator reads — transient retry (U7)", () => {
	it("U7a: one transient commit failure retries once; the retry's read is served with a single committed touch", async () => {
		const ops = makeOps()
		collections.tenants.structured.seed({ _id: "s1", openedCount: 0 })
		collections.tenants.structured.scriptFindOne([
			{
				_id: "s1",
				agentId: "agent-1",
				type: "fact",
				key: "sky",
				value: "attempt-1",
			},
			{
				_id: "s1",
				agentId: "agent-1",
				type: "fact",
				key: "sky",
				value: "attempt-2",
			},
		])
		fenceSeam.knobs.transientOnce = true

		const result = await ops.readFile({ relPath: "structured:fact:sky" })

		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		expect(fenceSeam.state.attempts).toBe(2)
		// the retry observes attempt 2's document, not attempt 1's
		expect(result.text).toContain("value: attempt-2")
		// exactly one admission capture — never recaptured across the retry
		expect(captureCalls()).toHaveLength(1)
		// one touch per attempt, but only the committed attempt counts
		expect(collections.tenants.structured.calls.updateOne).toHaveLength(2)
		expect(collections.tenants.structured.store.get("s1")?.openedCount).toBe(1)
		// every attempt's reads ran in the one fence session
		const session = fenceSeam.state.sessions[0]
		expectSessionOn(collections.tenants.structured.calls.findOne, session)
		expectSessionOn(collections.tenants.structured.calls.updateOne, session)
		// C3: the ONE injected transient was spent (knob consumed), and both
		// attempts reused the ONE retry session
		expect(fenceSeam.knobs.transientOnce).toBe(false)
		expect(fenceSeam.state.sessions).toHaveLength(1)
	})

	it("U7b: a retry that observes the gate erasing conflicts — the read is suppressed, the discarded touch never counts", async () => {
		const ops = makeOps()
		seedGate("agent-1", { epoch: 5, state: "open", serial: 0 })
		collections.tenants.structured.seed({ _id: "s1", openedCount: 0 })
		collections.tenants.structured.scriptFindOne([
			{
				_id: "s1",
				agentId: "agent-1",
				type: "fact",
				key: "sky",
				value: "blue",
			},
		])
		fenceSeam.knobs.transientOnce = true
		// C3: the flip mutates the STORED gate entry the in-fence re-check
		// reads — flipToErasing itself is a doc-mutation helper, so wrap it.
		collections.attempt.flipOnStage = (gateDocs) => {
			const doc = gateDocs.get("tenant-erasure-epoch:agent-1")
			if (doc) {
				flipToErasing(6, "run-4")(doc)
			}
		}

		const result = await ops.readFile({ relPath: "structured:fact:sky" })

		expect(result).toStrictEqual(SUPPRESSED_STRUCTURED)
		expect(fenceSeam.state.attempts).toBe(2)
		expect(captureCalls()).toHaveLength(1)
		// C3: the retry conflicts against the ORIGINAL token — the stored
		// gate it re-checked had flipped to erasing(6); never recaptured.
		expect(fenceSeam.state.fenceCalls[0]?.token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{ epoch: 6, state: "erasing" },
		)
		// the gate re-check ran inside the fence on BOTH attempts — attempt 1
		// saw open(5), the retry saw erasing(6)
		expect(metaFake.calls.findOne).toHaveLength(2)
		// exactly one tenant read (attempt 1) ran before the retry conflict
		expect(collections.tenants.structured.calls.findOne).toHaveLength(1)
		expectSessionOn(
			collections.tenants.structured.calls.findOne,
			fenceSeam.state.sessions[0],
		)
		// attempt 1 issued its touch, but the transient discard means it was
		// never acknowledged — the store must not count it
		expect(collections.tenants.structured.calls.updateOne).toHaveLength(1)
		expect(
			collections.tenants.structured.store.get("s1")?.openedCount ?? 0,
		).toBe(0)
		// C3: the ONE injected transient was spent (knob consumed), and both
		// attempts' gate re-checks ran in the ONE retry session
		expect(fenceSeam.knobs.transientOnce).toBe(false)
		expect(fenceSeam.state.sessions).toHaveLength(1)
		expectSessionOn(metaFake.calls.findOne, fenceSeam.state.sessions[0])
	})

	it("U7c: a retry that observes the gate reopened at a newer epoch conflicts — never recaptures", async () => {
		const ops = makeOps()
		seedGate("agent-1", { epoch: 5, state: "open", serial: 0 })
		collections.tenants.structured.seed({ _id: "s1", openedCount: 0 })
		collections.tenants.structured.scriptFindOne([
			{
				_id: "s1",
				agentId: "agent-1",
				type: "fact",
				key: "sky",
				value: "blue",
			},
		])
		fenceSeam.knobs.transientOnce = true
		collections.attempt.flipOnStage = (gateDocs) => {
			const doc = gateDocs.get("tenant-erasure-epoch:agent-1")
			if (doc) {
				flipToReopened(7)(doc)
			}
		}

		const result = await ops.readFile({ relPath: "structured:fact:sky" })

		expect(result).toStrictEqual(SUPPRESSED_STRUCTURED)
		expect(fenceSeam.state.attempts).toBe(2)
		expect(captureCalls()).toHaveLength(1)
		// C3: the retry conflicts against the ORIGINAL token — the stored
		// gate it re-checked had reopened at epoch 7; never recaptured.
		expect(fenceSeam.state.fenceCalls[0]?.token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{ epoch: 7, state: "open" },
		)
		// the gate re-check ran inside the fence on BOTH attempts — attempt 1
		// saw open(5), the retry saw open(7) ≠ token epoch 5
		expect(metaFake.calls.findOne).toHaveLength(2)
		// exactly one tenant read (attempt 1) ran before the retry conflict
		expect(collections.tenants.structured.calls.findOne).toHaveLength(1)
		expectSessionOn(
			collections.tenants.structured.calls.findOne,
			fenceSeam.state.sessions[0],
		)
		expect(
			collections.tenants.structured.store.get("s1")?.openedCount ?? 0,
		).toBe(0)
		// C3: attempt 1 DID attempt its touch once (updateOne fired) even
		// though the reopened-epoch retry conflict suppressed the read —
		// pin it exactly like U7b so "no touch" can never pass vacuously
		expect(collections.tenants.structured.calls.updateOne).toHaveLength(1)
		// C3: the ONE injected transient was spent (knob consumed), and both
		// attempts' gate re-checks ran in the ONE retry session
		expect(fenceSeam.knobs.transientOnce).toBe(false)
		expect(fenceSeam.state.sessions).toHaveLength(1)
		expectSessionOn(metaFake.calls.findOne, fenceSeam.state.sessions[0])
	})
})

// ---------------------------------------------------------------------------
// U8: passing controls — legacy miss shapes stay byte-identical
// ---------------------------------------------------------------------------

describe("fenced locator reads — legacy miss-shape controls (U8)", () => {
	it.each(
		SHAPE_TABLE,
	)("control: $relPath misses with the family miss shape and no title/type/key extras", async ({
		relPath,
		path,
		source,
	}) => {
		const ops = makeOps()

		const result = await ops.readFile({ relPath })

		expect(result).toStrictEqual({
			text: "",
			path,
			locator: path,
			source,
			sourceType: source,
		})
	})

	it("control: an empty path throws before any gate work", async () => {
		const ops = makeOps()

		await expect(ops.readFile({ relPath: "   " })).rejects.toThrow(
			"path required",
		)

		expect(metaFake.calls.findOneAndUpdate).toHaveLength(0)
	})

	it("control: a branch read failure propagates instead of a fabricated miss", async () => {
		const ops = makeOps()
		collections.tenants.structured.scriptFindOne([
			new Error("branch read boom"),
		])

		await expect(
			ops.readFile({ relPath: "structured:fact:sky" }),
		).rejects.toThrow("branch read boom")
	})
})

// ---------------------------------------------------------------------------
// C6: the SAME SHAPE_TABLE under erasure conflict — suppressed output must
// equal the legacy miss shape, with zero tenant access, across every
// branch family. The admission rows conflict at capture (erasing gate
// stored); the in-fence rows conflict at the gate re-check (the stored
// gate flips after the capture admitted the pre-flip snapshot).
// ---------------------------------------------------------------------------

describe("fenced locator reads — miss shapes under erasure conflict (C6)", () => {
	it.each(
		SHAPE_TABLE,
	)("admission conflict: $relPath suppresses with the family miss shape and zero tenant access", async ({
		relPath,
		path,
		source,
	}) => {
		const ops = makeOps()
		seedGate("agent-1", {
			epoch: 3,
			state: "erasing",
			serial: 0,
			erase: { runId: "run-c6-a", startedAt: new Date() },
		})

		const result = await ops.readFile({ relPath })

		expect(result).toStrictEqual({
			text: "",
			path,
			locator: path,
			source,
			sourceType: source,
		})
		expectZeroTenantAccess()
		expect(captureCalls()).toHaveLength(1)
	})

	it.each(
		SHAPE_TABLE,
	)("in-fence conflict: $relPath suppresses with the family miss shape and zero tenant access", async ({
		relPath,
		path,
		source,
	}) => {
		const ops = makeOps()
		seedGate("agent-1", { epoch: 3, state: "open", serial: 0 })
		metaFake.setFlipOnCapture(flipToErasing(4, "run-c6-b"))

		const result = await ops.readFile({ relPath })

		expect(result).toStrictEqual({
			text: "",
			path,
			locator: path,
			source,
			sourceType: source,
		})
		expectZeroTenantAccess()
		expect(captureCalls()).toHaveLength(1)
		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
	})
})

// ---------------------------------------------------------------------------
// U9: indeterminate commits and driver failures fail closed
// ---------------------------------------------------------------------------

describe("fenced locator reads — indeterminate commits (U9)", () => {
	it.each([
		{ disposition: "staged writes applied", applyStaged: true },
		{ disposition: "staged writes discarded", applyStaged: false },
	])("U9: an indeterminate commit fails closed ($disposition) — the exact error, no fabricated miss, no fresh-token retry", async ({
		applyStaged,
	}) => {
		const ops = makeOps()
		collections.tenants.structured.seed({ _id: "s1", openedCount: 0 })
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])
		const injected = new Error(
			"indeterminate commit: touch outcome unknown after write-concern timeout",
		)
		// C5: a real indeterminate commit leaves the persisted-touch
		// outcome UNKNOWN, so BOTH dispositions are played by the
		// fixture — neither is claimed as the driver's real behavior.
		fenceSeam.knobs.failCommitOnce = { error: injected, applyStaged }

		const error = await ops
			.readFile({
				relPath: "structured:fact:sky",
			})
			.then(
				() => null,
				(err: unknown) => err,
			)

		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		// the EXACT injected error propagates — never wrapped, never a
		// fabricated miss
		expect(error).toBe(injected)
		// no fresh-token retry, no recapture — indeterminate is terminal
		expect(captureCalls()).toHaveLength(1)
		expect(fenceSeam.state.attempts).toBe(1)
		// the scripted disposition played out on the staged writes (the
		// store reflects it), but the read still fails closed either way
		const openedCount =
			collections.tenants.structured.store.get("s1")?.openedCount ?? 0
		expect(openedCount).toBe(applyStaged ? 1 : 0)
		// C5: the ONE injected commit fault was actually fired and consumed
		// (knob reset to null) — neither disposition can pass without the
		// fault firing exactly once
		expect(fenceSeam.knobs.failCommitOnce).toBeNull()
	})

	it("U9: a fence commit driver failure propagates, never a silent serve", async () => {
		const ops = makeOps()
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])
		const injected = new Error("driver connection failure during commit")
		fenceSeam.knobs.failCommitOnce = { error: injected, applyStaged: false }

		await expect(ops.readFile({ relPath: "structured:fact:sky" })).rejects.toBe(
			injected,
		)

		expect(captureCalls()).toHaveLength(1)
		// C5: the injected commit fault fired once and was consumed
		expect(fenceSeam.knobs.failCommitOnce).toBeNull()
	})

	it("U9: a capture-site driver failure propagates — only typed erasure conflicts become misses", async () => {
		const ops = makeOps()
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])
		metaFake.knobs.failNextCapture = new Error(
			"driver error during admission capture",
		)

		await expect(
			ops.readFile({ relPath: "structured:fact:sky" }),
		).rejects.toThrow("driver error during admission capture")

		expectZeroTenantAccess()
	})
})

// ---------------------------------------------------------------------------
// C1/C2/C4: PASSING harness controls — no product code under test. These pin
// the FAKE's gate semantics against the REAL primitives, so a harness bug
// cannot masquerade as a product RED.
// ---------------------------------------------------------------------------

describe("fenced locator reads — harness controls (C1/C2/C4)", () => {
	it("C1 control: the REAL captureAdmissionToken conflicts on a stored erasing gate", async () => {
		seedGate("agent-1", {
			epoch: 2,
			state: "erasing",
			serial: 0,
			erase: { runId: "run-c1", startedAt: new Date() },
		})

		await expect(
			captureAdmissionToken({
				db: FAKE_DB,
				prefix: "t_",
				agentId: "agent-1",
			}),
		).rejects.toBeInstanceOf(ErasureGateConflictError)

		expect(captureCalls()).toHaveLength(1)
	})

	it("C1 control: the REAL captureAdmissionToken admits a stored open gate at its epoch", async () => {
		seedGate("agent-1", { epoch: 9, state: "open", serial: 0 })

		const token = await captureAdmissionToken({
			db: FAKE_DB,
			prefix: "t_",
			agentId: "agent-1",
		})

		expect(token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 9,
		})
	})

	it("C1 control: the REAL captureAdmissionToken initializes a missing gate open(0) via the $setOnInsert upsert", async () => {
		const token = await captureAdmissionToken({
			db: FAKE_DB,
			prefix: "t_",
			agentId: "agent-1",
		})

		expect(token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 0,
		})
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{ epoch: 0, state: "open" },
		)
	})

	it("C1 control: the REAL captureAdmissionToken fails loudly on a malformed stored gate", async () => {
		seedGate("agent-1", { epoch: "x", state: "open" })

		await expect(
			captureAdmissionToken({
				db: FAKE_DB,
				prefix: "t_",
				agentId: "agent-1",
			}),
		).rejects.toBeInstanceOf(MalformedGateError)
	})

	it("C2 control: reset clears an unconsumed scripted findOne — a later case reads a natural miss", async () => {
		collections.tenants.structured.scriptFindOne([STRUCTURED_LIVE])

		collections.reset()

		const ops = makeOps()
		const result = await ops.readFile({ relPath: "structured:fact:sky" })

		// the scripted live record did NOT survive the reset — the natural
		// miss shape comes back, and no stale call records remain
		expect(result).toStrictEqual(SUPPRESSED_STRUCTURED)
		expect(collections.tenants.structured.calls.findOne).toHaveLength(1)
	})

	it("C1 control: capture admits open(5), the stored gate flips erasing(6) — the DIRECT fence call conflicts at the re-check", async () => {
		seedGate("agent-1", { epoch: 5, state: "open", serial: 0 })
		// the flip fires during the capture but mutates only the STORED
		// entry — the capture still admits the pre-flip open(5) snapshot
		metaFake.setFlipOnCapture(flipToErasing(6, "run-c1-t1"))

		const token = await captureAdmissionToken({
			db: FAKE_DB,
			prefix: "t_",
			agentId: "agent-1",
		})
		expect(token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})

		let callbackRuns = 0
		await expect(
			withFencedWrite({
				db: FAKE_DB,
				prefix: "t_",
				token,
				fn: async () => {
					callbackRuns++
					return "callback-ran"
				},
			}),
		).rejects.toBeInstanceOf(ErasureGateConflictError)

		// the ORIGINAL open(5) token is unchanged — never recaptured
		expect(token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})
		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		// the STORED gate is the flipped erasing(6) the re-check observed
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{ epoch: 6, state: "erasing" },
		)
		// exactly ONE in-session gate re-check ran before the conflict —
		// the serial admission updateOne never fired
		expect(metaFake.calls.findOne).toHaveLength(1)
		expect(metaFake.calls.updateOne).toHaveLength(0)
		expect(fenceSeam.state.sessions).toHaveLength(1)
		expectSessionOn(metaFake.calls.findOne, fenceSeam.state.sessions[0])
		// the callback never ran and no tenant collection was touched
		expect(callbackRuns).toBe(0)
		expectZeroTenantAccess()
	})

	it("C1 control: capture admits open(5), the gate reopens at epoch 7 — the DIRECT fence call conflicts, never recaptures", async () => {
		seedGate("agent-1", { epoch: 5, state: "open", serial: 0 })
		metaFake.setFlipOnCapture(flipToReopened(7))

		const token = await captureAdmissionToken({
			db: FAKE_DB,
			prefix: "t_",
			agentId: "agent-1",
		})
		expect(token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})

		let callbackRuns = 0
		await expect(
			withFencedWrite({
				db: FAKE_DB,
				prefix: "t_",
				token,
				fn: async () => {
					callbackRuns++
					return "callback-ran"
				},
			}),
		).rejects.toBeInstanceOf(ErasureGateConflictError)

		// the ORIGINAL open(5) token is unchanged — the reopen to epoch 7
		// does NOT trigger a recapture
		expect(token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})
		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		// the STORED gate is the reopened open(7) the re-check observed
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{ epoch: 7, state: "open" },
		)
		// exactly ONE in-session gate re-check ran before the conflict —
		// open(7) ≠ token epoch 5 conflicts, and the serial updateOne
		// never fired
		expect(metaFake.calls.findOne).toHaveLength(1)
		expect(metaFake.calls.updateOne).toHaveLength(0)
		expect(fenceSeam.state.sessions).toHaveLength(1)
		expectSessionOn(metaFake.calls.findOne, fenceSeam.state.sessions[0])
		expect(callbackRuns).toBe(0)
		expectZeroTenantAccess()
	})

	it("C1 control: capture admits open(5), the stored gate goes malformed — the DIRECT fence call fails loudly at the re-check", async () => {
		seedGate("agent-1", { epoch: 5, state: "open", serial: 0 })
		metaFake.setFlipOnCapture((doc) => {
			doc.epoch = "x"
		})

		const token = await captureAdmissionToken({
			db: FAKE_DB,
			prefix: "t_",
			agentId: "agent-1",
		})
		expect(token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})

		let callbackRuns = 0
		await expect(
			withFencedWrite({
				db: FAKE_DB,
				prefix: "t_",
				token,
				fn: async () => {
					callbackRuns++
					return "callback-ran"
				},
			}),
		).rejects.toBeInstanceOf(MalformedGateError)

		// the ORIGINAL open(5) token is unchanged
		expect(token).toStrictEqual({
			kind: "admission",
			agentId: "agent-1",
			epoch: 5,
		})
		expect(fenceSeam.state.fenceCalls).toHaveLength(1)
		// the STORED gate is the malformed doc the re-check failed to parse
		expect(metaFake.gateDocs.get("tenant-erasure-epoch:agent-1")).toMatchObject(
			{
				epoch: "x",
				state: "open",
			},
		)
		// exactly ONE in-session gate re-check ran before the malformed
		// rejection — the serial admission updateOne never fired
		expect(metaFake.calls.findOne).toHaveLength(1)
		expect(metaFake.calls.updateOne).toHaveLength(0)
		expect(fenceSeam.state.sessions).toHaveLength(1)
		expectSessionOn(metaFake.calls.findOne, fenceSeam.state.sessions[0])
		expect(callbackRuns).toBe(0)
		expectZeroTenantAccess()
	})

	it("C4 control: expectUnexpiredTtl pins the REAL buildUnexpiredClause output", () => {
		// the branch filters spread this exact clause object
		// (mongodb-manager-read.ts:66-75,535-541) — pin the real builder's
		// product, not a handwritten lookalike
		expectUnexpiredTtl(buildUnexpiredClause())
	})
})
