import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type RunQuestionMetrics, joinB2Runs, main } from "./b2-join.js"

type Verdict = "yes" | "no"
type Outcome = [a: Verdict, b: Verdict]

// gains: A no -> B yes; losses: A yes -> B no; the rest concordant.
function outcomes(gains: number, losses: number, n: number): Outcome[] {
	const rows: Outcome[] = []
	for (let i = 0; i < gains; i++) rows.push(["no", "yes"])
	for (let i = 0; i < losses; i++) rows.push(["yes", "no"])
	while (rows.length < n)
		rows.push(rows.length % 2 ? ["yes", "yes"] : ["no", "no"])
	return rows
}

function maps(rows: Outcome[], recall?: Array<[number, number]>) {
	const a = new Map<string, RunQuestionMetrics>()
	const b = new Map<string, RunQuestionMetrics>()
	rows.forEach(([va, vb], i) => {
		const id = `q${i}`
		const [ra, rb] = recall?.[i] ?? [1, 1]
		a.set(id, { questionId: id, recallAnyAt10: ra, verdict: va })
		b.set(id, { questionId: id, recallAnyAt10: rb, verdict: vb })
	})
	return [a, b] as const
}

const ELIGIBLE = {
	eligible: true,
	reasons: [],
	treatment: null,
	independence: "declared-not-verified" as const,
}

describe("joinB2Runs paired inference", () => {
	it("withholds inference from typed maps whose artifacts were never assessed", () => {
		const [a, b] = maps(outcomes(6, 0, 50))
		const report = joinB2Runs(a, b)
		expect(report.inference).toMatchObject({ eligible: false })
		expect(report.inference.reasons.join(" ")).toContain("not assessed")
		expect(report.inference).not.toHaveProperty("pTwoSided")
		expect(report.noiseRule.real).toBe(false)
	})

	it.each([6, 50, 500])("gives p = 0.03125 for 6/0 at n = %i", (n) => {
		const [a, b] = maps(outcomes(6, 0, n))
		const report = joinB2Runs(a, b, { eligibility: ELIGIBLE })
		expect(report.inference).toMatchObject({
			eligible: true,
			endpoint: "official-qa-judged-correct",
			method: "exact-mcnemar-two-sided",
			alpha: 0.05,
			n,
			gains: 6,
			losses: 0,
			discordant: 6,
			pTwoSided: 0.03125,
			evidence: "b-higher",
			practicalSignificance: "not-assessed",
		})
		expect(report.inference.differenceInProportion).toBeCloseTo(6 / n, 12)
		expect(report.noiseRule.real).toBe(true)
	})

	it("reports regressions and inconclusive results without calling them noise", () => {
		const [a, b] = maps(outcomes(0, 6, 50))
		expect(joinB2Runs(a, b, { eligibility: ELIGIBLE }).inference.evidence).toBe(
			"a-higher",
		)
		const [c, d] = maps(outcomes(5, 0, 50))
		const inconclusive = joinB2Runs(c, d, { eligibility: ELIGIBLE })
		expect(inconclusive.inference).toMatchObject({
			pTwoSided: 0.0625,
			evidence: "inconclusive",
		})
		expect(inconclusive.noiseRule.real).toBe(false)
		expect(inconclusive.noiseRule.reason).not.toContain("noise")
	})

	it("cannot declare a win from netQ = 1, netR = 2, threshold 6", () => {
		const recall: Array<[number, number]> = [
			[0, 1],
			[0, 1],
		]
		const [a, b] = maps(outcomes(1, 0, 50), recall)
		const report = joinB2Runs(a, b, {
			eligibility: ELIGIBLE,
			baselineFlips: 5,
		})
		expect(report).toMatchObject({ netQFlips: 1, netR: 2 })
		expect(report.noiseRule.threshold).toBe(6)
		expect(report.inference.evidence).toBe("inconclusive")
		expect(report.noiseRule.real).toBe(false)
	})

	it("keeps the baseline threshold descriptive instead of vetoing the test", () => {
		const [a, b] = maps(outcomes(6, 0, 50))
		const report = joinB2Runs(a, b, {
			eligibility: ELIGIBLE,
			baselineFlips: 6,
		})
		expect(report.noiseRule.threshold).toBe(7)
		expect(report.inference.evidence).toBe("b-higher")
	})

	it("tests binary session R@10 as the r-only endpoint and refuses fractions", () => {
		const recall: Array<[number, number]> = Array.from({ length: 6 }, () => [
			0, 1,
		])
		const [a, b] = maps(outcomes(0, 0, 20), recall)
		const report = joinB2Runs(a, b, { eligibility: ELIGIBLE, rOnly: true })
		expect(report.inference).toMatchObject({
			endpoint: "session-recall-any-at-10",
			gains: 6,
			pTwoSided: 0.03125,
		})
		const fractional = maps(outcomes(0, 0, 20), [[0.5, 1], ...recall])
		const refused = joinB2Runs(fractional[0], fractional[1], {
			eligibility: ELIGIBLE,
			rOnly: true,
		})
		expect(refused.inference.eligible).toBe(false)
		expect(refused.inference.reasons.join(" ")).toContain("binary")
	})

	it("refuses incomplete pairs even when artifacts were assessed eligible", () => {
		const [a, b] = maps(outcomes(6, 0, 10))
		b.set("q9", { questionId: "q9", recallAnyAt10: 1, verdict: null })
		const report = joinB2Runs(a, b, { eligibility: ELIGIBLE })
		expect(report.inference.eligible).toBe(false)
		expect(report.inference.reasons.join(" ")).toContain("incomplete pairs")
	})
})

