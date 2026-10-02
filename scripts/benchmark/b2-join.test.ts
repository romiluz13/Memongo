import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
	type RunQuestionMetrics,
	b2FlipRate,
	joinB2Runs,
	main,
	readB2RunArtifacts,
} from "./b2-join.js"

function run(
	entries: Array<{
		id: string
		r10?: number
		r50?: number
		turnR10?: number
		verdict?: string | null
		type?: string
	}>,
): Map<string, RunQuestionMetrics> {
	return new Map(
		entries.map((entry) => [
			entry.id,
			{
				questionId: entry.id,
				questionType: entry.type ?? "knowledge-update",
				recallAnyAt10: entry.r10,
				recallAnyAt50: entry.r50,
				turnRecallAnyAt10: entry.turnR10,
				verdict: entry.verdict,
			},
		]),
	)
}

describe("joinB2Runs (tightened noise rule)", () => {
	it("marks a change real when net Q flips reach the 3-question threshold", () => {
		const a = run([
			{ id: "q1", r10: 1, verdict: "no" },
			{ id: "q2", r10: 1, verdict: "no" },
			{ id: "q3", r10: 0, verdict: "no" },
			{ id: "q4", r10: 1, verdict: "yes" },
		])
		const b = run([
			{ id: "q1", r10: 1, verdict: "yes" },
			{ id: "q2", r10: 1, verdict: "yes" },
			{ id: "q3", r10: 0, verdict: "yes" },
			{ id: "q4", r10: 1, verdict: "yes" },
		])
		const report = joinB2Runs(a, b)
		expect(report.netQFlips).toBe(3)
		expect(report.netR).toBe(0)
		expect(report.noiseRule.real).toBe(true)
		expect(report.noiseRule.reason).toContain("threshold")
		expect(report.noiseRule.threshold).toBe(3)
		expect(report.aggregate.accuracy.delta).toBeCloseTo(0.75)
		expect(report.judgedInBoth).toBe(4)
	})

	it("treats +1 recall question with +1 Q flip as noise (inside the envelope)", () => {
		const a = run([
			{ id: "q1", r10: 0, verdict: "no" },
			{ id: "q2", r10: 1, verdict: "yes" },
		])
		const b = run([
			{ id: "q1", r10: 1, verdict: "yes" },
			{ id: "q2", r10: 1, verdict: "yes" },
		])
		const report = joinB2Runs(a, b)
		expect(report.netR).toBe(1)
		expect(report.netQFlips).toBe(1)
		expect(report.noiseRule.real).toBe(false)
		expect(report.noiseRule.reason).toContain("noise envelope")
	})

	it("marks a change real when R and Q co-move with at least 2 net recall questions", () => {
		const a = run([
			{ id: "q1", r10: 0, verdict: "no" },
			{ id: "q2", r10: 0, verdict: "no" },
			{ id: "q3", r10: 1, verdict: "yes" },
		])
		const b = run([
			{ id: "q1", r10: 1, verdict: "yes" },
			{ id: "q2", r10: 1, verdict: "no" },
			{ id: "q3", r10: 1, verdict: "yes" },
		])
		const report = joinB2Runs(a, b)
		expect(report.netR).toBe(2)
		expect(report.netQFlips).toBe(1)
		expect(report.noiseRule.real).toBe(true)
		expect(report.noiseRule.reason).toContain("move together")
	})

	it("marks a co-moving regression real", () => {
		const a = run([
			{ id: "q1", r10: 1, verdict: "yes" },
			{ id: "q2", r10: 1, verdict: "no" },
			{ id: "q3", r10: 0, verdict: "no" },
		])
		const b = run([
			{ id: "q1", r10: 0, verdict: "no" },
			{ id: "q2", r10: 0, verdict: "no" },
			{ id: "q3", r10: 0, verdict: "no" },
		])
		const report = joinB2Runs(a, b)
		expect(report.netR).toBe(-2)
		expect(report.netQFlips).toBe(-1)
		expect(report.noiseRule.real).toBe(true)
		expect(report.noiseRule.reason).toContain("move together")
	})

	it("treats diverging R and Q as noise", () => {
		const a = run([
			{ id: "q1", r10: 0, verdict: "yes" },
			{ id: "q2", r10: 1, verdict: "no" },
		])
		const b = run([
			{ id: "q1", r10: 1, verdict: "no" },
			{ id: "q2", r10: 0, verdict: "yes" },
		])
		const report = joinB2Runs(a, b)
		expect(report.netR).toBe(0)
		expect(report.netQFlips).toBe(0)
		expect(report.noiseRule.real).toBe(false)
	})

	it("flags retrieval-real, answer-neutral movement without calling it real", () => {
		const a = run([
			{ id: "q1", r10: 0, verdict: "no" },
			{ id: "q2", r10: 0, verdict: "no" },
			{ id: "q3", r10: 0, verdict: "yes" },
			{ id: "q4", r10: 1, verdict: "yes" },
		])
		const b = run([
			{ id: "q1", r10: 1, verdict: "no" },
			{ id: "q2", r10: 1, verdict: "no" },
			{ id: "q3", r10: 1, verdict: "yes" },
			{ id: "q4", r10: 1, verdict: "yes" },
		])
		const report = joinB2Runs(a, b)
		expect(report.netR).toBe(3)
		expect(report.netQFlips).toBe(0)
		expect(report.noiseRule.real).toBe(false)
		expect(report.noiseRule.retrievalRealAnswerNeutral).toBe(true)
		expect(report.noiseRule.reason).toContain("noise envelope")
	})

	it("raises the threshold from measured baseline flips", () => {
		const a = run([
			{ id: "q1", r10: 1, verdict: "no" },
			{ id: "q2", r10: 1, verdict: "no" },
			{ id: "q3", r10: 1, verdict: "no" },
			{ id: "q4", r10: 1, verdict: "no" },
		])
		const b = run([
			{ id: "q1", r10: 1, verdict: "yes" },
			{ id: "q2", r10: 1, verdict: "yes" },
			{ id: "q3", r10: 1, verdict: "yes" },
			{ id: "q4", r10: 1, verdict: "no" },
		])
		// Without a baseline: 3 flips reach the default threshold of 3.
		expect(joinB2Runs(a, b).noiseRule.real).toBe(true)
		// With 5 measured baseline flips, the threshold becomes 6.
		const raised = joinB2Runs(a, b, { baselineFlips: 5 })
		expect(raised.noiseRule.threshold).toBe(6)
		expect(raised.noiseRule.real).toBe(false)
	})

	it("verdicts on R movement alone in r-only mode", () => {
		const quiet = run([
			{ id: "q1", r10: 0, verdict: "no" },
			{ id: "q2", r10: 0, verdict: "no" },
			{ id: "q3", r10: 0, verdict: "no" },
		])
		const improved = run([
			{ id: "q1", r10: 1, verdict: "no" },
			{ id: "q2", r10: 1, verdict: "no" },
			{ id: "q3", r10: 0, verdict: "no" },
		])
		const report = joinB2Runs(quiet, improved, { rOnly: true })
		expect(report.netR).toBe(2)
		expect(report.noiseRule.real).toBe(false)
		const stronger = joinB2Runs(
			quiet,
			run([
				{ id: "q1", r10: 1, verdict: "no" },
				{ id: "q2", r10: 1, verdict: "no" },
				{ id: "q3", r10: 1, verdict: "no" },
			]),
			{ rOnly: true },
		)
		expect(stronger.noiseRule.real).toBe(true)
		expect(stronger.noiseRule.reason).toContain("r-only")
	})
})

