import { describe, expect, it } from "vitest"
import { evaluateRouteHealth } from "./health.ts"
import {
	B_MAX_CALLS,
	type BControl,
	buildBFixture,
	fixtureViolations,
} from "./probe-b-fixtures.ts"
import {
	type BCall,
	type BCaseFacts,
	B_GAPS,
	classifyAnswerShape,
	evaluateProbeB,
	PROBE_B_RULE,
	PROBE_B_VERSION,
	requiredCaseIdsB,
} from "./probe-b-model.ts"

const fixture = buildBFixture(
	(position) => `zqb${String(position).padStart(4, "0")}`,
)

const healthy = evaluateRouteHealth("search", {
	kind: "response",
	route: "search",
	body: {
		results: [{ snippet: "x" }],
		outcomes: { status: "complete", lanes: [] },
	},
})
const unhealthy = evaluateRouteHealth("search", {
	kind: "response",
	route: "search",
	body: { results: [], outcomes: { status: "partial", lanes: [] } },
})

const answered = (answer: string): BCall => ({ outcome: "answered", answer })

function controlFacts(
	control: BControl,
	overrides: Partial<BCaseFacts> = {},
): BCaseFacts {
	return {
		caseId: control.caseId,
		kind: "control",
		marker: control.marker,
		retrieval: { health: healthy, markerSeen: true },
		calls: [answered(`The code is ${control.marker}.`)],
		...overrides,
	}
}

function neverFacts(
	index: number,
	overrides: Partial<BCaseFacts> = {},
): BCaseFacts {
	const item = fixture.never[index]
	if (!item) throw new Error("no such case")
	return {
		caseId: item.caseId,
		kind: "never",
		pairedControl: item.pairedControl,
		retrieval: { health: healthy, markerSeen: false },
		calls: [answered("")],
		...overrides,
	}
}

function allFacts(): BCaseFacts[] {
	return [
		...fixture.controls.map((control) => controlFacts(control)),
		...fixture.never.map((_, index) => neverFacts(index)),
	]
}

function evaluate(facts: BCaseFacts[], violations: string[] = []) {
	return evaluateProbeB(facts, violations)
}

function caseOf(result: ReturnType<typeof evaluate>, id: string) {
	const found = result.cases.find((item) => item.caseId === id)
	if (!found) throw new Error(`missing ${id}`)
	return found
}

describe("B fixture", () => {
	it("has twenty paired controls, twenty never-written cases and thirty seeds", () => {
		expect(fixture.controls).toHaveLength(20)
		expect(fixture.never).toHaveLength(20)
		expect(fixture.seeds).toHaveLength(30)
		expect(B_MAX_CALLS).toBe(60)
	})

	it("keeps every never-written fact out of the whole seeded dataset", () => {
		expect(fixtureViolations(fixture)).toEqual([])
		const corpus = fixture.seeds
			.map((seed) => seed.text.toLowerCase())
			.join("\n")
		for (const item of fixture.never) {
			for (const token of item.absent) {
				expect(corpus).not.toContain(token.toLowerCase())
			}
		}
	})

	it("reports a never-written fact that leaked into the seeds", () => {
		const leaked = {
			...fixture,
			seeds: [
				...fixture.seeds,
				{ id: "x", kind: "distractor" as const, text: "Vexmoor has a vault." },
			],
		}
		expect(fixtureViolations(leaked).join(" ")).toContain("Vexmoor")
	})

	it("reports duplicate or nested markers and unknown pairings", () => {
		const clash = buildBFixture(() => "same")
		expect(fixtureViolations(clash).join(" ")).toContain("not unique")
		const nested = buildBFixture((position) =>
			position === 0 ? "zq" : `zq${position}`,
		)
		expect(fixtureViolations(nested).join(" ")).toContain(
			"contained in another marker",
		)
		const orphan = {
			...fixture,
			never: fixture.never.map((item, index) =>
				index === 0 ? { ...item, pairedControl: "B/control/99" } : item,
			),
		}
		expect(fixtureViolations(orphan).join(" ")).toContain("paired control")
	})

	it("gives every never-written question a pairing with an existing control", () => {
		const ids = new Set(fixture.controls.map((control) => control.caseId))
		for (const item of fixture.never)
			expect(ids.has(item.pairedControl)).toBe(true)
	})
})