const IDENTITY = {
	datasetSha256: "d".repeat(64),
	configurationHash: "c".repeat(64),
	answerModel: "answer-1",
	judgeModel: "judge-1",
	judgeProtocol: "official",
	promptVersion: "prompt-1",
	answerPromptVersion: "dated-v1",
	answerTemperature: "0",
	answerMaxTokens: "512",
}

type Fixture = {
	checkpoint: Record<string, unknown> & {
		completedScenarios: Array<{
			scenarioId: string
			executionsByPass: Array<Array<Record<string, unknown>>>
		}>
	}
	sidecar: Record<string, unknown> & {
		identity: Record<string, string>
		rows: Record<string, Record<string, unknown>>
	}
}

function fixture(
	runId: string,
	verdicts: Verdict[],
	recall?: number[],
): Fixture {
	const ids = verdicts.map((_, i) => `q${i}`)
	return {
		checkpoint: {
			version: 2,
			runId,
			datasetSha256: IDENTITY.datasetSha256,
			configurationHash: IDENTITY.configurationHash,
			executableDigest: "e".repeat(64),
			totalScenarios: ids.length,
			scenarioIds: ids,
			completedScenarios: ids.map((id, i) => ({
				scenarioId: id,
				executionsByPass: [
					[
						{
							caseId: id,
							longMemEval: {
								session: { recallAnyAt10: recall?.[i] ?? 1 },
							},
						},
					],
				],
			})),
		},
		sidecar: {
			version: "v2",
			identity: { runId, ...IDENTITY },
			rows: Object.fromEntries(
				ids.map((id, i) => [
					id,
					{
						questionId: id,
						stage: "judged",
						hypothesis: "h",
						verdict: verdicts[i],
						updatedAt: "2026-10-14T00:00:00.000Z",
					},
				]),
			),
		},
	}
}

function pair(gains = 6, losses = 0, n = 20) {
	const rows = outcomes(gains, losses, n)
	return [
		fixture(
			"run-a",
			rows.map(([a]) => a),
		),
		fixture(
			"run-b",
			rows.map(([, b]) => b),
		),
	] as const
}

const dirs: string[] = []
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true })
})

