import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

type JsonRecord = Record<string, unknown>

export type BenchmarkStatusOptions = {
	strictWarnings?: boolean
	requireFullUnlock?: boolean
	requirePublishableEnvelope?: boolean
}

export type BenchmarkStatus = {
	ok: boolean
	fullUnlockOk: boolean
	artifactPath?: string
	runId?: string
	cases: number
	scoredCases: number | null
	internalRAt5: number | null
	internalRAt10: number | null
	emptyRate: number | null
	sessionRecallAnyAt5: number | null
	warnings: string[]
	degradations: string[]
	failures: string[]
	notes: string[]
}

const DEFAULT_ARTIFACT_ROOT = path.join(
	process.cwd(),
	".claude",
	"cc10x",
	"v10",
	"workflows",
	"memongo-memory-hardening",
	"artifacts",
)

const ARTIFACT_FILENAMES = new Set([
	"benchmark-response.json",
	"canary-artifact.json",
])

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {}
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter(Boolean)
		: []
}

function readNestedRecord(
	root: JsonRecord,
	pathSegments: string[],
): JsonRecord {
	let current: unknown = root
	for (const segment of pathSegments) {
		current = asRecord(current)[segment]
	}
	return asRecord(current)
}

function readNestedNumber(
	root: JsonRecord,
	pathSegments: string[],
): number | null {
	let current: unknown = root
	for (const segment of pathSegments) {
		current = asRecord(current)[segment]
	}
	return asNumber(current)
}

function findBenchmarkReport(payload: JsonRecord): JsonRecord {
	const direct = asRecord(payload.benchmarkReport)
	if (Object.keys(direct).length > 0) return direct
	const response = asRecord(payload.benchmarkResponse)
	const nested = asRecord(response.benchmarkReport)
	if (Object.keys(nested).length > 0) return nested
	const metrics = asRecord(payload.metrics)
	return Object.keys(metrics).length > 0 ? metrics : {}
}

function findBenchmarkResponse(payload: JsonRecord): JsonRecord {
	const response = asRecord(payload.benchmarkResponse)
	return Object.keys(response).length > 0 ? response : payload
}

function hasRequiredEnvelope(report: JsonRecord): string[] {
	const missing: string[] = []
	for (const key of [
		"runIdentity",
		"embedding",
		"reranker",
		"storage",
		"latency",
		"cost",
	]) {
		if (Object.keys(asRecord(report[key])).length === 0) {
			missing.push(key)
		}
	}
	return missing
}

function perTypeUnlockFailures(response: JsonRecord): string[] {
	const perType = Array.isArray(response.questionTypeBreakdown)
		? response.questionTypeBreakdown
		: []
	const failures: string[] = []
	for (const raw of perType) {
		const entry = asRecord(raw)
		const questionType =
			typeof entry.questionType === "string" ? entry.questionType : "unknown"
		const rAt5 = asNumber(entry.rAt5)
		if (rAt5 !== null && rAt5 < 0.75) {
			failures.push(`${questionType} R@5=${rAt5.toFixed(4)} < 0.7500`)
		}
	}
	return failures
}