describe("classifyAnswerShape", () => {
	it("accepts a string answer, a fenced answer and an empty answer", () => {
		expect(classifyAnswerShape('{"answer":"x"}')).toBe("answer")
		expect(classifyAnswerShape('```json\n{"answer":""}\n```')).toBe("answer")
		expect(classifyAnswerShape('{"answer":""}')).toBe("answer")
	})

	it("flags non-JSON, a missing answer and a non-string answer as malformed", () => {
		expect(classifyAnswerShape("I think it is 4")).toBe("malformed")
		expect(classifyAnswerShape("{}")).toBe("malformed")
		expect(classifyAnswerShape('{"answer":42}')).toBe("malformed")
		expect(classifyAnswerShape("")).toBe("malformed")
	})
})

describe("evaluateProbeB controls", () => {
	it("passes when every control contains its unique marker and every never-written case abstains", () => {
		const result = evaluate(allFacts())
		expect(result.cases.filter((item) => item.outcome !== "pass")).toEqual([])
		expect(result.outcome).toBe("pass")
		expect(result.cases).toHaveLength(40)
	})

	it("fails a control whose answer lacks the marker and names the answer", () => {
		const control = fixture.controls[3] as BControl
		const facts = allFacts().map((item) =>
			item.caseId === control.caseId
				? controlFacts(control, { calls: [answered("It is a secret.")] })
				: item,
		)
		const failed = caseOf(evaluate(facts), control.caseId)
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("control-missed")
		expect(failed.detail).toMatchObject({ answer: "It is a secret." })
	})

	it("matches the marker exactly and case sensitively", () => {
		const control = fixture.controls[0] as BControl
		const facts = allFacts().map((item) =>
			item.caseId === control.caseId
				? controlFacts(control, {
						calls: [answered(control.marker.toUpperCase())],
					})
				: item,
		)
		expect(caseOf(evaluate(facts), control.caseId).outcome).toBe("fail")
	})

	it("is inconclusive when the marker was never retrieved, without blaming the answerer", () => {
		const control = fixture.controls[1] as BControl
		const facts = allFacts().map((item) =>
			item.caseId === control.caseId
				? controlFacts(control, {
						retrieval: { health: healthy, markerSeen: false },
						calls: [],
					})
				: item,
		)
		const result = caseOf(evaluate(facts), control.caseId)
		expect(result.outcome).toBe("inconclusive")
		expect(result.reason).toBe("retrieval-miss")
	})

	it("is inconclusive when retrieval was degraded", () => {
		const control = fixture.controls[2] as BControl
		const facts = allFacts().map((item) =>
			item.caseId === control.caseId
				? controlFacts(control, {
						retrieval: { health: unhealthy, markerSeen: true },
					})
				: item,
		)
		expect(caseOf(evaluate(facts), control.caseId).reason).toMatch(
			/^unevaluable:/,
		)
	})

	it("treats provider failure and malformed output as their own outcomes, never as a miss", () => {
		const control = fixture.controls[4] as BControl
		for (const outcome of ["provider-failure", "malformed"] as const) {
			const facts = allFacts().map((item) =>
				item.caseId === control.caseId
					? controlFacts(control, { calls: [{ outcome, answer: "" }] })
					: item,
			)
			const result = caseOf(evaluate(facts), control.caseId)
			expect(result.outcome).toBe("inconclusive")
			expect(result.reason).toBe(`provider:${outcome}`)
		}
	})

	it("uses the last attempt after a retried provider failure", () => {
		const control = fixture.controls[5] as BControl
		const facts = allFacts().map((item) =>
			item.caseId === control.caseId
				? controlFacts(control, {
						calls: [
							{ outcome: "provider-failure", answer: "" },
							answered(`yes ${control.marker}`),
						],
					})
				: item,
		)
		expect(caseOf(evaluate(facts), control.caseId).outcome).toBe("pass")
	})
})

