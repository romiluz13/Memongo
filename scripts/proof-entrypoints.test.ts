import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const ROOT = resolve(import.meta.dirname, "..")
const SPAWN_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 2 * SPAWN_TIMEOUT_MS + 10_000

// Refuse every socket, DNS lookup and real fetch, then answer HTTP in-process.
const PRELOAD = `
import net from "node:net"
import tls from "node:tls"
import dns from "node:dns"
import { syncBuiltinESMExports } from "node:module"
const refuse = (name) => () => { throw new Error("offline test refused " + name) }
net.Socket.prototype.connect = refuse("net.Socket.connect")
net.connect = refuse("net.connect")
net.createConnection = refuse("net.createConnection")
tls.connect = refuse("tls.connect")
for (const target of [dns, dns.promises]) {
	for (const key of Object.keys(target)) {
		if (/^(lookup|resolve)/.test(key) && typeof target[key] === "function") target[key] = refuse("dns." + key)
	}
}
syncBuiltinESMExports()
const mode = process.env.RESPONDER_MODE
const baseMetadata = () => ({
	evidenceCoverage: "none",
	noDirectEvidenceReason: "no evidence",
	pathsExecuted: [],
	resultsByPath: {},
	constraintsApplied: [],
	resultsRejected: [],
	queryRewritten: false,
	reranked: false,
})
const noop = () => ({ ok: true, eventId: "e", id: "x", results: [], items: [], sections: [], metadata: baseMetadata() })
const found = (path, snippet, confidence) => {
	const metadata = baseMetadata()
	delete metadata.noDirectEvidenceReason
	return {
		results: [{ path, snippet, score: 0.9 }],
		metadata: { ...metadata, evidenceCoverage: "direct", trustSummary: { topConfidence: confidence } },
	}
}
function search(body) {
	const query = String(body.query ?? "").toLowerCase()
	const secondary = String(body.agentId ?? "").endsWith("-secondary")
	if (query.includes("red kite")) {
		if (secondary) return found("events/foreign-1", "The foreign launch codeword is Red Kite.", "high")
		const empty = { results: [], metadata: baseMetadata() }
		if (mode === "throttled") empty.metadata.throttled = { retryAfterMs: 500 }
		return empty
	}
	if (query.includes("release window"))
		return found("structured:decision/phoenix-release-window", "Phoenix deploys on Monday afternoon after validation.", "high")
	if (query.includes("rollback"))
		return found("events/main-3", "In this main thread, Marcus owns the Phoenix rollback.", "high")
	return { results: [], metadata: baseMetadata() }
}
function healthy(path, body) {
	switch (path) {
		case "/v1/search-detailed":
			return search(body)
		case "/v1/hydrate-active-slate":
			return {
				items: [
					{ kind: "active-critical", title: "Phoenix current blocker", summary: "Atlas Local preview validation is blocking the Phoenix launch." },
					{ kind: "procedure", title: "Phoenix rollback runbook", summary: "Check health dashboards" },
				],
			}
		case "/v1/discovery-projection":
			if (body.kind === "contradiction-report")
				return {
					title: "Contradiction report",
					summary: "",
					sections: [
						{ title: "Structured contradictions", summary: "Phoenix requires only Marcus approval.", evidence: [{ title: "approval", summary: "", path: "structured:fact/phoenix-approval-policy" }] },
						{ title: "Procedure contradictions", summary: "Skip proof lanes", evidence: [{ title: "contingency", summary: "", path: "procedure:phoenix-contingency" }] },
					],
				}
			return {
				title: "What changed",
				summary: "",
				sections: [
					{ title: "Structured changes", summary: "Phoenix deploys on Monday afternoon after validation.", evidence: [{ title: "window", summary: "", path: "structured:decision/phoenix-release-window" }] },
					{ title: "Procedure changes", summary: "Run proof-pack and capability stress", evidence: [{ title: "rollback", summary: "", path: "procedure:phoenix-rollback" }] },
				],
			}
		case "/v1/context-bundle":
			return {
				rendered: "",
				sections: [
					{ kind: "active-slate", title: "Active", summary: "Atlas Local preview validation is blocking the Phoenix launch.", items: [] },
					{ kind: "query-evidence", title: "Evidence", summary: "Phoenix deploys on Monday afternoon after validation.", items: [] },
					{ kind: "recent-events", title: "Recent", summary: "Marcus owns the Phoenix rollback.", items: [] },
				],
				metadata: { estimatedTokensUsed: 120, trustSummary: { topConfidence: "high" } },
			}
		default:
			return noop()
	}
}
globalThis.fetch = async (input, init) => {
	const url = new URL(typeof input === "string" ? input : input.url)
	const body = init?.body ? JSON.parse(String(init.body)) : {}
	const payload = mode === "noop" ? noop() : healthy(url.pathname, body)
	// A fixed service time keeps the p95 latency-ratio gate from comparing sub-millisecond noise.
	await new Promise((done) => setTimeout(done, 100))
	return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
}
`