describe("joinB2Runs (paired populations)", () => {
	it("computes R deltas over questions with recall in both runs only", () => {
		const a = run([
			{ id: "q1", r10: 1, verdict: "yes" },
			{ id: "q2", r10: 1, verdict: "no" },
		])
		// q2 failed in run B (executionError): no recall on the B side.
		const b = run([{ id: "q1", r10: 1, verdict: "yes" }])
		const report = joinB2Runs(a, b)
		expect(report.rPaired).toBe(1)
		expect(report.rUnpaired.aOnly).toBe(1)
		expect(report.rUnpaired.bOnly).toBe(0)
		expect(report.aggregate.recallAnyAt10.delta).toBe(0)
		expect(report.questionCount).toBe(2)
		expect(report.judgedInBoth).toBe(1)
	})

	it("carries per-question rows for both runs, including sidecar-less questions", () => {
		const a = run([{ id: "q1", r10: 1, verdict: "yes" }])
		const b = run([
			{ id: "q1", r10: 0 },
			{ id: "q2", r10: 1, verdict: "no" },
		])
		const report = joinB2Runs(a, b)
		expect(report.questionCount).toBe(2)
		const q1 = report.perQuestion.find((row) => row.questionId === "q1")
		expect(q1?.recallAnyAt10A).toBe(1)
		expect(q1?.recallAnyAt10B).toBe(0)
		expect(q1?.verdictB).toBeUndefined()
		const q2 = report.perQuestion.find((row) => row.questionId === "q2")
		expect(q2?.verdictA).toBeUndefined()
		expect(report.partialQ.incomplete).toBe(true)
	})

	it("projects turn-level recall into paired aggregates", () => {
		const a = run([
			{ id: "q1", r10: 1, turnR10: 0, verdict: "yes" },
			{ id: "q2", r10: 0, turnR10: 0, verdict: "no" },
		])
		const b = run([
			{ id: "q1", r10: 1, turnR10: 1, verdict: "yes" },
			{ id: "q2", r10: 0, turnR10: 1, verdict: "no" },
		])
		const report = joinB2Runs(a, b)
		expect(report.aggregate.turnRecallAnyAt10.a).toBe(0)
		expect(report.aggregate.turnRecallAnyAt10.b).toBe(1)
		expect(report.aggregate.turnRecallAnyAt10.delta).toBe(1)
		expect(report.aggregate.recallAnyAt10.delta).toBe(0)
	})
})

