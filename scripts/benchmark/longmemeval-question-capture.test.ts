import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { EnrichmentProvider } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type { BenchmarkJudgedAnswerMaterial } from "./benchmark-answer-quality.js"
import {
	prepareOfficialQa,
	scoreOfficialScenario,
} from "./longmemeval-official-scoring.js"

type Call = Parameters<EnrichmentProvider["chatCompletion"]>[0]
function provider(reply: (call: Call, index: number) => string) {
	const calls: Call[] = []
	return {
		name: "synthetic",
		calls,
		async chatCompletion(call: Call) {
			calls.push(call)
			return { content: reply(call, calls.length) }
		},
	}
}
function material(caseId: string): BenchmarkJudgedAnswerMaterial {
	return {
		caseId,
		question: `Which activity does ${caseId} prefer?`,
		goldAnswer: "private gold rubric only for judge",
		abstention: false,
		questionType: "single-session-preference",
		contextPassages: [
			`${caseId}: I enjoy pottery after work.`,
			"I avoid noisy venues.",
		],
		passageDates: [["2024/04/30"], ["2024/04/12"]],
		passageRoles: ["user", "user"],
	}
}
async function records(directory: string) {
	const names = await readdir(directory)
	return Promise.all(
		names.map(async (name) =>
			JSON.parse(await readFile(path.join(directory, name), "utf8")),
		),
	)
}
async function fixture(
	options: {
		protocol?: "official" | "custom-judge"
		answer?: string | Error
		judge?: string | Error
	} = {},
) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-question-capture-"))
	const answer = provider((_call, index) => {
		if (index === 1) return "ok"
		if (options.answer instanceof Error) throw options.answer
		return options.answer ?? '{"answer":"pottery"}'
	})
	const judge = provider(() => {
		if (options.judge instanceof Error) throw options.judge
		return options.judge ?? "no"
	})
	try {
		const context = await prepareOfficialQa({
			env: {
				MEMONGO_BENCHMARK_QA_PROTOCOL: options.protocol ?? "custom-judge",
				MEMONGO_BENCHMARK_QA_CAPTURE: "1",
				MEMONGO_BENCHMARK_ANSWER_MODEL: "synthetic-reader",
				MEMONGO_BENCHMARK_JUDGE_MODEL:
					options.protocol === "official"
						? "gpt-4o-2024-08-06"
						: "synthetic-judge",
				MEMONGO_BENCHMARK_ANSWER_API_KEY: "synthetic-private-key",
			},
			checkpointPath: path.join(dir, "checkpoint.json"),
			runId: "synthetic-run",
			datasetSha256: "a".repeat(64),
			configurationHash: "b".repeat(64),
			resolveProviders: () => ({ answer, judge }),
		})
		return {
			dir,
			context,
			answer,
			judge,
			capturePath: `${context.sidecarPath}.capture`,
			score: (cases: BenchmarkJudgedAnswerMaterial[]) =>
				scoreOfficialScenario({
					context,
					scenarioId: "synthetic-scenario",
					declaredCaseIds: cases.map((c) => c.caseId),
					materialByCaseId: new Map(cases.map((c) => [c.caseId, c])),
				}),
		}
	} catch (error) {
		await rm(dir, { recursive: true, force: true })
		throw error
	}
}

