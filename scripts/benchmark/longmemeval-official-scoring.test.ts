import { describe, it, expect, vi } from "vitest"
import { promises as fs } from "node:fs"
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type {
	EnrichmentChatUsage,
	EnrichmentProvider,
	EnrichmentResponseMeta,
} from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import { EnrichmentHttpError } from "../../packages/memory-engine/src/mongodb-llm-enrichment.js"
import type { BenchmarkJudgedAnswerMaterial } from "./benchmark-answer-quality.js"
import { LONGMEMEVAL_RELEASE_V2 } from "./benchmark-quality-contracts.js"
import {
	OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL,
	OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
	buildOfficialAnscheckPrompt,
	computeOfficialLongMemEvalQaMetrics,
	isOfficialAbstentionQuestion,
} from "./longmemeval-official-qa.js"
import {
	OfficialPredictionSidecarError,
	OfficialQaCaptureError,
	createOfficialPredictionSidecar,
	recordOfficialAnswer,
	recordOfficialUnreliable,
	recordOfficialVerdict,
	writeOfficialPredictionSidecarAtomic,
} from "./longmemeval-prediction-sidecar.js"
import type { OfficialPredictionSidecarIdentity } from "./longmemeval-prediction-sidecar.js"
import {
	OFFICIAL_ANSWER_MAX_TOKENS,
	OFFICIAL_ANSWER_TEMPERATURE,
	OFFICIAL_DATED_ANSWER_VERSION,
	OFFICIAL_JUDGE_CONTENT_RETRIES,
	buildOfficialDatedAnswerMessages,
	buildOfficialDatedAnswerUserContent,
	exportOfficialPredictionsJsonl,
	parseOfficialJudgeVerdict,
	prepareOfficialQa,
	resolveBenchmarkOfficialJudgeProvider,
	resolveBenchmarkQaProtocol,
	scoreOfficialScenario,
	summarizeOfficialBenchmarkQaRun,
} from "./longmemeval-official-scoring.js"
import type { OfficialQaContext } from "./longmemeval-official-scoring.js"

const ANSWER_MODEL = "fw-deepseek-v4-pro"
const JUDGE_MODEL = OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL

type CapturedCall = {
	model: string
	messages: Array<{ role: string; content: string }>
	responseFormat?: unknown
	maxTokens?: number
	temperature?: number
}

function fakeProvider(
	handler: (call: CapturedCall) => {
		content: string
		usage?: EnrichmentChatUsage
		responseMeta?: EnrichmentResponseMeta
	},
): MockedProvider {
	const calls: CapturedCall[] = []
	return {
		name: "fake",
		calls,
		async chatCompletion(params) {
			const call = {
				model: params.model,
				messages: params.messages,
				...(params.responseFormat !== undefined
					? { responseFormat: params.responseFormat }
					: {}),
				...(params.maxTokens !== undefined
					? { maxTokens: params.maxTokens }
					: {}),
				...(params.temperature !== undefined
					? { temperature: params.temperature }
					: {}),
			}
			calls.push(call)
			return handler(call)
		},
	}
}

function answerProvider() {
	return fakeProvider(() => ({
		content: JSON.stringify({ answer: "violet" }),
		usage: { inputTokens: 11, outputTokens: 3 },
	}))
}

function judgeProvider(verdict = "yes") {
	return fakeProvider(() => ({
		content: verdict,
		usage: { inputTokens: 31, outputTokens: 2 },
	}))
}

function sidecarIdentity(): OfficialPredictionSidecarIdentity {
	return {
		runId: "run-1",
		datasetSha256: "a".repeat(64),
		configurationHash: "b".repeat(64),
		answerModel: ANSWER_MODEL,
		judgeModel: JUDGE_MODEL,
		judgeProtocol: "official-anscheck",
		promptVersion: OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION,
		answerPromptVersion: OFFICIAL_DATED_ANSWER_VERSION,
		answerTemperature: `${OFFICIAL_ANSWER_TEMPERATURE}`,
		answerMaxTokens: `${OFFICIAL_ANSWER_MAX_TOKENS}`,
	}
}

async function tempDir(label: string) {
	return mkdtemp(path.join(os.tmpdir(), `memongo-scoring-${label}-`))
}

function material(
	caseId: string,
	overrides: Partial<BenchmarkJudgedAnswerMaterial> = {},
): BenchmarkJudgedAnswerMaterial {
	return {
		caseId,
		question: `What color is the sky in ${caseId}?`,
		goldAnswer: "violet",
		abstention: false,
		contextPassages: ["snippet one", "snippet two"],
		questionType: "single-session-user",
		questionDate: "2024/05/03",
		passageDates: [["2024/04/12"], ["2024/04/12", "2024/04/30"]],
		passageRoles: ["user", "assistant"],
		...overrides,
	}
}

type MockedProvider = EnrichmentProvider & { calls: CapturedCall[] }

/** Official QA context with mock providers that record their calls. */
type MockedOfficialQaContext = Omit<
	OfficialQaContext,
	"answerProvider" | "judgeProvider"
> & {
	answerProvider: MockedProvider
	judgeProvider: MockedProvider
}

async function buildContext(
	label: string,
	sidecarSeed?: (
		sidecar: ReturnType<typeof createOfficialPredictionSidecar>,
	) => void,
) {
	const dir = await tempDir(label)
	const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
	const sidecar = createOfficialPredictionSidecar(sidecarIdentity())
	sidecarSeed?.(sidecar)
	if (sidecarSeed) {
		await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)
	}
	const context: MockedOfficialQaContext = {
		protocol: "official",
		answerProvider: answerProvider(),
		judgeProvider: judgeProvider(),
		answerModel: ANSWER_MODEL,
		judgeModel: JUDGE_MODEL,
		sidecarPath,
		sidecar,
		stats: {
			attempts: { answerGeneration: 0, answerJudge: 0 },
			successes: { answerGeneration: 0, answerJudge: 0 },
			failures: { answerGeneration: 0, answerJudge: 0 },
			unreliable: { answerGeneration: 0, answerJudge: 0 },
		},
		unavailable: [],
	}
	return { context, dir }
}

const BASE_ENV = {
	MEMONGO_ENRICHMENT_API_KEY: "synthetic-answer",
	MEMONGO_ENRICHMENT_BASE_URL: "https://answer.example/v1",
	MEMONGO_ENRICHMENT_MODEL: ANSWER_MODEL,
	MEMONGO_BENCHMARK_JUDGE_API_KEY: "synthetic-judge",
	MEMONGO_BENCHMARK_JUDGE_BASE_URL: "https://judge.example/v1",
	MEMONGO_BENCHMARK_JUDGE_MODEL: JUDGE_MODEL,
}