describe("b2FlipRate (double baseline)", () => {
	it("counts verdict flips between two repetitions of the same configuration", () => {
		const first = run([
			{ id: "q1", verdict: "yes" },
			{ id: "q2", verdict: "yes" },
			{ id: "q3", verdict: "no" },
			{ id: "q4", verdict: "yes" },
		])
		const second = run([
			{ id: "q1", verdict: "yes" },
			{ id: "q2", verdict: "no" },
			{ id: "q3", verdict: "yes" },
			{ id: "q4", verdict: "yes" },
		])
		const rate = b2FlipRate(first, second)
		expect(rate.judgedInBoth).toBe(4)
		expect(rate.flips).toBe(2)
		expect(rate.flipRate).toBe(0.5)
	})

	it("ignores questions not judged in both repetitions", () => {
		const first = run([{ id: "q1", verdict: "yes" }])
		const second = run([{ id: "q2", verdict: "no" }])
		const rate = b2FlipRate(first, second)
		expect(rate.judgedInBoth).toBe(0)
		expect(rate.flipRate).toBe(0)
	})
})

describe("readB2RunArtifacts (checkpoint + sidecar files)", () => {
	it("merges the last measurement pass with sidecar verdicts and turn recall", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "b2-join-"))
		const checkpointPath = path.join(dir, "checkpoint.json")
		await writeFile(
			checkpointPath,
			JSON.stringify({
				completedScenarios: [
					{
						scenarioId: "s1",
						executionsByPass: [
							[
								{
									caseId: "q1",
									questionType: "temporal-reasoning",
									abstention: false,
									longMemEval: {
										session: { recallAnyAt10: 0.2, recallAnyAt50: 0.4 },
									},
								},
							],
							[
								{
									caseId: "q1",
									questionType: "temporal-reasoning",
									abstention: false,
									longMemEval: {
										session: { recallAnyAt10: 0.5, recallAnyAt50: 1.0 },
										turn: { recallAnyAt10: 1, recallAnyAt50: 1 },
									},
								},
							],
						],
					},
				],
			}),
		)
		await writeFile(
			`${checkpointPath}.predictions.json`,
			JSON.stringify({
				rows: {
					q1: { questionId: "q1", stage: "judged", verdict: "yes" },
				},
			}),
		)
		const artifacts = await readB2RunArtifacts(checkpointPath)
		expect(artifacts.get("q1")).toEqual({
			questionId: "q1",
			questionType: "temporal-reasoning",
			abstention: false,
			recallAnyAt10: 0.5,
			recallAnyAt50: 1.0,
			turnRecallAnyAt10: 1,
			turnRecallAnyAt50: 1,
			verdict: "yes",
		})
	})

	it("tolerates a missing sidecar when not required (R-only run)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "b2-join-"))
		const checkpointPath = path.join(dir, "checkpoint.json")
		await writeFile(
			checkpointPath,
			JSON.stringify({
				completedScenarios: [
					{
						scenarioId: "s1",
						executionsByPass: [
							[
								{
									caseId: "q1",
									longMemEval: {
										session: { recallAnyAt10: 1, recallAnyAt50: 1 },
									},
								},
							],
						],
					},
				],
			}),
		)
		const artifacts = await readB2RunArtifacts(checkpointPath)
		expect(artifacts.get("q1")?.verdict).toBeUndefined()
		expect(artifacts.get("q1")?.recallAnyAt10).toBe(1)
	})

	it("refuses a missing sidecar when required", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "b2-join-"))
		const checkpointPath = path.join(dir, "checkpoint.json")
		await writeFile(
			checkpointPath,
			JSON.stringify({
				completedScenarios: [
					{
						scenarioId: "s1",
						executionsByPass: [
							[
								{
									caseId: "q1",
									longMemEval: {
										session: { recallAnyAt10: 1, recallAnyAt50: 1 },
									},
								},
							],
						],
					},
				],
			}),
		)
		await expect(
			readB2RunArtifacts(checkpointPath, { requireSidecar: true }),
		).rejects.toThrow(/missing prediction sidecar/)
	})
})

