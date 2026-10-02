import { describe, expect, it } from "vitest"
import {
	buildEventLifecycleClause,
	buildUnexpiredClause,
	resolveWriteExpiresAt,
} from "./mongodb-temporal.js"

// ---------------------------------------------------------------------------
// P4.4.1: TTL expiration — pure helpers
// ---------------------------------------------------------------------------

// Minimal MQL-semantics matcher for the lifecycle clause shape emitted by
// buildEventLifecycleClause: $and/$or composition, $exists, $lte/$gt date
// comparisons, and null equality (which also matches a missing field).
function matchesTemporalClause(
	doc: Record<string, unknown>,
	clause: Record<string, unknown>,
): boolean {
	return Object.entries(clause).every(([key, value]) => {
		if (key === "$and" && Array.isArray(value)) {
			return value.every((entry) =>
				matchesTemporalClause(doc, entry as Record<string, unknown>),
			)
		}
		if (key === "$or" && Array.isArray(value)) {
			return value.some((entry) =>
				matchesTemporalClause(doc, entry as Record<string, unknown>),
			)
		}
		if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			!(value instanceof Date)
		) {
			return Object.entries(value as Record<string, unknown>).every(
				([op, operand]) => {
					switch (op) {
						case "$exists":
							return (doc[key] !== undefined) === operand
						case "$lte":
							return (
								doc[key] instanceof Date &&
								operand instanceof Date &&
								doc[key] <= operand
							)
						case "$gt":
							return (
								doc[key] instanceof Date &&
								operand instanceof Date &&
								doc[key] > operand
							)
						default:
							return false
					}
				},
			)
		}
		if (value === null) {
			return doc[key] === null || doc[key] === undefined
		}
		return doc[key] === value
	})
}

describe("buildUnexpiredClause (P4.4.1)", () => {
	it("matches docs with no expiresAt or an expiresAt in the future", () => {
		const asOf = new Date("2026-08-03T12:00:00.000Z")
		expect(buildUnexpiredClause({ asOf })).toEqual({
			$or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: asOf } }],
		})
	})

	it("defaults the comparison clock to now", () => {
		const before = Date.now()
		const clause = buildUnexpiredClause()
		const after = Date.now()
		const gtBranch = clause.$or[1].expiresAt.$gt as Date
		expect(gtBranch.getTime()).toBeGreaterThanOrEqual(before)
		expect(gtBranch.getTime()).toBeLessThanOrEqual(after)
	})

	it("supports a custom field name", () => {
		const asOf = new Date("2026-08-03T12:00:00.000Z")
		expect(buildUnexpiredClause({ asOf, field: "ttlAt" })).toEqual({
			$or: [{ ttlAt: { $exists: false } }, { ttlAt: { $gt: asOf } }],
		})
	})

	it("is semantics-neutral for docs without the field and excludes expired docs", () => {
		const asOf = new Date("2026-08-03T12:00:00.000Z")
		const clause = buildUnexpiredClause({ asOf })
		const matches = (doc: { expiresAt?: Date }): boolean => {
			const branches = clause.$or as Array<Record<string, unknown>>
			return branches.some((branch) => {
				if ("$exists" in (branch.expiresAt as object)) {
					return doc.expiresAt === undefined
				}
				return (
					doc.expiresAt !== undefined &&
					doc.expiresAt.getTime() > asOf.getTime()
				)
			})
		}
		expect(matches({})).toBe(true)
		expect(matches({ expiresAt: new Date("2026-08-03T12:00:01.000Z") })).toBe(
			true,
		)
		expect(matches({ expiresAt: new Date("2026-08-03T11:59:59.000Z") })).toBe(
			false,
		)
	})
})

