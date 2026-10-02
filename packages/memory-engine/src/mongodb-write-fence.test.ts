import type { ClientSession, Collection, Db } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { isTransactionUnsupported } from "./mongodb-transactions.js"
import {
	type AdmissionToken,
	type ErasureToken,
	finalizeErasure,
	isErasureGateConflictError,
	isMalformedGateError,
	withFencedWrite,
} from "./mongodb-write-fence.js"

const PREFIX = "test_"
const AGENT = "agent-1"
const META = `${PREFIX}meta`
const OPEN_GATE = {
	agentId: AGENT,
	epoch: 3,
	state: "open",
	serial: 0,
}

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		findOne: vi.fn().mockResolvedValue(OPEN_GATE),
		findOneAndUpdate: vi.fn().mockResolvedValue(null),
		updateOne: vi.fn().mockResolvedValue({
			matchedCount: 1,
			modifiedCount: 1,
			upsertedCount: 0,
		}),
		insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
		...overrides,
	} as unknown as Collection
}

function createMockSession(opts: { inTransaction?: boolean } = {}) {
	const session = {
		inTransaction: vi.fn(() => opts.inTransaction ?? false),
		withTransaction: vi.fn(async (fn: (s: unknown) => Promise<unknown>) =>
			fn(session),
		),
		endSession: vi.fn(async () => {}),
	}
	return session as unknown as ClientSession & {
		inTransaction: ReturnType<typeof vi.fn>
		withTransaction: ReturnType<typeof vi.fn>
		endSession: ReturnType<typeof vi.fn>
	}
}

function createMockDb(
	collections: Record<string, Collection>,
	opts: { session?: ClientSession } = {},
) {
	const startSession = vi.fn(() => opts.session ?? createMockSession())
	const db = {
		collection: (name: string) => collections[name] ?? createMockCollection(),
		client: { startSession },
	} as unknown as Db
	return { db, startSession }
}

const ADMISSION: AdmissionToken = {
	kind: "admission",
	agentId: AGENT,
	epoch: 3,
}

const ERASURE: ErasureToken = {
	kind: "erasure",
	agentId: AGENT,
	runId: "run-a",
	epoch: 3,
}

const ERASING_GATE = {
	agentId: AGENT,
	epoch: 3,
	state: "erasing",
	serial: 0,
	erase: { runId: "run-a", startedAt: new Date() },
}

describe("withFencedWrite gate application", () => {
	it("applies the conditional gate mutation before the caller's writes", async () => {
		const order: string[] = []
		const meta = createMockCollection({
			updateOne: vi.fn(async () => {
				order.push("gate")
				return { matchedCount: 1 }
			}),
		})
		const { db } = createMockDb({ [META]: meta })
		await withFencedWrite({
			db,
			prefix: PREFIX,
			token: ADMISSION,
			fn: async () => {
				order.push("fn")
			},
		})
		expect(order).toEqual(["gate", "fn"])
		const [filter, update] = (meta.updateOne as ReturnType<typeof vi.fn>).mock
			.calls[0]
		expect(filter).toEqual({
			_id: `tenant-erasure-epoch:${AGENT}`,
			epoch: 3,
			$or: [{ state: "open" }, { state: { $exists: false } }],
		})
		expect(update.$inc).toEqual({ serial: 1 })
	})

	it("uses the ownership filter for erasure tokens", async () => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue(ERASING_GATE),
		})
		const { db } = createMockDb({ [META]: meta })
		await withFencedWrite({
			db,
			prefix: PREFIX,
			token: ERASURE,
			fn: async () => {},
		})
		expect(
			(meta.updateOne as ReturnType<typeof vi.fn>).mock.calls[0][0],
		).toEqual({
			_id: `tenant-erasure-epoch:${AGENT}`,
			epoch: 3,
			state: "erasing",
			"erase.runId": "run-a",
		})
	})

	it("propagates the caller's fn error unchanged", async () => {
		const meta = createMockCollection()
		const { db } = createMockDb({ [META]: meta })
		const boom = new Error("caller failed")
		await expect(
			withFencedWrite({
				db,
				prefix: PREFIX,
				token: ADMISSION,
				fn: async () => {
					throw boom
				},
			}),
		).rejects.toBe(boom)
	})

	it("rejects malformed tokens before touching the database", async () => {
		const meta = createMockCollection()
		const { db } = createMockDb({ [META]: meta })
		await expect(
			withFencedWrite({
				db,
				prefix: PREFIX,
				token: { kind: "admission", agentId: AGENT, epoch: Number.NaN },
				fn: async () => {},
			}),
		).rejects.toBeInstanceOf(TypeError)
		await expect(
			withFencedWrite({
				db,
				prefix: PREFIX,
				token: {
					kind: "erasure",
					agentId: AGENT,
					runId: "",
					epoch: 1,
				},
				fn: async () => {},
			}),
		).rejects.toBeInstanceOf(TypeError)
		expect(meta.findOne).not.toHaveBeenCalled()
		expect(meta.updateOne).not.toHaveBeenCalled()
	})
})

