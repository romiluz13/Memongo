import type { ClientSession, Db } from "mongodb"
import { describe, expect, it } from "vitest"
import { runFenceContentionCase } from "./fence-contention.js"

// Storage boundary only: never synthesizes server conflict errors or retries.
function fixture(states: [string, string] = ["open", "open"], overlap = true) {
	const effects: string[] = []
	const reads: string[] = []
	const predicates: unknown[] = []
	const transactionOptions: unknown[] = []
	let ended = 0
	const dbs = states.map((state, lane) => {
		let active = false
		const session = {
			inTransaction: () => active,
			withTransaction: async (fn: () => Promise<unknown>, options: unknown) => {
				transactionOptions.push(options)
				active = true
				try {
					return await fn()
				} finally {
					active = false
				}
			},
			endSession: async () => {
				ended++
			},
		} as unknown as ClientSession
		return {
			client: { startSession: () => session },
			collection: (name: string) => ({
				findOne: async (
					filter: { _id: string },
					options: { session: ClientSession },
				) => {
					expect(options.session).toBe(session)
					reads.push(filter._id)
					return {
						_id: filter._id,
						agentId: filter._id.split(":")[1],
						epoch: 0,
						state,
						serial: 0,
						erase:
							state === "erasing"
								? { runId: "erase", startedAt: new Date() }
								: undefined,
					}
				},
				updateOne: async (
					filter: unknown,
					_update: unknown,
					options: { session: ClientSession },
				) => {
					expect(options.session).toBe(session)
					if (overlap) expect(reads).toHaveLength(2) // Both real fence reads precede either update.
					predicates.push(filter)
					return { matchedCount: 1 }
				},
				insertOne: async (
					doc: { _id: string },
					options: { session: ClientSession },
				) => {
					expect(name).toBe("probe_effects")
					expect(options.session).toBe(session)
					expect(active).toBe(true)
					effects.push(`${lane}:${doc._id}`)
				},
			}),
		} as unknown as Db
	}) as [Db, Db]
	return {
		dbs,
		effects,
		reads,
		predicates,
		transactionOptions,
		ended: () => ended,
	}
}

describe("source-bound fence contention probe (offline structural controls)", () => {
	it("overlaps both actual gate reads while keeping effects in each transaction", async () => {
		const f = fixture()
		const result = await runFenceContentionCase({
			dbs: f.dbs,
			prefix: "probe_",
			agents: ["A", "A"],
			mode: "overlap",
			caseId: "same",
			admitAttempt: () => {},
		})
		expect(result.attempts).toEqual([1, 1])
		expect(f.effects.sort()).toEqual(["0:same:0", "1:same:1"])
		expect(f.predicates).toEqual([
			{
				_id: "tenant-erasure-epoch:A",
				epoch: 0,
				$or: [{ state: "open" }, { state: { $exists: false } }],
			},
			{
				_id: "tenant-erasure-epoch:A",
				epoch: 0,
				$or: [{ state: "open" }, { state: { $exists: false } }],
			},
		])
		expect(f.ended()).toBe(2)
		expect(f.transactionOptions).toEqual([
			{ writeConcern: { w: "majority", wtimeoutMS: 5000 }, timeoutMS: 10000 },
			{ writeConcern: { w: "majority", wtimeoutMS: 5000 }, timeoutMS: 10000 },
		])
	})

	it("keeps different agent gates independent in the overlap control", async () => {
		const f = fixture()
		await runFenceContentionCase({
			dbs: f.dbs,
			prefix: "probe_",
			agents: ["A", "B"],
			mode: "overlap",
			caseId: "different",
			admitAttempt: () => {},
		})
		expect(f.reads.sort()).toEqual([
			"tenant-erasure-epoch:A",
			"tenant-erasure-epoch:B",
		])
		expect(f.effects.sort()).toEqual(["0:different:0", "1:different:1"])
	})

	it("serial control completes without waiting for a second read", async () => {
		const f = fixture(["open", "open"], false)
		await runFenceContentionCase({
			dbs: f.dbs,
			prefix: "probe_",
			agents: ["A", "A"],
			mode: "serial",
			caseId: "serial",
			admitAttempt: () => {},
		})
		expect(f.effects).toEqual(["0:serial:0", "1:serial:1"])
		expect(f.ended()).toBe(2)
	})

	it("retains real erasure rejection and joins both session cleanups", async () => {
		const f = fixture(["erasing", "erasing"])
		await expect(
			runFenceContentionCase({
				dbs: f.dbs,
				prefix: "probe_",
				agents: ["A", "A"],
				mode: "overlap",
				caseId: "blocked",
				admitAttempt: () => {},
			}),
		).rejects.toThrow("contention case failed")
		expect(f.effects).toEqual([])
		expect(f.predicates).toEqual([])
		expect(f.ended()).toBe(2)
	})

	it("admission refusal cancels the partner's barrier and drains both lanes", async () => {
		const f = fixture()
		await expect(
			runFenceContentionCase({
				dbs: f.dbs,
				prefix: "probe_",
				agents: ["A", "A"],
				mode: "overlap",
				caseId: "refused",
				admitAttempt: (lane) => {
					if (lane === 1) throw new Error("root budget refused")
				},
			}),
		).rejects.toThrow("contention case failed")
		expect(f.effects).toEqual([])
		expect(f.predicates).toEqual([])
		expect(f.ended()).toBe(2)
	})
})