describe("buildEventLifecycleClause (RET-10)", () => {
	it("composes the canonical bitemporal and TTL arms the events lanes apply", () => {
		const asOf = new Date("2026-09-07T12:00:00.000Z")
		const before = Date.now()
		const clause = buildEventLifecycleClause({ asOf })
		const after = Date.now()
		// Validity arms stay pinned to the resolved historical asOf.
		expect(clause.$and[0]).toEqual({
			$or: [{ validAt: { $exists: false } }, { validAt: { $lte: asOf } }],
		})
		expect(clause.$and[1]).toEqual({
			// The explicit-null branch matters: the events upsert path
			// stores `invalidAt: null` for open windows, so $exists-only
			// arms would drop still-valid events.
			$or: [
				{ invalidAt: { $exists: false } },
				{ invalidAt: null },
				{ invalidAt: { $gt: asOf } },
			],
		})
		// Retention arm uses the wall clock, never the historical asOf: a
		// historical question must not revive a document awaiting physical
		// TTL deletion.
		const expiryArm = clause.$and[2] as {
			$or: Array<Record<string, unknown>>
		}
		expect(expiryArm.$or[0]).toEqual({ expiresAt: { $exists: false } })
		const expiryGt = (expiryArm.$or[1]?.expiresAt as { $gt: Date }).$gt
		expect(expiryGt).toBeInstanceOf(Date)
		expect(expiryGt.getTime()).toBeGreaterThanOrEqual(before)
		expect(expiryGt.getTime()).toBeLessThanOrEqual(after)
		expect(expiryGt.getTime()).not.toBe(asOf.getTime())
	})

	it("splits the clocks: validity at the historical asOf, retention at wall-now", () => {
		// Behavioral discrimination of the two clocks over one emitted
		// clause: a historical question at 2026-01-10 evaluated under a
		// wall clock after 2026-01-15.
		const asOf = new Date("2026-01-10T00:00:00.000Z")
		const clause = buildEventLifecycleClause({ asOf })
		const matches = (doc: Record<string, unknown>): boolean =>
			matchesTemporalClause(doc, clause)

		// Historically valid + currently invalid (invalidAt AFTER the
		// question) + unexpired: usable as of the historical query.
		expect(
			matches({
				validAt: new Date("2026-01-01T00:00:00.000Z"),
				invalidAt: new Date("2026-01-15T00:00:00.000Z"),
				expiresAt: new Date("2027-01-01T00:00:00.000Z"),
			}),
		).toBe(true)
		// Expired after the question but before wall-now: retention does
		// NOT honor the question clock.
		expect(matches({ expiresAt: new Date("2026-01-15T00:00:00.000Z") })).toBe(
			false,
		)
		// Invalid before the question: excluded under any clock.
		expect(matches({ invalidAt: new Date("2026-01-05T00:00:00.000Z") })).toBe(
			false,
		)
		// Not yet valid at the question: excluded.
		expect(matches({ validAt: new Date("2026-01-20T00:00:00.000Z") })).toBe(
			false,
		)
		// Absent lifecycle fields (legacy / TTL disabled): retained.
		expect(matches({})).toBe(true)
	})

	it("defaults the comparison clock to now for every arm", () => {
		const before = Date.now()
		const clause = buildEventLifecycleClause()
		const after = Date.now()
		const arms = clause.$and as Array<{
			$or: Array<Record<string, { $lte?: Date; $gt?: Date }>>
		}>
		expect(arms).toHaveLength(3)
		const comparisonDates = [
			arms[0]?.$or[1]?.validAt?.$lte,
			arms[1]?.$or[2]?.invalidAt?.$gt,
			arms[2]?.$or[1]?.expiresAt?.$gt,
		]
		for (const date of comparisonDates) {
			expect(date).toBeInstanceOf(Date)
			expect((date as Date).getTime()).toBeGreaterThanOrEqual(before)
			expect((date as Date).getTime()).toBeLessThanOrEqual(after)
		}
	})
})

describe("resolveWriteExpiresAt (P4.4.1)", () => {
	const now = new Date("2026-08-03T12:00:00.000Z")

	it("returns undefined when the TTL config is disabled and no explicit expiresAt is given", () => {
		expect(
			resolveWriteExpiresAt({
				sessionId: "sess-1",
				ttl: { enabled: false, sessionDays: 7 },
				now,
			}),
		).toBeUndefined()
		expect(resolveWriteExpiresAt({ sessionId: "sess-1", now })).toBeUndefined()
	})

	it("returns the explicit per-write expiresAt even when TTL is disabled", () => {
		const explicit = new Date("2026-09-01T00:00:00.000Z")
		expect(
			resolveWriteExpiresAt({
				explicit,
				ttl: { enabled: false, sessionDays: 7 },
				now,
			}),
		).toBe(explicit)
	})

	it("derives expiresAt from the session-scope default when enabled and a sessionId is present", () => {
		expect(
			resolveWriteExpiresAt({
				sessionId: "sess-1",
				ttl: { enabled: true, sessionDays: 7 },
				now,
			}),
		).toEqual(new Date(now.getTime() + 7 * 86_400_000))
	})

	it("does not derive expiresAt for writes without a sessionId", () => {
		expect(
			resolveWriteExpiresAt({
				ttl: { enabled: true, sessionDays: 7 },
				now,
			}),
		).toBeUndefined()
	})

	it("lets an explicit per-write expiresAt win over the session-scope default", () => {
		const explicit = new Date("2026-08-10T00:00:00.000Z")
		expect(
			resolveWriteExpiresAt({
				explicit,
				sessionId: "sess-1",
				ttl: { enabled: true, sessionDays: 7 },
				now,
			}),
		).toBe(explicit)
	})
})