describe("withFencedWrite gate conflicts", () => {
	function metaWithNoMatch(rawGate: unknown) {
		return createMockCollection({
			findOne: vi.fn().mockResolvedValue(rawGate),
			updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }),
		})
	}

	it("uses one stable conflict when an admission fence does not match", async () => {
		const meta = metaWithNoMatch(OPEN_GATE)
		const { db } = createMockDb({ [META]: meta })
		await expect(
			withFencedWrite({
				db,
				prefix: PREFIX,
				token: ADMISSION,
				fn: async () => {},
			}),
		).rejects.toSatisfy(
			(err) =>
				isErasureGateConflictError(err) && err.code === "ERASURE_GATE_CONFLICT",
		)
		expect(meta.findOne).toHaveBeenCalledTimes(1)
	})

	it("uses the same stable conflict when erasure ownership no longer matches", async () => {
		const meta = metaWithNoMatch(ERASING_GATE)
		const { db } = createMockDb({ [META]: meta })
		await expect(
			withFencedWrite({
				db,
				prefix: PREFIX,
				token: ERASURE,
				fn: async () => {},
			}),
		).rejects.toSatisfy(isErasureGateConflictError)
		expect(meta.findOne).toHaveBeenCalledTimes(1)
	})
})

describe("withFencedWrite gate update failures", () => {
	it("propagates gate write infrastructure errors unchanged", async () => {
		const failure = new Error("socket closed")
		const meta = createMockCollection({
			updateOne: vi.fn().mockRejectedValue(failure),
		})
		const { db } = createMockDb({ [META]: meta })
		await expect(
			withFencedWrite({
				db,
				prefix: PREFIX,
				token: ADMISSION,
				fn: async () => {},
			}),
		).rejects.toBe(failure)
	})

	it("fails closed (not silently downgraded) on TransactionNotSupported code 20", async () => {
		const unsupported = Object.assign(
			new Error("Transaction numbers are only allowed"),
			{
				code: 20,
			},
		)
		const meta = createMockCollection({
			updateOne: vi.fn().mockRejectedValue(unsupported),
		})
		const { db } = createMockDb({ [META]: meta })
		const failure = await withFencedWrite({
			db,
			prefix: PREFIX,
			token: ADMISSION,
			fn: async () => {},
		}).catch((err: unknown) => err)
		expect(failure).toBe(unsupported)
		expect(isTransactionUnsupported(failure)).toBe(true)
	})

	it("passes retry-labeled errors through unchanged so withTransaction can retry", async () => {
		const labeled = Object.assign(new Error("WriteConflict"), {
			errorLabels: ["TransientTransactionError"],
			code: 112,
		})
		const meta = createMockCollection({
			updateOne: vi.fn().mockRejectedValue(labeled),
		})
		const { db } = createMockDb({ [META]: meta })
		await expect(
			withFencedWrite({
				db,
				prefix: PREFIX,
				token: ADMISSION,
				fn: async () => {},
			}),
		).rejects.toBe(labeled)
	})
})