describe("per-question private QA evidence", () => {
	it.each([
		"official",
		"custom-judge",
	] as const)("joins delivered context, calls and terminal verdict without changing %s prompts", async (protocol) => {
		const f = await fixture({ protocol })
		try {
			await f.score([material("q-1"), material("q-2")])
			const entries = await records(f.capturePath)
			const requests = entries.filter((e) => e.kind === "request")
			expect(requests.filter((e) => e.phase === "preflight")).toHaveLength(1)
			expect(requests.find((e) => e.phase === "preflight")).not.toHaveProperty(
				"questionId",
			)
			for (const [index, questionId] of ["q-1", "q-2"].entries()) {
				const answer = requests.find(
					(e) => e.phase === "answer" && e.questionId === questionId,
				)
				expect(answer.messages).toEqual(f.answer.calls[index + 1].messages)
				expect(answer.messages[1].content).toContain(
					`${questionId}: I enjoy pottery after work.`,
				)
				expect(answer.messages[1].content).toContain(
					"[2024/04/12] User: I avoid noisy venues.",
				)
				expect(JSON.stringify(answer)).not.toContain("private gold rubric")
				const judge = requests.find(
					(e) => e.phase === "judge" && e.questionId === questionId,
				)
				expect(judge.messages).toEqual(f.judge.calls[index].messages)
				for (const request of [answer, judge]) {
					expect(
						entries.find(
							(e) => e.kind === "outcome" && e.sequence === request.sequence,
						),
					).toMatchObject({ questionId, status: "succeeded" })
				}
				expect(
					entries
						.filter((e) => e.kind === "case" && e.questionId === questionId)
						.sort((a, b) => a.sequence - b.sequence)
						.map(({ stage, status }) => [stage, status]),
				).toEqual([
					["answer", "started"],
					["judge", "started"],
					["result", "incorrect"],
				])
			}
			expect(f.context.stats.attempts).toEqual({
				answerGeneration: 2,
				answerJudge: 2,
			})
			expect((await stat(f.capturePath)).mode & 0o777).toBe(0o700)
			for (const name of await readdir(f.capturePath))
				expect((await stat(path.join(f.capturePath, name))).mode & 0o777).toBe(
					0o600,
				)
		} finally {
			await rm(f.dir, { recursive: true, force: true })
		}
	})

	it.each([
		{ answer: "{", stage: "answer-validation", status: "unreliable" },
		{ judge: "not a verdict", stage: "judge-validation", status: "unreliable" },
		{
			answer: new Error("sensitive-answer-body"),
			stage: "answer",
			status: "failed",
		},
		{
			judge: new Error("sensitive-judge-body"),
			stage: "judge",
			status: "failed",
		},
	])("distinguishes $stage/$status from an incorrect judged answer", async (options) => {
		const f = await fixture(options)
		try {
			const run = f.score([material("q-1")])
			if (options.status === "failed") await expect(run).rejects.toThrow()
			else await run
			const entries = await records(f.capturePath)
			expect(
				entries
					.filter((e) => e.kind === "case")
					.sort((a, b) => a.sequence - b.sequence)
					.at(-1),
			).toMatchObject({
				questionId: "q-1",
				stage: options.stage,
				status: options.status,
			})
			expect(
				entries.some((e) => e.kind === "case" && e.stage === "result"),
			).toBe(false)
			expect(JSON.stringify(entries)).not.toContain("sensitive-answer-body")
			expect(JSON.stringify(entries)).not.toContain("sensitive-judge-body")
		} finally {
			await rm(f.dir, { recursive: true, force: true })
		}
	})

	it("records unavailable and reused cases without inventing a new answer request", async () => {
		const f = await fixture({ judge: "yes" })
		try {
			await f.score([
				{ ...material("q-missing"), goldAnswer: "" },
				material("q-ok"),
			])
			await f.score([material("q-ok")])
			const entries = await records(f.capturePath)
			expect(entries).toContainEqual(
				expect.objectContaining({
					questionId: "q-missing",
					stage: "eligibility",
					status: "unavailable",
				}),
			)
			expect(entries).toContainEqual(
				expect.objectContaining({
					questionId: "q-ok",
					stage: "result",
					status: "correct",
				}),
			)
			expect(entries).toContainEqual(
				expect.objectContaining({
					questionId: "q-ok",
					stage: "resume",
					status: "reused",
				}),
			)
			expect(f.answer.calls).toHaveLength(2)
			expect(f.judge.calls).toHaveLength(1)
		} finally {
			await rm(f.dir, { recursive: true, force: true })
		}
	})

	it("refuses a case-record collision before answer dispatch and preserves its bytes", async () => {
		const f = await fixture()
		try {
			const existing = path.join(f.capturePath, "1.case.json")
			await writeFile(existing, "protected", { mode: 0o600 })
			await expect(f.score([material("q-1")])).rejects.toThrow("capture failed")
			expect(f.answer.calls).toHaveLength(1)
			expect(f.judge.calls).toHaveLength(0)
			expect(await readFile(existing, "utf8")).toBe("protected")
		} finally {
			await rm(f.dir, { recursive: true, force: true })
		}
	})

	it("redacts configured credentials even in question and scenario identities", async () => {
		const f = await fixture()
		try {
			const value = material("synthetic-private-key")
			await scoreOfficialScenario({
				context: f.context,
				scenarioId: "scenario-synthetic-private-key",
				declaredCaseIds: [value.caseId],
				materialByCaseId: new Map([[value.caseId, value]]),
			})
			const raw = JSON.stringify(await records(f.capturePath))
			expect(raw).not.toContain("synthetic-private-key")
			expect(raw).toContain("[REDACTED]")
		} finally {
			await rm(f.dir, { recursive: true, force: true })
		}
	})
})