export function evaluateBenchmarkStatus(
	payload: JsonRecord,
	options: BenchmarkStatusOptions = {},
	artifactPath?: string,
): BenchmarkStatus {
	const strictWarnings = options.strictWarnings ?? true
	const requirePublishableEnvelope = options.requirePublishableEnvelope ?? true
	const report = findBenchmarkReport(payload)
	const response = findBenchmarkResponse(payload)
	const corpus = asRecord(report.corpus)
	const internal = readNestedRecord(report, ["metrics", "internal"])
	const official = readNestedRecord(report, ["metrics", "official"])
	const longMemEval = asRecord(official.longMemEval)
	const sessionMetrics = asRecord(longMemEval.session)
	const warnings = asStringArray(report.warnings)
	const degradations = asStringArray(report.degradations)
	const failures: string[] = []
	const notes: string[] = []
	const cases =
		asNumber(corpus.cases) ?? asNumber(payload.totalEvaluations) ?? 0
	const scoredCases = asNumber(corpus.scoredCases)
	const internalRAt5 = asNumber(internal.rAt5)
	const internalRAt10 = asNumber(internal.rAt10)
	const emptyRate = asNumber(internal.emptyRate)
	const sessionRecallAnyAt5 = asNumber(sessionMetrics.recallAnyAt5)
	const runId =
		typeof payload.runId === "string"
			? payload.runId
			: typeof response.runId === "string"
				? response.runId
				: undefined

	if (Object.keys(report).length === 0) {
		failures.push("benchmarkReport missing")
	}
	if (typeof payload.error === "string" && payload.error.trim()) {
		failures.push(`artifact error: ${payload.error.trim()}`)
	}
	if (typeof payload.status === "string" && payload.status !== "completed") {
		failures.push(`artifact status=${payload.status}`)
	}
	if (cases <= 0) {
		failures.push("cases=0")
	}
	if (scoredCases === null) {
		failures.push("scoredCases missing")
	} else if (cases > 0 && scoredCases !== cases) {
		failures.push(`scoredCases=${scoredCases}/${cases}`)
	}
	if (emptyRate === null) {
		failures.push("emptyRate missing")
	} else if (emptyRate > 0) {
		failures.push(`emptyRate=${emptyRate.toFixed(4)}`)
	}
	if (degradations.length > 0) {
		failures.push(`degradations present: ${degradations.join("; ")}`)
	}
	if (strictWarnings && warnings.length > 0) {
		failures.push(`warnings present: ${warnings.join("; ")}`)
	}
	const build = asRecord(report.build)
	if (build.source !== "env") {
		failures.push("build identity missing env commit/build id")
	}
	const missingEnvelope = hasRequiredEnvelope(report)
	if (requirePublishableEnvelope && missingEnvelope.length > 0) {
		failures.push(`publishable envelope missing: ${missingEnvelope.join(", ")}`)
	}
	if (!Array.isArray(response.missLedger)) {
		failures.push("missLedger missing")
	}
	if (!Array.isArray(response.caseDiagnostics)) {
		failures.push("caseDiagnostics missing")
	}

	const fullUnlockFailures: string[] = []
	if (cases < 48) {
		fullUnlockFailures.push(
			`cases=${cases} < 48-case canary unlock minimum`,
		)
	}
	if (internalRAt5 === null || internalRAt5 < 0.85) {
		fullUnlockFailures.push(
			`internal R@5=${internalRAt5?.toFixed(4) ?? "missing"} < 0.8500`,
		)
	}
	if (sessionRecallAnyAt5 === null || sessionRecallAnyAt5 < 0.9) {
		fullUnlockFailures.push(
			`session RecallAny@5=${sessionRecallAnyAt5?.toFixed(4) ?? "missing"} < 0.9000`,
		)
	}
	fullUnlockFailures.push(...perTypeUnlockFailures(response))
	if (fullUnlockFailures.length > 0) {
		notes.push(`full-500 locked: ${fullUnlockFailures.join("; ")}`)
	}
	if (options.requireFullUnlock && fullUnlockFailures.length > 0) {
		failures.push(...fullUnlockFailures)
	}

	return {
		ok: failures.length === 0,
		fullUnlockOk: fullUnlockFailures.length === 0,
		...(artifactPath ? { artifactPath } : {}),
		...(runId ? { runId } : {}),
		cases,
		scoredCases,
		internalRAt5,
		internalRAt10,
		emptyRate,
		sessionRecallAnyAt5,
		warnings,
		degradations,
		failures,
		notes,
	}
}

function findArtifactFiles(root: string): string[] {
	if (!existsSync(root)) return []
	const found: string[] = []
	const visit = (dir: string, depth: number) => {
		if (depth > 6) return
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const filePath = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git") continue
				visit(filePath, depth + 1)
				continue
			}
			if (entry.isFile() && ARTIFACT_FILENAMES.has(entry.name)) {
				found.push(filePath)
			}
		}
	}
	visit(root, 0)
	return found
}