describe("evaluateProbeB never-written cases", () => {
	it("passes an empty answer and the recognized refusal phrasings", () => {
		for (const answer of ["", "I don't know", "No information is available"]) {
			const facts = allFacts().map((item) =>
				item.caseId === "B/never/01"
					? neverFacts(0, { calls: [answered(answer)] })
					: item,
			)
			expect(caseOf(evaluate(facts), "B/never/01").outcome).toBe("pass")
		}
	})

	it("fails when the answerer invents a value and keeps the answer as evidence", () => {
		const facts = allFacts().map((item) =>
			item.caseId === "B/never/02"
				? neverFacts(1, { calls: [answered("The code is 4471.")] })
				: item,
		)
		const failed = caseOf(evaluate(facts), "B/never/02")
		expect(failed.outcome).toBe("fail")
		expect(failed.predicate).toBe("answered-never-written")
		expect(failed.detail).toMatchObject({ answer: "The code is 4471." })
		expect(failed.controlEligible).toBe(true)
	})

	it("fails a different-entity answer that borrowed a control marker", () => {
		const borrowed = (fixture.controls[0] as BControl).marker
		const facts = allFacts().map((item) =>
			item.caseId === "B/never/01"
				? neverFacts(0, { calls: [answered(borrowed)] })
				: item,
		)
		expect(caseOf(evaluate(facts), "B/never/01").outcome).toBe("fail")
	})

	it("is inconclusive, not a pass, when the provider failed on a never-written case", () => {
		for (const outcome of ["provider-failure", "malformed"] as const) {
			const facts = allFacts().map((item) =>
				item.caseId === "B/never/03"
					? neverFacts(2, { calls: [{ outcome, answer: "" }] })
					: item,
			)
			const result = evaluate(facts)
			expect(caseOf(result, "B/never/03").outcome).toBe("inconclusive")
			expect(result.outcome).toBe("inconclusive")
		}
	})

	it("does not credit an abstention when the paired control did not pass", () => {
		const control = fixture.controls[0] as BControl
		const facts = allFacts().map((item) =>
			item.caseId === control.caseId
				? controlFacts(control, { calls: [answered("nothing")] })
				: item,
		)
		const result = evaluate(facts)
		const paired = caseOf(result, "B/never/01")
		expect(paired.outcome).toBe("inconclusive")
		expect(paired.reason).toBe("paired-control-not-passed")
		expect(result.outcome).toBe("fail")
	})

	it("still fails an invented answer when the paired control failed, marked ineligible", () => {
		const control = fixture.controls[0] as BControl
		const facts = allFacts().map((item) =>
			item.caseId === control.caseId
				? controlFacts(control, { calls: [answered("nothing")] })
				: item.caseId === "B/never/01"
					? neverFacts(0, { calls: [answered("It is 1234")] })
					: item,
		)
		const failed = caseOf(evaluate(facts), "B/never/01")
		expect(failed.outcome).toBe("fail")
		expect(failed.controlEligible).toBe(false)
	})

	it("is inconclusive when retrieval for the never-written question was degraded", () => {
		const facts = allFacts().map((item) =>
			item.caseId === "B/never/04"
				? neverFacts(3, { retrieval: { health: unhealthy, markerSeen: false } })
				: item,
		)
		expect(caseOf(evaluate(facts), "B/never/04").reason).toMatch(
			/^unevaluable:/,
		)
	})

	it("declares coverage incomplete for cases the call bound skipped", () => {
		const facts = allFacts().map((item) =>
			item.caseId === "B/never/20"
				? neverFacts(19, { calls: [], skipped: "call-cap" })
				: item,
		)
		const result = evaluate(facts)
		const skipped = caseOf(result, "B/never/20")
		expect(skipped.outcome).toBe("inconclusive")
		expect(skipped.reason).toBe("call-cap")
		expect(result.outcome).toBe("inconclusive")
	})

	it("makes never-written cases inconclusive when the fixture is invalid", () => {
		const result = evaluate(allFacts(), ["B/never/01: leaked"])
		expect(
			result.cases.filter((item) => item.caseId.startsWith("B/never/")),
		).toSatisfy((list: { outcome: string }[]) =>
			list.every((item) => item.outcome === "inconclusive"),
		)
		expect(result.outcome).toBe("inconclusive")
		expect(result.reasons.join(" ")).toContain("fixture-violation")
	})

	it("requires all forty cases", () => {
		const result = evaluate(allFacts().slice(1))
		expect(result.outcome).not.toBe("pass")
		expect(result.reasons.join(" ")).toContain("B/control/01")
		expect(requiredCaseIdsB(fixture)).toHaveLength(40)
	})

	it("states its rule, version and coverage gaps", () => {
		expect(PROBE_B_RULE).toMatch(/isAbstaining/)
		expect(PROBE_B_VERSION).toBe("B-1")
		expect(B_GAPS.length).toBeGreaterThan(0)
	})
})
