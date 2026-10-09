// KB auto-refresh markers are isolated by owner.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Db } from "mongodb"
import { MongoDBManagerSyncOps } from "./mongodb-manager-sync.js"
import { ingestFilesToKB } from "./mongodb-kb.js"
import type { KBIngestResult } from "./mongodb-kb.js"
import { ErasureGateConflictError } from "./mongodb-erasure-epoch.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"

const AUTO_REFRESH_HOURS = 24
const STALE_MS = 25 * 60 * 60 * 1000
const GLOBAL_MARKER_KEY = "kb_last_auto_refresh"

// File-local stateful meta fake. The state lives in vi.hoisted so the
// hoisted vi.mock factory can close over it (Vitest hoists both blocks,
// in definition order).
const { metaFake } = vi.hoisted(() => {
	const docs = new Map<string, { _id: string } & Record<string, unknown>>()
	// S1 observer: every updateOne call (filter, update, options) in call
	// order — the marker upsert's session threading is asserted through it.
	const updateOneCalls: Array<{
		filter: Record<string, unknown>
		update: { $set?: Record<string, unknown> }
		options?: { upsert?: boolean; session?: unknown }
	}> = []
	const metaFake = {
		docs,
		updateOneCalls,
		findOne: async (filter: Record<string, unknown>) => {
			const id = filter._id
			return typeof id === "string" ? (docs.get(id) ?? null) : null
		},
		updateOne: async (
			filter: Record<string, unknown>,
			update: { $set?: Record<string, unknown> },
			options?: { upsert?: boolean; session?: unknown },
		) => {
			updateOneCalls.push({ filter, update, options })
			const id = filter._id
			if (typeof id !== "string") {
				return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
			}
			const existing = docs.get(id)
			if (existing) {
				Object.assign(existing, update.$set ?? {})
				return { acknowledged: true, matchedCount: 1, modifiedCount: 1 }
			}
			if (options?.upsert) {
				const inserted: { _id: string } & Record<string, unknown> = {
					_id: id,
					...(update.$set ?? {}),
				}
				docs.set(id, inserted)
				return { acknowledged: true, matchedCount: 0, modifiedCount: 1 }
			}
			return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
		},
	}
	return { metaFake }
})

// F2 binding: serve the stateful fake through the REAL
// ./mongodb-schema.js import — manager-sync imports `metaCollection`
// from here (mongodb-manager-sync.ts:17-21).
vi.mock("./mongodb-schema.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-schema.js")>()
	return {
		...actual,
		metaCollection: () => metaFake,
	}
})

// Mock the ingest through ./mongodb-kb.js; the dynamic
// `await import("./mongodb-kb.js")` inside maybeAutoRefreshKB resolves
// to this mock.
vi.mock("./mongodb-kb.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-kb.js")>()
	return {
		...actual,
		ingestFilesToKB: vi.fn(),
	}
})

// S1 admission-fence seam (cleared plan e5ec10dc…): the write-fence
// module keeps its real exports via importOriginal EXCEPT
// captureAdmissionToken and withFencedWrite, which become recording
// fakes with on-demand gate conflicts — the meta fake above has no
// gate-document semantics to run the real primitives against. The fakes
// mint one token per capture and one session per fence so U1 can assert
// the SAME token threads from capture into the ingest call and the
// marker fence, and the marker upsert carries the fence session.
const fenceSeam = vi.hoisted(() => {
	const state = {
		// captureAdmissionToken args, in call order.
		captureCalls: [] as Array<Record<string, unknown>>,
		// Tokens minted by the fake capture, in call order.
		tokens: [] as Array<{
			kind: "admission"
			agentId: unknown
			epoch: number
		}>,
		// withFencedWrite args, in call order.
		fenceCalls: [] as Array<{
			db: unknown
			prefix: unknown
			token: unknown
		}>,
		// Sessions minted by the fake fence, in call order.
		sessions: [] as Array<{ __kbRefreshFenceSession: true }>,
		// Cross-fake ordering markers: "capture" | "ingest" | "fence".
		order: [] as Array<string>,
		// Knob: thrown by the NEXT capture call (null = admit).
		captureConflict: null as null | Error,
		// Knob: thrown by the NEXT fence call BEFORE fn runs (null = run).
		fenceConflict: null as null | Error,
	}
	const captureAdmissionTokenFake = async (params: {
		db: unknown
		prefix: unknown
		agentId: unknown
	}) => {
		state.order.push("capture")
		state.captureCalls.push({ ...params })
		if (state.captureConflict) {
			throw state.captureConflict
		}
		const token = { kind: "admission", agentId: params.agentId, epoch: 0 }
		state.tokens.push(token)
		return token
	}
	const withFencedWriteFake = async (params: {
		db: unknown
		prefix: unknown
		token: unknown
		fn: (session: unknown) => Promise<unknown>
	}) => {
		state.order.push("fence")
		state.fenceCalls.push({
			db: params.db,
			prefix: params.prefix,
			token: params.token,
		})
		if (state.fenceConflict) {
			throw state.fenceConflict
		}
		const session = { __kbRefreshFenceSession: true }
		state.sessions.push(session)
		return params.fn(session)
	}
	const reset = () => {
		state.captureCalls.length = 0
		state.tokens.length = 0
		state.fenceCalls.length = 0
		state.sessions.length = 0
		state.order.length = 0
		state.captureConflict = null
		state.fenceConflict = null
	}
	return { state, captureAdmissionTokenFake, withFencedWriteFake, reset }
})

vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-write-fence.js")>()
	return {
		...actual,
		captureAdmissionToken:
			fenceSeam.captureAdmissionTokenFake as unknown as typeof actual.captureAdmissionToken,
		withFencedWrite:
			fenceSeam.withFencedWriteFake as unknown as typeof actual.withFencedWrite,
	}
})

function ingestResult(): KBIngestResult {
	return {
		documentsProcessed: 1,
		chunksCreated: 1,
		skipped: 0,
		errors: [],
	}
}

function makeSyncOps(agentId: string): MongoDBManagerSyncOps {
	const host = {
		db: {} as Db,
		prefix: "test_",
		agentId,
		config: {
			mongodb: {
				kb: {
					enabled: true,
					autoRefreshHours: AUTO_REFRESH_HOURS,
					autoImportPaths: [`/kb/${agentId}`],
					chunking: {},
				},
				embeddingMode: "automated",
			},
		},
	} as unknown as MongoDBManagerHost
	return new MongoDBManagerSyncOps(host)
}

function ownerMarkerKey(agentId: string): string {
	return `kb_last_auto_refresh:${agentId}`
}

describe("MongoDBManagerSyncOps maybeAutoRefreshKB owner marker", () => {
	beforeEach(() => {
		metaFake.docs.clear()
		vi.mocked(ingestFilesToKB).mockReset()
		vi.mocked(ingestFilesToKB).mockResolvedValue(ingestResult())
	})

	it("does not suppress agent B's first refresh on a shared prefix after agent A refreshes", async () => {
		const agentA = makeSyncOps("agent-a")
		const agentB = makeSyncOps("agent-b")

		await agentA.maybeAutoRefreshKB()
		await agentB.maybeAutoRefreshKB()

		// B-import assertion FIRST: on unfixed bytes B is suppressed by the
		// marker A wrote, so this fails before any marker-shape assertion
		// runs.
		expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(2)
		const firstCall = vi.mocked(ingestFilesToKB).mock.calls[0]?.[0]
		const secondCall = vi.mocked(ingestFilesToKB).mock.calls[1]?.[0]
		expect(firstCall?.scope.agentId).toBe("agent-a")
		expect(secondCall?.scope.agentId).toBe("agent-b")

		// Marker shape AFTER the import assertions.
		expect(metaFake.docs.has(ownerMarkerKey("agent-a"))).toBe(true)
		expect(metaFake.docs.has(ownerMarkerKey("agent-b"))).toBe(true)
		expect(metaFake.docs.has(GLOBAL_MARKER_KEY)).toBe(false)
	})

	it("keeps suppressing a repeated same-agent refresh inside the interval", async () => {
		const agentA = makeSyncOps("agent-a")

		await agentA.maybeAutoRefreshKB()
		await agentA.maybeAutoRefreshKB()

		expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(1)
		expect(metaFake.docs.has(ownerMarkerKey("agent-a"))).toBe(true)
	})

	it("ignores a pre-existing legacy global marker for BOTH agents and preserves it in place", async () => {
		const seededAt = new Date()
		metaFake.docs.set(GLOBAL_MARKER_KEY, {
			_id: GLOBAL_MARKER_KEY,
			timestamp: seededAt,
		})

		const agentA = makeSyncOps("agent-a")
		const agentB = makeSyncOps("agent-b")
		await agentA.maybeAutoRefreshKB()
		await agentB.maybeAutoRefreshKB()

		// Both-import assertions FIRST: on unfixed bytes the seeded global
		// marker suppresses BOTH first refreshes (zero ingest calls), so
		// this fails before any marker-shape assertion runs.
		expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(2)
		const firstCall = vi.mocked(ingestFilesToKB).mock.calls[0]?.[0]
		const secondCall = vi.mocked(ingestFilesToKB).mock.calls[1]?.[0]
		expect(firstCall?.scope.agentId).toBe("agent-a")
		expect(secondCall?.scope.agentId).toBe("agent-b")

		// Marker shape AFTER the import assertions: both owner markers
		// written; the legacy global row preserved untouched in place.
		expect(metaFake.docs.has(ownerMarkerKey("agent-a"))).toBe(true)
		expect(metaFake.docs.has(ownerMarkerKey("agent-b"))).toBe(true)
		const globalRow = metaFake.docs.get(GLOBAL_MARKER_KEY)
		expect(globalRow?.timestamp).toBe(seededAt)
	})

	it("leaves no owner marker when the import rejects, then a retry runs", async () => {
		vi.mocked(ingestFilesToKB).mockRejectedValueOnce(
			new Error("kb ingest rejected"),
		)
		const agentA = makeSyncOps("agent-a")

		await agentA.maybeAutoRefreshKB()

		// Only the rejection path is pinned here: a REJECTED import reaches
		// the outer catch and skips the marker write. Resolved-with-errors
		// and zero-work imports still write the marker; that behavior is
		// preserved and stays open separately.
		expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(1)
		expect(metaFake.docs.has(ownerMarkerKey("agent-a"))).toBe(false)
		expect(metaFake.docs.size).toBe(0)

		await agentA.maybeAutoRefreshKB()

		expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(2)
		expect(metaFake.docs.has(ownerMarkerKey("agent-a"))).toBe(true)
	})

	it("keeps each agent's owner marker independent of the other agent's refresh", async () => {
		const agentA = makeSyncOps("agent-a")
		const agentB = makeSyncOps("agent-b")

		await agentA.maybeAutoRefreshKB()
		await agentB.maybeAutoRefreshKB()

		const markerA = metaFake.docs.get(ownerMarkerKey("agent-a"))
		const markerB = metaFake.docs.get(ownerMarkerKey("agent-b"))
		if (!(markerA?.timestamp instanceof Date)) {
			throw new Error("agent-a owner marker missing or malformed before aging")
		}
		if (!(markerB?.timestamp instanceof Date)) {
			throw new Error("agent-b owner marker missing or malformed before aging")
		}

		// Direct pin: A re-refreshes on its own stale marker; B's marker
		// must be UNCHANGED by A's refresh.
		markerA.timestamp = new Date(Date.now() - STALE_MS)
		const markerBTime = markerB.timestamp
		await agentA.maybeAutoRefreshKB()
		expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(3)
		const thirdCall = vi.mocked(ingestFilesToKB).mock.calls[2]?.[0]
		expect(thirdCall?.scope.agentId).toBe("agent-a")
		expect(metaFake.docs.get(ownerMarkerKey("agent-b"))?.timestamp).toBe(
			markerBTime,
		)

		// Reciprocal: B re-refreshes on its own stale marker; A's marker
		// must be UNCHANGED by B's refresh.
		markerB.timestamp = new Date(Date.now() - STALE_MS)
		const markerATime = markerA.timestamp
		await agentB.maybeAutoRefreshKB()
		expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(4)
		const fourthCall = vi.mocked(ingestFilesToKB).mock.calls[3]?.[0]
		expect(fourthCall?.scope.agentId).toBe("agent-b")
		expect(metaFake.docs.get(ownerMarkerKey("agent-a"))?.timestamp).toBe(
			markerATime,
		)
	})
})