function latestArtifact(root: string): string | null {
	const candidates = findArtifactFiles(root)
	if (candidates.length === 0) return null
	return candidates.toSorted((a, b) => {
		const aTime = statSync(a).mtimeMs
		const bTime = statSync(b).mtimeMs
		return bTime - aTime
	})[0]
}

export function parseArgs(argv: string[]): {
	artifactPath?: string
	root: string
	json: boolean
	options: BenchmarkStatusOptions
} {
	let artifactPath: string | undefined
	let root =
		process.env.MEMONGO_BENCHMARK_STATUS_DIR?.trim() || DEFAULT_ARTIFACT_ROOT
	let json = false
	const options: BenchmarkStatusOptions = {
		strictWarnings: process.env.MEMONGO_BENCHMARK_STATUS_ALLOW_WARNINGS !== "1",
		requireFullUnlock:
			process.env.MEMONGO_BENCHMARK_STATUS_REQUIRE_FULL_UNLOCK === "1",
		requirePublishableEnvelope:
			process.env.MEMONGO_BENCHMARK_STATUS_ALLOW_PARTIAL_ENVELOPE !== "1",
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--artifact" && argv[i + 1]) {
			artifactPath = argv[++i]
		} else if (arg === "--root" && argv[i + 1]) {
			root = argv[++i]
		} else if (arg === "--json") {
			json = true
		} else if (arg === "--allow-warnings") {
			options.strictWarnings = false
		} else if (arg === "--require-full-unlock") {
			options.requireFullUnlock = true
		} else if (arg === "--allow-partial-envelope") {
			options.requirePublishableEnvelope = false
		} else if (!arg.startsWith("-") && artifactPath === undefined) {
			artifactPath = arg
		}
	}
	return { artifactPath, root, json, options }
}

function renderStatus(status: BenchmarkStatus): string {
	const lines = [
		`benchmark:status ${status.ok ? "PASS" : "FAIL"}`,
		`artifact: ${status.artifactPath ?? "not found"}`,
		`runId: ${status.runId ?? "unknown"}`,
		`cases: ${status.scoredCases ?? "?"}/${status.cases}`,
		`internal R@5: ${status.internalRAt5?.toFixed(4) ?? "missing"}`,
		`internal R@10: ${status.internalRAt10?.toFixed(4) ?? "missing"}`,
		`session RecallAny@5: ${status.sessionRecallAnyAt5?.toFixed(4) ?? "missing"}`,
		`emptyRate: ${status.emptyRate?.toFixed(4) ?? "missing"}`,
		`full-500 unlock: ${status.fullUnlockOk ? "PASS" : "LOCKED"}`,
	]
	if (status.failures.length > 0) {
		lines.push("failures:")
		for (const failure of status.failures) lines.push(`- ${failure}`)
	}
	if (status.notes.length > 0) {
		lines.push("notes:")
		for (const note of status.notes) lines.push(`- ${note}`)
	}
	return lines.join("\n")
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2))
	const artifactPath = parsed.artifactPath ?? latestArtifact(parsed.root)
	if (!artifactPath) {
		const status: BenchmarkStatus = {
			ok: false,
			fullUnlockOk: false,
			cases: 0,
			scoredCases: null,
			internalRAt5: null,
			internalRAt10: null,
			emptyRate: null,
			sessionRecallAnyAt5: null,
			warnings: [],
			degradations: [],
			failures: [`no benchmark artifact found under ${parsed.root}`],
			notes: [],
		}
		console.log(
			parsed.json ? JSON.stringify(status, null, 2) : renderStatus(status),
		)
		process.exitCode = 1
		return
	}

	const payload = JSON.parse(readFileSync(artifactPath, "utf8")) as JsonRecord
	const status = evaluateBenchmarkStatus(payload, parsed.options, artifactPath)
	console.log(
		parsed.json ? JSON.stringify(status, null, 2) : renderStatus(status),
	)
	process.exitCode = status.ok ? 0 : 1
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err))
		process.exitCode = 1
	})
}
