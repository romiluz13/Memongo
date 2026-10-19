import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOperationRunContext } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import { main as b2JoinMain } from "./b2-join.js"
import { SYNTHETIC_BENCHMARK_HOST } from "./benchmark-run-configuration.fixture.js"
import { prepareOfficialQa } from "./longmemeval-official-scoring.js"
import { writeOfficialPredictionSidecarAtomic } from "./longmemeval-prediction-sidecar.js"
import {
	readBenchmarkCheckpoint,
	writeBenchmarkCheckpointAtomic,
} from "./mongodb-benchmark-checkpoint.js"
import { buildBenchmarkRunReport } from "./mongodb-benchmark-runner.js"
import { MongoDBManagerBenchmarkScenarioOps } from "./mongodb-manager-benchmark-scenario.js"

// Synthetic credential components. Each is unique and starts with "cnry", so a
// match cannot come from ordinary text, hex digests or identifiers. Some carry
// characters that change under JSON or percent encoding, so the escaped forms
// below are genuinely different strings.
const C = {
	enrichmentKey: "cnryEK7q2Lx",
	answerKey: 'cnryAK"q\\7Rm',
	judgeKey: "cnryJK4w9Zt",
	voyageKey: "cnryVK3n8Pd",
	enrichmentUser: "cnryEU5h1Bc",
	enrichmentPass: "cnryEP/9+Wv",
	enrichmentToken: "cnryET2k6Hs",
	enrichmentPath: "cnryEZ4d8Jn",
	answerUser: "cnryAU8m3Qj",
	answerPass: "cnryAP:4@Ny",
	answerToken: "cnryAT6r1Fg",
	answerPath: "cnryAZ2b5Mw",
	judgeUser: "cnryJU1s5Kd",
	judgePass: "cnryJP%7Ux",
	judgeToken: "cnryJT9v2Ce",
	judgePath: "cnryJZ7c3Lq",
	mongoUser: "cnryMU3t7Ab",
	mongoPass: "cnryMP#2Yz",
	mongoToken: "cnryMT5p8Gw",
}

function url(
	user: string,
	pass: string,
	segment: string,
	token: string,
	query = "api_key",
) {
	return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:9/${encodeURIComponent(segment)}/v1?${query}=${encodeURIComponent(token)}`
}

const URLS = {
	enrichment: url(
		C.enrichmentUser,
		C.enrichmentPass,
		C.enrichmentPath,
		C.enrichmentToken,
	),
	answer: url(C.answerUser, C.answerPass, C.answerPath, C.answerToken),
	judge: url(C.judgeUser, C.judgePass, C.judgePath, C.judgeToken, "key"),
	mongo: `mongodb://${encodeURIComponent(C.mongoUser)}:${encodeURIComponent(C.mongoPass)}@synthetic.invalid:27017/db?authSource=admin&tlsCertificateKeyFilePassword=${encodeURIComponent(C.mongoToken)}`,
}

// Synthetic fingerprint key; hex, so the detector also checks its case forms.
const FINGERPRINT_KEY = "c0ffee5e".repeat(8)

const ENV: Record<string, string> = {
	MEMONGO_BENCHMARK_FINGERPRINT_KEY: FINGERPRINT_KEY,
	MEMONGO_ENRICHMENT_API_KEY: C.enrichmentKey,
	MEMONGO_ENRICHMENT_BASE_URL: URLS.enrichment,
	MEMONGO_ENRICHMENT_MODEL: "enrich-model",
	MEMONGO_ENRICHMENT_ALLOW_PRIVATE_NETWORK: "true",
	MEMONGO_BENCHMARK_ANSWER_API_KEY: C.answerKey,
	MEMONGO_BENCHMARK_ANSWER_BASE_URL: URLS.answer,
	MEMONGO_BENCHMARK_ANSWER_MODEL: "answer-model",
	MEMONGO_BENCHMARK_ANSWER_ALLOW_PRIVATE_NETWORK: "true",
	MEMONGO_BENCHMARK_JUDGE_API_KEY: C.judgeKey,
	MEMONGO_BENCHMARK_JUDGE_BASE_URL: URLS.judge,
	MEMONGO_BENCHMARK_JUDGE_MODEL: "gpt-4o-2024-08-06",
	MEMONGO_BENCHMARK_QA_PROTOCOL: "official",
}

