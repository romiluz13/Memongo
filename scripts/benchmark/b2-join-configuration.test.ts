import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	createOperationRunContext,
	hashOperationRunConfiguration,
} from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import { main } from "./b2-join.js"
import { BENCHMARK_CONFIGURATION_SETTING_KEYS } from "./benchmark-run-configuration-schema.js"
import { SYNTHETIC_BENCHMARK_HOST } from "./benchmark-run-configuration.fixture.js"
import { writeBenchmarkCheckpointAtomic } from "./mongodb-benchmark-checkpoint.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"
import { prepareOfficialQa } from "./longmemeval-official-scoring.js"
import { writeOfficialPredictionSidecarAtomic } from "./longmemeval-prediction-sidecar.js"

// Real producer -> real checkpoint/sidecar writers -> real b2-join CLI. Only
// the MongoDB host and the providers are synthetic; no network is reached.
const HOST = SYNTHETIC_BENCHMARK_HOST

const SECRETS = {
	answerKey: "sk-synthetic-answer-secret",
	judgeKey: "sk-synthetic-judge-secret",
	enrichmentKey: "sk-synthetic-enrichment-secret",
	judgeUrl: "https://judge-one.invalid/v1",
}

const DEDICATED = {
	MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-judge",
	MEMONGO_BENCHMARK_ANSWER_API_KEY: SECRETS.answerKey,
	MEMONGO_BENCHMARK_ANSWER_BASE_URL: "https://answer.invalid/v1",
	MEMONGO_BENCHMARK_ANSWER_MODEL: "answer-a",
	MEMONGO_BENCHMARK_JUDGE_API_KEY: SECRETS.judgeKey,
	MEMONGO_BENCHMARK_JUDGE_BASE_URL: SECRETS.judgeUrl,
	MEMONGO_BENCHMARK_JUDGE_MODEL: "judge-j",
}

const FALLBACK = {
	MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-judge",
	MEMONGO_ENRICHMENT_API_KEY: SECRETS.enrichmentKey,
	MEMONGO_ENRICHMENT_BASE_URL: "https://enrichment.invalid/v1",
	MEMONGO_ENRICHMENT_MODEL: "enrich-a",
	MEMONGO_BENCHMARK_JUDGE_API_KEY: SECRETS.judgeKey,
	MEMONGO_BENCHMARK_JUDGE_BASE_URL: SECRETS.judgeUrl,
	MEMONGO_BENCHMARK_JUDGE_MODEL: "judge-j",
}

// Parsed checkpoint JSON as the edit callbacks mutate it.
type StoredCheckpoint = {
	configurationHash: string
	configuration: Record<string, unknown> & { settings: Record<string, unknown> }
}
type StoredSidecar = { identity: Record<string, string> }

// Re-binds an edited manifest so only coverage, not the hash, can refuse it.
function rehash(checkpoint: StoredCheckpoint, sidecar: StoredSidecar) {
	const hash = hashOperationRunConfiguration(checkpoint.configuration as never)
	checkpoint.configurationHash = hash
	sidecar.identity.configurationHash = hash
}

const DATASET = "d".repeat(64)
const EXECUTABLE = "e".repeat(64)
const N = 20

const saved = { ...process.env }
const dirs: string[] = []
beforeEach(() => {
	for (const key of Object.keys(process.env))
		if (key.startsWith("MEMONGO_")) delete process.env[key]
})
afterEach(async () => {
	process.env = { ...saved }
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true })
})

const stubProvider = {
	name: "synthetic",
	chatCompletion: async () => ({ content: "ok" }),
}

// gains: the first 6 cases flip no -> yes in B.
function verdict(run: "a" | "b", i: number): "yes" | "no" {
	if (i < 6) return run === "b" ? "yes" : "no"
	return i % 2 ? "yes" : "no"
}

