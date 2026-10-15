import { describe, expect, it } from "vitest"
import {
	endOfBenchmarkQuestionDay,
	parseBenchmarkTurnTimestamp,
} from "./mongodb-manager-benchmark.js"

describe("benchmark UTC-calendar question cutoff", () => {
	it("uses the declared UTC fields and preserves its input", () => {
		const question = parseBenchmarkTurnTimestamp("2024/06/15 (Sat) 14:30")!
		expect(question.toISOString()).toBe("2024-06-15T14:30:00.000Z")
		expect(endOfBenchmarkQuestionDay(question).toISOString()).toBe(
			"2024-06-15T23:59:59.999Z",
		)
		expect(question.toISOString()).toBe("2024-06-15T14:30:00.000Z")
	})
	it("includes later same-day sessions and excludes next-day sessions", () => {
		const cutoff = endOfBenchmarkQuestionDay(
			parseBenchmarkTurnTimestamp("2024/06/15 (Sat) 01:30")!,
		).getTime()
		expect(
			parseBenchmarkTurnTimestamp("2024/06/15 (Sat) 23:50")!.getTime(),
		).toBeLessThan(cutoff)
		expect(
			parseBenchmarkTurnTimestamp("2024/06/16 (Sun) 00:10")!.getTime(),
		).toBeGreaterThan(cutoff)
		// A local cutoff in Los Angeles would admit this UTC-fields next-day event.
		expect(
			parseBenchmarkTurnTimestamp("2024/06/16 (Sun) 03:00")!.getTime(),
		).toBeGreaterThan(cutoff)
	})
	it("keeps a year boundary on the declared calendar date", () => {
		expect(
			endOfBenchmarkQuestionDay(
				parseBenchmarkTurnTimestamp("2024/12/31 (Tue) 23:59")!,
			).toISOString(),
		).toBe("2024-12-31T23:59:59.999Z")
	})
	it("distinguishes missing timestamps from invalid explicit timestamps", () => {
		expect(parseBenchmarkTurnTimestamp(undefined)).toBeUndefined()
		expect(() => parseBenchmarkTurnTimestamp("bad")).toThrow("timestamp")
	})
})