const HOST = {
	...SYNTHETIC_BENCHMARK_HOST,
	config: {
		mongodb: {
			...SYNTHETIC_BENCHMARK_HOST.config.mongodb,
			uri: URLS.mongo,
		},
	},
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/**
 * Every encoding of every component and full URL that would expose it,
 * including its unkeyed SHA-256, which anyone can confirm by guessing.
 */
function exposures(text: string): string[] {
	const found: string[] = []
	const values: Array<[string, string]> = [
		...Object.entries(C),
		...Object.entries(URLS).map(([name, value]): [string, string] => [
			`${name}Url`,
			value,
		]),
		["fingerprintKey", FINGERPRINT_KEY],
	]
	for (const [name, value] of values) {
		const forms = new Set([
			value,
			JSON.stringify(value).slice(1, -1),
			encodeURIComponent(value),
			encodeURIComponent(value).toLowerCase(),
			encodeURIComponent(encodeURIComponent(value)),
			sha256(value),
		])
		for (const form of forms)
			if (
				text.includes(form) ||
				text.toLowerCase().includes(form.toLowerCase())
			)
				found.push(name)
	}
	return [...new Set(found)]
}

const saved = { ...process.env }
const dirs: string[] = []
let fetchCalls = 0

beforeEach(() => {
	for (const key of Object.keys(process.env))
		if (key.startsWith("MEMONGO_")) delete process.env[key]
	Object.assign(process.env, ENV)
	fetchCalls = 0
	// Every provider request is answered here with a redirect: no request
	// leaves the process, and private-network mode skips DNS resolution.
	vi.stubGlobal("fetch", async () => {
		fetchCalls += 1
		return new Response(null, {
			status: 307,
			headers: { location: "https://elsewhere.invalid/" },
		})
	})
})

afterEach(async () => {
	vi.unstubAllGlobals()
	process.env = { ...saved }
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true })
})

describe("credential canary detector", () => {
	it("finds raw, JSON-escaped and percent-encoded credential output", () => {
		expect(exposures(`request to ${URLS.answer} failed`)).toContain("answerUrl")
		expect(exposures(JSON.stringify({ key: C.answerKey }))).toContain(
			"answerKey",
		)
		expect(exposures(`next=${encodeURIComponent(URLS.judge)}`)).toContain(
			"judgeUrl",
		)
		expect(exposures(`user ${C.mongoUser}`)).toEqual(["mongoUser"])
		expect(exposures(`password ${C.enrichmentPass}`)).toContain(
			"enrichmentPass",
		)
		expect(exposures(`{"fp":"${sha256(C.judgeKey)}"}`)).toEqual(["judgeKey"])
		expect(exposures(FINGERPRINT_KEY.toUpperCase())).toEqual(["fingerprintKey"])
	})

	it("does not flag digests, model names or the safe origin", () => {
		expect(
			exposures(
				'{"env.MEMONGO_BENCHMARK_ANSWER_API_KEY.hmac":"4f2a","model":"answer-model","origin":"http://127.0.0.1:9/v1"}',
			),
		).toEqual([])
	})
})

