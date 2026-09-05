import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Db } from "mongodb"
import {
	DEFAULT_SEARCH_ADMISSION_BURST,
	resetSearchAdmissionForTests,
	tryConsumeSearchAdmission,
} from "./mongodb-search-admission.js"
import { searchV2 } from "./mongodb-search-v2.js"

// WS-11 change 2 (09-report R5/U1): admission denial must surface as a
// DISTINCT throttled outcome — empty results PLUS the throttle marker and
// a retry hint — never as the empty-success that a healthy empty corpus
// produces. These tests pin that contract at the searchV2 seam (the type
// WS-12 consumes upstream).

const TELEMETRY_ENV = "MEMONGO_TELEMETRY_ENABLED"
const RPM_ENV = "MEMONGO_SEARCH_ADMISSION_RPM"

describe("searchV2 admission denial produces a distinct throttled outcome", () => {
	const originalTelemetry = process.env[TELEMETRY_ENV]
	const originalRpm = process.env[RPM_ENV]
	// The throttle branch emits telemetry before returning; a fake Db must
	// never be touched, so disable telemetry for these tests. RPM=1 (one
	// token per MINUTE) makes the post-exhaustion refill rate ~0 for the
	// test's duration, so the denial verdict cannot race the clock between
	// the drain loop below and searchV2's internal Date.now() read.
	beforeEach(() => {
		process.env[TELEMETRY_ENV] = "false"
		process.env[RPM_ENV] = "1"
		resetSearchAdmissionForTests(Date.now())
	})

	afterEach(() => {
		if (originalTelemetry === undefined) {
			delete process.env[TELEMETRY_ENV]
		} else {
			process.env[TELEMETRY_ENV] = originalTelemetry
		}
		if (originalRpm === undefined) {
			delete process.env[RPM_ENV]
		} else {
			process.env[RPM_ENV] = originalRpm
		}
	})

	function exhaustBucket(): void {
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST; i++) {
			tryConsumeSearchAdmission(Date.now())
		}
	}

	it("denial returns empty results with the throttled marker and retry hint", async () => {
		exhaustBucket()
		const fakeDb = {} as Db
		const outcome = await searchV2(fakeDb, "test_", "hello", "agent-a", {
			availablePaths: new Set(["raw-window"]),
		})
		expect(outcome.results).toEqual([])
		expect(outcome.metadata.throttled).toBeDefined()
		expect(outcome.metadata.throttled?.retryAfterMs).toBeGreaterThan(0)
		// Distinct from a healthy empty search: no paths ran and no budget
		// was opened, so both fields say "nothing happened".
		expect(outcome.metadata.pathsExecuted).toEqual([])
		expect(outcome.metadata.resultsByPath).toEqual({})
		expect(outcome.metadata.budget).toBeUndefined()
	})

	it("denial never touches the database (no lanes, no coverage read)", async () => {
		exhaustBucket()
		let touched = 0
		const fakeDb = new Proxy(
			{},
			{
				get: () => {
					touched += 1
					return () => {
						throw new Error("db must not be touched by a throttled search")
					}
				},
			},
		) as unknown as Db
		const outcome = await searchV2(fakeDb, "test_", "hello", "agent-a", {
			availablePaths: new Set(["raw-window"]),
		})
		expect(outcome.metadata.throttled).toBeDefined()
		expect(touched).toBe(0)
	})

	it("an admitted search (tokens available) is never throttled", async () => {
		resetSearchAdmissionForTests(0)
		// Consume all but one token, then run a search that will FAIL fast on
		// the fake db — the point is the admission verdict, not the search
		// result. searchV2 with a cold fake db throws or returns empty; either
		// way metadata.throttled must stay unset because admission passed.
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST - 1; i++) {
			tryConsumeSearchAdmission(0)
		}
		const fakeDb = {} as Db
		let settled: { throttled?: unknown } | null = null
		try {
			const outcome = await searchV2(fakeDb, "t_", "q", "agent-a", {
				availablePaths: new Set(),
			})
			settled = outcome.metadata
		} catch {
			// The fake db cannot serve lanes; an error here is fine — the
			// admission branch already ran and passed.
			settled = { throttled: undefined }
		}
		expect(settled.throttled).toBeUndefined()
	})
})