describe("explicit private provider capture", () => {
	function prepare(
		dir: string,
		answer: EnrichmentProvider,
		judge: EnrichmentProvider,
		capture: string | undefined = "1",
	) {
		return prepareOfficialQa({
			env: {
				...BASE_ENV,
				MEMONGO_BENCHMARK_QA_CAPTURE:
					capture === "omitted" ? undefined : capture,
			},
			checkpointPath: path.join(dir, "checkpoint.json"),
			runId: "run-1",
			configurationHash: "b".repeat(64),
			datasetSha256: "a".repeat(64),
			resolveProviders: () => ({ answer, judge }),
		})
	}

	function score(context: OfficialQaContext, value = material("q-1")) {
		return scoreOfficialScenario({
			context,
			scenarioId: "scenario-1",
			declaredCaseIds: ["q-1"],
			materialByCaseId: new Map([["q-1", value]]),
		})
	}

	it.each([
		"omitted",
		"",
		"0",
	])("preserves the default providers, compact sidecar and no capture for %s", async (capture) => {
		const dir = await tempDir("capture-off")
		try {
			const answer = answerProvider()
			const judge = judgeProvider()
			const context = await prepare(dir, answer, judge, capture)
			expect(context.answerProvider).toBe(answer)
			expect(context.judgeProvider).toBe(judge)
			await score(context)
			expect(await readdir(dir)).toEqual(["checkpoint.json.predictions.json"])
			const raw = await readFile(context.sidecarPath, "utf8")
			expect(raw).not.toContain("snippet one")
			expect(raw).not.toContain(BASE_ENV.MEMONGO_ENRICHMENT_API_KEY)
			expect(Object.keys(JSON.parse(raw))).toEqual([
				"version",
				"identity",
				"rows",
			])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it.each([
		"yes",
		"true",
	])("rejects ambiguous capture %s before preflight", async (capture) => {
		const dir = await tempDir("capture-flag")
		try {
			const answer = answerProvider()
			await expect(
				prepare(dir, answer, judgeProvider(), capture),
			).rejects.toThrow("MEMONGO_BENCHMARK_QA_CAPTURE must be 0 or 1")
			expect(answer.calls).toHaveLength(0)
			expect(await readdir(dir)).toEqual([])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("captures preflight, physical retries and raw adapted judge content without changing logical stats", async () => {
		const dir = await tempDir("capture-retries")
		try {
			let answerCalls = 0
			const answer = fakeProvider(() => {
				answerCalls += 1
				if (answerCalls === 2) {
					throw new EnrichmentHttpError(
						"untrusted-http-body synthetic-answer",
						429,
					)
				}
				return {
					content: answerCalls === 1 ? "ok" : '{"answer":"violet"}',
					responseMeta: { shape: "ok", finishReason: "stop" },
					usage: { inputTokens: 11, outputTokens: 3, reasoningTokens: 2 },
				}
			})
			let judgeCalls = 0
			const judge = fakeProvider(() => ({
				content: ++judgeCalls === 1 ? "invalid synthetic-judge" : "yes",
				responseMeta: { shape: "ok", finishReason: "stop" },
			}))
			const context = await prepareOfficialQa({
				env: {
					...BASE_ENV,
					MEMONGO_ENRICHMENT_API_KEY: "  synthetic-answer  ",
					MEMONGO_BENCHMARK_JUDGE_API_KEY: "  synthetic-judge  ",
					MEMONGO_BENCHMARK_ANSWER_API_KEY: "  synthetic-dedicated  ",
					MEMONGO_BENCHMARK_ANSWER_MODEL: ANSWER_MODEL,
					MEMONGO_BENCHMARK_QA_CAPTURE: "1",
				},
				checkpointPath: path.join(dir, "checkpoint.json"),
				runId: "run-1",
				configurationHash: "b".repeat(64),
				datasetSha256: "a".repeat(64),
				resolveProviders: () => ({ answer, judge }),
			})
			await score(
				context,
				material("q-1", {
					contextPassages: [
						"delivered synthetic-answer synthetic-judge synthetic-dedicated",
					],
				}),
			)
			const capture = `${context.sidecarPath}.capture`
			expect(await readdir(capture)).toHaveLength(10)
			const entries = await Promise.all(
				(await readdir(capture))
					.sort()
					.map(async (name) =>
						JSON.parse(await readFile(path.join(capture, name), "utf8")),
					),
			)
			expect(
				entries
					.filter((entry) => entry.kind === "request")
					.map((entry) => entry.phase),
			).toEqual(["preflight", "answer", "answer", "judge", "judge"])
			expect(
				entries.find(
					(entry) => entry.sequence === 2 && entry.kind === "outcome",
				),
			).toMatchObject({
				level: "provider-failure-classification",
				status: "failed",
				failure: "http",
				httpStatus: 429,
			})
			expect(
				entries.find(
					(entry) => entry.sequence === 4 && entry.kind === "outcome",
				),
			).toMatchObject({
				level: "provider-adapted-completion",
				content: "invalid [REDACTED]",
				responseMeta: { shape: "ok", finishReason: "stop" },
			})
			expect(
				entries.find(
					(entry) => entry.sequence === 3 && entry.kind === "outcome",
				).usage,
			).toEqual({ inputTokens: 11, outputTokens: 3, reasoningTokens: 2 })
			expect(
				entries.find(
					(entry) => entry.sequence === 5 && entry.kind === "outcome",
				),
			).not.toHaveProperty("usage")
			const raw = JSON.stringify(entries)
			for (const secret of [
				"synthetic-answer",
				"synthetic-judge",
				"synthetic-dedicated",
				"untrusted-http-body",
			])
				expect(raw).not.toContain(secret)
			expect(raw).not.toMatch(/headers|apiKey|stack|cause/)
			expect(answer.calls[1]?.messages[1]?.content).toContain(
				"synthetic-answer",
			)
			expect(context.stats.attempts).toEqual({
				answerGeneration: 1,
				answerJudge: 2,
			})
			expect(context.sidecar.rows["q-1"]?.verdict).toBe("yes")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("retains length and reasoning usage while excluding the case honestly", async () => {
		const dir = await tempDir("capture-length")
		try {
			const answer = fakeProvider(() => ({
				content: '{"answer":"violet"}',
				responseMeta: { shape: "length", finishReason: "length" },
				usage: { inputTokens: 11, outputTokens: 3, reasoningTokens: 2 },
			}))
			const judge = judgeProvider()
			const context = await prepare(dir, answer, judge)
			await score(context)
			const outcome = JSON.parse(
				await readFile(`${context.sidecarPath}.capture/2.outcome.json`, "utf8"),
			)
			expect(outcome.responseMeta).toEqual({
				shape: "length",
				finishReason: "length",
			})
			expect(outcome.usage).toEqual({
				inputTokens: 11,
				outputTokens: 3,
				reasoningTokens: 2,
			})
			expect(context.sidecar.rows["q-1"]?.stage).toBe("unreliable")
			expect(judge.calls).toHaveLength(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it.each([
		"open",
		"writeFile",
		"sync",
		"close",
	])("makes initial %s failure terminal before paid preflight", async (method) => {
		const dir = await tempDir(`capture-fail-${method}`)
		let closeHandle: (() => Promise<void>) | undefined
		try {
			const answer = answerProvider()
			const originalOpen = fs.open.bind(fs)
			vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
				if (method === "open")
					throw new EnrichmentHttpError("untrusted-secret", 429)
				const handle = await originalOpen(file, flags, mode)
				closeHandle = handle.close.bind(handle)
				if (method === "writeFile")
					vi.spyOn(handle, "writeFile").mockRejectedValueOnce(
						new Error("untrusted-secret"),
					)
				if (method === "sync")
					vi.spyOn(handle, "sync").mockRejectedValueOnce(
						new Error("untrusted-secret"),
					)
				if (method === "close")
					vi.spyOn(handle, "close").mockRejectedValueOnce(
						new Error("untrusted-secret"),
					)
				return handle
			})
			await expect(prepare(dir, answer, judgeProvider())).rejects.toThrow(
				new OfficialQaCaptureError(),
			)
			expect(answer.calls).toHaveLength(0)
		} finally {
			vi.restoreAllMocks()
			await closeHandle?.()
			await rm(dir, { recursive: true, force: true })
		}
	})

	it.each([
		"succeeded",
		"http429",
	])("stops after a %s provider outcome cannot be persisted, without overwriting or retrying", async (kind) => {
		const dir = await tempDir(`capture-outcome-${kind}`)
		try {
			let calls = 0
			const answer: EnrichmentProvider = {
				name: "fake",
				async chatCompletion() {
					calls += 1
					if (calls === 1) return { content: "ok" }
					await writeFile(
						path.join(
							dir,
							"checkpoint.json.predictions.json.capture/2.outcome.json",
						),
						"protected bytes",
						{ mode: 0o600 },
					)
					if (kind === "http429")
						throw new EnrichmentHttpError("untrusted-secret", 429)
					return { content: '{"answer":"violet"}' }
				},
			}
			const judge = judgeProvider()
			const context = await prepare(dir, answer, judge)
			await expect(score(context)).rejects.toThrow(
				"official answer generation failed for question q-1: Official QA capture failed; refusing further provider calls",
			)
			expect(calls).toBe(2)
			expect(judge.calls).toHaveLength(0)
			expect(
				await readFile(`${context.sidecarPath}.capture/2.outcome.json`, "utf8"),
			).toBe("protected bytes")
			expect(context.sidecar.rows["q-1"]).toBeUndefined()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it.each([
		["http", new EnrichmentHttpError("untrusted-body-secret", 400)],
		["timeout", new DOMException("untrusted-abort-secret", "AbortError")],
		["network", new TypeError("untrusted-network-secret")],
		["provider", new Error("untrusted-provider-secret")],
	] as const)("persists only fixed %s failure fields and rethrows the original provider error", async (failure, error) => {
		const dir = await tempDir(`capture-error-${failure}`)
		try {
			let calls = 0
			const answer: EnrichmentProvider = {
				name: "fake",
				async chatCompletion() {
					if (++calls === 1) return { content: "ok" }
					throw error
				},
			}
			const context = await prepare(dir, answer, judgeProvider())
			await expect(
				context.answerProvider.chatCompletion({
					model: ANSWER_MODEL,
					messages: [{ role: "user", content: "synthetic" }],
				}),
			).rejects.toBe(error)
			const outcome = JSON.parse(
				await readFile(`${context.sidecarPath}.capture/2.outcome.json`, "utf8"),
			)
			expect(outcome.failure).toBe(failure)
			expect(Object.keys(outcome).sort()).toEqual(
				[
					"configurationHash",
					"datasetSha256",
					"failure",
					"kind",
					"level",
					"phase",
					"recordedAt",
					"runId",
					"sequence",
					"status",
					...(failure === "http" ? ["httpStatus"] : []),
				].sort(),
			)
			expect(JSON.stringify(outcome)).not.toContain("untrusted")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("returns the original adapted response and omits arbitrary provider properties", async () => {
		const dir = await tempDir("capture-response-identity")
		try {
			const response = {
				content: '{"answer":"violet"}',
				responseMeta: {
					shape: "ok" as const,
					finishReason: "stop",
					providerSecret: "excluded-meta-secret",
				},
				usage: {
					inputTokens: 11,
					outputTokens: 3,
					providerSecret: "excluded-usage-secret",
				},
				providerConfig: "excluded-config-secret",
			}
			const answer = fakeProvider(() => response)
			const context = await prepare(dir, answer, judgeProvider())
			const completion = await context.answerProvider.chatCompletion({
				model: ANSWER_MODEL,
				messages: [{ role: "user", content: "synthetic" }],
			})
			expect(completion).toBe(response)
			const raw = await readFile(
				`${context.sidecarPath}.capture/2.outcome.json`,
				"utf8",
			)
			expect(raw).not.toContain("excluded-")
			expect(JSON.parse(raw).usage).toEqual({
				inputTokens: 11,
				outputTokens: 3,
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects existing predictions before preflight while default resume remains available", async () => {
		const dir = await tempDir("capture-existing-sidecar")
		try {
			const answer = answerProvider()
			const original = recordOfficialVerdict(
				recordOfficialAnswer(
					createOfficialPredictionSidecar(sidecarIdentity()),
					"q-1",
					"violet",
				),
				"q-1",
				"yes",
			)
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			await writeOfficialPredictionSidecarAtomic(sidecarPath, original)
			const bytes = await readFile(sidecarPath, "utf8")
			await expect(prepare(dir, answer, judgeProvider())).rejects.toThrow(
				OfficialQaCaptureError,
			)
			expect(answer.calls).toHaveLength(0)
			expect(await readFile(sidecarPath, "utf8")).toBe(bytes)
			const resumed = await prepare(dir, answer, judgeProvider(), "0")
			expect(resumed.sidecar.rows["q-1"]?.verdict).toBe("yes")
			expect(await readdir(dir)).toEqual(["checkpoint.json.predictions.json"])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects an existing capture directory before preflight without changing its bytes", async () => {
		const dir = await tempDir("capture-existing-directory")
		try {
			const capture = path.join(dir, "checkpoint.json.predictions.json.capture")
			await mkdir(capture, { mode: 0o700 })
			await writeFile(path.join(capture, "protected"), "protected bytes")
			const answer = answerProvider()
			await expect(prepare(dir, answer, judgeProvider())).rejects.toThrow(
				OfficialQaCaptureError,
			)
			expect(answer.calls).toHaveLength(0)
			expect(await readdir(capture)).toEqual(["protected"])
			expect(await readFile(path.join(capture, "protected"), "utf8")).toBe(
				"protected bytes",
			)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("resolveBenchmarkQaProtocol", () => {
	it("preserves legacy behavior for undefined and custom-v1", () => {
		expect(resolveBenchmarkQaProtocol({})).toBe("custom-v1")
		expect(
			resolveBenchmarkQaProtocol({
				MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-v1",
			}),
		).toBe("custom-v1")
	})

	it("opts into official mode only with the exact value", () => {
		expect(
			resolveBenchmarkQaProtocol({ MEMONGO_BENCHMARK_QA_PROTOCOL: "official" }),
		).toBe("official")
	})

	it("fails preflight on unknown values", () => {
		expect(() =>
			resolveBenchmarkQaProtocol({ MEMONGO_BENCHMARK_QA_PROTOCOL: "banana" }),
		).toThrow(/MEMONGO_BENCHMARK_QA_PROTOCOL/)
	})
})

describe("resolveBenchmarkOfficialJudgeProvider", () => {
	it("requires each judge env and names it", () => {
		for (const field of [
			"MEMONGO_BENCHMARK_JUDGE_API_KEY",
			"MEMONGO_BENCHMARK_JUDGE_BASE_URL",
			"MEMONGO_BENCHMARK_JUDGE_MODEL",
		] as const) {
			const env = { ...BASE_ENV }
			delete env[field]
			expect(() => resolveBenchmarkOfficialJudgeProvider(env)).toThrow(
				new RegExp(field),
			)
		}
	})

	it("requires the exact official judge model", () => {
		expect(() =>
			resolveBenchmarkOfficialJudgeProvider({
				...BASE_ENV,
				MEMONGO_BENCHMARK_JUDGE_MODEL: "gpt-4o",
			}),
		).toThrow(new RegExp(OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL))
	})

	it("builds an OpenAI-compatible provider without any network call", () => {
		const provider = resolveBenchmarkOfficialJudgeProvider(BASE_ENV)
		expect(typeof provider.chatCompletion).toBe("function")
		expect(provider.name).toBe("http")
	})
})

describe("prepareOfficialQa preflight", () => {
	it("requires checkpointPath", async () => {
		const dir = await tempDir("no-checkpoint")
		try {
			await expect(
				prepareOfficialQa({
					env: BASE_ENV,
					checkpointPath: undefined,
					runId: "run-1",
					configurationHash: "b".repeat(64),
					datasetSha256: "a".repeat(64),
				}),
			).rejects.toThrow(/checkpointPath/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("fails before any provider call when the judge model equals the answer model", async () => {
		const dir = await tempDir("self-judge")
		try {
			const answer = answerProvider()
			const judge = judgeProvider()
			await expect(
				prepareOfficialQa({
					env: { ...BASE_ENV, MEMONGO_BENCHMARK_JUDGE_MODEL: ANSWER_MODEL },
					checkpointPath: path.join(dir, "checkpoint.json"),
					runId: "run-1",
					configurationHash: "b".repeat(64),
					datasetSha256: "a".repeat(64),
					resolveProviders: () => ({ answer, judge }),
				}),
			).rejects.toThrow(/distinct/)
			expect(answer.calls).toHaveLength(0)
			expect(judge.calls).toHaveLength(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("fails before any provider call when the answer provider is missing", async () => {
		const dir = await tempDir("no-answer")
		try {
			await expect(
				prepareOfficialQa({
					env: BASE_ENV,
					checkpointPath: path.join(dir, "checkpoint.json"),
					runId: "run-1",
					configurationHash: "b".repeat(64),
					datasetSha256: "a".repeat(64),
					resolveProviders: () => ({ answer: null, judge: judgeProvider() }),
				}),
			).rejects.toThrow(/benchmark answer provider/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("preflight-probes the answer provider once and skips the judge on a valid fresh preflight (B8-2)", async () => {
		const dir = await tempDir("fresh-ok")
		try {
			const answer = answerProvider()
			const judge = judgeProvider()
			const context = await prepareOfficialQa({
				env: BASE_ENV,
				checkpointPath: path.join(dir, "checkpoint.json"),
				runId: "run-1",
				configurationHash: "b".repeat(64),
				datasetSha256: "a".repeat(64),
				resolveProviders: () => ({ answer, judge }),
			})
			// B8-2: exactly one cheap answer-provider probe with the pinned
			// settings; the judge provider is never called at preflight.
			expect(answer.calls).toHaveLength(1)
			expect(answer.calls[0]?.maxTokens).toBe(OFFICIAL_ANSWER_MAX_TOKENS)
			expect(answer.calls[0]?.temperature).toBe(OFFICIAL_ANSWER_TEMPERATURE)
			expect(judge.calls).toHaveLength(0)
			expect(context.sidecar.rows).toEqual({})
			expect(context.judgeModel).toBe(JUDGE_MODEL)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("fails fast with an actionable message when the answer provider rejects the pinned settings (B8-2)", async () => {
		const dir = await tempDir("preflight-reject")
		try {
			const answer = fakeProvider(() => {
				throw new Error("400 unsupported_value: temperature")
			})
			await expect(
				prepareOfficialQa({
					env: BASE_ENV,
					checkpointPath: path.join(dir, "checkpoint.json"),
					runId: "run-1",
					configurationHash: "b".repeat(64),
					datasetSha256: "a".repeat(64),
					resolveProviders: () => ({ answer, judge: judgeProvider() }),
				}),
			).rejects.toThrow(/answer provider preflight failed.*temperature/s)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("hard-fails a scored resume when a completed checkpoint scenario is missing a judged row", async () => {
		const dir = await tempDir("resume-missing")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			let sidecar = createOfficialPredictionSidecar(sidecarIdentity())
			sidecar = recordOfficialAnswer(sidecar, "q-1", "violet")
			sidecar = recordOfficialVerdict(sidecar, "q-1", "yes")
			// q-2 never judged, but the checkpoint claims scenario-A complete.
			await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)
			await expect(
				prepareOfficialQa({
					env: BASE_ENV,
					checkpointPath: path.join(dir, "checkpoint.json"),
					runId: "run-1",
					configurationHash: "b".repeat(64),
					datasetSha256: "a".repeat(64),
					resumeCompletedScenarios: [
						{ scenarioId: "scenario-A", declaredCaseIds: ["q-1", "q-2"] },
					],
					resolveProviders: () => ({
						answer: answerProvider(),
						judge: judgeProvider(),
					}),
				}),
			).rejects.toThrow(/scenario-A.*q-2/s)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("accepts a scored resume when every declared case of every completed scenario is judged", async () => {
		const dir = await tempDir("resume-ok")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			let sidecar = createOfficialPredictionSidecar(sidecarIdentity())
			sidecar = recordOfficialAnswer(sidecar, "q-1", "violet")
			sidecar = recordOfficialVerdict(sidecar, "q-1", "yes")
			await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)
			const context = await prepareOfficialQa({
				env: BASE_ENV,
				checkpointPath: path.join(dir, "checkpoint.json"),
				runId: "run-1",
				configurationHash: "b".repeat(64),
				datasetSha256: "a".repeat(64),
				resumeCompletedScenarios: [
					{ scenarioId: "scenario-A", declaredCaseIds: ["q-1"] },
				],
				resolveProviders: () => ({
					answer: answerProvider(),
					judge: judgeProvider(),
				}),
			})
			expect(context.sidecar.rows["q-1"]?.stage).toBe("judged")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("accepts a resume whose completed scenario carries unreliable rows (B8-3)", async () => {
		const dir = await tempDir("resume-unreliable")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			let sidecar = createOfficialPredictionSidecar(sidecarIdentity())
			sidecar = recordOfficialAnswer(sidecar, "q-1", "violet")
			sidecar = recordOfficialVerdict(sidecar, "q-1", "yes")
			sidecar = recordOfficialUnreliable(
				sidecar,
				"q-2",
				"answer truncated by the token budget (finishReason=length)",
			)
			await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)
			const context = await prepareOfficialQa({
				env: BASE_ENV,
				checkpointPath: path.join(dir, "checkpoint.json"),
				runId: "run-1",
				configurationHash: "b".repeat(64),
				datasetSha256: "a".repeat(64),
				resumeCompletedScenarios: [
					{ scenarioId: "scenario-A", declaredCaseIds: ["q-1", "q-2"] },
				],
				resolveProviders: () => ({
					answer: answerProvider(),
					judge: judgeProvider(),
				}),
			})
			expect(context.sidecar.rows["q-2"]?.stage).toBe("unreliable")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("dated answer context (judge prompt untouched)", () => {
	it("renders the question date line, per-passage dates, role labels, and the chain-of-note schema", () => {
		const messages = buildOfficialDatedAnswerMessages(material("q-1"))
		expect(messages).toHaveLength(2)
		expect(messages[0]?.role).toBe("system")
		expect(messages[0]?.content).toContain("notes")
		expect(messages[0]?.content).toContain("the latest dated statement wins")
		expect(messages[0]?.content).toContain("chronological order")
		expect(messages[1]?.content).toBe(
			[
				"QUESTION (asked on 2024/05/03): What color is the sky in q-1?",
				"<context>",
				"[1] [2024/04/12] User: snippet one",
				"[2] [2024/04/12; 2024/04/30] Assistant: snippet two",
				"</context>",
				'Return only {"notes":[{"passage":<number>,"relevant_fact":"...","date":"..."}],"reasoning":"...","answer":"..."}.',
			].join("\n"),
		)
	})

	it("orders passages chronologically regardless of retrieval order (B9)", () => {
		const user = buildOfficialDatedAnswerUserContent(
			material("q-1", {
				contextPassages: ["newest snippet", "oldest snippet", "middle snippet"],
				passageDates: [["2024/05/10"], ["2024/03/01"], ["2024/04/15"]],
				passageRoles: ["assistant", "user", "user"],
			}),
		)
		expect(user).toContain(
			[
				"<context>",
				"[1] [2024/03/01] User: oldest snippet",
				"[2] [2024/04/15] User: middle snippet",
				"[3] [2024/05/10] Assistant: newest snippet",
			].join("\n"),
		)
	})

	it("keeps undated passages last in capture order (B9)", () => {
		const user = buildOfficialDatedAnswerUserContent(
			material("q-1", {
				contextPassages: ["undated first", "dated snippet", "undated second"],
				passageDates: [[], ["2024/04/12"], []],
				passageRoles: [undefined, "user", undefined],
			}),
		)
		expect(user).toContain(
			[
				"<context>",
				"[1] [2024/04/12] User: dated snippet",
				"[2] undated first",
				"[3] undated second",
			].join("\n"),
		)
	})

	it("omits date and role decorations when neither is known", () => {
		const user = buildOfficialDatedAnswerUserContent(
			material("q-2", {
				questionDate: undefined,
				passageDates: [[], []],
				passageRoles: undefined,
			}),
		)
		expect(user).toBe(
			[
				"QUESTION: What color is the sky in q-2?",
				"<context>",
				"[1] snippet one",
				"[2] snippet two",
				"</context>",
				'Return only {"notes":[{"passage":<number>,"relevant_fact":"...","date":"..."}],"reasoning":"...","answer":"..."}.',
			].join("\n"),
		)
	})

	it("does not double-label a passage that already starts with its role label (B9-2)", () => {
		// Real chunk text arrives as "User: <body>" (renderEventChunkText
		// embeds the label), so the prompt must not prepend a second one.
		const user = buildOfficialDatedAnswerUserContent(
			material("q-1", {
				contextPassages: [
					"User: I started taking pottery classes",
					"Assistant: That sounds like a great hobby.",
					"User: The classes are on Tuesdays",
				],
				passageDates: [["2024/04/12"], ["2024/04/12"], ["2024/04/30"]],
				passageRoles: ["user", "assistant", "user"],
			}),
		)
		expect(user).toContain(
			"[1] [2024/04/12] User: I started taking pottery classes",
		)
		expect(user).toContain(
			"[2] [2024/04/12] Assistant: That sounds like a great hobby.",
		)
		expect(user).toContain("[3] [2024/04/30] User: The classes are on Tuesdays")
		expect(user).not.toContain("User: User:")
		expect(user).not.toContain("Assistant: Assistant:")
	})

	it("still labels passages whose embedded label differs from the known role", () => {
		// A quoted/forwarded turn can start with a different label; the known
		// role still wins and is prepended (never silently dropped).
		const user = buildOfficialDatedAnswerUserContent(
			material("q-1", {
				contextPassages: ["Assistant: the user said they liked pottery"],
				passageDates: [["2024/04/12"]],
				passageRoles: ["user"],
			}),
		)
		expect(user).toContain(
			"[1] [2024/04/12] User: Assistant: the user said they liked pottery",
		)
	})

	it("carries a version constant so runs stay comparable", () => {
		expect(OFFICIAL_DATED_ANSWER_VERSION).toBe("dated-v2")
	})
})

describe("scoreOfficialScenario", () => {
	it("generates and judges every declared case, staging rows answered then judged", async () => {
		const { context, dir } = await buildContext("fresh-score")
		try {
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1", "q-2"],
				materialByCaseId: new Map([
					["q-1", material("q-1")],
					["q-2", material("q-2")],
				]),
			})
			expect(outcome.complete).toBe(true)
			expect(outcome.judgedCaseIds).toEqual(["q-1", "q-2"])
			expect(context.stats.attempts).toEqual({
				answerGeneration: 2,
				answerJudge: 2,
			})
			const onDisk = await readFile(context.sidecarPath, "utf8")
			const parsed = JSON.parse(onDisk) as { rows: Record<string, unknown> }
			expect(parsed.rows["q-1"]).toMatchObject({
				stage: "judged",
				verdict: "yes",
			})
			expect(parsed.rows["q-2"]).toMatchObject({
				stage: "judged",
				verdict: "yes",
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("pins answer-call hygiene: temperature 0 and a 4096-token budget (B8)", async () => {
		const { context, dir } = await buildContext("answer-hygiene")
		try {
			await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(context.answerProvider.calls).toHaveLength(1)
			expect(context.answerProvider.calls[0]?.temperature).toBe(0)
			expect(context.answerProvider.calls[0]?.maxTokens).toBe(4096)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("parses a chain-of-note answer response down to its final answer (B9)", async () => {
		const { context, dir } = await buildContext("answer-chain-of-note")
		try {
			context.answerProvider = fakeProvider(() => ({
				content: JSON.stringify({
					notes: [
						{
							passage: 1,
							relevant_fact: "the sky was ash gray",
							date: "2024/04/12",
						},
						{
							passage: 2,
							relevant_fact: "the sky is violet",
							date: "2024/04/30",
						},
					],
					reasoning: "The latest dated statement (2024/04/30) wins.",
					answer: "violet",
				}),
				usage: { inputTokens: 60, outputTokens: 40 },
			}))
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(outcome.complete).toBe(true)
			// Only the final answer is stored and judged; the notes and
			// reasoning are scaffolding, never scored content.
			expect(context.sidecar.rows["q-1"]?.hypothesis).toBe("violet")
			const judge = context.judgeProvider as ReturnType<typeof judgeProvider>
			const judgeContent = judge.calls[0]?.messages[0]?.content ?? ""
			expect(judgeContent).toContain("violet")
			expect(judgeContent).not.toContain("ash gray")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("records an unreliable row and continues when the answer is truncated by the token budget (B8-3)", async () => {
		const { context, dir } = await buildContext("answer-length")
		try {
			// First answer call truncates (q-1); the next one (q-2) is healthy,
			// proving the run keeps scoring after an unreliable answer.
			let callIndex = 0
			context.answerProvider = fakeProvider(() => {
				callIndex += 1
				if (callIndex === 1) {
					return {
						content: '{"answer":"truncated partial',
						usage: { inputTokens: 500, outputTokens: 4096 },
						responseMeta: { shape: "length", finishReason: "length" },
					}
				}
				return {
					content: '{"answer":"violet","reasoning":"latest wins","notes":[]}',
					usage: { inputTokens: 500, outputTokens: 40 },
				}
			})
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1", "q-2"],
				materialByCaseId: new Map([
					["q-1", material("q-1")],
					["q-2", material("q-2")],
				]),
			})
			// B8-3: the truncated question no longer aborts the run. It is
			// recorded unreliable (terminal, excluded from judged coverage),
			// the scenario still resolves, and the rest keeps scoring.
			expect(outcome.complete).toBe(true)
			expect(outcome.judgedCaseIds).toEqual(["q-2"])
			expect(outcome.unreliableCaseIds).toEqual(["q-1"])
			expect(context.stats.failures.answerGeneration).toBe(1)
			expect(context.stats.unreliable.answerGeneration).toBe(1)
			expect(context.stats.successes.answerGeneration).toBe(1)
			// The unreliable question is never judged as a wrong answer.
			expect(context.judgeProvider.calls).toHaveLength(1)
			const unreliableRow = context.sidecar.rows["q-1"]
			expect(unreliableRow?.stage).toBe("unreliable")
			expect(unreliableRow?.verdict).toBeNull()
			expect(unreliableRow?.reason).toMatch(/truncated by the token budget/)
			// The row is durable: a resumed run never re-pays for it.
			const onDisk = JSON.parse(
				await readFile(context.sidecarPath, "utf8"),
			) as {
				rows: Record<string, { stage: string }>
			}
			expect(onDisk.rows["q-1"]?.stage).toBe("unreliable")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("records an unreliable row on an empty answer instead of aborting (B8-3)", async () => {
		const { context, dir } = await buildContext("answer-empty")
		try {
			context.answerProvider = fakeProvider(() => ({
				content: "",
				usage: { inputTokens: 500, outputTokens: 0 },
			}))
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(outcome.complete).toBe(true)
			expect(outcome.unreliableCaseIds).toEqual(["q-1"])
			expect(context.stats.failures.answerGeneration).toBe(1)
			expect(context.stats.unreliable.answerGeneration).toBe(1)
			expect(context.judgeProvider.calls).toHaveLength(0)
			expect(context.sidecar.rows["q-1"]?.stage).toBe("unreliable")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("extracts a fenced chain-of-note answer without the fence contaminating the hypothesis (B9-1)", async () => {
		const { context, dir } = await buildContext("answer-fenced")
		try {
			context.answerProvider = fakeProvider(() => ({
				content: [
					"```json",
					JSON.stringify({
						notes: [
							{
								passage: 1,
								relevant_fact: "the sky is violet",
								date: "2024/04/30",
							},
						],
						reasoning: "Only one passage bears on the question.",
						answer: "violet",
					}),
					"```",
				].join("\n"),
				usage: { inputTokens: 60, outputTokens: 40 },
			}))
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(outcome.judgedCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.hypothesis).toBe("violet")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("extracts the answer object when the model surrounds its JSON with prose (B9-1)", async () => {
		const { context, dir } = await buildContext("answer-prose-wrapped")
		try {
			context.answerProvider = fakeProvider(() => ({
				content: [
					"Let me work through the passages first.",
					'{"notes":[],"reasoning":"The dated passage wins.","answer":"violet"}',
					"I hope that helps.",
				].join("\n"),
				usage: { inputTokens: 60, outputTokens: 40 },
			}))
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(outcome.judgedCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.hypothesis).toBe("violet")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("records unreliable instead of sending raw reasoning to the judge when no answer JSON is extractable (B9-1)", async () => {
		const { context, dir } = await buildContext("answer-no-json")
		try {
			context.answerProvider = fakeProvider(() => ({
				content: [
					"The user asked about the sky color in q-1.",
					"Passage 1 mentions ash gray, but passage 2 is later.",
					"I would guess violet, but let me consider more evidence.",
				].join("\n"),
				usage: { inputTokens: 60, outputTokens: 40 },
			}))
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(outcome.unreliableCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.stage).toBe("unreliable")
			// The reasoning text never reaches the judge.
			expect(context.judgeProvider.calls).toHaveLength(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("uses a single fence-free line as a bare answer (B9-1)", async () => {
		const { context, dir } = await buildContext("answer-bare-line")
		try {
			context.answerProvider = fakeProvider(() => ({
				content: "violet",
				usage: { inputTokens: 10, outputTokens: 2 },
			}))
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(outcome.judgedCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.hypothesis).toBe("violet")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("never falls back to a bare line for truncated single-line JSON — unreliable, judge untouched (N3)", async () => {
		// Claude round-4 N3: a gateway that reports finish_reason "stop" (or
		// a proxy that strips finish_reason) can still hand back a truncated
		// single-line JSON body. The bare-line fallback would ship the whole
		// string — reasoning included — to the judge (B9-1 violation).
		const { context, dir } = await buildContext("answer-truncated-json")
		try {
			context.answerProvider = fakeProvider(() => ({
				content:
					'{"notes":[{"passage":1,"relevant_fact":"a","date":"2024/04/12"}],"reasoning":"the sky color resolves to violet across the latest dated session so the answer',
				usage: { inputTokens: 10, outputTokens: 2 },
				responseMeta: { shape: "ok", finishReason: "stop" },
			}))
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(outcome.unreliableCaseIds).toEqual(["q-1"])
			expect(outcome.judgedCaseIds).toEqual([])
			const row = context.sidecar.rows["q-1"]
			expect(row?.stage).toBe("unreliable")
			expect(row?.reason).toMatch(/unterminated or unparseable JSON/)
			// The judge never sees the raw truncated string.
			expect(context.judgeProvider.calls).toHaveLength(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("extracts the answer object when earlier braces belong to prose or thinking (N4)", async () => {
		// Claude round-4 N4: only the first `{` used to be tried, so a
		// thinking block or prose brace before the real JSON made the case
		// unreliable. Every balanced object is now tried in order.
		const { context, dir } = await buildContext("answer-brace-prose")
		try {
			const contents = [
				'Consider {the set} of options.\n{"answer":"violet"}',
				'I think {maybe} about this.\n{"notes":[],"reasoning":"r","answer":"violet"}',
			]
			let answerCalls = 0
			context.answerProvider = fakeProvider(() => {
				const content = contents[answerCalls] ?? "violet"
				answerCalls += 1
				return {
					content,
					usage: { inputTokens: 10, outputTokens: 2 },
				}
			})
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1", "q-2"],
				materialByCaseId: new Map([
					["q-1", material("q-1")],
					["q-2", material("q-2")],
				]),
			})
			expect(outcome.judgedCaseIds).toEqual(["q-1", "q-2"])
			expect(context.sidecar.rows["q-1"]?.hypothesis).toBe("violet")
			expect(context.sidecar.rows["q-2"]?.hypothesis).toBe("violet")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("sends the untouched official judge prompt (Slice A helper output, byte-exact)", async () => {
		const { context, dir } = await buildContext("judge-prompt")
		try {
			const m = material("q-1")
			await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", m]]),
			})
			const judge = context.judgeProvider as ReturnType<typeof judgeProvider>
			expect(judge.calls).toHaveLength(1)
			const expected = buildOfficialAnscheckPrompt({
				questionType: "single-session-user",
				question: m.question,
				goldAnswer: m.goldAnswer,
				hypothesis: "violet",
				abstention: false,
			})
			expect(judge.calls[0]?.messages).toEqual([
				{ role: "user", content: expected },
			])
			expect(judge.calls[0]?.maxTokens).toBe(10)
			expect(judge.calls[0]?.temperature).toBe(0)
			expect(judge.calls[0]?.responseFormat).toBeUndefined()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("custom-judge requests a 1024-token judge budget and omits temperature (lead-verified shape)", async () => {
		// Lead-proven blocker: a 10-token judge budget exhausts output tokens
		// with invalid verdicts on both common-GLM and opposite-DeepSeek judge
		// probes; exactly one 1024-token probe per model succeeded (HTTP 200,
		// finish_reason stop, normalized yes). The official pin (10 tokens,
		// temperature 0) is unchanged; custom-judge gets 1024 and NO
		// temperature property (Luna Foundry rejects temperature:0 with 400).
		const { context, dir } = await buildContext("custom-judge-budget")
		context.protocol = "custom-judge"
		try {
			const m = material("q-1")
			await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", m]]),
			})
			const judge = context.judgeProvider as ReturnType<typeof judgeProvider>
			expect(judge.calls).toHaveLength(1)
			const expected = buildOfficialAnscheckPrompt({
				questionType: "single-session-user",
				question: m.question,
				goldAnswer: m.goldAnswer,
				hypothesis: "violet",
				abstention: false,
			})
			expect(judge.calls[0]?.messages).toEqual([
				{ role: "user", content: expected },
			])
			expect(judge.calls[0]?.maxTokens).toBe(1024)
			expect(judge.calls[0]?.temperature).toBeUndefined()
			expect(judge.calls[0]?.responseFormat).toBeUndefined()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("reuses judged rows with zero provider calls (judged-before-checkpoint crash)", async () => {
		const { context, dir } = await buildContext("reuse-judged", (sidecar) => {
			let seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
			seeded = recordOfficialVerdict(seeded, "q-1", "no")
			Object.assign(sidecar.rows, seeded.rows)
		})
		try {
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(outcome.complete).toBe(true)
			expect(context.answerProvider.calls).toHaveLength(0)
			expect(context.judgeProvider.calls).toHaveLength(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("judges a stored hypothesis without repeating the answer call (answer-before-judge crash)", async () => {
		const { context, dir } = await buildContext("reuse-answered", (sidecar) => {
			const seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
			Object.assign(sidecar.rows, seeded.rows)
		})
		try {
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			expect(outcome.complete).toBe(true)
			expect(context.answerProvider.calls).toHaveLength(0)
			expect(context.judgeProvider.calls).toHaveLength(1)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("throws a sanitized error on upstream scenario failure (no upstream text, before checkpoint)", async () => {
		const { context, dir } = await buildContext("upstream")
		try {
			await expect(
				scoreOfficialScenario({
					context,
					scenarioId: "scenario-A",
					declaredCaseIds: ["q-1", "q-2"],
					materialByCaseId: new Map([
						["q-1", material("q-1")],
						[
							"q-2",
							material("q-2", {
								contextPassages: [],
								passageDates: [],
								upstreamFailure:
									"MongoDB connection lost mid-query with SECRET-DETAILS",
							}),
						],
					]),
				}),
			).rejects.toThrow(/scenario-A/)
			try {
				await scoreOfficialScenario({
					context,
					scenarioId: "scenario-A",
					declaredCaseIds: ["q-1", "q-2"],
					materialByCaseId: new Map([
						["q-1", material("q-1")],
						[
							"q-2",
							material("q-2", {
								contextPassages: [],
								passageDates: [],
								upstreamFailure:
									"MongoDB connection lost mid-query with SECRET-DETAILS",
							}),
						],
					]),
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				expect(message).not.toContain("SECRET-DETAILS")
				expect(message).not.toContain("MongoDB connection lost")
				return
			}
			expect.unreachable("expected a sanitized upstream-failure error")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("marks no-gold and unsupported-type cases unavailable before paid work, never wrong", async () => {
		const { context, dir } = await buildContext("unjudgeable")
		try {
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-ok", "q-nogold", "q-badtype"],
				materialByCaseId: new Map([
					["q-ok", material("q-ok")],
					["q-nogold", material("q-nogold", { goldAnswer: "" })],
					["q-badtype", material("q-badtype", { questionType: "mystery" })],
				]),
			})
			expect(outcome.complete).toBe(false)
			expect(outcome.unavailable).toEqual([
				{ questionId: "q-nogold", reason: "missing-gold" },
				{ questionId: "q-badtype", reason: "unsupported-question-type" },
			])
			expect(context.stats.attempts).toEqual({
				answerGeneration: 1,
				answerJudge: 1,
			})
			expect(context.unavailable.map((entry) => entry.questionId)).toEqual([
				"q-nogold",
				"q-badtype",
			])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("hard-fails when a declared case has no captured material or is declared twice", async () => {
		const { context, dir } = await buildContext("declared-mismatch")
		try {
			await expect(
				scoreOfficialScenario({
					context,
					scenarioId: "scenario-A",
					declaredCaseIds: ["q-1", "q-ghost"],
					materialByCaseId: new Map([["q-1", material("q-1")]]),
				}),
			).rejects.toThrow(/q-ghost/)
			await expect(
				scoreOfficialScenario({
					context,
					scenarioId: "scenario-A",
					declaredCaseIds: ["q-1", "q-1"],
					materialByCaseId: new Map([["q-1", material("q-1")]]),
				}),
			).rejects.toThrow(/duplicate/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("ignores materials outside the declared set (no caseId === scenarioId assumption)", async () => {
		const { context, dir } = await buildContext("exact-set")
		try {
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([
					["q-1", material("q-1")],
					["q-other-scenario", material("q-other-scenario")],
				]),
			})
			expect(outcome.complete).toBe(true)
			expect(outcome.judgedCaseIds).toEqual(["q-1"])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("retries a transient answer transport failure and still ends judged (N1)", async () => {
		const { context, dir } = await buildContext("answer-retry")
		try {
			let answerCalls = 0
			context.answerProvider = fakeProvider(() => {
				answerCalls += 1
				if (answerCalls === 1) {
					// Transport-class 503, as the HTTP provider throws it.
					throw new EnrichmentHttpError(
						"LLM enrichment request failed: 503 overloaded",
						503,
					)
				}
				return {
					content: JSON.stringify({ answer: "violet" }),
					usage: { inputTokens: 11, outputTokens: 3 },
				}
			})
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			// N1: the retry succeeds in-process; the question ends judged,
			// not unreliable, and the answer provider paid exactly 2 calls.
			expect(outcome.complete).toBe(true)
			expect(outcome.judgedCaseIds).toEqual(["q-1"])
			expect(outcome.unreliableCaseIds).toEqual([])
			expect(context.answerProvider.calls).toHaveLength(2)
			const row = context.sidecar.rows["q-1"]
			expect(row?.stage).toBe("judged")
			expect(context.stats.attempts.answerGeneration).toBe(1)
			expect(context.stats.successes.answerGeneration).toBe(1)
			expect(context.stats.failures.answerGeneration).toBe(0)
			expect(context.stats.unreliable.answerGeneration).toBe(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}, 30_000)

	it("rethrows a persistent answer transport failure instead of recording a sticky unreliable row (N1)", async () => {
		const { context, dir } = await buildContext("answer-outage")
		try {
			context.answerProvider = fakeProvider(() => {
				throw new EnrichmentHttpError(
					"LLM enrichment request failed: 503 overloaded",
					503,
				)
			})
			await expect(
				scoreOfficialScenario({
					context,
					scenarioId: "scenario-A",
					declaredCaseIds: ["q-1"],
					materialByCaseId: new Map([["q-1", material("q-1")]]),
				}),
			).rejects.toThrow(
				/official answer generation failed for question q-1: .*503/,
			)
			// N1: a provider outage never writes an unreliable row — the
			// scenario stays un-checkpointed so --resume retries the question
			// on a healthy provider. Bounded retries: 1 attempt + 2 retries.
			expect(context.answerProvider.calls).toHaveLength(3)
			expect(context.sidecar.rows["q-1"]).toBeUndefined()
			expect(context.stats.failures.answerGeneration).toBe(1)
			expect(context.stats.unreliable.answerGeneration).toBe(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}, 30_000)

	it("retries a transient judge transport failure and still records the verdict (N1-c)", async () => {
		const { context, dir } = await buildContext("judge-retry")
		try {
			let judgeCalls = 0
			context.judgeProvider = fakeProvider(() => {
				judgeCalls += 1
				if (judgeCalls === 1) {
					throw new EnrichmentHttpError(
						"LLM enrichment request failed: 503 overloaded",
						503,
					)
				}
				return {
					content: "yes",
					usage: { inputTokens: 31, outputTokens: 2 },
				}
			})
			const outcome = await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
			})
			// N1-c: the judge call gets the same bounded transport retry as
			// the answer call; a transient judge 503 no longer aborts the run.
			expect(outcome.complete).toBe(true)
			expect(outcome.judgedCaseIds).toEqual(["q-1"])
			expect(context.judgeProvider.calls).toHaveLength(2)
			expect(context.sidecar.rows["q-1"]?.stage).toBe("judged")
			expect(context.sidecar.rows["q-1"]?.verdict).toBe("yes")
			expect(context.stats.failures.answerJudge).toBe(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	}, 30_000)

	it("forwards per-operation accounting with usage", async () => {
		const { context, dir } = await buildContext("accounting")
		try {
			const entries: Array<{
				operation: string
				outcome: string
				usage?: EnrichmentChatUsage
			}> = []
			await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", material("q-1")]]),
				onProviderCall: (operation, outcome, usage) => {
					entries.push({ operation, outcome, usage })
				},
			})
			expect(entries).toEqual([
				{
					operation: "answer-generation",
					outcome: "attempted",
					usage: undefined,
				},
				{
					operation: "answer-generation",
					outcome: "succeeded",
					usage: { inputTokens: 11, outputTokens: 3 },
				},
				{ operation: "answer-judge", outcome: "attempted", usage: undefined },
				{
					operation: "answer-judge",
					outcome: "succeeded",
					usage: { inputTokens: 31, outputTokens: 2 },
				},
			])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("judges abstention cases through the official abstention template", async () => {
		const { context, dir } = await buildContext("abstention")
		try {
			const m = material("q-1_abs", {
				abstention: true,
				goldAnswer: "not answerable from memory",
				questionType: "single-session-user",
			})
			await scoreOfficialScenario({
				context,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1_abs"],
				materialByCaseId: new Map([["q-1_abs", m]]),
			})
			const judge = context.judgeProvider as ReturnType<typeof judgeProvider>
			const expected = buildOfficialAnscheckPrompt({
				questionType: "single-session-user",
				question: m.question,
				goldAnswer: m.goldAnswer,
				hypothesis: "violet",
				abstention: true,
			})
			expect(judge.calls[0]?.messages[0]?.content).toBe(expected)
			expect(isOfficialAbstentionQuestion("q-1_abs")).toBe(true)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

function scenarioFixture(
	evaluations: Array<{
		caseId: string
		query: string
		answer?: string
		questionType?: string
		abstention?: boolean
	}>,
	scenarioId = "scenario-A",
) {
	return { scenarioId, conversations: [], evaluations }
}

describe("parseOfficialJudgeVerdict (J1)", () => {
	it("accepts a clean leading yes or no, case-insensitively", () => {
		expect(parseOfficialJudgeVerdict("yes")).toBe("yes")
		expect(parseOfficialJudgeVerdict("  No.")).toBe("no")
		expect(parseOfficialJudgeVerdict("**Yes** — it matches")).toBe("yes")
	})

	it("rejects text that merely contains yes", () => {
		expect(parseOfficialJudgeVerdict("I would not say yes here")).toBeNull()
		expect(parseOfficialJudgeVerdict("yesterday's answer")).toBeNull()
		expect(parseOfficialJudgeVerdict("")).toBeNull()
	})
})

describe("judge verdict reliability (J1)", () => {
	async function scoreWithJudge(
		label: string,
		judge: MockedProvider,
	): Promise<{
		context: MockedOfficialQaContext
		outcome: Awaited<ReturnType<typeof scoreOfficialScenario>>
		dir: string
	}> {
		const { context, dir } = await buildContext(label)
		context.judgeProvider = judge
		const outcome = await scoreOfficialScenario({
			context,
			scenarioId: "scenario-A",
			declaredCaseIds: ["q-1"],
			materialByCaseId: new Map([["q-1", material("q-1")]]),
		})
		return { context, outcome, dir }
	}

	it("records a clean yes as judged yes", async () => {
		const { context, outcome, dir } = await scoreWithJudge(
			"j1-yes",
			judgeProvider("yes"),
		)
		try {
			expect(outcome.judgedCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.verdict).toBe("yes")
			expect(context.judgeProvider.calls).toHaveLength(1)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("records a clean no as judged no", async () => {
		const { context, outcome, dir } = await scoreWithJudge(
			"j1-no",
			judgeProvider("no"),
		)
		try {
			expect(outcome.judgedCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.verdict).toBe("no")
			expect(context.stats.unreliable.answerJudge).toBe(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("never passes explanatory text that contains yes", async () => {
		const { context, outcome, dir } = await scoreWithJudge(
			"j1-would-not",
			judgeProvider("The response is wrong; I would not say yes."),
		)
		try {
			expect(outcome.judgedCaseIds).toEqual([])
			expect(outcome.unreliableCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.stage).toBe("unreliable")
			expect(context.sidecar.rows["q-1"]?.verdict).toBeNull()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("records an empty judge completion unreliable, never a silent no", async () => {
		const { context, outcome, dir } = await scoreWithJudge(
			"j1-empty",
			judgeProvider(""),
		)
		try {
			expect(outcome.complete).toBe(true)
			expect(outcome.unreliableCaseIds).toEqual(["q-1"])
			const row = context.sidecar.rows["q-1"]
			expect(row?.stage).toBe("unreliable")
			expect(row?.verdict).toBeNull()
			expect(row?.reason).toMatch(/judge completion was empty/)
			// The paid-for answer stays on the row for offline re-judging.
			expect(row?.hypothesis).toBe("violet")
			expect(context.stats.unreliable.answerJudge).toBe(1)
			expect(context.stats.unreliable.answerGeneration).toBe(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("records a token-budget-truncated judge completion unreliable even if it starts with yes", async () => {
		const judge = fakeProvider(() => ({
			content: "yes, because",
			usage: { inputTokens: 31, outputTokens: 1024 },
			responseMeta: { shape: "length", finishReason: "length" },
		}))
		const { context, outcome, dir } = await scoreWithJudge("j1-length", judge)
		try {
			expect(outcome.unreliableCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.reason).toMatch(/truncated/)
			expect(context.sidecar.rows["q-1"]?.verdict).toBeNull()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("retries once on a bad judge completion and uses a clean retry verdict", async () => {
		let calls = 0
		const judge = fakeProvider(() => {
			calls += 1
			return {
				content: calls === 1 ? "" : "no",
				usage: { inputTokens: 31, outputTokens: 2 },
			}
		})
		const { context, outcome, dir } = await scoreWithJudge("j1-retry-ok", judge)
		try {
			expect(outcome.judgedCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.verdict).toBe("no")
			expect(context.judgeProvider.calls).toHaveLength(2)
			expect(context.stats.attempts.answerJudge).toBe(2)
			expect(context.stats.unreliable.answerJudge).toBe(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("retries once, then records unreliable when the retry is also bad", async () => {
		const { context, outcome, dir } = await scoreWithJudge(
			"j1-retry-bad",
			judgeProvider(""),
		)
		try {
			expect(context.judgeProvider.calls).toHaveLength(
				OFFICIAL_JUDGE_CONTENT_RETRIES + 1,
			)
			expect(outcome.unreliableCaseIds).toEqual(["q-1"])
			expect(context.sidecar.rows["q-1"]?.reason).toMatch(/after 2 judge calls/)
			// Persisted, and the persisted row survives the stored-row parser.
			const persisted = JSON.parse(
				await readFile(context.sidecarPath, "utf8"),
			) as { rows: Record<string, { stage: string; hypothesis: string }> }
			expect(persisted.rows["q-1"]?.stage).toBe("unreliable")
			expect(persisted.rows["q-1"]?.hypothesis).toBe("violet")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("summarizeOfficialBenchmarkQaRun", () => {
	it.each([
		"unknown judged row",
		"row key/question ID mismatch",
		"duplicate row question ID",
		"invalid judged verdict",
		"null judged verdict",
		"duplicate declared ID",
		"blank declared ID",
		"answered row with verdict",
	])("rejects %s before metrics or export without rewriting the sidecar", async (invalid) => {
		const { context, dir } = await buildContext(
			"summary-invalid",
			(sidecar) => {
				let seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
				seeded = recordOfficialVerdict(seeded, "q-1", "yes")
				seeded = recordOfficialAnswer(seeded, "q-2", "emerald")
				seeded = recordOfficialVerdict(seeded, "q-2", "no")
				if (invalid === "unknown judged row") {
					seeded = recordOfficialAnswer(seeded, "foreign", "synthetic")
					seeded = recordOfficialVerdict(seeded, "foreign", "no")
				}
				if (invalid === "row key/question ID mismatch") {
					seeded.rows["q-1"]!.questionId = "q-2"
				}
				if (invalid === "duplicate row question ID") {
					seeded.rows.alias = { ...seeded.rows["q-1"]! }
				}
				if (invalid === "invalid judged verdict") {
					seeded.rows["q-1"]!.verdict = "maybe"
				}
				if (invalid === "null judged verdict") {
					seeded.rows["q-1"]!.verdict = null
				}
				if (invalid === "answered row with verdict") {
					seeded.rows["q-1"]!.stage = "answered"
				}
				Object.assign(sidecar.rows, seeded.rows)
			},
		)
		try {
			const original = await readFile(context.sidecarPath, "utf8")
			await expect(
				summarizeOfficialBenchmarkQaRun({
					context,
					scenarios: [
						scenarioFixture([
							{
								caseId: invalid === "blank declared ID" ? " " : "q-1",
								query: "q1",
							},
							{
								caseId: invalid === "duplicate declared ID" ? "q-1" : "q-2",
								query: "q2",
							},
						]),
					],
					coveredCaseIds: new Set(["q-1", "q-2"]),
					datasetSha256: "a".repeat(64),
				}),
			).rejects.toThrow(OfficialPredictionSidecarError)
			expect(await readdir(dir)).toEqual(["checkpoint.json.predictions.json"])
			expect(await readFile(context.sidecarPath, "utf8")).toBe(original)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("keeps an empty declaration with no rows unavailable", async () => {
		const { context, dir } = await buildContext("summary-empty")
		try {
			const { envelope, metrics } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [],
				coveredCaseIds: new Set(),
				datasetSha256: "a".repeat(64),
			})
			expect(envelope.official?.coverage).toBe("unavailable")
			expect(envelope.accuracy).toBeNull()
			expect(envelope.cases.eligible).toBe(0)
			expect(envelope.cases.completed).toBe(0)
			expect(metrics).toBeNull()
			expect(await readdir(dir)).toEqual([])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("keeps declared answered rows unmeasured with unavailable coverage", async () => {
		const { context, dir } = await buildContext(
			"summary-answered",
			(sidecar) => {
				Object.assign(
					sidecar.rows,
					recordOfficialAnswer(sidecar, "q-1", "violet").rows,
				)
			},
		)
		try {
			const { envelope, metrics } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [scenarioFixture([{ caseId: "q-1", query: "q1" }])],
				coveredCaseIds: new Set(["q-1"]),
				datasetSha256: "a".repeat(64),
			})
			expect(envelope.official?.coverage).toBe("unavailable")
			expect(envelope.official?.missingQuestionIds).toEqual(["q-1"])
			expect(envelope.accuracy).toBeNull()
			expect(envelope.cases.completed).toBe(0)
			expect(metrics).toBeNull()
			expect(await readdir(dir)).toEqual(["checkpoint.json.predictions.json"])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("aggregates judged rows exactly like the Slice A metric computation", async () => {
		const { context, dir } = await buildContext("summary-full", (sidecar) => {
			let seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
			seeded = recordOfficialVerdict(seeded, "q-1", "yes")
			let seeded2 = recordOfficialAnswer(seeded, "q-2", "emerald")
			seeded2 = recordOfficialVerdict(seeded2, "q-2", "no")
			Object.assign(sidecar.rows, seeded2.rows)
		})
		try {
			const scenarios = [
				scenarioFixture([
					{
						caseId: "q-1",
						query: "What color is the sky in q-1?",
						answer: "violet",
						questionType: "single-session-user",
					},
					{
						caseId: "q-2",
						query: "What color is the sky in q-2?",
						answer: "emerald",
						questionType: "temporal-reasoning",
					},
				]),
			]
			const covered = new Set(["q-1", "q-2"])
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios,
				coveredCaseIds: covered,
				datasetSha256: "a".repeat(64),
			})
			const expected = computeOfficialLongMemEvalQaMetrics([
				{
					questionId: "q-1",
					questionType: "single-session-user",
					abstention: false,
					label: true,
				},
				{
					questionId: "q-2",
					questionType: "temporal-reasoning",
					abstention: false,
					label: false,
				},
			])
			const official = envelope.official
			expect(official?.coverage).toBe("full")
			expect(official?.overallAccuracy).toBe(expected.overallAccuracy)
			expect(official?.taskAveragedAccuracy).toBe(expected.taskAveragedAccuracy)
			expect(official?.perType).toEqual(expected.perType)
			expect(envelope.accuracy).toBe(expected.overallAccuracy)
			expect(envelope.answerModel).toBe(ANSWER_MODEL)
			expect(envelope.judge).toBe(JUDGE_MODEL)
			expect(envelope.judgeVersion).toBe(OFFICIAL_LONGMEMEVAL_QA_JUDGE_VERSION)
			expect(envelope.attempts.decoyJudge).toBe(0)
			expect(official?.accountingCompleteness).toBe("complete")
			expect(official?.export?.kind).toBe("sample")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("reports partial coverage with null full accuracy and named missing IDs", async () => {
		const { context, dir } = await buildContext(
			"summary-partial",
			(sidecar) => {
				let seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
				seeded = recordOfficialVerdict(seeded, "q-1", "yes")
				Object.assign(sidecar.rows, seeded.rows)
			},
		)
		try {
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [
					scenarioFixture([
						{
							caseId: "q-1",
							query: "q1",
							answer: "violet",
							questionType: "single-session-user",
						},
					]),
					scenarioFixture(
						[
							{
								caseId: "q-2",
								query: "q2",
								answer: "emerald",
								questionType: "multi-session",
							},
						],
						"scenario-B",
					),
				],
				coveredCaseIds: new Set(["q-1"]),
				datasetSha256: "a".repeat(64),
			})
			expect(envelope.accuracy).toBeNull()
			expect(envelope.official?.coverage).toBe("partial")
			expect(envelope.official?.overallAccuracy).toBeNull()
			expect(envelope.official?.taskAveragedAccuracy).toBeNull()
			expect(envelope.official?.missingQuestionIds).toEqual(["q-2"])
			expect(envelope.unavailableReason).toBeTruthy()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("reports unavailable when nothing was judged", async () => {
		const { context, dir } = await buildContext("summary-unavailable")
		try {
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [
					scenarioFixture([
						{
							caseId: "q-1",
							query: "q1",
							answer: "violet",
							questionType: "single-session-user",
						},
					]),
				],
				coveredCaseIds: new Set(),
				datasetSha256: "a".repeat(64),
			})
			expect(envelope.official?.coverage).toBe("unavailable")
			expect(envelope.official?.overallAccuracy).toBeNull()
			expect(envelope.official?.missingQuestionIds).toEqual(["q-1"])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("marks lost pre-checkpoint usage incomplete with named IDs, never complete", async () => {
		const { context, dir } = await buildContext("summary-lost", (sidecar) => {
			let seeded = recordOfficialAnswer(sidecar, "q-restored", "violet")
			seeded = recordOfficialVerdict(seeded, "q-restored", "yes")
			let seeded2 = recordOfficialAnswer(seeded, "q-orphan", "emerald")
			seeded2 = recordOfficialVerdict(seeded2, "q-orphan", "yes")
			Object.assign(sidecar.rows, seeded2.rows)
		})
		try {
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [
					scenarioFixture([
						{
							caseId: "q-restored",
							query: "q1",
							answer: "violet",
							questionType: "single-session-user",
						},
						{
							caseId: "q-orphan",
							query: "q2",
							answer: "emerald",
							questionType: "multi-session",
						},
					]),
				],
				// q-orphan's scenario never reached a completed checkpoint.
				coveredCaseIds: new Set(["q-restored"]),
				datasetSha256: "a".repeat(64),
			})
			expect(envelope.official?.accountingCompleteness).toBe("incomplete")
			expect(envelope.official?.lostPreCheckpointQuestionIds).toEqual([
				"q-orphan",
			])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("preserves abstention accuracy and count from the Slice A metrics (round 2)", async () => {
		const { context, dir } = await buildContext(
			"summary-abstention",
			(sidecar) => {
				let seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
				seeded = recordOfficialVerdict(seeded, "q-1", "yes")
				let seeded2 = recordOfficialAnswer(seeded, "q-2_abs", "not covered")
				seeded2 = recordOfficialVerdict(seeded2, "q-2_abs", "yes")
				Object.assign(sidecar.rows, seeded2.rows)
			},
		)
		try {
			const scenarios = [
				scenarioFixture([
					{
						caseId: "q-1",
						query: "q1",
						answer: "violet",
						questionType: "single-session-user",
					},
					{
						caseId: "q-2_abs",
						query: "q2",
						answer: "",
						abstention: true,
						questionType: "single-session-user",
					},
				]),
			]
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios,
				coveredCaseIds: new Set(["q-1", "q-2_abs"]),
				datasetSha256: "a".repeat(64),
			})
			const expected = computeOfficialLongMemEvalQaMetrics([
				{
					questionId: "q-1",
					questionType: "single-session-user",
					abstention: false,
					label: true,
				},
				{
					questionId: "q-2_abs",
					questionType: "single-session-user",
					abstention: true,
					label: true,
				},
			])
			expect(envelope.official?.coverage).toBe("full")
			expect(envelope.official?.abstentionAccuracy).toBe(
				expected.abstentionAccuracy,
			)
			expect(envelope.official?.abstentionAccuracy).toBe(1)
			expect(envelope.official?.abstentionCount).toBe(expected.abstentionCount)
			expect(envelope.official?.abstentionCount).toBe(1)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("nulls abstention accuracy on partial coverage but keeps the honest count (round 2)", async () => {
		const { context, dir } = await buildContext(
			"summary-abstention-partial",
			(sidecar) => {
				let seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
				seeded = recordOfficialVerdict(seeded, "q-1", "yes")
				Object.assign(sidecar.rows, seeded.rows)
			},
		)
		try {
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [
					scenarioFixture([
						{
							caseId: "q-1",
							query: "q1",
							answer: "violet",
							questionType: "single-session-user",
						},
						{
							caseId: "q-2_abs",
							query: "q2",
							answer: "",
							abstention: true,
							questionType: "single-session-user",
						},
					]),
				],
				// q-2_abs was never judged this run.
				coveredCaseIds: new Set(["q-1"]),
				datasetSha256: "a".repeat(64),
			})
			expect(envelope.official?.coverage).toBe("partial")
			// Never a fabricated zero: not measured reads null.
			expect(envelope.official?.abstentionAccuracy).toBeNull()
			expect(envelope.official?.abstentionCount).toBe(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("keeps accounting incomplete after a successful resume, even with zero surviving orphans (round 2)", async () => {
		const { context, dir } = await buildContext(
			"summary-resumed",
			(sidecar) => {
				let seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
				seeded = recordOfficialVerdict(seeded, "q-1", "yes")
				Object.assign(sidecar.rows, seeded.rows)
			},
		)
		try {
			const scenarios = [
				scenarioFixture([
					{
						caseId: "q-1",
						query: "q1",
						answer: "violet",
						questionType: "single-session-user",
					},
				]),
			]
			const common = {
				context,
				scenarios,
				coveredCaseIds: new Set(["q-1"]),
				datasetSha256: "a".repeat(64),
			}
			// First resume: coverage ends up full and no orphan rows survive,
			// but the run resumed — usage lost before any checkpoint may have
			// left no surviving evidence at all, so accounting stays incomplete.
			const first = await summarizeOfficialBenchmarkQaRun({
				...common,
				resumedFromCheckpoint: true,
			})
			expect(first.envelope.official?.coverage).toBe("full")
			expect(first.envelope.official?.lostPreCheckpointQuestionIds).toEqual([])
			expect(first.envelope.official?.accountingCompleteness).toBe("incomplete")
			// A later repeat resume of the same state: still incomplete.
			const second = await summarizeOfficialBenchmarkQaRun({
				...common,
				resumedFromCheckpoint: true,
			})
			expect(second.envelope.official?.accountingCompleteness).toBe(
				"incomplete",
			)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("keeps startup orphans lost even when this run re-covers them (round 2)", async () => {
		const { context, dir } = await buildContext(
			"summary-startup-orphans",
			(sidecar) => {
				let seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
				seeded = recordOfficialVerdict(seeded, "q-1", "yes")
				Object.assign(sidecar.rows, seeded.rows)
			},
		)
		try {
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [
					scenarioFixture([
						{
							caseId: "q-1",
							query: "q1",
							answer: "violet",
							questionType: "single-session-user",
						},
					]),
				],
				// This run covered and judged q-1, but q-1 was a startup orphan
				// (judged in a previous crash whose scenario never checkpointed).
				// Recovery cannot silently clear that uncertainty.
				coveredCaseIds: new Set(["q-1"]),
				datasetSha256: "a".repeat(64),
				startupLostQuestionIds: ["q-1"],
			})
			expect(envelope.official?.coverage).toBe("full")
			expect(envelope.official?.lostPreCheckpointQuestionIds).toEqual(["q-1"])
			expect(envelope.official?.accountingCompleteness).toBe("incomplete")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("exports exact {question_id,hypothesis} JSONL; full export requires exact500 coverage", async () => {
		const smallScenarios = [
			scenarioFixture([
				{
					caseId: "q-1",
					query: "q1",
					answer: "violet",
					questionType: "single-session-user",
				},
			]),
		]
		const { context, dir } = await buildContext("export-sample", (sidecar) => {
			let seeded = recordOfficialAnswer(sidecar, "q-1", "violet")
			seeded = recordOfficialVerdict(seeded, "q-1", "yes")
			Object.assign(sidecar.rows, seeded.rows)
		})
		try {
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: smallScenarios,
				coveredCaseIds: new Set(["q-1"]),
				datasetSha256: "a".repeat(64),
			})
			const exportInfo = envelope.official?.export
			expect(exportInfo?.kind).toBe("sample")
			const samplePath = exportInfo?.path ?? ""
			expect(samplePath).toContain(".export.sample.jsonl")
			const lines = (await readFile(samplePath, "utf8")).trim().split("\n")
			expect(lines).toEqual(['{"question_id":"q-1","hypothesis":"violet"}'])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}

		const fullDir = await tempDir("export-full")
		try {
			const sidecarPath = path.join(fullDir, "checkpoint.json.predictions.json")
			const sidecar = createOfficialPredictionSidecar(sidecarIdentity())
			const evaluations = Array.from({ length: 500 }, (_, index) => {
				const caseId = `q-${index + 1}`
				let seeded = recordOfficialAnswer(
					sidecar,
					caseId,
					`hypothesis-${index + 1}`,
				)
				seeded = recordOfficialVerdict(seeded, caseId, "yes")
				Object.assign(sidecar.rows, seeded.rows)
				return {
					caseId,
					query: `question ${index + 1}`,
					answer: `answer ${index + 1}`,
					questionType: "single-session-user",
				}
			})
			await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)
			const context: OfficialQaContext = {
				protocol: "official",
				answerProvider: answerProvider(),
				judgeProvider: judgeProvider(),
				answerModel: ANSWER_MODEL,
				judgeModel: JUDGE_MODEL,
				sidecarPath,
				sidecar,
				stats: {
					attempts: { answerGeneration: 0, answerJudge: 0 },
					successes: { answerGeneration: 0, answerJudge: 0 },
					failures: { answerGeneration: 0, answerJudge: 0 },
					unreliable: { answerGeneration: 0, answerJudge: 0 },
				},
				unavailable: [],
			}
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [scenarioFixture(evaluations)],
				coveredCaseIds: new Set(evaluations.map((e) => e.caseId)),
				// Round 2: the pinned LongMemEval digest is required for a
				// full-set export; exact-500 coverage alone is not enough.
				datasetSha256: LONGMEMEVAL_RELEASE_V2.datasetSha256,
			})
			expect(envelope.official?.coverage).toBe("full")
			expect(envelope.official?.export?.kind).toBe("full")
			const fullPath = envelope.official?.export?.path ?? ""
			expect(fullPath).toContain(".export.jsonl")
			expect(fullPath).not.toContain("sample")
			const lines = (await readFile(fullPath, "utf8")).trim().split("\n")
			expect(lines).toHaveLength(500)
			expect(lines[0]).toBe('{"question_id":"q-1","hypothesis":"hypothesis-1"}')
			expect(lines[499]).toBe(
				'{"question_id":"q-500","hypothesis":"hypothesis-500"}',
			)

			// Round 2 (correction 5): the same 500 judged rows with full
			// coverage but a NON-pinned dataset digest (any other corpus)
			// must degrade to an honestly-labeled sample, never "full".
			const nonPinned = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [scenarioFixture(evaluations)],
				coveredCaseIds: new Set(evaluations.map((e) => e.caseId)),
				datasetSha256: "a".repeat(64),
			})
			expect(nonPinned.envelope.official?.coverage).toBe("full")
			expect(nonPinned.envelope.official?.export?.kind).toBe("sample")
			expect(nonPinned.envelope.official?.export?.path).toContain(
				".export.sample.jsonl",
			)
		} finally {
			await rm(fullDir, { recursive: true, force: true })
		}

		const shortDir = await tempDir("export-short")
		try {
			const sidecarPath = path.join(
				shortDir,
				"checkpoint.json.predictions.json",
			)
			const sidecar = createOfficialPredictionSidecar(sidecarIdentity())
			const evaluations = Array.from({ length: 500 }, (_, index) => ({
				caseId: `q-${index + 1}`,
				query: `question ${index + 1}`,
				answer: `answer ${index + 1}`,
				questionType: "single-session-user",
			}))
			// Only 499 of the 500 declared cases were judged: the full export
			// must be refused (exact500 coverage gate), never silently shrunk.
			for (let index = 0; index < 499; index += 1) {
				const caseId = `q-${index + 1}`
				let seeded = recordOfficialAnswer(
					sidecar,
					caseId,
					`hypothesis-${index + 1}`,
				)
				seeded = recordOfficialVerdict(seeded, caseId, "yes")
				Object.assign(sidecar.rows, seeded.rows)
			}
			await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)
			const references = evaluations.map((evaluation) => ({
				questionId: evaluation.caseId,
				question: evaluation.query,
				answer: evaluation.answer ?? "",
				questionType: "single-session-user" as const,
			}))
			const predictions = Object.values(sidecar.rows).map((row) => ({
				questionId: row.questionId,
				hypothesis: row.hypothesis,
			}))
			await expect(
				exportOfficialPredictionsJsonl({
					sidecarPath,
					predictions,
					references,
					kind: "full",
					datasetSha256: LONGMEMEVAL_RELEASE_V2.datasetSha256,
				}),
			).rejects.toThrow(/500/)

			// Round 2 (correction 5): a direct full export with a NON-pinned
			// digest is refused outright, even with id-matched references — a
			// 500-case set from any other corpus is not comparable to the
			// official split. (The digest gate fires before the coverage
			// validator, so the pinned-digest message is what surfaces.)
			await expect(
				exportOfficialPredictionsJsonl({
					sidecarPath,
					predictions,
					references,
					kind: "full",
					datasetSha256: "a".repeat(64),
				}),
			).rejects.toThrow(/pinned LongMemEval dataset digest/)

			// A partial run must not crash the summary: it degrades to an
			// honestly-labeled sample export with partial coverage reporting.
			const context: OfficialQaContext = {
				protocol: "official",
				answerProvider: answerProvider(),
				judgeProvider: judgeProvider(),
				answerModel: ANSWER_MODEL,
				judgeModel: JUDGE_MODEL,
				sidecarPath,
				sidecar,
				stats: {
					attempts: { answerGeneration: 0, answerJudge: 0 },
					successes: { answerGeneration: 0, answerJudge: 0 },
					failures: { answerGeneration: 0, answerJudge: 0 },
					unreliable: { answerGeneration: 0, answerJudge: 0 },
				},
				unavailable: [],
			}
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [scenarioFixture(evaluations)],
				coveredCaseIds: new Set(evaluations.map((e) => e.caseId)),
				datasetSha256: "a".repeat(64),
			})
			expect(envelope.official?.coverage).toBe("partial")
			expect(envelope.official?.export?.kind).toBe("sample")
			expect(envelope.official?.missingQuestionIds).toEqual(["q-500"])
		} finally {
			await rm(shortDir, { recursive: true, force: true })
		}
	})
})

describe("custom-judge protocol (non-official Luna judging)", () => {
	const CUSTOM_JUDGE_MODEL = "gpt-5.6-luna"
	const CUSTOM_JUDGE_ENV = {
		...BASE_ENV,
		MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-judge",
		MEMONGO_BENCHMARK_JUDGE_MODEL: CUSTOM_JUDGE_MODEL,
	}

	function customSidecarIdentity(): OfficialPredictionSidecarIdentity {
		return {
			...sidecarIdentity(),
			judgeModel: CUSTOM_JUDGE_MODEL,
			judgeProtocol: "custom-judge-anscheck",
		}
	}

	function customContext(
		dir: string,
		answer: ReturnType<typeof answerProvider>,
		judge: ReturnType<typeof judgeProvider>,
	): OfficialQaContext {
		return {
			answerProvider: answer,
			judgeProvider: judge,
			answerModel: ANSWER_MODEL,
			judgeModel: CUSTOM_JUDGE_MODEL,
			protocol: "custom-judge",
			sidecarPath: path.join(dir, "checkpoint.json.predictions.json"),
			sidecar: createOfficialPredictionSidecar(customSidecarIdentity()),
			stats: {
				attempts: { answerGeneration: 0, answerJudge: 0 },
				successes: { answerGeneration: 0, answerJudge: 0 },
				failures: { answerGeneration: 0, answerJudge: 0 },
				unreliable: { answerGeneration: 0, answerJudge: 0 },
			},
			unavailable: [],
		}
	}

	it("resolves the exact custom-judge value and still refuses unknown values", () => {
		expect(
			resolveBenchmarkQaProtocol({
				MEMONGO_BENCHMARK_QA_PROTOCOL: "custom-judge",
			}),
		).toBe("custom-judge")
		expect(() =>
			resolveBenchmarkQaProtocol({ MEMONGO_BENCHMARK_QA_PROTOCOL: "luna" }),
		).toThrow(/MEMONGO_BENCHMARK_QA_PROTOCOL/)
	})

	it("accepts a non-pinned judge model for custom-judge while the official pin still refuses it", () => {
		const provider = resolveBenchmarkOfficialJudgeProvider(
			CUSTOM_JUDGE_ENV,
			"custom-judge",
		)
		expect(typeof provider.chatCompletion).toBe("function")
		expect(provider.name).toBe("http")
		expect(() =>
			resolveBenchmarkOfficialJudgeProvider(CUSTOM_JUDGE_ENV, "official"),
		).toThrow(new RegExp(OFFICIAL_LONGMEMEVAL_QA_JUDGE_MODEL))
	})

	it("requires each custom-judge judge env and names it", () => {
		for (const field of [
			"MEMONGO_BENCHMARK_JUDGE_API_KEY",
			"MEMONGO_BENCHMARK_JUDGE_BASE_URL",
			"MEMONGO_BENCHMARK_JUDGE_MODEL",
		] as const) {
			const env = { ...CUSTOM_JUDGE_ENV }
			delete env[field]
			expect(() =>
				resolveBenchmarkOfficialJudgeProvider(env, "custom-judge"),
			).toThrow(new RegExp(field))
		}
	})

	it("prepares a custom-judge run with the distinct sidecar protocol and a single answer preflight probe (B8-2)", async () => {
		const dir = await tempDir("custom-fresh")
		try {
			const answer = answerProvider()
			const judge = judgeProvider()
			const context = await prepareOfficialQa({
				env: CUSTOM_JUDGE_ENV,
				checkpointPath: path.join(dir, "checkpoint.json"),
				runId: "run-1",
				configurationHash: "b".repeat(64),
				datasetSha256: "a".repeat(64),
				resolveProviders: () => ({ answer, judge }),
			})
			expect(context.protocol).toBe("custom-judge")
			expect(context.sidecar.identity.judgeProtocol).toBe(
				"custom-judge-anscheck",
			)
			// B8-2: the preflight probes the answer provider once; the judge
			// provider is never called at preflight.
			expect(answer.calls).toHaveLength(1)
			expect(judge.calls).toHaveLength(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("refuses a cross-protocol resume (official sidecar vs custom-judge run) before any provider call", async () => {
		const dir = await tempDir("custom-xproto")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			await writeOfficialPredictionSidecarAtomic(
				sidecarPath,
				createOfficialPredictionSidecar(sidecarIdentity()),
			)
			const answer = answerProvider()
			const judge = judgeProvider()
			await expect(
				prepareOfficialQa({
					env: CUSTOM_JUDGE_ENV,
					checkpointPath: path.join(dir, "checkpoint.json"),
					runId: "run-1",
					configurationHash: "b".repeat(64),
					datasetSha256: "a".repeat(64),
					resolveProviders: () => ({ answer, judge }),
				}),
			).rejects.toThrow(/judgeProtocol/)
			expect(answer.calls).toHaveLength(0)
			expect(judge.calls).toHaveLength(0)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("summarizes a custom-judge run with a customJudge block, distinct export name, and no official block", async () => {
		const dir = await tempDir("custom-summary")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			const identity = customSidecarIdentity()
			let sidecar = createOfficialPredictionSidecar(identity)
			sidecar = recordOfficialAnswer(sidecar, "q-1", "violet")
			sidecar = recordOfficialVerdict(sidecar, "q-1", "yes")
			await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)
			const context = customContext(dir, answerProvider(), judgeProvider())
			context.sidecar = sidecar
			const { envelope } = await summarizeOfficialBenchmarkQaRun({
				context,
				scenarios: [
					scenarioFixture([
						{
							caseId: "q-1",
							query: "q1",
							answer: "violet",
							questionType: "single-session-user",
						},
					]),
				],
				coveredCaseIds: new Set(["q-1"]),
				datasetSha256: "a".repeat(64),
			})
			expect(envelope.official).toBeUndefined()
			expect(envelope.customJudge?.protocol).toBe("custom-judge-anscheck")
			expect(envelope.customJudge?.judgeModel).toBe(CUSTOM_JUDGE_MODEL)
			expect(envelope.customJudge?.coverage).toBe("full")
			expect(envelope.customJudge?.overallAccuracy).toBe(1)
			expect(envelope.customJudge?.export?.kind).toBe("sample")
			expect(envelope.customJudge?.export?.path).toContain(
				".export.custom-judge.sample.jsonl",
			)
			expect(envelope.judge).toBe(CUSTOM_JUDGE_MODEL)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("omits temperature on custom-judge judge calls while official keeps temperature 0 (same reviewed prompt, custom budget 1024 / official 10)", async () => {
		const customDir = await tempDir("custom-temp")
		try {
			const m = material("q-1")
			const customCtx = customContext(
				customDir,
				answerProvider(),
				judgeProvider(),
			)
			await scoreOfficialScenario({
				context: customCtx,
				scenarioId: "scenario-A",
				declaredCaseIds: ["q-1"],
				materialByCaseId: new Map([["q-1", m]]),
			})
			const customJudge = customCtx.judgeProvider as ReturnType<
				typeof judgeProvider
			>
			expect(customJudge.calls).toHaveLength(1)
			// Luna Foundry rejects temperature:0 with HTTP 400; the field must
			// be absent entirely on custom-judge judge calls.
			expect(customJudge.calls[0]?.temperature).toBeUndefined()
			// Custom-judge budget is 1024 (lead-verified shape); official stays
			// pinned at 10 below.
			expect(customJudge.calls[0]?.maxTokens).toBe(1024)

			const { context, dir } = await buildContext("official-temp")
			try {
				await scoreOfficialScenario({
					context,
					scenarioId: "scenario-A",
					declaredCaseIds: ["q-1"],
					materialByCaseId: new Map([["q-1", m]]),
				})
				const officialJudge = context.judgeProvider as ReturnType<
					typeof judgeProvider
				>
				expect(officialJudge.calls).toHaveLength(1)
				expect(officialJudge.calls[0]?.temperature).toBe(0)
				expect(officialJudge.calls[0]?.maxTokens).toBe(10)
				// Byte-exact same reviewed anscheck prompt under both protocols.
				expect(customJudge.calls[0]?.messages).toEqual(
					officialJudge.calls[0]?.messages,
				)
				const expected = buildOfficialAnscheckPrompt({
					questionType: "single-session-user",
					question: m.question,
					goldAnswer: m.goldAnswer,
					hypothesis: "violet",
					abstention: false,
				})
				expect(customJudge.calls[0]?.messages).toEqual([
					{ role: "user", content: expected },
				])
			} finally {
				await rm(dir, { recursive: true, force: true })
			}
		} finally {
			await rm(customDir, { recursive: true, force: true })
		}
	})
})
