import { describe, expect, it } from "vitest"
import {
	BENCHMARK_ARMS_ENV,
	benchmarkArmsRunError,
	parseBenchmarkArms,
	resolveBenchmarkArms,
} from "./benchmark-arms.js"

const FOUR_ARMS = "v1=custom-v1,v2=custom-v2,v3=custom-v3,v3r=custom-v3+recall"

describe("parseBenchmarkArms", () => {
	it("reads named arms in order, recall off unless +recall", () => {
		expect(parseBenchmarkArms(FOUR_ARMS)).toEqual([
			{ name: "v1", protocol: "custom-v1", sessionTurnRecall: false },
			{ name: "v2", protocol: "custom-v2", sessionTurnRecall: false },
			{ name: "v3", protocol: "custom-v3", sessionTurnRecall: false },
			{ name: "v3r", protocol: "custom-v3", sessionTurnRecall: true },
		])
	})

	it("ignores whitespace around entries", () => {
		expect(
			parseBenchmarkArms(" a = custom-v1 , b = custom-v3 + recall "),
		).toEqual([
			{ name: "a", protocol: "custom-v1", sessionTurnRecall: false },
			{ name: "b", protocol: "custom-v3", sessionTurnRecall: true },
		])
	})

	it.each([
		["", "names no arms"],
		["  ", "names no arms"],
		["v1=custom-v1,,v2=custom-v2", 'entry "" is not name=protocol[+recall]'],
		["v1", 'entry "v1" is not name=protocol[+recall]'],
		["=custom-v1,v2=custom-v2", 'entry "=custom-v1" is not name=protocol'],
		["v 1=custom-v1,v2=custom-v2", 'arm name "v 1" must match'],
		["v1=custom-v1,v2=custom-v9", 'arm v2 has unknown protocol "custom-v9"'],
		[
			"v1=custom-v1,v2=official",
			"arm v2 uses official: official and custom-judge cannot run as paired arms",
		],
		[
			"v1=custom-v1,v2=custom-judge",
			"arm v2 uses custom-judge: official and custom-judge cannot run as paired arms",
		],
		["v1=custom-v1,v2=custom-v3+turns", 'arm v2 has unknown modifier "turns"'],
		["v1=custom-v1,v1=custom-v2", 'duplicate arm name "v1"'],
		["v1=custom-v1", "a paired run needs at least two arms; got 1"],
	])("refuses %j", (raw, message) => {
		expect(() => parseBenchmarkArms(raw)).toThrow(message)
	})
})

describe("resolveBenchmarkArms", () => {
	it("is undefined when the setting is absent", () => {
		expect(resolveBenchmarkArms({})).toBeUndefined()
	})

	it("refuses a blank setting instead of reading it as absent", () => {
		expect(() => resolveBenchmarkArms({ [BENCHMARK_ARMS_ENV]: "" })).toThrow(
			"names no arms",
		)
	})

	it("refuses a QA protocol or turn recall flag the arms would override", () => {
		expect(() =>
			resolveBenchmarkArms({
				[BENCHMARK_ARMS_ENV]: FOUR_ARMS,
				MEMONGO_BENCHMARK_QA_PROTOCOL: "official",
			}),
		).toThrow(
			"MEMONGO_BENCHMARK_ARMS fixes each arm's QA protocol: unset MEMONGO_BENCHMARK_QA_PROTOCOL",
		)
		expect(() =>
			resolveBenchmarkArms({
				[BENCHMARK_ARMS_ENV]: FOUR_ARMS,
				MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v1",
			}),
		).toThrow("unset MEMONGO_BENCHMARK_QA_PROTOCOL")
		expect(() =>
			resolveBenchmarkArms({
				[BENCHMARK_ARMS_ENV]: FOUR_ARMS,
				MEMONGO_SESSION_TURN_RECALL: "enabled",
			}),
		).toThrow(
			"MEMONGO_BENCHMARK_ARMS fixes session turn recall per arm: unset MEMONGO_SESSION_TURN_RECALL",
		)
	})
})

describe("benchmarkArmsRunError", () => {
	it("is null without arms and for a subset run with valid arms", () => {
		expect(benchmarkArmsRunError({}, { publishable: true })).toBeNull()
		expect(
			benchmarkArmsRunError(
				{ [BENCHMARK_ARMS_ENV]: FOUR_ARMS },
				{ publishable: false },
			),
		).toBeNull()
	})

	it("refuses arms on a publishable full500 run", () => {
		expect(
			benchmarkArmsRunError(
				{ [BENCHMARK_ARMS_ENV]: FOUR_ARMS },
				{ publishable: true },
			),
		).toBe(
			"MEMONGO_BENCHMARK_ARMS cannot run on the publishable full500 run: use --questions or --sample",
		)
	})

	it("returns the validation message for invalid arms", () => {
		expect(
			benchmarkArmsRunError(
				{ [BENCHMARK_ARMS_ENV]: "v1=custom-v1" },
				{ publishable: false },
			),
		).toBe("a paired run needs at least two arms; got 1")
	})
})