async function produceRun(
	dir: string,
	label: "a" | "b",
	env: Record<string, string>,
): Promise<string> {
	for (const key of Object.keys(process.env))
		if (key.startsWith("MEMONGO_")) delete process.env[key]
	Object.assign(process.env, env)
	const ops = new MongoDBManagerBenchmarkScenarioOps(HOST as never)
	const runContext = createOperationRunContext({
		runId: `run-${label}`,
		configuration: ops.snapshotBenchmarkRunConfiguration({
			executionProfile: "shipped",
			retrievalLane: "native",
			maxResults: 10,
			minScore: 0.01,
		}),
	})
	const ids = Array.from({ length: N }, (_, i) => `q${i}`)
	const checkpointPath = path.join(dir, `${label}.json`)
	await writeBenchmarkCheckpointAtomic(checkpointPath, {
		version: 2,
		runId: runContext.runId,
		datasetSha256: DATASET,
		configurationHash: runContext.configurationHash,
		configuration: runContext.configuration,
		executableDigest: EXECUTABLE,
		totalScenarios: N,
		scenarioIds: ids,
		completedScenarios: ids.map((id, index) => ({
			index,
			scenarioId: id,
			executionsByPass: [
				[
					{
						caseId: id,
						longMemEval: { session: { recallAnyAt10: 1 } },
					} as never,
				],
			],
			ingest: {
				conversationsIngested: 1,
				turnsIngested: 1,
				skippedConversations: 0,
				failedTurns: 0,
			},
			expectedSessionEntries: [],
			expectedTurnEntries: [],
			storageCollections: [],
		})),
		accounting: runContext.accounting.snapshot(),
		updatedAt: "2026-10-14T00:00:00.000Z",
	})
	const qa = await prepareOfficialQa({
		env: process.env,
		checkpointPath,
		runId: runContext.runId,
		configurationHash: runContext.configurationHash,
		datasetSha256: DATASET,
		resolveProviders: () => ({ answer: stubProvider, judge: stubProvider }),
	})
	await writeOfficialPredictionSidecarAtomic(qa.sidecarPath, {
		identity: qa.sidecar.identity,
		rows: Object.fromEntries(
			ids.map((id, i) => [
				id,
				{
					questionId: id,
					stage: "judged" as const,
					hypothesis: "h",
					verdict: verdict(label, i),
					updatedAt: "2026-10-14T00:00:00.000Z",
				},
			]),
		),
	})
	return checkpointPath
}

async function compare(
	envA: Record<string, string>,
	envB: Record<string, string>,
	flags: string[] = [],
	// A returned string replaces the file text; otherwise the edited JSON.
	edit?: (
		checkpoint: StoredCheckpoint,
		label: "a" | "b",
		sidecar: StoredSidecar,
	) => unknown,
) {
	const dir = await mkdtemp(path.join(tmpdir(), "b2-config-"))
	dirs.push(dir)
	const a = await produceRun(dir, "a", envA)
	const b = await produceRun(dir, "b", envB)
	if (edit) {
		for (const [file, label] of [
			[a, "a"],
			[b, "b"],
		] as const) {
			const parsed = JSON.parse(await readFile(file, "utf8"))
			const sidecarPath = `${file}.predictions.json`
			const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"))
			const text = edit(parsed, label, sidecar)
			await writeFile(
				file,
				typeof text === "string" ? text : JSON.stringify(parsed),
			)
			await writeFile(sidecarPath, JSON.stringify(sidecar))
		}
	}
	const artifacts = [
		await readFile(a, "utf8"),
		await readFile(b, "utf8"),
		await readFile(`${a}.predictions.json`, "utf8"),
		await readFile(`${b}.predictions.json`, "utf8"),
	].join("\n")
	const stdout: string[] = []
	const stderr: string[] = []
	const log = vi.spyOn(console, "log").mockImplementation((m) => {
		stdout.push(String(m))
	})
	const err = vi.spyOn(console, "error").mockImplementation((m) => {
		stderr.push(String(m))
	})
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	const previous = process.exitCode
	process.exitCode = 0
	try {
		await main(["--a", a, "--b", b, "--assume-independent-questions", ...flags])
	} finally {
		log.mockRestore()
		err.mockRestore()
		warn.mockRestore()
	}
	const code = process.exitCode
	process.exitCode = previous
	const report = JSON.parse(stdout.join("\n"))
	return {
		code,
		report,
		inference: report.inference,
		reasons: (report.inference.reasons ?? []).join(" | ") as string,
		output: `${stdout.join("\n")}\n${stderr.join("\n")}`,
		artifacts,
	}
}

function expectEligible(result: Awaited<ReturnType<typeof compare>>) {
	expect(result.reasons).toBe("")
	expect(result.code).toBe(0)
	expect(result.inference).toMatchObject({
		eligible: true,
		gains: 6,
		losses: 0,
		pTwoSided: 0.03125,
	})
}

function expectRefused(
	result: Awaited<ReturnType<typeof compare>>,
	reason: string,
) {
	expect(result.code).toBe(1)
	expect(result.inference.eligible).toBe(false)
	expect(result.inference).not.toHaveProperty("pTwoSided")
	expect(result.reasons).toContain(reason)
}