describe("benchmark artifacts and errors under synthetic credentials", () => {
	async function produceRun(dir: string, label: string) {
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
		const checkpointPath = path.join(dir, `${label}.json`)
		const ids = ["q0", "q1"]
		await writeBenchmarkCheckpointAtomic(checkpointPath, {
			version: 2,
			failedLines: 0,
			runId: runContext.runId,
			datasetSha256: "d".repeat(64),
			configurationHash: runContext.configurationHash,
			configuration: runContext.configuration,
			executableDigest: "e".repeat(64),
			totalScenarios: ids.length,
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
			datasetSha256: "d".repeat(64),
			resolveProviders: () => ({
				answer: {
					name: "stub",
					chatCompletion: async () => ({ content: "ok" }),
				},
				judge: {
					name: "stub",
					chatCompletion: async () => ({ content: "yes" }),
				},
			}),
		})
		await writeOfficialPredictionSidecarAtomic(qa.sidecarPath, {
			identity: qa.sidecar.identity,
			rows: Object.fromEntries(
				ids.map((id) => [
					id,
					{
						questionId: id,
						stage: "judged" as const,
						hypothesis: "h",
						verdict: "yes" as const,
						updatedAt: "2026-10-14T00:00:00.000Z",
					},
				]),
			),
		})
		return { checkpointPath, runContext }
	}

	async function filesUnder(dir: string): Promise<string> {
		const texts: string[] = []
		for (const name of await readdir(dir, { recursive: true }))
			texts.push(await readFile(path.join(dir, name), "utf8").catch(() => ""))
		return texts.join("\n")
	}

	it("keeps every credential out of manifests, checkpoints, sidecars and reports", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "credential-canary-"))
		dirs.push(dir)
		const { runContext } = await produceRun(dir, "a")
		const report = buildBenchmarkRunReport({
			datasetVersion: "v1",
			cases: 1,
			hitRate: 1,
			emptyRate: 0,
			avgTopScore: 1,
			p95LatencyMs: 1,
			runIdentity: {
				runId: runContext.runId,
				datasetSha256: "d".repeat(64),
				retrievalUnit: "session",
				configurationHash: runContext.configurationHash,
				executionProfile: runContext.configuration.executionProfile,
				retrievalLane: runContext.configuration.retrievalLane,
				maxResults: runContext.configuration.maxResults,
				minScore: runContext.configuration.minScore,
				settings: { ...runContext.configuration.settings },
			} as never,
		})
		// The fingerprints exist, so the manifest really was built from them.
		expect(
			runContext.configuration.settings[
				"env.MEMONGO_BENCHMARK_ANSWER_BASE_URL.hmac"
			],
		).toMatch(/^[0-9a-f]{64}$/)
		expect(runContext.configuration.settings.rerankerApiKeyHmac).toBeNull()
		const text = [
			JSON.stringify(runContext.configuration),
			JSON.stringify(report),
			await filesUnder(dir),
		].join("\n")
		expect(exposures(text)).toEqual([])
		expect(fetchCalls).toBe(0)
	})

	it("keeps every credential out of checkpoint refusals", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "credential-canary-"))
		dirs.push(dir)
		const { checkpointPath, runContext } = await produceRun(dir, "a")
		const messages: string[] = []
		for (const expected of [
			{ configurationHash: "f".repeat(64), executableDigest: "e".repeat(64) },
			{
				configurationHash: runContext.configurationHash,
				executableDigest: "f".repeat(64),
			},
		])
			await readBenchmarkCheckpoint(checkpointPath, {
				datasetSha256: "d".repeat(64),
				scenarioIds: ["q0", "q1"],
				...expected,
			}).catch((error: Error) => messages.push(error.message))
		expect(messages).toHaveLength(2)
		expect(messages[0]).toContain("configuration hash does not match")
		expect(messages[1]).toContain("executable digest does not match")
		expect(exposures(messages.join("\n"))).toEqual([])
	})

	it("keeps every credential out of b2-join output for runs that differ in them", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "credential-canary-"))
		dirs.push(dir)
		const a = await produceRun(dir, "a")
		process.env.MEMONGO_BENCHMARK_ANSWER_API_KEY = `${C.answerKey}2`
		process.env.MEMONGO_BENCHMARK_JUDGE_BASE_URL = `${URLS.judge}&x=1`
		const b = await produceRun(dir, "b")
		const output: string[] = []
		const capture = (message: unknown) => {
			output.push(String(message))
		}
		const spies = [
			vi.spyOn(console, "log").mockImplementation(capture),
			vi.spyOn(console, "error").mockImplementation(capture),
			vi.spyOn(console, "warn").mockImplementation(capture),
		]
		const previous = process.exitCode
		try {
			await b2JoinMain([
				"--a",
				a.checkpointPath,
				"--b",
				b.checkpointPath,
				"--assume-independent-questions",
			])
		} finally {
			for (const spy of spies) spy.mockRestore()
			process.exitCode = previous
		}
		expect(output.join("\n")).toContain("MEMONGO_BENCHMARK_ANSWER_API_KEY")
		expect(exposures(output.join("\n"))).toEqual([])
	})

	it("keeps a provider error body that echoes credentials out of the preflight failure", async () => {
		process.env.MEMONGO_BENCHMARK_ANSWER_BASE_URL = `http://127.0.0.1:9/${encodeURIComponent(C.answerPath)}/v1?api_key=${encodeURIComponent(C.answerToken)}`
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				fetchCalls += 1
				new Request(input, init)
				return new Response(
					JSON.stringify({
						error: {
							message: `Incorrect API key provided: ${C.answerKey} for ${String(input)}`,
						},
					}),
					{ status: 401 },
				)
			},
		)
		const dir = await mkdtemp(path.join(tmpdir(), "credential-canary-"))
		dirs.push(dir)
		const error = await prepareOfficialQa({
			env: process.env,
			checkpointPath: path.join(dir, "preflight.json"),
			runId: "run-preflight",
			configurationHash: "c".repeat(64),
			datasetSha256: "d".repeat(64),
		}).then(
			() => null,
			(failure: Error) => failure,
		)
		expect(error?.message).toContain("preflight failed")
		expect(error?.message).toContain("HTTP 401 (response body withheld)")
		expect(fetchCalls).toBe(1)
		const text = `${error?.message}\n${error?.stack}\n${JSON.stringify(error)}\n${await filesUnder(dir)}`
		expect(exposures(text)).toEqual([])
	})

	it.each([
		["embedded credentials, refused before any request", URLS.answer, 0],
		[
			"path and query tokens, refused on redirect",
			`http://127.0.0.1:9/${encodeURIComponent(C.answerPath)}/v1?api_key=${encodeURIComponent(C.answerToken)}`,
			1,
		],
	])("keeps every credential out of a provider preflight failure with %s", async (_name, answerUrl, minimumFetches) => {
		process.env.MEMONGO_BENCHMARK_ANSWER_BASE_URL = answerUrl
		const dir = await mkdtemp(path.join(tmpdir(), "credential-canary-"))
		dirs.push(dir)
		const checkpointPath = path.join(dir, "preflight.json")
		const error = await prepareOfficialQa({
			env: process.env,
			checkpointPath,
			runId: "run-preflight",
			configurationHash: "c".repeat(64),
			datasetSha256: "d".repeat(64),
		}).then(
			() => null,
			(failure: Error) => failure,
		)
		expect(error?.message).toContain("preflight failed")
		expect(error?.message).toContain("SSRF guard")
		expect(fetchCalls).toBeGreaterThanOrEqual(minimumFetches)
		if (minimumFetches === 0) expect(fetchCalls).toBe(0)
		const text = `${error?.message}\n${String(error?.cause ?? "")}\n${await filesUnder(dir)}`
		expect(exposures(text)).toEqual([])
	})
})
