import type { ClientSession, Collection, Db } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import {
	admissionGateFilter,
	beginErasure,
	captureAdmissionToken,
	type ErasureToken,
	isErasureGateConflictError,
	erasureOwnershipGateFilter,
	isMalformedGateError,
	parseErasureGateDoc,
	readErasureGate,
	takeoverErasure,
} from "./mongodb-erasure-epoch.js"

const PREFIX = "test_"
const AGENT = "agent-1"
const META = `${PREFIX}meta`
const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function createMockCollection(
	overrides: Partial<Record<string, unknown>> = {},
): Collection {
	return {
		findOne: vi.fn().mockResolvedValue(null),
		findOneAndUpdate: vi.fn().mockResolvedValue(null),
		updateOne: vi.fn().mockResolvedValue({
			matchedCount: 1,
			modifiedCount: 1,
			upsertedCount: 0,
		}),
		...overrides,
	} as unknown as Collection
}

function createMockDb(collections: Record<string, Collection>): Db {
	const session = {
		withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
		endSession: vi.fn(async () => {}),
	} as unknown as ClientSession
	return {
		collection: (name: string) => collections[name] ?? createMockCollection(),
		client: { startSession: vi.fn(() => session) },
	} as unknown as Db
}

function dbWithMeta(meta: Collection): Db {
	return createMockDb({ [META]: meta })
}

function erasingPostImage(
	doc: Record<string, unknown>,
): ReturnType<typeof vi.fn> {
	return vi.fn(async (_filter: unknown, update: unknown) => {
		const erase = (update as { $set: { erase: unknown } }).$set.erase
		return { ...doc, erase }
	})
}

describe("parseErasureGateDoc", () => {
	it("returns null only for absent documents", () => {
		expect(parseErasureGateDoc(AGENT, null)).toBeNull()
		expect(parseErasureGateDoc(AGENT, undefined)).toBeNull()
	})

	it("interprets a legacy epoch-only document as open with serial 0, non-destructively", () => {
		const gate = parseErasureGateDoc(AGENT, {
			_id: `tenant-erasure-epoch:${AGENT}`,
			agentId: AGENT,
			epoch: 3,
			updatedAt: new Date(),
		})
		expect(gate).toMatchObject({
			agentId: AGENT,
			epoch: 3,
			state: "open",
			serial: 0,
		})
		expect(gate?.erase).toBeUndefined()
	})

	it("parses a valid erasing gate with its owner record", () => {
		const startedAt = new Date()
		const gate = parseErasureGateDoc(AGENT, {
			agentId: AGENT,
			epoch: 2,
			state: "erasing",
			serial: 7,
			erase: { runId: "run-1", startedAt },
		})
		expect(gate).toMatchObject({
			epoch: 2,
			state: "erasing",
			serial: 7,
			erase: { runId: "run-1", startedAt },
		})
	})

	it.each([
		["non-object", "gate"],
		["string epoch", { agentId: AGENT, epoch: "three" }],
		["negative epoch", { agentId: AGENT, epoch: -1 }],
		["non-integer epoch", { agentId: AGENT, epoch: 1.5 }],
		["unknown state", { agentId: AGENT, epoch: 1, state: "banana" }],
		["erasing without owner", { agentId: AGENT, epoch: 1, state: "erasing" }],
		[
			"erasing with empty runId",
			{
				agentId: AGENT,
				epoch: 1,
				state: "erasing",
				erase: { runId: "", startedAt: new Date() },
			},
		],
		[
			"erasing with invalid startedAt",
			{
				agentId: AGENT,
				epoch: 1,
				state: "erasing",
				erase: { runId: "run-1", startedAt: "yesterday" },
			},
		],
		[
			"open with leftover erase record",
			{
				agentId: AGENT,
				epoch: 1,
				state: "open",
				erase: { runId: "run-1", startedAt: new Date() },
			},
		],
		["negative serial", { agentId: AGENT, epoch: 1, serial: -1 }],
		["agentId mismatch", { agentId: "agent-2", epoch: 1 }],
	])("fails closed on malformed retained state: %s", (_label, raw) => {
		try {
			parseErasureGateDoc(AGENT, raw)
			expect.unreachable("malformed gate must throw")
		} catch (err) {
			expect(isMalformedGateError(err)).toBe(true)
		}
	})
})

describe("gate filter builders", () => {
	it("admission filter pins the captured epoch on an open-or-legacy gate", () => {
		expect(
			admissionGateFilter({ kind: "admission", agentId: AGENT, epoch: 4 }),
		).toEqual({
			_id: `tenant-erasure-epoch:${AGENT}`,
			epoch: 4,
			$or: [{ state: "open" }, { state: { $exists: false } }],
		})
	})

	it("erasure filter pins the exact owner and run", () => {
		const token: ErasureToken = {
			kind: "erasure",
			agentId: AGENT,
			runId: "run-1",
			epoch: 5,
		}
		expect(erasureOwnershipGateFilter(token)).toEqual({
			_id: `tenant-erasure-epoch:${AGENT}`,
			epoch: 5,
			state: "erasing",
			"erase.runId": "run-1",
		})
	})
})

