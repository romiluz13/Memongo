import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	DEFAULT_SEARCH_ADMISSION_BURST,
	DEFAULT_SEARCH_ADMISSION_RPM,
	getSearchAdmissionSnapshot,
	resetSearchAdmissionForTests,
	resolveSearchAdmissionLimits,
	tryConsumeSearchAdmission,
} from "./mongodb-search-admission.js"

// WS-11 change 1 (09-report R5/U1): the process-level token bucket that
// admission-controls searchV2. These tests pin the bucket arithmetic —
// burst capacity, lazy refill, denial retry hints, and the env contract
// (override, disable at 0, invalid fallback) — so the bound is honest.

describe("resolveSearchAdmissionLimits", () => {
	const ORIGINAL_RPM = process.env.MEMONGO_SEARCH_ADMISSION_RPM
	const ORIGINAL_BURST = process.env.MEMONGO_SEARCH_ADMISSION_BURST

	afterEach(() => {
		if (ORIGINAL_RPM === undefined) {
			delete process.env.MEMONGO_SEARCH_ADMISSION_RPM
		} else {
			process.env.MEMONGO_SEARCH_ADMISSION_RPM = ORIGINAL_RPM
		}
		if (ORIGINAL_BURST === undefined) {
			delete process.env.MEMONGO_SEARCH_ADMISSION_BURST
		} else {
			process.env.MEMONGO_SEARCH_ADMISSION_BURST = ORIGINAL_BURST
		}
	})

	it("defaults to a generous process cap (20/sec sustained, 240 burst)", () => {
		const limits = resolveSearchAdmissionLimits({})
		expect(limits).toEqual({
			requestsPerMinute: DEFAULT_SEARCH_ADMISSION_RPM,
			burst: DEFAULT_SEARCH_ADMISSION_BURST,
			enabled: true,
		})
		expect(DEFAULT_SEARCH_ADMISSION_RPM).toBe(1200)
		expect(DEFAULT_SEARCH_ADMISSION_BURST).toBe(240)
	})

	it("honors explicit RPM and burst overrides", () => {
		expect(
			resolveSearchAdmissionLimits({
				MEMONGO_SEARCH_ADMISSION_RPM: "60",
				MEMONGO_SEARCH_ADMISSION_BURST: "10",
			}),
		).toEqual({ requestsPerMinute: 60, burst: 10, enabled: true })
	})

	it("RPM=0 disables admission (documented escape for dedicated tiers)", () => {
		expect(
			resolveSearchAdmissionLimits({ MEMONGO_SEARCH_ADMISSION_RPM: "0" }),
		).toEqual({ requestsPerMinute: 0, burst: 0, enabled: false })
	})

	it("invalid values fall back to the safe defaults", () => {
		expect(
			resolveSearchAdmissionLimits({
				MEMONGO_SEARCH_ADMISSION_RPM: "not-a-number",
				MEMONGO_SEARCH_ADMISSION_BURST: "-5",
			}),
		).toEqual({
			requestsPerMinute: DEFAULT_SEARCH_ADMISSION_RPM,
			burst: DEFAULT_SEARCH_ADMISSION_BURST,
			enabled: true,
		})
	})

	// D2 (independent audit): a fractional positive RPM used to floor to an
	// enabled zero-rate bucket (0.5 -> 0 RPM, 0 burst, Infinity retry hint).
	// Fractional support is now explicit: the rate is honored exactly and the
	// default burst is floored to one token.
	it("honors a fractional RPM as a real rate with a one-token default burst", () => {
		expect(
			resolveSearchAdmissionLimits({ MEMONGO_SEARCH_ADMISSION_RPM: "0.5" }),
		).toEqual({ requestsPerMinute: 0.5, burst: 1, enabled: true })
		// An explicit burst override stays an integral capacity >= 1.
		expect(
			resolveSearchAdmissionLimits({
				MEMONGO_SEARCH_ADMISSION_RPM: "0.5",
				MEMONGO_SEARCH_ADMISSION_BURST: "2.5",
			}),
		).toEqual({ requestsPerMinute: 0.5, burst: 2, enabled: true })
		// Integral settings are unchanged by the max(1, floor) default.
		expect(
			resolveSearchAdmissionLimits({ MEMONGO_SEARCH_ADMISSION_RPM: "60" }),
		).toEqual({ requestsPerMinute: 60, burst: 60, enabled: true })
	})
})