describe("main baseline sidecar gate (R2-1)", () => {
	async function writeCheckpoint(dir: string, name: string): Promise<string> {
		const checkpointPath = path.join(dir, name)
		await writeFile(
			checkpointPath,
			JSON.stringify({
				completedScenarios: [
					{
						scenarioId: "s1",
						executionsByPass: [
							[
								{
									caseId: "q1",
									longMemEval: {
										session: { recallAnyAt10: 1, recallAnyAt50: 1 },
									},
								},
							],
						],
					},
				],
			}),
		)
		return checkpointPath
	}

	async function runMain(argv: string[]): Promise<{
		code: number | undefined
		stderr: string
	}> {
		const previous = process.exitCode
		process.exitCode = 0
		const stderr: string[] = []
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation((message) => {
				stderr.push(String(message))
			})
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			await main(argv)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error(message)
			process.exitCode = 1
		}
		const code = process.exitCode
		process.exitCode = previous
		errorSpy.mockRestore()
		logSpy.mockRestore()
		return { code, stderr: stderr.join("\n") }
	}

	it("exits non-zero when a baseline checkpoint has no sidecar", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "b2-join-baseline-"))
		const runA = await writeCheckpoint(dir, "a.json")
		const runB = await writeCheckpoint(dir, "b.json")
		await writeFile(
			`${runA}.predictions.json`,
			JSON.stringify({ rows: { q1: { verdict: "yes" } } }),
		)
		await writeFile(
			`${runB}.predictions.json`,
			JSON.stringify({ rows: { q1: { verdict: "yes" } } }),
		)
		const baselineA = await writeCheckpoint(dir, "baseline-a.json")
		const baselineB = await writeCheckpoint(dir, "baseline-b.json")
		const result = await runMain([
			"--a",
			runA,
			"--b",
			runB,
			"--baseline-a",
			baselineA,
			"--baseline-b",
			baselineB,
		])
		expect(result.code).not.toBe(0)
		expect(result.stderr).toMatch(/missing prediction sidecar/)
		expect(result.stderr).toContain("baseline-a.json.predictions.json")
	})

	it("exits non-zero when baseline sidecars judge zero questions", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "b2-join-baseline-empty-"))
		const runA = await writeCheckpoint(dir, "a.json")
		const runB = await writeCheckpoint(dir, "b.json")
		const baselineA = await writeCheckpoint(dir, "baseline-a.json")
		const baselineB = await writeCheckpoint(dir, "baseline-b.json")
		for (const checkpointPath of [runA, runB, baselineA, baselineB]) {
			await writeFile(
				`${checkpointPath}.predictions.json`,
				JSON.stringify({ rows: {} }),
			)
		}
		const result = await runMain([
			"--a",
			runA,
			"--b",
			runB,
			"--baseline-a",
			baselineA,
			"--baseline-b",
			baselineB,
		])
		expect(result.code).not.toBe(0)
		expect(result.stderr).toMatch(/baseline has no judged questions/)
	})
})