describe("captureAdmissionToken", () => {
	it("initializes an absent gate as open at epoch 0 and returns the token", async () => {
		const meta = createMockCollection({
			findOneAndUpdate: vi.fn().mockResolvedValue({
				agentId: AGENT,
				epoch: 0,
				state: "open",
				serial: 0,
			}),
		})
		const token = await captureAdmissionToken({
			db: dbWithMeta(meta),
			prefix: PREFIX,
			agentId: AGENT,
		})
		expect(token).toEqual({ kind: "admission", agentId: AGENT, epoch: 0 })
		const [filter, update, options] = (
			meta.findOneAndUpdate as ReturnType<typeof vi.fn>
		).mock.calls[0]
		expect(filter).toEqual({ _id: `tenant-erasure-epoch:${AGENT}` })
		expect(update.$setOnInsert).toMatchObject({
			agentId: AGENT,
			epoch: 0,
			state: "open",
			serial: 0,
		})
		expect(options).toMatchObject({ upsert: true, returnDocument: "after" })
	})

	it("returns the current epoch of a legacy open gate", async () => {
		const meta = createMockCollection({
			findOneAndUpdate: vi.fn().mockResolvedValue({ agentId: AGENT, epoch: 3 }),
		})
		const token = await captureAdmissionToken({
			db: dbWithMeta(meta),
			prefix: PREFIX,
			agentId: AGENT,
		})
		expect(token.epoch).toBe(3)
	})

	it("rejects admission while erasure is in progress", async () => {
		const meta = createMockCollection({
			findOneAndUpdate: vi.fn().mockResolvedValue({
				agentId: AGENT,
				epoch: 4,
				state: "erasing",
				erase: { runId: "run-1", startedAt: new Date() },
			}),
		})
		await expect(
			captureAdmissionToken({
				db: dbWithMeta(meta),
				prefix: PREFIX,
				agentId: AGENT,
			}),
		).rejects.toSatisfy(isErasureGateConflictError)
	})

	it("fails closed on malformed retained state", async () => {
		const meta = createMockCollection({
			findOneAndUpdate: vi
				.fn()
				.mockResolvedValue({ agentId: AGENT, epoch: "three" }),
		})
		await expect(
			captureAdmissionToken({
				db: dbWithMeta(meta),
				prefix: PREFIX,
				agentId: AGENT,
			}),
		).rejects.toSatisfy(isMalformedGateError)
	})

	it("propagates gate infrastructure errors unchanged", async () => {
		const failure = new Error("socket closed")
		const meta = createMockCollection({
			findOneAndUpdate: vi.fn().mockRejectedValue(failure),
		})
		await expect(
			captureAdmissionToken({
				db: dbWithMeta(meta),
				prefix: PREFIX,
				agentId: AGENT,
			}),
		).rejects.toBe(failure)
	})
})

describe("beginErasure", () => {
	it("validates the open gate and atomically returns the incremented epoch", async () => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue({
				agentId: AGENT,
				epoch: 5,
				state: "open",
				serial: 2,
			}),
			findOneAndUpdate: erasingPostImage({
				agentId: AGENT,
				epoch: 6,
				state: "erasing",
				serial: 2,
			}),
		})
		const token = await beginErasure({
			db: dbWithMeta(meta),
			prefix: PREFIX,
			agentId: AGENT,
		})
		expect(token).toMatchObject({
			kind: "erasure",
			agentId: AGENT,
			runId: expect.stringMatching(UUID_V4_PATTERN),
			epoch: 6,
		})
		const [filter, update, options] = (
			meta.findOneAndUpdate as ReturnType<typeof vi.fn>
		).mock.calls[0]
		expect(filter).toEqual({
			_id: `tenant-erasure-epoch:${AGENT}`,
			epoch: 5,
			$or: [{ state: "open" }, { state: { $exists: false } }],
		})
		expect(update.$inc).toEqual({ epoch: 1 })
		expect(update.$set.state).toBe("erasing")
		expect(update.$set.erase).toEqual({
			runId: token.runId,
			startedAt: expect.any(Date),
		})
		expect(options).toMatchObject({
			returnDocument: "after",
			includeResultMetadata: false,
			session: expect.anything(),
		})
	})

	it("treats an upserted gate as a successful start", async () => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue(null),
			findOneAndUpdate: erasingPostImage({
				agentId: AGENT,
				epoch: 1,
				state: "erasing",
				serial: 0,
			}),
		})
		const token = await beginErasure({
			db: dbWithMeta(meta),
			prefix: PREFIX,
			agentId: AGENT,
		})
		expect(token).toMatchObject({
			kind: "erasure",
			epoch: 1,
			runId: expect.stringMatching(UUID_V4_PATTERN),
		})
	})

	it("throws the stable conflict when the validated gate is already erasing", async () => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue({
				agentId: AGENT,
				epoch: 1,
				state: "erasing",
				serial: 0,
				erase: { runId: "run-existing", startedAt: new Date() },
			}),
		})
		await expect(
			beginErasure({ db: dbWithMeta(meta), prefix: PREFIX, agentId: AGENT }),
		).rejects.toSatisfy(isErasureGateConflictError)
		expect(meta.findOneAndUpdate).not.toHaveBeenCalled()
	})

	it("maps an absent-gate duplicate-key race to the stable conflict", async () => {
		const duplicate = Object.assign(new Error("E11000 duplicate key error"), {
			code: 11000,
		})
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue(null),
			findOneAndUpdate: vi.fn().mockRejectedValue(duplicate),
		})
		await expect(
			beginErasure({ db: dbWithMeta(meta), prefix: PREFIX, agentId: AGENT }),
		).rejects.toSatisfy(isErasureGateConflictError)
	})

	it.each([
		["unknown state", { agentId: AGENT, epoch: 3, state: "garbage" }],
		["fractional epoch", { agentId: AGENT, epoch: 1.5 }],
	])("rejects malformed retained state before mutation: %s", async (_label, raw) => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue(raw),
		})
		await expect(
			beginErasure({ db: dbWithMeta(meta), prefix: PREFIX, agentId: AGENT }),
		).rejects.toSatisfy(isMalformedGateError)
		expect(meta.findOneAndUpdate).not.toHaveBeenCalled()
	})

	it("propagates gate infrastructure errors unchanged", async () => {
		const failure = new Error("socket closed")
		const meta = createMockCollection({
			findOne: vi.fn().mockRejectedValue(failure),
		})
		await expect(
			beginErasure({ db: dbWithMeta(meta), prefix: PREFIX, agentId: AGENT }),
		).rejects.toBe(failure)
	})
})