describe("b2-join configuration identity from the real producer", () => {
	it("tests an identical dedicated configuration", async () => {
		expectEligible(await compare(DEDICATED, DEDICATED))
	})

	it.each([
		["MEMONGO_BENCHMARK_JUDGE_BASE_URL", "https://judge-two.invalid/v1"],
		["MEMONGO_BENCHMARK_JUDGE_API_KEY", "sk-synthetic-other-judge"],
		["MEMONGO_BENCHMARK_JUDGE_AUTH_STYLE", "x-api-key"],
		["MEMONGO_BENCHMARK_JUDGE_TOKEN_PARAM", "max_completion_tokens"],
	])("refuses an undeclared judge transport change in %s", async (key, value) => {
		const result = await compare(DEDICATED, { ...DEDICATED, [key]: value })
		expectRefused(
			result,
			`undeclared configuration difference: settings.env.${key}`,
		)
	})

	it("tests a declared dedicated answer-model treatment", async () => {
		const result = await compare(
			DEDICATED,
			{ ...DEDICATED, MEMONGO_BENCHMARK_ANSWER_MODEL: "answer-b" },
			["--treatment", "answerModel"],
		)
		expectEligible(result)
		expect(result.inference.treatment).toBe("answerModel")
	})

	it("tests a declared judge-model treatment", async () => {
		const result = await compare(
			DEDICATED,
			{ ...DEDICATED, MEMONGO_BENCHMARK_JUDGE_MODEL: "judge-k" },
			["--treatment", "judgeModel"],
		)
		expectEligible(result)
	})

	it("tests a declared judge-protocol treatment", async () => {
		const result = await compare(
			{ ...DEDICATED, MEMONGO_BENCHMARK_QA_PROTOCOL: "official" },
			DEDICATED,
			["--treatment", "judgeProtocol"],
		)
		expectEligible(result)
	})

	it("refuses an undeclared judge-protocol change", async () => {
		expectRefused(
			await compare(
				{ ...DEDICATED, MEMONGO_BENCHMARK_QA_PROTOCOL: "official" },
				DEDICATED,
			),
			"undeclared configuration difference: settings.env.MEMONGO_BENCHMARK_QA_PROTOCOL",
		)
	})

	it("refuses a fallback enrichment-model change as an answer treatment", async () => {
		const result = await compare(
			FALLBACK,
			{ ...FALLBACK, MEMONGO_ENRICHMENT_MODEL: "enrich-b" },
			["--treatment", "answerModel"],
		)
		expectRefused(result, "requires a dedicated answer provider")
		expect(result.reasons).toContain(
			"undeclared configuration difference: settings.env.MEMONGO_ENRICHMENT_MODEL",
		)
	})

	it("refuses an answer treatment that hides another configuration change", async () => {
		const result = await compare(
			DEDICATED,
			{
				...DEDICATED,
				MEMONGO_BENCHMARK_ANSWER_MODEL: "answer-b",
				MEMONGO_RERANK_MIN_SCORE: "0.5",
			},
			["--treatment", "answerModel"],
		)
		expectRefused(
			result,
			"undeclared configuration difference: settings.env.MEMONGO_RERANK_MIN_SCORE",
		)
	})

	it("refuses a source-constant treatment with no configuration change", async () => {
		const result = await compare(DEDICATED, DEDICATED, [
			"--treatment",
			"answerPromptVersion",
		])
		expectRefused(result, "answerPromptVersion")
	})

	it("refuses a sidecar answer label that is not the effective fallback model", async () => {
		const mislabeled = {
			...FALLBACK,
			MEMONGO_BENCHMARK_ANSWER_MODEL: "label-x",
		}
		const result = await compare(mislabeled, mislabeled)
		expectRefused(
			result,
			"run A: sidecar answerModel disagrees with the effective configuration",
		)
	})

	it("refuses a tampered manifest whose hash was kept", async () => {
		const result = await compare(DEDICATED, DEDICATED, [], (cp, label) => {
			if (label === "b") cp.configuration.settings.numCandidates = 999
			return undefined
		})
		expectRefused(
			result,
			"run B: configuration manifest is missing, unsupported or does not match configurationHash",
		)
	})

	it.each([
		[
			"missing",
			(cp: StoredCheckpoint) => Reflect.deleteProperty(cp, "configuration"),
		],
		[
			"unversioned",
			(cp: StoredCheckpoint) =>
				Reflect.deleteProperty(
					cp.configuration.settings,
					"configurationCoverage",
				),
		],
		[
			"non-scalar",
			(cp: StoredCheckpoint) =>
				Reflect.set(cp.configuration.settings, "numCandidates", { n: 100 }),
		],
		[
			"unknown top-level field",
			(cp: StoredCheckpoint) => Reflect.set(cp.configuration, "extra", 1),
		],
		[
			"non-finite",
			(cp: StoredCheckpoint) =>
				JSON.stringify(cp).replace(
					'"numCandidates":100',
					'"numCandidates":1e999',
				),
		],
	])("keeps a %s manifest descriptive only", async (_name, edit) => {
		const result = await compare(DEDICATED, DEDICATED, [], (cp, label) =>
			label === "a" ? edit(cp) : undefined,
		)
		expectRefused(result, "run A: configuration manifest")
		expect(result.report.questionCount).toBe(N)
	})

	it("treats reordered keys and negative zero as the same configuration", async () => {
		const result = await compare(DEDICATED, DEDICATED, [], (cp, label) => {
			if (label !== "b") return
			const settings = cp.configuration.settings
			cp.configuration.settings = Object.fromEntries(
				Object.entries(settings).reverse(),
			)
			return JSON.stringify(cp).replace(
				'"queryRewritingMaxTokens":0',
				'"queryRewritingMaxTokens":-0',
			)
		})
		expectEligible(result)
	})

	it("never writes or prints raw credentials or judge URLs", async () => {
		const result = await compare(DEDICATED, {
			...DEDICATED,
			MEMONGO_BENCHMARK_JUDGE_BASE_URL: "https://judge-two.invalid/v1",
		})
		for (const secret of [...Object.values(SECRETS), "judge-two.invalid"]) {
			expect(result.artifacts).not.toContain(secret)
			expect(result.output).not.toContain(secret)
		}
	})

	it("produces exactly the covered settings keys", async () => {
		let produced: string[] = []
		await compare(DEDICATED, DEDICATED, [], (cp) => {
			produced = Object.keys(cp.configuration.settings)
		})
		expect(produced.toSorted()).toEqual(
			[...BENCHMARK_CONFIGURATION_SETTING_KEYS].toSorted(),
		)
	})

	it("refuses a rehashed manifest missing any covered setting", async () => {
		const accepted: string[] = []
		for (const key of BENCHMARK_CONFIGURATION_SETTING_KEYS) {
			const result = await compare(
				DEDICATED,
				DEDICATED,
				[],
				(cp, label, sc) => {
					if (label !== "a") return
					Reflect.deleteProperty(cp.configuration.settings, key)
					rehash(cp, sc)
				},
			)
			if (
				result.code !== 1 ||
				!result.reasons.includes("run A: configuration manifest")
			)
				accepted.push(key)
		}
		expect(accepted).toEqual([])
	})

	it.each([
		[
			"malformed judge URL digest",
			(s: Record<string, unknown>) => {
				s["env.MEMONGO_BENCHMARK_JUDGE_BASE_URL.sha256"] = "not-a-digest"
			},
		],
		[
			"durable protocol without judge endpoint",
			(s: Record<string, unknown>) => {
				s["env.MEMONGO_BENCHMARK_JUDGE_BASE_URL.sha256"] = null
			},
		],
		[
			"durable protocol without judge key",
			(s: Record<string, unknown>) => {
				s["env.MEMONGO_BENCHMARK_JUDGE_API_KEY.sha256"] = null
			},
		],
		[
			"unknown judge auth style",
			(s: Record<string, unknown>) => {
				s["env.MEMONGO_BENCHMARK_JUDGE_AUTH_STYLE"] = "cookie"
			},
		],
		[
			"padded env text",
			(s: Record<string, unknown>) => {
				s["env.MEMONGO_BENCHMARK_JUDGE_MODEL"] = " judge-j"
			},
		],
		[
			"dedicated source without a dedicated key",
			(s: Record<string, unknown>) => {
				s["env.MEMONGO_BENCHMARK_ANSWER_API_KEY.sha256"] = null
			},
		],
		[
			"unknown extra setting",
			(s: Record<string, unknown>) => {
				s.unrecorded = "x"
			},
		],
	])("refuses a rehashed manifest with %s", async (_name, mutate) => {
		const result = await compare(DEDICATED, DEDICATED, [], (cp, label, sc) => {
			if (label !== "a") return
			mutate(cp.configuration.settings)
			rehash(cp, sc)
		})
		expectRefused(result, "run A: configuration manifest")
	})

	it("refuses a rehashed marker-only manifest under --r-only", async () => {
		const result = await compare(
			DEDICATED,
			DEDICATED,
			["--r-only"],
			(cp, _l, sc) => {
				cp.configuration.settings = {
					configurationCoverage:
						cp.configuration.settings.configurationCoverage,
				}
				rehash(cp, sc)
			},
		)
		expectRefused(result, "run A: configuration manifest")
		expect(result.reasons).toContain("run B: configuration manifest")
	})
})
