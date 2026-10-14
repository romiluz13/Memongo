import { describe, expect, it } from "vitest"

import {
	coldLanes,
	exitCodeForVerdict,
	requiredChecksPassed,
} from "./proof-verdict.js"

describe("proof verdict", () => {
	it("fails when any required check failed", () => {
		expect(
			requiredChecksPassed([
				{ name: "a", ok: true, details: "" },
				{ name: "b", ok: false, details: "" },
			]),
		).toBe(false)
	})

	it("fails when no required check ran", () => {
		expect(requiredChecksPassed([])).toBe(false)
	})

	it("passes only when every required check passed", () => {
		expect(requiredChecksPassed([{ name: "a", ok: true, details: "" }])).toBe(
			true,
		)
	})

	it("maps the verdict to the process exit code", () => {
		expect(exitCodeForVerdict(false)).toBe(1)
		expect(exitCodeForVerdict(true)).toBe(0)
	})

	it("treats a producer-marked lane with count 0 as ready and unmarked lanes as cold", () => {
		expect(
			coldLanes(
				{
					graph: { hasData: true, count: 0 },
					episodic: { hasData: false, count: 0 },
					structured: { hasData: true, count: 3 },
				},
				["graph", "episodic", "structured"],
			),
		).toEqual(["episodic"])
	})

	it("treats a required lane the producer never wrote as cold", () => {
		expect(
			coldLanes({ structured: { hasData: true, count: 3 } }, [
				"structured",
				"graph",
			]),
		).toEqual(["graph"])
	})
})
