import { describe, expect, it } from "vitest"
import { BudgetRefusal, createBudget, validateLimits } from "./budget.ts"

const PRICES = {
	"answer-model": {
		inputUsdPerMTok: 1,
		outputUsdPerMTok: 4,
		source: "fixture",
	},
}

function budget(overrides: Partial<Parameters<typeof createBudget>[0]> = {}) {
	return createBudget({
		ceilingUsd: 1,
		prices: PRICES,
		caps: { "api-write": 5, "answer-llm": 3 },
		...overrides,
	})
}

function refusal(fn: () => unknown): BudgetRefusal {
	try {
		fn()
	} catch (error) {
		if (error instanceof BudgetRefusal) return error
		throw error
	}
	throw new Error("expected a BudgetRefusal")
}

describe("budget reservation", () => {
	it("reserves worst-case cost before dispatch: input bytes at one token per byte plus the output cap", () => {
		const b = budget()
		const r = b.reserveLlm({
			path: "answer-llm",
			model: "answer-model",
			inputBytes: 1000,
			maxOutputTokens: 512,
		})
		expect(r.usd).toBeCloseTo((1000 * 1 + 512 * 4) / 1_000_000, 10)
		expect(b.snapshot().reservedUsd).toBeCloseTo(r.usd, 10)
	})

	it("multiplies the worst case by the attempts a single dispatch may make", () => {
		const b = budget()
		const r = b.reserveLlm({
			path: "answer-llm",
			model: "answer-model",
			inputBytes: 100,
			maxOutputTokens: 10,
			attempts: 3,
		})
		expect(r.usd).toBeCloseTo((3 * (100 * 1 + 10 * 4)) / 1_000_000, 10)
	})

	it("fails closed on a model with no price", () => {
		const b = budget()
		const error = refusal(() =>
			b.reserveLlm({
				path: "answer-llm",
				model: "mystery-model",
				inputBytes: 10,
				maxOutputTokens: 10,
			}),
		)
		expect(error.reason).toBe("unpriced")
		expect(b.snapshot().reservedUsd).toBe(0)
	})

	it("fails closed on a counted path with no cap", () => {
		const error = refusal(() => budget().reserveCount("surprise-path"))
		expect(error.reason).toBe("unpriced")
	})

	it("refuses invalid quantities instead of reserving NaN", () => {
		const b = budget()
		for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, 0.5]) {
			expect(
				refusal(() =>
					b.reserveLlm({
						path: "answer-llm",
						model: "answer-model",
						inputBytes: bad,
						maxOutputTokens: 10,
					}),
				).reason,
			).toBe("invalid")
		}
		expect(refusal(() => b.reserveCount("api-write", 0)).reason).toBe("invalid")
		expect(b.snapshot().reservedUsd).toBe(0)
	})

	it("refuses to cross the dollar ceiling and keeps earlier reservations", () => {
		const b = budget({ ceilingUsd: 0.001 })
		const ok = b.reserveLlm({
			path: "answer-llm",
			model: "answer-model",
			inputBytes: 100,
			maxOutputTokens: 100,
		})
		const error = refusal(() =>
			b.reserveLlm({
				path: "answer-llm",
				model: "answer-model",
				inputBytes: 100_000,
				maxOutputTokens: 100,
			}),
		)
		expect(error.reason).toBe("ceiling")
		expect(b.snapshot().reservedUsd).toBeCloseTo(ok.usd, 10)
	})

	it("enforces invocation-wide caps across runs and probes", () => {
		const b = budget()
		b.reserveCount("api-write", 3)
		b.reserveCount("api-write", 2)
		expect(refusal(() => b.reserveCount("api-write")).reason).toBe("cap")
		expect(b.snapshot().calls["api-write"]).toBe(5)
	})

	it("settles to reported usage when it is below the reservation", () => {
		const b = budget()
		const r = b.reserveLlm({
			path: "answer-llm",
			model: "answer-model",
			inputBytes: 1000,
			maxOutputTokens: 512,
		})
		b.settle(r, { inputTokens: 100, outputTokens: 10 })
		expect(b.snapshot().settledUsd).toBeCloseTo(
			(100 * 1 + 10 * 4) / 1_000_000,
			10,
		)
	})

	it("keeps the reservation as the cost when reported usage exceeds it or is absent", () => {
		const b = budget()
		const r = b.reserveLlm({
			path: "answer-llm",
			model: "answer-model",
			inputBytes: 10,
			maxOutputTokens: 10,
		})
		b.settle(r, { inputTokens: 1_000_000, outputTokens: 1_000_000 })
		expect(b.snapshot().settledUsd).toBeCloseTo(r.usd, 10)
		const r2 = b.reserveLlm({
			path: "answer-llm",
			model: "answer-model",
			inputBytes: 10,
			maxOutputTokens: 10,
		})
		b.settle(r2)
		expect(b.snapshot().settledUsd).toBeCloseTo(r.usd + r2.usd, 10)
	})

	it("counts a refused reservation and never double-settles", () => {
		const b = budget()
		refusal(() => b.reserveCount("nope"))
		expect(b.snapshot().refusals).toBe(1)
		const r = b.reserveCount("api-write")
		b.settle(r)
		b.settle(r)
		expect(b.snapshot().calls["api-write"]).toBe(1)
	})
})

describe("validateLimits", () => {
	it("accepts finite positive integer runs and a finite positive ceiling", () => {
		expect(validateLimits({ runs: 2, ceilingUsd: 20 })).toEqual({
			runs: 2,
			ceilingUsd: 20,
		})
	})

	it("rejects non-finite, non-integer, zero, negative and oversized values", () => {
		for (const runs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 6]) {
			expect(() => validateLimits({ runs, ceilingUsd: 20 })).toThrow(
				BudgetRefusal,
			)
		}
		for (const ceilingUsd of [
			0,
			-3,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			21,
		]) {
			expect(() => validateLimits({ runs: 2, ceilingUsd })).toThrow(
				BudgetRefusal,
			)
		}
	})
})
