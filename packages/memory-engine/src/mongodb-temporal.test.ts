import { describe, expect, it } from "vitest"
import {
	buildUnexpiredClause,
	resolveWriteExpiresAt,
} from "./mongodb-temporal.js"

// ---------------------------------------------------------------------------
// P4.4.1: TTL expiration — pure helpers
// ---------------------------------------------------------------------------

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