describe("withFencedWrite session semantics", () => {
	it("owns and closes its session when none is provided", async () => {
		const meta = createMockCollection()
		const session = createMockSession()
		const { db, startSession } = createMockDb({ [META]: meta }, { session })
		await withFencedWrite({
			db,
			prefix: PREFIX,
			token: ADMISSION,
			fn: async () => "done",
		})
		expect(startSession).toHaveBeenCalledTimes(1)
		expect(session.withTransaction).toHaveBeenCalledTimes(1)
		expect(session.endSession).toHaveBeenCalledTimes(1)
	})

	it("closes its owned session even when fn throws", async () => {
		const meta = createMockCollection()
		const session = createMockSession()
		const { db } = createMockDb({ [META]: meta }, { session })
		await expect(
			withFencedWrite({
				db,
				prefix: PREFIX,
				token: ADMISSION,
				fn: async () => {
					throw new Error("boom")
				},
			}),
		).rejects.toThrow("boom")
		expect(session.endSession).toHaveBeenCalledTimes(1)
	})

	it("hosts the fenced transaction on a provided idle session", async () => {
		const meta = createMockCollection()
		const session = createMockSession({ inTransaction: false })
		const { db, startSession } = createMockDb({ [META]: meta })
		await withFencedWrite({
			db,
			prefix: PREFIX,
			token: ADMISSION,
			session,
			fn: async () => {},
		})
		expect(startSession).not.toHaveBeenCalled()
		expect(session.withTransaction).toHaveBeenCalledTimes(1)
		expect(session.endSession).not.toHaveBeenCalled()
		expect(meta.updateOne).toHaveBeenCalledTimes(1)
	})

	it("applies the gate when joining an active caller transaction", async () => {
		const meta = createMockCollection()
		const session = createMockSession({ inTransaction: true })
		const { db } = createMockDb({ [META]: meta })
		let fnSaw: unknown
		await withFencedWrite({
			db,
			prefix: PREFIX,
			token: ADMISSION,
			session,
			fn: async (s) => {
				fnSaw = s
			},
		})
		expect(session.withTransaction).not.toHaveBeenCalled()
		expect(meta.updateOne).toHaveBeenCalledTimes(1)
		expect(fnSaw).toBe(session)
	})
})

describe("finalizeErasure", () => {
	it("writes the audit before the conditional reopen in one transaction", async () => {
		const order: string[] = []
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue(ERASING_GATE),
			findOneAndUpdate: vi.fn(async () => {
				order.push("reopen")
				return {
					...ERASING_GATE,
					state: "open",
					erase: undefined,
				}
			}),
		})
		const { db } = createMockDb({ [META]: meta })
		await finalizeErasure({
			db,
			prefix: PREFIX,
			token: ERASURE,
			writeAudit: async () => {
				order.push("audit")
			},
		})
		expect(order).toEqual(["audit", "reopen"])
		const [filter, update] = (meta.findOneAndUpdate as ReturnType<typeof vi.fn>)
			.mock.calls[0]
		expect(filter).toEqual({
			_id: `tenant-erasure-epoch:${AGENT}`,
			epoch: 3,
			state: "erasing",
			"erase.runId": "run-a",
		})
		expect(update.$set.state).toBe("open")
		expect(update.$unset).toEqual({ erase: "" })
		// The epoch is NOT touched on reopen: it advanced at beginErasure.
		expect(update.$inc).toBeUndefined()
	})

	it("aborts the audit and throws superseded when ownership is gone", async () => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue(ERASING_GATE),
			findOneAndUpdate: vi.fn().mockResolvedValue(null),
		})
		const { db } = createMockDb({ [META]: meta })
		let auditRan = false
		await expect(
			finalizeErasure({
				db,
				prefix: PREFIX,
				token: ERASURE,
				writeAudit: async () => {
					auditRan = true
				},
			}),
		).rejects.toSatisfy(isErasureGateConflictError)
		// The audit DID run inside the transaction — the thrown conflict is what
		// aborts it atomically at the database.
		expect(auditRan).toBe(true)
	})

	it("rejects malformed retained state before audit or reopen", async () => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue({
				...ERASING_GATE,
				epoch: 1.5,
			}),
		})
		const { db } = createMockDb({ [META]: meta })
		const writeAudit = vi.fn(async () => {})
		await expect(
			finalizeErasure({
				db,
				prefix: PREFIX,
				token: ERASURE,
				writeAudit,
			}),
		).rejects.toSatisfy(isMalformedGateError)
		expect(writeAudit).not.toHaveBeenCalled()
		expect(meta.findOneAndUpdate).not.toHaveBeenCalled()
	})

	it("propagates reopen infrastructure errors unchanged", async () => {
		const failure = new Error("socket closed")
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue(ERASING_GATE),
			findOneAndUpdate: vi.fn().mockRejectedValue(failure),
		})
		const { db } = createMockDb({ [META]: meta })
		await expect(
			finalizeErasure({ db, prefix: PREFIX, token: ERASURE }),
		).rejects.toBe(failure)
	})
})