async function cli(
	a: Fixture,
	b: Fixture,
	flags: string[] = ["--assume-independent-questions"],
) {
	const dir = await mkdtemp(path.join(tmpdir(), "b2-inference-"))
	dirs.push(dir)
	const paths: string[] = []
	for (const [name, f] of [
		["a.json", a],
		["b.json", b],
	] as const) {
		const file = path.join(dir, name)
		await writeFile(file, JSON.stringify(f.checkpoint))
		await writeFile(`${file}.predictions.json`, JSON.stringify(f.sidecar))
		paths.push(file)
	}
	const previous = process.exitCode
	process.exitCode = 0
	const stdout: string[] = []
	const stderr: string[] = []
	const log = vi.spyOn(console, "log").mockImplementation((m) => {
		stdout.push(String(m))
	})
	const err = vi.spyOn(console, "error").mockImplementation((m) => {
		stderr.push(String(m))
	})
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	try {
		await main(["--a", paths[0], "--b", paths[1], ...flags])
	} catch (error) {
		stderr.push(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	}
	const code = process.exitCode
	process.exitCode = previous
	log.mockRestore()
	err.mockRestore()
	warn.mockRestore()
	const out = stdout.join("\n")
	return {
		code,
		stderr: stderr.join("\n"),
		stdout: out,
		report: out ? JSON.parse(out) : undefined,
	}
}

function expectIneligible(
	result: Awaited<ReturnType<typeof cli>>,
	reason: string,
) {
	expect(result.code).toBe(1)
	expect(result.report.inference.eligible).toBe(false)
	expect(result.report.inference.reasons.join(" ")).toContain(reason)
	expect(result.report.inference).not.toHaveProperty("pTwoSided")
	expect(result.report.inference).not.toHaveProperty("evidence")
	expect(result.report.noiseRule.real).toBe(false)
	expect(result.report.questionCount).toBeGreaterThan(0)
}

describe("b2-join CLI comparison eligibility", () => {
	it("tests a compatible matched control under the declared independence assumption", async () => {
		const [a, b] = pair()
		const result = await cli(a, b)
		expect(result.code).toBe(0)
		expect(result.report.inference).toMatchObject({
			eligible: true,
			treatment: null,
			analysisUnit: "question",
			independence: "declared-not-verified",
			n: 20,
			pTwoSided: 0.03125,
			evidence: "b-higher",
		})
	})

	it("withholds inference without a declared independence assumption", async () => {
		const [a, b] = pair()
		const result = await cli(a, b, [])
		expectIneligible(result, "independence")
		expect(result.report.inference.independence).toBe("not-declared")
	})

	it.each(
		Object.keys(IDENTITY).filter((key) => key !== "datasetSha256"),
	)("refuses an undeclared %s difference", async (field) => {
		const [a, b] = pair()
		b.sidecar.identity[field] = "other"
		if (field === "configurationHash") b.checkpoint.configurationHash = "other"
		expectIneligible(await cli(a, b), field)
	})

	it.each([
		"datasetSha256",
		"executableDigest",
	])("refuses a %s difference between runs", async (field) => {
		const [a, b] = pair()
		b.checkpoint[field] = "f".repeat(64)
		if (field === "datasetSha256") b.sidecar.identity[field] = "f".repeat(64)
		expectIneligible(await cli(a, b), field)
	})

	it("accepts exactly one declared scalar treatment difference", async () => {
		const [a, b] = pair()
		b.sidecar.identity.answerModel = "answer-2"
		const result = await cli(a, b, [
			"--assume-independent-questions",
			"--treatment",
			"answerModel",
		])
		expect(result.code).toBe(0)
		expect(result.report.inference).toMatchObject({
			eligible: true,
			treatment: "answerModel",
			evidence: "b-higher",
		})
	})

	it("refuses a declared treatment that hides a second difference or does not differ", async () => {
		const [a, b] = pair()
		b.sidecar.identity.answerModel = "answer-2"
		b.sidecar.identity.judgeModel = "judge-2"
		const flags = [
			"--assume-independent-questions",
			"--treatment",
			"answerModel",
		]
		expectIneligible(await cli(a, b, flags), "judgeModel")
		const [c, d] = pair()
		expectIneligible(await cli(c, d, flags), "answerModel")
	})

	it.each([
		"configurationHash",
		"executableDigest",
		"runId",
		"bogus",
	])("rejects --treatment %s before reading artifacts", async (treatment) => {
		const [a, b] = pair()
		const result = await cli(a, b, [
			"--assume-independent-questions",
			"--treatment",
			treatment,
		])
		expect(result.code).toBe(1)
		expect(result.stdout).toBe("")
		expect(result.stderr).toContain("--treatment")
	})

	it.each([
		["runId", "run-other"],
		["datasetSha256", "f".repeat(64)],
		["configurationHash", "f".repeat(64)],
	])("refuses a sidecar whose %s disagrees with its own checkpoint", async (field, value) => {
		const [a, b] = pair()
		b.sidecar.identity[field] = value
		expectIneligible(await cli(a, b), field)
	})

	it("refuses comparing a run with itself", async () => {
		const [a, b] = pair()
		b.checkpoint.runId = "run-a"
		b.sidecar.identity.runId = "run-a"
		expectIneligible(await cli(a, b), "same run")
	})

	it("refuses runs without recorded identity but still prints the descriptive join", async () => {
		const [a, b] = pair()
		delete b.checkpoint.version
		delete b.checkpoint.executableDigest
		delete (b.sidecar as Record<string, unknown>).identity
		expectIneligible(await cli(a, b), "identity")
	})

	it("refuses missing pairs across the declared population", async () => {
		const [a, b] = pair()
		b.sidecar.rows.q19 = {
			...b.sidecar.rows.q19,
			stage: "unreliable",
			verdict: null,
		}
		const unreliable = await cli(a, b)
		expectIneligible(unreliable, "incomplete pairs")
		expect(unreliable.report.judgedInBoth).toBe(19)
		const [c, d] = pair()
		d.checkpoint.completedScenarios.pop()
		expectIneligible(await cli(c, d), "declared population")
	})

	it("refuses a declared scenario with no final-pass case in either run", async () => {
		const [a, b] = pair()
		for (const f of [a, b])
			f.checkpoint.completedScenarios[19].executionsByPass = [[]]
		const longMemEval = await cli(a, b)
		expect(longMemEval.code).toBe(1)
		expect(longMemEval.stdout).toBe("")
		expect(longMemEval.stderr).toContain("invalid run coverage")
		const [c, d] = pair()
		for (const f of [c, d]) {
			for (const scenario of f.checkpoint.completedScenarios)
				for (const execution of scenario.executionsByPass[0])
					Reflect.deleteProperty(execution, "longMemEval")
			f.checkpoint.completedScenarios[19].executionsByPass = [[]]
		}
		const generic = await cli(c, d)
		expectIneligible(generic, "no final-pass case")
		expect(generic.report.questionCount).toBe(19)
	})

	it("refuses a known clustered population even with the independence declaration", async () => {
		const [a, b] = pair(6, 0, 4)
		for (const f of [a, b]) {
			f.checkpoint.totalScenarios = 1
			f.checkpoint.scenarioIds = ["conversation-1"]
			const cases = f.checkpoint.completedScenarios.map((scenario) => ({
				caseId: scenario.scenarioId,
			}))
			f.checkpoint.completedScenarios = [
				{ scenarioId: "conversation-1", executionsByPass: [cases] },
			]
		}
		expectIneligible(await cli(a, b), "clustered")
	})

	it("keeps the descriptive report when below --min-judged", async () => {
		const [a, b] = pair()
		expectIneligible(
			await cli(a, b, ["--assume-independent-questions", "--min-judged", "21"]),
			"min-judged",
		)
	})

	it("tests binary R@10 under --r-only and refuses fractional recall", async () => {
		const verdicts: Verdict[] = Array.from({ length: 20 }, () => "yes")
		const recallA = Array.from({ length: 20 }, (_, i) => (i < 6 ? 0 : 1))
		const a = fixture("run-a", verdicts, recallA)
		const b = fixture("run-b", verdicts)
		const flags = ["--assume-independent-questions", "--r-only"]
		const result = await cli(a, b, flags)
		expect(result.code).toBe(0)
		expect(result.report.inference).toMatchObject({
			endpoint: "session-recall-any-at-10",
			pTwoSided: 0.03125,
		})
		const c = fixture("run-a", verdicts, [0.5, ...recallA.slice(1)])
		expectIneligible(await cli(c, fixture("run-b", verdicts), flags), "binary")
	})
})