describe("MongoDBManagerSyncOps maybeAutoRefreshKB admission fence (S1)", () => {
	beforeEach(() => {
		metaFake.docs.clear()
		metaFake.updateOneCalls.length = 0
		fenceSeam.reset()
		vi.mocked(ingestFilesToKB).mockReset()
		// The ingest implementation records the cross-fake ordering marker
		// so U1 can prove capture ran BEFORE the ingest.
		vi.mocked(ingestFilesToKB).mockImplementation(async () => {
			fenceSeam.state.order.push("ingest")
			return ingestResult()
		})
	})

	it("U1: captures admission exactly once BEFORE the ingest, threads the SAME token into the ingest and the marker fence", async () => {
		const agentA = makeSyncOps("agent-a")

		await agentA.maybeAutoRefreshKB()

		// Capture-first ordering (C1): exactly one capture, then the
		// ingest, then the marker fence — never a recapture mid-attempt.
		// On unfixed bytes no capture ever runs, so this fails first and
		// meaningfully.
		expect(fenceSeam.state.order).toEqual(["capture", "ingest", "fence"])
		expect(fenceSeam.state.captureCalls.length).toBe(1)
		expect(fenceSeam.state.captureCalls[0]).toMatchObject({
			prefix: "test_",
			agentId: "agent-a",
		})

		// The SAME token object is threaded into the ingest call.
		const token = fenceSeam.state.tokens[0]
		const ingestCall = vi.mocked(ingestFilesToKB).mock.calls[0]?.[0]
		expect(ingestCall?.admission).toBe(token)

		// The marker upsert runs INSIDE withFencedWrite under the SAME
		// token, on the fence session.
		expect(fenceSeam.state.fenceCalls.length).toBe(1)
		expect(fenceSeam.state.fenceCalls[0]?.token).toBe(token)
		expect(metaFake.updateOneCalls.length).toBe(1)
		expect(metaFake.updateOneCalls[0]?.filter).toEqual({
			_id: ownerMarkerKey("agent-a"),
		})
		expect(metaFake.updateOneCalls[0]?.options?.upsert).toBe(true)
		expect(metaFake.updateOneCalls[0]?.options?.session).toBe(
			fenceSeam.state.sessions[0],
		)
		expect(metaFake.docs.has(ownerMarkerKey("agent-a"))).toBe(true)
	})

	it("U2: a capture conflict defers the attempt — no ingest, no marker, deferred warn", async () => {
		fenceSeam.state.captureConflict = new ErasureGateConflictError(
			"agent-a",
			"capture refused: erasure in progress",
		)
		const agentA = makeSyncOps("agent-a")
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			await agentA.maybeAutoRefreshKB()

			// The attempt stopped at the capture: no ingest call, no fence,
			// no meta mutation at all.
			expect(fenceSeam.state.order).toEqual(["capture"])
			expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(0)
			expect(fenceSeam.state.fenceCalls.length).toBe(0)
			expect(metaFake.updateOneCalls.length).toBe(0)
			expect(metaFake.docs.size).toBe(0)
			// Deferred, NOT failed: the warn names the deferral, and the
			// failure line never fires.
			expect(
				warnSpy.mock.calls.some((args) =>
					String(args[0]).includes("KB auto-refresh deferred"),
				),
			).toBe(true)
			expect(
				warnSpy.mock.calls.some((args) =>
					String(args[0]).includes("KB auto-refresh failed"),
				),
			).toBe(false)
		} finally {
			warnSpy.mockRestore()
		}
	})

	it("U3: a resolved-with-errors import still attempts the fenced marker write", async () => {
		vi.mocked(ingestFilesToKB).mockResolvedValueOnce({
			...ingestResult(),
			errors: ["doc-a.md: simulated ingest error"],
		})
		const agentA = makeSyncOps("agent-a")

		await agentA.maybeAutoRefreshKB()

		expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(1)
		// Fenced-marker assertion FIRST: on unfixed bytes the marker still
		// lands for a resolved-with-errors import, but UNFENCED — the
		// fence count is the meaningful RED discriminator.
		expect(fenceSeam.state.fenceCalls.length).toBe(1)
		expect(metaFake.updateOneCalls.length).toBe(1)
		expect(metaFake.docs.has(ownerMarkerKey("agent-a"))).toBe(true)
	})

	it("U4: a marker-fence conflict mutates no meta, defers with a warn, and the next cycle retries", async () => {
		fenceSeam.state.fenceConflict = new ErasureGateConflictError(
			"agent-a",
			"marker fence refused: erasure in progress",
		)
		const agentA = makeSyncOps("agent-a")
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			await agentA.maybeAutoRefreshKB()

			// The ingest resolved, but the marker fence conflicted: no meta
			// mutation at all — the marker upsert never ran.
			expect(fenceSeam.state.order).toEqual(["capture", "ingest", "fence"])
			expect(metaFake.updateOneCalls.length).toBe(0)
			expect(metaFake.docs.size).toBe(0)
			expect(
				warnSpy.mock.calls.some((args) =>
					String(args[0]).includes("KB auto-refresh deferred"),
				),
			).toBe(true)

			// The marker never landed, so the next cycle retries the whole
			// attempt (capture + ingest + fence) once the conflict clears.
			fenceSeam.state.fenceConflict = null
			await agentA.maybeAutoRefreshKB()
			expect(vi.mocked(ingestFilesToKB)).toHaveBeenCalledTimes(2)
			expect(fenceSeam.state.fenceCalls.length).toBe(2)
			expect(metaFake.docs.has(ownerMarkerKey("agent-a"))).toBe(true)
		} finally {
			warnSpy.mockRestore()
		}
	})
})