describe("tryConsumeSearchAdmission (bucket arithmetic)", () => {
	const T0 = 1_000_000

	beforeEach(() => {
		resetSearchAdmissionForTests(T0)
	})

	it("admits up to the burst instantaneously and denies the next request", () => {
		// Freeze the clock: zero refill, pure burst behavior.
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST; i++) {
			expect(tryConsumeSearchAdmission(T0)).toEqual({ ok: true })
		}
		const denied = tryConsumeSearchAdmission(T0)
		expect(denied.ok).toBe(false)
	})

	it("denial carries a positive retry hint derived from the refill rate", () => {
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST; i++) {
			tryConsumeSearchAdmission(T0)
		}
		const denied = tryConsumeSearchAdmission(T0)
		if (!denied.ok) {
			// 1200 RPM = 20 tokens/sec; the bucket is fully drained so a full
			// token takes 50ms to refill.
			expect(denied.retryAfterMs).toBeGreaterThan(0)
			expect(denied.retryAfterMs).toBeLessThanOrEqual(50)
		} else {
			throw new Error("expected denial after burst exhaustion")
		}
	})

	it("refills lazily from elapsed time (no timers)", () => {
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST; i++) {
			tryConsumeSearchAdmission(T0)
		}
		expect(tryConsumeSearchAdmission(T0).ok).toBe(false)
		// 1 second later at 1200 RPM = 20 tokens refilled; consume all 20,
		// then the 21st is denied again.
		const t1 = T0 + 1_000
		for (let i = 0; i < 20; i++) {
			expect(tryConsumeSearchAdmission(t1)).toEqual({ ok: true })
		}
		expect(tryConsumeSearchAdmission(t1).ok).toBe(false)
	})

	it("refill never exceeds the burst capacity", () => {
		for (let i = 0; i < 10; i++) {
			tryConsumeSearchAdmission(T0)
		}
		// An hour of idle time cannot overfill the bucket past burst.
		const t1 = T0 + 3_600_000
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST; i++) {
			expect(tryConsumeSearchAdmission(t1)).toEqual({ ok: true })
		}
		expect(tryConsumeSearchAdmission(t1).ok).toBe(false)
	})

	it("disabled admission (RPM=0) admits unconditionally", () => {
		const ORIGINAL_RPM = process.env.MEMONGO_SEARCH_ADMISSION_RPM
		process.env.MEMONGO_SEARCH_ADMISSION_RPM = "0"
		try {
			for (let i = 0; i < 10_000; i++) {
				expect(tryConsumeSearchAdmission(T0)).toEqual({ ok: true })
			}
		} finally {
			if (ORIGINAL_RPM === undefined) {
				delete process.env.MEMONGO_SEARCH_ADMISSION_RPM
			} else {
				process.env.MEMONGO_SEARCH_ADMISSION_RPM = ORIGINAL_RPM
			}
		}
	})

	// D2 (independent audit): a sub-unit RPM used to floor to zero rate —
	// an enabled bucket that throttles everything forever with an Infinity
	// retry hint. 0.5 RPM must now admit one search every two minutes and
	// carry a finite, exact retry hint.
	it("sub-unit RPM admits once per rate interval with a finite retry hint", () => {
		const ORIGINAL_RPM = process.env.MEMONGO_SEARCH_ADMISSION_RPM
		const ORIGINAL_BURST = process.env.MEMONGO_SEARCH_ADMISSION_BURST
		process.env.MEMONGO_SEARCH_ADMISSION_RPM = "0.5"
		delete process.env.MEMONGO_SEARCH_ADMISSION_BURST
		try {
			// Recompute the bucket under the fractional setting: capacity 1.
			resetSearchAdmissionForTests(T0)
			expect(tryConsumeSearchAdmission(T0)).toEqual({ ok: true })
			const denied = tryConsumeSearchAdmission(T0)
			// 1 token at 0.5/min = exactly 120_000ms — finite, not Infinity,
			// and exact (Math.ceil keeps the caller waiting long enough).
			expect(denied).toEqual({ ok: false, retryAfterMs: 120_000 })
			// The hinted interval actually refills one full token.
			expect(tryConsumeSearchAdmission(T0 + 120_000)).toEqual({ ok: true })
		} finally {
			if (ORIGINAL_RPM === undefined) {
				delete process.env.MEMONGO_SEARCH_ADMISSION_RPM
			} else {
				process.env.MEMONGO_SEARCH_ADMISSION_RPM = ORIGINAL_RPM
			}
			if (ORIGINAL_BURST === undefined) {
				delete process.env.MEMONGO_SEARCH_ADMISSION_BURST
			} else {
				process.env.MEMONGO_SEARCH_ADMISSION_BURST = ORIGINAL_BURST
			}
		}
	})

	it("an operator retune to RPM=0 unblocks a denied bucket without a restart", () => {
		const ORIGINAL_RPM = process.env.MEMONGO_SEARCH_ADMISSION_RPM
		const ORIGINAL_BURST = process.env.MEMONGO_SEARCH_ADMISSION_BURST
		process.env.MEMONGO_SEARCH_ADMISSION_RPM = "0.5"
		delete process.env.MEMONGO_SEARCH_ADMISSION_BURST
		try {
			resetSearchAdmissionForTests(T0)
			expect(tryConsumeSearchAdmission(T0).ok).toBe(true)
			expect(tryConsumeSearchAdmission(T0).ok).toBe(false)
			// Limits resolve per call, so the retune takes effect on the
			// very next admission attempt.
			process.env.MEMONGO_SEARCH_ADMISSION_RPM = "0"
			expect(tryConsumeSearchAdmission(T0)).toEqual({ ok: true })
		} finally {
			if (ORIGINAL_RPM === undefined) {
				delete process.env.MEMONGO_SEARCH_ADMISSION_RPM
			} else {
				process.env.MEMONGO_SEARCH_ADMISSION_RPM = ORIGINAL_RPM
			}
			if (ORIGINAL_BURST === undefined) {
				delete process.env.MEMONGO_SEARCH_ADMISSION_BURST
			} else {
				process.env.MEMONGO_SEARCH_ADMISSION_BURST = ORIGINAL_BURST
			}
		}
	})

	it("throttled counter is monotone across denials", () => {
		for (let i = 0; i < DEFAULT_SEARCH_ADMISSION_BURST + 3; i++) {
			tryConsumeSearchAdmission(T0)
		}
		expect(getSearchAdmissionSnapshot(T0).throttled).toBe(3)
	})
})

describe("getSearchAdmissionSnapshot", () => {
	it("reports limits, live token depth, and denial count", () => {
		resetSearchAdmissionForTests(2_000_000)
		tryConsumeSearchAdmission(2_000_000)
		const snapshot = getSearchAdmissionSnapshot(2_000_000)
		expect(snapshot.limits.enabled).toBe(true)
		expect(snapshot.tokens).toBe(DEFAULT_SEARCH_ADMISSION_BURST - 1)
		expect(snapshot.throttled).toBe(0)
	})
})
