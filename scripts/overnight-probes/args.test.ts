import { describe, expect, it } from "vitest"
import { ArgsRefusal, parseArgs } from "./args.ts"

function refusal(fn: () => unknown): Error {
	try {
		fn()
	} catch (error) {
		if (error instanceof ArgsRefusal) return error
		throw error
	}
	throw new Error("expected a refusal")
}

describe("parseArgs", () => {
	it("defaults to all probes, two runs, json off", () => {
		expect(parseArgs([])).toEqual({
			probes: ["A", "B", "C", "D", "E", "F", "G"],
			runs: 2,
			json: false,
		})
	})

	it("parses a probe list, runs and json in any order", () => {
		expect(parseArgs(["--json", "--runs", "3", "--probes", "G,A"])).toEqual({
			probes: ["G", "A"],
			runs: 3,
			json: true,
		})
		expect(parseArgs(["--probes=C", "--runs=1"]).probes).toEqual(["C"])
	})

	it("refuses an unknown probe letter, lowercase letters, duplicates and empty lists", () => {
		for (const probes of ["H", "A,Z", "a", "A,A", "", "A,,B", "AB"]) {
			expect(refusal(() => parseArgs(["--probes", probes])).message).toMatch(
				/probe/i,
			)
		}
	})

	it("refuses invalid run counts", () => {
		for (const runs of [
			"0",
			"-1",
			"1.5",
			"abc",
			"",
			"1e3",
			"6",
			"NaN",
			"Infinity",
		]) {
			expect(refusal(() => parseArgs(["--runs", runs])).message).toMatch(
				/runs/i,
			)
		}
	})

	it("refuses a missing flag value", () => {
		expect(refusal(() => parseArgs(["--runs"])).message).toMatch(/runs/i)
		expect(refusal(() => parseArgs(["--probes"])).message).toMatch(/probe/i)
	})

	it("refuses external target overrides by name and unknown flags", () => {
		for (const flag of [
			"--base-url",
			"--api-url",
			"--url",
			"--database",
			"--db",
			"--uri",
			"--port",
			"--host",
			"--api-key",
		]) {
			expect(refusal(() => parseArgs([flag, "x"])).message).toMatch(
				/refused|override/i,
			)
		}
		expect(refusal(() => parseArgs(["--frobnicate"])).message).toMatch(
			/unknown/i,
		)
		expect(refusal(() => parseArgs(["positional"])).message).toMatch(/unknown/i)
	})

	it("does not echo the value of a refused flag", () => {
		const message = refusal(() =>
			parseArgs(["--uri=mongodb://user:pw-SENTINEL@host/db"]),
		).message
		expect(message).not.toContain("pw-SENTINEL")
	})
})
