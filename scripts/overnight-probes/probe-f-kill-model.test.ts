import { describe, expect, it } from "vitest"
import {
	evaluateKill,
	type FKillFacts,
	isEligibleOp,
	pickEligibleOp,
} from "./probe-f-model.ts"

describe("eligible operations", () => {
	const ownership = {
		database: "memongo_probe_ab12cd34",
		appName: "memongo-probe-api-ab12cd34",
		identities: ["zqfmarker1"],
	}
	const op = (overrides: Record<string, unknown> = {}) => ({
		opid: 4242,
		active: true,
		op: "update",
		ns: "memongo_probe_ab12cd34.events",
		appName: "memongo-probe-api-ab12cd34",
		command: {
			update: "events",
			updates: [{ u: { $setOnInsert: { body: "entry zqfmarker1" } } }],
		},
		...overrides,
	})

	it("accepts only an active write in the generated database from the spawned client with a pending identity", () => {
		expect(isEligibleOp(op(), ownership)).toBe(true)
		expect(isEligibleOp(op({ op: "insert" }), ownership)).toBe(true)
	})

	it("rejects other databases, prefixes of the name and namespaces without a collection", () => {
		expect(isEligibleOp(op({ ns: "other.events" }), ownership)).toBe(false)
		expect(
			isEligibleOp(op({ ns: "memongo_probe_ab12cd34x.events" }), ownership),
		).toBe(false)
		expect(isEligibleOp(op({ ns: "memongo_probe_ab12cd34" }), ownership)).toBe(
			false,
		)
		expect(isEligibleOp(op({ ns: undefined }), ownership)).toBe(false)
	})

	it("rejects other clients, inactive operations and the listing itself", () => {
		expect(isEligibleOp(op({ appName: "someone-else" }), ownership)).toBe(false)
		expect(isEligibleOp(op({ appName: undefined }), ownership)).toBe(false)
		expect(isEligibleOp(op({ active: false }), ownership)).toBe(false)
		expect(
			isEligibleOp(
				op({ command: { $currentOp: {}, body: "zqfmarker1" } }),
				ownership,
			),
		).toBe(false)
	})

	it("accepts commands and queries that carry a pending identity but not cursor continuations or idle entries", () => {
		expect(isEligibleOp(op({ op: "command" }), ownership)).toBe(true)
		expect(isEligibleOp(op({ op: "query" }), ownership)).toBe(true)
		expect(isEligibleOp(op({ op: "getmore" }), ownership)).toBe(false)
		expect(isEligibleOp(op({ op: "none" }), ownership)).toBe(false)
		expect(isEligibleOp(op({ op: undefined }), ownership)).toBe(false)
	})

	it("rejects operations whose command carries no pending identity", () => {
		expect(isEligibleOp(op({ command: { update: "events" } }), ownership)).toBe(
			false,
		)
		expect(isEligibleOp(op(), { ...ownership, identities: [] })).toBe(false)
	})

	it("finds an identity inside a truncated command", () => {
		expect(
			isEligibleOp(
				op({
					command: { $truncated: "{ update: 'events', body: 'zqfmarker1' ..." },
				}),
				ownership,
			),
		).toBe(true)
	})

	it("picks the first eligible operation and ignores everything else", () => {
		const ops = [
			op({ ns: "other.events", opid: 1 }),
			op({ opid: 2 }),
			op({ opid: 3 }),
		]
		expect(pickEligibleOp(ops, ownership)?.opid).toBe(2)
		expect(pickEligibleOp([op({ active: false })], ownership)).toBeUndefined()
	})
})

function kill(overrides: Partial<FKillFacts> = {}): FKillFacts {
	return {
		killed: true,
		interrupted: true,
		reissues: [{ customId: "a", ok: true, eventId: "e1" }],
		dedupe: {
			customId: "b",
			ok: true,
			firstEventId: "e2",
			secondEventId: "e2",
		},
		expectedRecords: 40,
		status: { trusted: true, count: 40 },
		controls: { writeAcked: true, search: "found" },
		...overrides,
	}
}

describe("evaluateKill", () => {
	it("passes an interrupted operation that recovers with one logical record and healthy controls", () => {
		expect(evaluateKill(kill()).outcome).toBe("pass")
	})

	it("reports not-run with the sanitized reason for each missing precondition", () => {
		for (const reason of [
			"permission",
			"no-owned-target",
			"operation-finished",
			"admin-unavailable",
		] as const) {
			const result = evaluateKill({
				killed: false,
				reissues: [],
				expectedRecords: 0,
				status: { trusted: false },
				controls: { writeAcked: false, search: "not-run" },
				notRun: { reason, detail: "not authorized" },
			})
			expect(result.outcome).toBe("not-run")
			expect(result.reason).toBe(`${reason}: not authorized`)
		}
	})

	it("reports not-run when a kill was issued but nothing was interrupted", () => {
		const result = evaluateKill(kill({ interrupted: false }))
		expect(result.outcome).toBe("not-run")
		expect(result.reason).toBe("not-interrupted")
	})

	it("fails when a reissue is rejected", () => {
		const result = evaluateKill(
			kill({ reissues: [{ customId: "a", ok: false }] }),
		)
		expect(result.predicate).toBe("reissue-failed")
	})

	it("fails when the same customId produced a different record the second time", () => {
		const result = evaluateKill(
			kill({
				dedupe: {
					customId: "b",
					ok: true,
					firstEventId: "e2",
					secondEventId: "e3",
				},
			}),
		)
		expect(result.predicate).toBe("non-idempotent-reissue")
	})

	it("fails duplicated and lost logical records", () => {
		expect(
			evaluateKill(kill({ status: { trusted: true, count: 41 } })).predicate,
		).toBe("duplicate-logical-record")
		expect(
			evaluateKill(kill({ status: { trusted: true, count: 39 } })).predicate,
		).toBe("lost-record")
	})

	it("is inconclusive when the count could not be trusted", () => {
		const result = evaluateKill(kill({ status: { trusted: false } }))
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("count-unverified")
	})

	it("fails when the system does not accept a healthy write or serve it afterwards", () => {
		expect(
			evaluateKill(kill({ controls: { writeAcked: false, search: "not-run" } }))
				.predicate,
		).toBe("write-not-recovered")
		expect(
			evaluateKill(
				kill({ controls: { writeAcked: true, search: "missing-healthy" } }),
			).predicate,
		).toBe("acked-not-searchable")
	})

	it("is inconclusive when the read control could not be evaluated", () => {
		const result = evaluateKill(
			kill({ controls: { writeAcked: true, search: "unhealthy" } }),
		)
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("read-control-unverified")
	})

	it("is inconclusive when the recovery sequence was aborted", () => {
		const result = evaluateKill(kill({ aborted: "budget-refusal:cap" }))
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("aborted:budget-refusal:cap")
	})

	it("is inconclusive when the admin interface failed unexpectedly", () => {
		const result = evaluateKill(kill({ adminError: "socket closed" }))
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("admin-failed")
	})
})