describe("takeoverErasure", () => {
	const erasingGate = {
		agentId: AGENT,
		epoch: 2,
		state: "erasing",
		serial: 0,
		erase: { runId: "run-a", startedAt: new Date() },
	}

	it("conditions on the observed run and returns the atomic successor state", async () => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue(erasingGate),
			findOneAndUpdate: erasingPostImage({
				...erasingGate,
				serial: 1,
			}),
		})
		const token = await takeoverErasure({
			db: dbWithMeta(meta),
			prefix: PREFIX,
			agentId: AGENT,
		})
		expect(token).toMatchObject({
			kind: "erasure",
			agentId: AGENT,
			runId: expect.stringMatching(UUID_V4_PATTERN),
			epoch: 2,
		})
		expect(token.runId).not.toBe(erasingGate.erase.runId)
		const [filter, update, options] = (
			meta.findOneAndUpdate as ReturnType<typeof vi.fn>
		).mock.calls[0]
		expect(filter).toEqual({
			_id: `tenant-erasure-epoch:${AGENT}`,
			agentId: AGENT,
			epoch: 2,
			state: "erasing",
			"erase.runId": "run-a",
			"erase.startedAt": erasingGate.erase.startedAt,
			$or: [{ serial: 0 }, { serial: { $exists: false } }],
		})
		expect(update.$set.erase).toEqual({
			runId: token.runId,
			startedAt: expect.any(Date),
		})
		expect(update.$inc).toEqual({ serial: 1 })
		expect(options).toMatchObject({
			returnDocument: "after",
			includeResultMetadata: false,
		})
	})

	it("refuses a takeover when no erasure is in progress", async () => {
		for (const raw of [
			null,
			{ agentId: AGENT, epoch: 2 },
			{ agentId: AGENT, epoch: 2, state: "open" },
		]) {
			const meta = createMockCollection({
				findOne: vi.fn().mockResolvedValue(raw),
			})
			await expect(
				takeoverErasure({
					db: dbWithMeta(meta),
					prefix: PREFIX,
					agentId: AGENT,
				}),
			).rejects.toSatisfy(isErasureGateConflictError)
		}
	})

	it("fails closed on malformed retained gate state", async () => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue({
				agentId: AGENT,
				epoch: 2,
				state: "erasing",
			}),
		})
		await expect(
			takeoverErasure({ db: dbWithMeta(meta), prefix: PREFIX, agentId: AGENT }),
		).rejects.toSatisfy(isMalformedGateError)
	})

	it("maps a lost takeover race to the stable conflict", async () => {
		const meta = createMockCollection({
			findOne: vi.fn().mockResolvedValue(erasingGate),
			findOneAndUpdate: vi.fn().mockResolvedValue(null),
		})
		await expect(
			takeoverErasure({ db: dbWithMeta(meta), prefix: PREFIX, agentId: AGENT }),
		).rejects.toSatisfy(isErasureGateConflictError)
	})
})

describe("readErasureGate", () => {
	it("returns null for an absent gate and parses legacy documents", async () => {
		const meta = createMockCollection()
		await expect(
			readErasureGate({ db: dbWithMeta(meta), prefix: PREFIX, agentId: AGENT }),
		).resolves.toBeNull()
	})

	it("propagates driver read failures unchanged", async () => {
		const failure = new Error("primary stepped down")
		const meta = createMockCollection({
			findOne: vi.fn().mockRejectedValue(failure),
		})
		await expect(
			readErasureGate({ db: dbWithMeta(meta), prefix: PREFIX, agentId: AGENT }),
		).rejects.toBe(failure)
	})
})