type RunResult = { status: number | null; json: Record<string, unknown> }

let workDir: string
let preloadPath: string

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "proof-entrypoints-"))
	preloadPath = join(workDir, "preload.mjs")
	writeFileSync(preloadPath, PRELOAD)
})

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true })
})

function runEntrypoint(
	script: string,
	mode: "noop" | "healthy" | "throttled",
): RunResult {
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"./node_modules/tsx/dist/esm/index.mjs",
			"--import",
			preloadPath,
			script,
		],
		{
			cwd: ROOT,
			encoding: "utf8",
			timeout: SPAWN_TIMEOUT_MS,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: workDir,
				MEMONGO_API_URL: "http://synthetic.invalid",
				MEMONGO_BASELINE_API_URL: "http://baseline.invalid",
				MEMONGO_CANDIDATE_API_URL: "http://candidate.invalid",
				MEMONGO_PROOF_ARTIFACT_DIR: join(workDir, "art"),
				MEMONGO_EVAL_SEED: `entry-${mode}`,
				RESPONDER_MODE: mode,
			},
		},
	)
	const start = result.stdout.indexOf("{")
	if (start < 0) {
		throw new Error(
			`${script} printed no JSON (status ${result.status}): ${result.stderr}`,
		)
	}
	return {
		status: result.status,
		json: JSON.parse(result.stdout.slice(start)) as Record<string, unknown>,
	}
}

type CaseView = { id: string; ok: boolean; failures: string[] }

function failingCases(report: Record<string, unknown>): CaseView[] {
	return (report.cases as CaseView[]).filter((entry) => !entry.ok)
}

describe("real-memory-eval entrypoint", () => {
	it(
		"exits 1 with ok:false against a no-op backend",
		() => {
			const run = runEntrypoint("scripts/real-memory-eval.ts", "noop")
			expect(run.json.ok).toBe(false)
			expect(run.status).toBe(1)
		},
		TEST_TIMEOUT_MS,
	)

	it(
		"exits 0 with ok:true against a healthy backend",
		() => {
			const run = runEntrypoint("scripts/real-memory-eval.ts", "healthy")
			expect(failingCases(run.json)).toEqual([])
			expect(run.json.ok).toBe(true)
			expect(run.status).toBe(0)
		},
		TEST_TIMEOUT_MS,
	)

	it(
		"exits 1 when the abstention search is throttled",
		() => {
			const run = runEntrypoint("scripts/real-memory-eval.ts", "throttled")
			const abstention = (run.json.cases as CaseView[]).find(
				(entry) => entry.id === "no-scope-leak-red-kite",
			)
			expect(abstention?.ok).toBe(false)
			expect(abstention?.failures.join("\n")).toMatch(/throttled/)
			expect(run.json.ok).toBe(false)
			expect(run.status).toBe(1)
		},
		TEST_TIMEOUT_MS,
	)
})

type CompareReport = {
	baseline: Record<string, unknown>
	candidate: Record<string, unknown>
	comparison: { summary: { releaseReady: boolean } }
}

describe("compare-memory-eval entrypoint", () => {
	it(
		"exits 1 and is not release-ready when both sides are no-op",
		() => {
			const run = runEntrypoint("scripts/compare-memory-eval.ts", "noop")
			const report = run.json as unknown as CompareReport
			expect(report.comparison.summary.releaseReady).toBe(false)
			expect(run.status).toBe(1)
		},
		TEST_TIMEOUT_MS,
	)

	it(
		"exits 0 and is release-ready when both sides are healthy",
		() => {
			const run = runEntrypoint("scripts/compare-memory-eval.ts", "healthy")
			const report = run.json as unknown as CompareReport
			expect(failingCases(report.baseline)).toEqual([])
			expect(failingCases(report.candidate)).toEqual([])
			expect(report.comparison.summary.releaseReady).toBe(true)
			expect(run.status).toBe(0)
		},
		TEST_TIMEOUT_MS,
	)
})
