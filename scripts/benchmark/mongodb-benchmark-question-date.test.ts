import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	endOfBenchmarkQuestionDay,
	parseBenchmarkTurnTimestamp,
} from "./mongodb-manager-benchmark.js"

// CI runners default to TZ=UTC, where `setUTCHours` and `setHours` are
// identical — the reverted (broken) UTC implementation would pass every
// local-calendar assertion there. Pinning a non-UTC timezone inside the
// test file keeps the regression guard meaningful everywhere. Asia/Tokyo
// (UTC+9, no DST) makes the UTC day end differ from the local day end by
// nine hours.
const PINNED_TZ = "Asia/Tokyo"
const ORIGINAL_TZ = process.env.TZ

beforeAll(() => {
	process.env.TZ = PINNED_TZ
})

afterAll(() => {
	process.env.TZ = ORIGINAL_TZ
})

// LongMemEval `question_date` is a wall-clock timestamp in the nonstandard
// `YYYY/MM/DD (Ddd) HH:MM` format (all 500 entries; none are date-only).
// `new Date()` parses it leniently in the machine's LOCAL timezone, and the
// engine parses session timestamps the same way, so every assertion below
// compares LOCAL calendar fields instead of UTC instants: the widened
// boundary must land on the question's own wall-clock day on any machine,
// not just a UTC one.
describe("endOfBenchmarkQuestionDay (backlog B3)", () => {
	it("widens a real-format questionDate to the end of its local calendar day", () => {
		const questionDate = parseBenchmarkTurnTimestamp("2024/06/15 (Sat) 14:30")
		expect(questionDate).toBeDefined()

		const endOfDay = endOfBenchmarkQuestionDay(questionDate as Date)
		// Same local calendar day, terminal local time-of-day.
		expect(endOfDay.getFullYear()).toBe(questionDate?.getFullYear())
		expect(endOfDay.getMonth()).toBe(questionDate?.getMonth())
		expect(endOfDay.getDate()).toBe(questionDate?.getDate())
		expect(endOfDay.getHours()).toBe(23)
		expect(endOfDay.getMinutes()).toBe(59)
		expect(endOfDay.getSeconds()).toBe(59)
		expect(endOfDay.getMilliseconds()).toBe(999)
	})

	it("keeps same-day answer sessions eligible under the engine's validAt guard", () => {
		// Failure scenario: the answer session occurred at 23:50 wall-clock on
		// the question's own day, later than the 14:30 question timestamp. The
		// engine's production guard (`validAt <= questionDate`) drops it when
		// the benchmark passes the parsed timestamp; the widened end-of-day
		// reference keeps it. Both timestamps go through the same lenient
		// local parse, so this holds on any machine timezone.
		const questionDate = parseBenchmarkTurnTimestamp(
			"2024/06/15 (Sat) 14:30",
		) as Date
		const answerSessionAt = parseBenchmarkTurnTimestamp(
			"2024/06/15 (Sat) 23:50",
		) as Date
		const endOfDay = endOfBenchmarkQuestionDay(questionDate)

		expect(answerSessionAt.getTime()).toBeGreaterThan(questionDate.getTime())
		expect(answerSessionAt.getTime()).toBeLessThanOrEqual(endOfDay.getTime())
	})

	it("excludes sessions from the next wall-clock day", () => {
		// The widening must not leak next-day sessions in: a session at 00:10
		// the following day stays past the widened boundary.
		const questionDate = parseBenchmarkTurnTimestamp(
			"2024/06/15 (Sat) 14:30",
		) as Date
		const nextDaySessionAt = parseBenchmarkTurnTimestamp(
			"2024/06/16 (Sun) 00:10",
		) as Date
		const endOfDay = endOfBenchmarkQuestionDay(questionDate)

		expect(nextDaySessionAt.getTime()).toBeGreaterThan(endOfDay.getTime())
	})

	it("keeps a late-evening same-day session that a UTC-day boundary would drop (Tokyo 01:30 question)", () => {
		// Regression case for the reverted UTC implementation. In Tokyo the
		// question instant "2024/06/15 (Sat) 01:30" is 2024-06-14T16:30Z, so
		// the end of its UTC day (2024-06-14T23:59:59.999Z) is only 08:59:59
		// local on June 15. A same-day answer session at 20:00 local
		// (2024-06-15T11:00Z) lands past that UTC boundary and would be
		// excluded; the local-calendar boundary keeps it. Under the pinned
		// UTC of CI, the old `setUTCHours` implementation could not be
		// distinguished from the correct one — this case makes the breakage
		// visible under the pinned Tokyo timezone.
		const questionDate = parseBenchmarkTurnTimestamp(
			"2024/06/15 (Sat) 01:30",
		) as Date
		const sameDaySessionAt = parseBenchmarkTurnTimestamp(
			"2024/06/15 (Sat) 20:00",
		) as Date
		const endOfDay = endOfBenchmarkQuestionDay(questionDate)

		// The boundary is the question's own local calendar day end: 23:59:59.999
		// on June 15 in Tokyo (2024-06-15T14:59:59.999Z), not its UTC day end.
		expect(endOfDay.toISOString()).toBe("2024-06-15T14:59:59.999Z")
		expect(sameDaySessionAt.getTime()).toBeLessThanOrEqual(endOfDay.getTime())
	})

	it("overwrites any time-of-day in the input without rolling the local calendar day", () => {
		const input = parseBenchmarkTurnTimestamp("2024/12/31 (Tue) 23:59") as Date
		const widened = endOfBenchmarkQuestionDay(input)
		expect(widened.getFullYear()).toBe(input.getFullYear())
		expect(widened.getMonth()).toBe(input.getMonth())
		expect(widened.getDate()).toBe(input.getDate())
	})

	it("does not mutate the input date", () => {
		const input = new Date("2024-06-15T08:30:00.000Z")
		const before = input.getTime()
		endOfBenchmarkQuestionDay(input)
		expect(input.getTime()).toBe(before)
	})
})
