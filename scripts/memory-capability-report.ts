import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
	fixtureForCapability,
	type MemoryCapabilityId,
} from "./memory-capability-fixtures.js"

type JsonRecord = Record<string, unknown>

type BenchmarkTarget = {
	label: string
	cutoffs: Record<string, number>
}

type CutoffScore = {
	cutoff: string
	total: number
	correct: number
	accuracy: number
	targets: {
		label: string
		accuracy: number
		casesToBeat: number
		targetCorrectToBeat: number
		beatsTarget: boolean
	}[]
}

type CapabilityBlocker = {
	id: MemoryCapabilityId
	label: string
	severity: "critical" | "high" | "medium" | "watch"
	misses: number
	evidence: string[]
	mongoCapabilities: string[]
	fixtureId: string
	smallestFixture: string
	nextGate: string
	stopCondition: string
}

type MemoryCapabilityReport = {
	artifactPath: string
	missAnalysisPath: string
	generatedAt: string
	benchmark: "mem0-longmemeval"
	metadata: JsonRecord
	cutoffs: CutoffScore[]
	emptyRetrievals: number
	capabilities: CapabilityBlocker[]
	redFlags: string[]
	nextActions: string[]
	publicationStatus: "blocked" | "ready-to-rerun" | "beats-targets"
}

const mem0LongMemEvalTargets: BenchmarkTarget[] = [
	{
		label: "Mem0 committed platform",
		cutoffs: {
			top_50: 90.4,
			top_200: 93.4,
		},
	},
	{
		label: "Mem0 README",
		cutoffs: {
			top_50: 94.8,
			top_200: 94.4,
		},
	},
]

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {}
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : ""
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function counterValue(counter: JsonRecord, key: string): number {
	return asNumber(counter[key])
}

function targetCorrectToBeat(total: number, targetAccuracy: number): number {
	return Math.floor((targetAccuracy / 100) * total) + 1
}

function scoreCutoffs(
	artifact: JsonRecord,
	targets = mem0LongMemEvalTargets,
): CutoffScore[] {
	const metricsByCutoff = asRecord(artifact.metrics_by_cutoff)
	const cutoffOrder = new Map([
		["top_10", 10],
		["top_50", 50],
		["top_200", 200],
	])
	return Object.entries(metricsByCutoff)
		.map(([cutoff, rawMetric]) => {
			const overall = asRecord(asRecord(rawMetric).overall)
			const total = asNumber(overall.total)
			const correct = asNumber(overall.correct)
			const accuracy = asNumber(overall.accuracy)
			return {
				cutoff,
				total,
				correct,
				accuracy,
				targets: targets
					.filter((target) => typeof target.cutoffs[cutoff] === "number")
					.map((target) => {
						const targetAccuracy = target.cutoffs[cutoff] ?? 0
						const targetCorrect = targetCorrectToBeat(total, targetAccuracy)
						return {
							label: target.label,
							accuracy: targetAccuracy,
							casesToBeat: Math.max(0, targetCorrect - correct),
							targetCorrectToBeat: targetCorrect,
							beatsTarget: correct >= targetCorrect,
						}
					}),
			}
		})
		.sort((left, right) => {
			const leftOrder = cutoffOrder.get(left.cutoff) ?? Number.MAX_SAFE_INTEGER
			const rightOrder =
				cutoffOrder.get(right.cutoff) ?? Number.MAX_SAFE_INTEGER
			return leftOrder - rightOrder || left.cutoff.localeCompare(right.cutoff)
		})
}

function countEmptyRetrievals(artifact: JsonRecord): number {
	return asArray(artifact.evaluations).filter((evaluation) => {
		const retrieval = asRecord(asRecord(evaluation).retrieval)
		return asArray(retrieval.search_results).length === 0
	}).length
}

function cutoffRegression(cutoffs: CutoffScore[]): boolean {
	const top50 = cutoffs.find((score) => score.cutoff === "top_50")
	const top200 = cutoffs.find((score) => score.cutoff === "top_200")
	return Boolean(top50 && top200 && top200.accuracy < top50.accuracy)
}

function missCategoryCounts(missAnalysis: JsonRecord): JsonRecord {
	return asRecord(asRecord(missAnalysis.summary).byCategory)
}

function questionTypeCounts(missAnalysis: JsonRecord): JsonRecord {
	return asRecord(asRecord(missAnalysis.summary).byQuestionType)
}

function questionTypeMisses(questionTypes: JsonRecord, key: string): number {
	return counterValue(asRecord(questionTypes[key]), "misses")
}

function capabilityBlocker(
	input: Omit<
		CapabilityBlocker,
		"fixtureId" | "smallestFixture" | "mongoCapabilities" | "stopCondition"
	>,
): CapabilityBlocker {
	const fixture = fixtureForCapability(input.id)
	return {
		...input,
		fixtureId: fixture?.id ?? "fixture-missing",
		smallestFixture:
			fixture?.minimumScenario ??
			"Create a generic product fixture before rerunning the benchmark.",
		mongoCapabilities: fixture?.mongoCapabilities ?? [],
		stopCondition:
			fixture?.stopCondition ??
			"Stop if the fix requires question-id logic, gold-answer shortcuts, scorer edits, or hidden fallback.",
	}
}

function buildCapabilities(
	missAnalysis: JsonRecord,
	cutoffs: CutoffScore[],
	emptyRetrievals: number,
): CapabilityBlocker[] {
	const categories = missCategoryCounts(missAnalysis)
	const questionTypes = questionTypeCounts(missAnalysis)
	const capabilities: CapabilityBlocker[] = []
	const retrievalMisses = counterValue(categories, "retrieval-missing-evidence")
	const staleMisses = counterValue(categories, "stale-or-conflicting-evidence")
	const countMisses = counterValue(categories, "count-aggregation-failure")
	const ignoredEvidenceMisses = counterValue(
		categories,
		"answerer-ignored-present-evidence",
	)
	const distractedMisses = counterValue(
		categories,
		"context-distracted-by-extra-evidence",
	)
	const judgeAmbiguityMisses = counterValue(
		categories,
		"judge-or-answer-format-ambiguity",
	)
	const preferenceMisses = counterValue(
		categories,
		"preference-evidence-missing-or-buried",
	)
	const multiSessionMisses = questionTypeMisses(questionTypes, "multi-session")
	const temporalMisses = questionTypeMisses(questionTypes, "temporal-reasoning")
	const assistantMisses = questionTypeMisses(
		questionTypes,
		"single-session-assistant",
	)
	const totalCaseDeltaToCommitted = cutoffs.reduce((sum, cutoff) => {
		const committed = cutoff.targets.find(
			(target) => target.label === "Mem0 committed platform",
		)
		return sum + (committed?.casesToBeat ?? 0)
	}, 0)

	if (retrievalMisses > 0 || emptyRetrievals > 0) {
		capabilities.push(
			capabilityBlocker({
				id: "retrieval-coverage",
				label: "Retrieval coverage",
				severity: emptyRetrievals > 0 ? "critical" : "high",
				misses: retrievalMisses,
				evidence: [
					`${retrievalMisses} retrieval-missing-evidence cutoff misses`,
					`${emptyRetrievals} evaluation${emptyRetrievals === 1 ? "" : "s"} with zero retrieved memories`,
				],
				nextGate:
					"Run targeted retrieval coverage probes with score/rank evidence before any full LongMemEval rerun; answerer status must have zero empty retrievals.",
			}),
		)
	}

	if (multiSessionMisses > 0 || staleMisses > 0) {
		capabilities.push(
			capabilityBlocker({
				id: "multi-session-current-state",
				label: "Multi-session current-state memory",
				severity:
					multiSessionMisses >= 25 || staleMisses >= 25 ? "critical" : "high",
				misses: Math.max(multiSessionMisses, staleMisses),
				evidence: [
					`${multiSessionMisses} multi-session cutoff misses`,
					`${staleMisses} stale-or-conflicting-evidence cutoff misses`,
				],
				nextGate:
					"Prove source-date ordering, supersession, and conflict labels on generic multi-session fixtures before another official run.",
			}),
		)
	}

	if (countMisses > 0) {
		capabilities.push(
			capabilityBlocker({
				id: "count-current-state",
				label: "Count and aggregation memory",
				severity: "high",
				misses: countMisses,
				evidence: [`${countMisses} count-aggregation-failure cutoff misses`],
				nextGate:
					"Replace overconfident derived count answers with source-backed candidate lists, uncertainty/conflict labels, and high-confidence count gates.",
			}),
		)
	}

	if (
		ignoredEvidenceMisses > 0 ||
		distractedMisses > 0 ||
		cutoffRegression(cutoffs)
	) {
		capabilities.push(
			capabilityBlocker({
				id: "answer-context-packing",
				label: "Answer-context packing",
				severity: cutoffRegression(cutoffs) ? "high" : "medium",
				misses: ignoredEvidenceMisses + distractedMisses,
				evidence: [
					`${ignoredEvidenceMisses} answerer-ignored-present-evidence cutoff misses`,
					`${distractedMisses} context-distracted-by-extra-evidence cutoff misses`,
					cutoffRegression(cutoffs)
						? "top_200 scored below top_50, so more retrieved context made judging worse"
						: "top_200 did not regress below top_50",
				],
				nextGate:
					"Prove the answerer sees compact source-backed evidence without duplicate or conflicting snippets drowning the current answer.",
			}),
		)
	}

	if (temporalMisses > 0) {
		capabilities.push(
			capabilityBlocker({
				id: "temporal-reasoning",
				label: "Temporal ordering and recency",
				severity: temporalMisses >= 10 ? "high" : "medium",
				misses: temporalMisses,
				evidence: [`${temporalMisses} temporal-reasoning cutoff misses`],
				nextGate:
					"Prove event-date extraction, source-date preservation, and earliest/latest ordering on fixture conversations.",
			}),
		)
	}

	if (assistantMisses > 0) {
		capabilities.push(
			capabilityBlocker({
				id: "assistant-recall",
				label: "Assistant-side memory recall",
				severity: assistantMisses >= 10 ? "high" : "medium",
				misses: assistantMisses,
				evidence: [`${assistantMisses} single-session-assistant cutoff misses`],
				nextGate:
					"Prove assistant-authored facts remain retrievable without polluting user preference/current-state answers.",
			}),
		)
	}

	if (preferenceMisses > 0) {
		capabilities.push(
			capabilityBlocker({
				id: "preference-memory",
				label: "Preference memory",
				severity: "medium",
				misses: preferenceMisses,
				evidence: [`${preferenceMisses} preference-evidence cutoff misses`],
				nextGate:
					"Prove explicit preference facts keep user wording, timestamps, and source scope in answer context.",
			}),
		)
	}

	if (judgeAmbiguityMisses > 0) {
		capabilities.push(
			capabilityBlocker({
				id: "judge-contract",
				label: "Judge contract and answer format",
				severity: "watch",
				misses: judgeAmbiguityMisses,
				evidence: [
					`${judgeAmbiguityMisses} judge-or-answer-format-ambiguity misses`,
				],
				nextGate:
					"Keep retrieval and judged QA separated; do not rerun retrieval just to smooth judge instability.",
			}),
		)
	}

	if (totalCaseDeltaToCommitted > 0 && capabilities.length === 0) {
		capabilities.push(
			capabilityBlocker({
				id: "unexplained-target-gap",
				label: "Unexplained target gap",
				severity: "critical",
				misses: totalCaseDeltaToCommitted,
				evidence: [
					`${totalCaseDeltaToCommitted} additional correct cutoff cases are needed to beat committed Mem0 rows`,
				],
				nextGate:
					"Regenerate miss analysis before another benchmark run; a target gap without capability evidence is not publishable.",
			}),
		)
	}

	return capabilities.sort((left, right) => {
		const severityRank = { critical: 0, high: 1, medium: 2, watch: 3 }
		return (
			severityRank[left.severity] - severityRank[right.severity] ||
			right.misses - left.misses
		)
	})
}

function buildRedFlags(
	cutoffs: CutoffScore[],
	emptyRetrievals: number,
	capabilities: CapabilityBlocker[],
): string[] {
	const redFlags: string[] = []
	for (const cutoff of cutoffs) {
		for (const target of cutoff.targets) {
			if (!target.beatsTarget) {
				redFlags.push(
					`${cutoff.cutoff} needs ${target.casesToBeat} more correct cases to beat ${target.label} (${target.accuracy}%).`,
				)
			}
		}
	}
	if (emptyRetrievals > 0) {
		redFlags.push(
			`${emptyRetrievals} evaluation${emptyRetrievals === 1 ? "" : "s"} had empty retrievals; answerer artifact checks should remain failed until this is generically fixed.`,
		)
	}
	if (cutoffRegression(cutoffs)) {
		redFlags.push(
			"top_200 scored below top_50, which points to context dilution rather than a simple top-k shortage.",
		)
	}
	if (capabilities.some((capability) => capability.severity === "critical")) {
		redFlags.push(
			"At least one critical capability blocker remains; do not run a publication-scale competitor rerun yet.",
		)
	}
	return redFlags
}

function buildNextActions(capabilities: CapabilityBlocker[]): string[] {
	const actions = capabilities
		.filter((capability) => capability.severity !== "watch")
		.slice(0, 4)
		.map((capability) => capability.nextGate)
	actions.push(
		"Keep all fixes generic: no question-id logic, no gold-answer shortcuts, no scorer edits, and no competitor harness modifications beyond transport headers.",
	)
	actions.push(
		"After capability gates pass, rerun predict-only retrieval first, cleanup the exact prefix, then judge only from saved prediction artifacts.",
	)
	return [...new Set(actions)]
}

function publicationStatus(
	cutoffs: CutoffScore[],
	capabilities: CapabilityBlocker[],
	emptyRetrievals: number,
): MemoryCapabilityReport["publicationStatus"] {
	const beatsCommitted = cutoffs.every((cutoff) => {
		const committed = cutoff.targets.find(
			(target) => target.label === "Mem0 committed platform",
		)
		return committed?.beatsTarget ?? true
	})
	if (
		beatsCommitted &&
		capabilities.every((capability) => capability.severity === "watch")
	) {
		return emptyRetrievals === 0 ? "beats-targets" : "blocked"
	}
	if (
		emptyRetrievals === 0 &&
		!capabilities.some((capability) => capability.severity === "critical")
	) {
		return "ready-to-rerun"
	}
	return "blocked"
}

export function buildMemoryCapabilityReport(
	artifact: JsonRecord,
	missAnalysis: JsonRecord,
	artifactPath: string,
	missAnalysisPath: string,
	generatedAt = new Date().toISOString(),
): MemoryCapabilityReport {
	const cutoffs = scoreCutoffs(artifact)
	const emptyRetrievals = countEmptyRetrievals(artifact)
	const capabilities = buildCapabilities(missAnalysis, cutoffs, emptyRetrievals)
	const redFlags = buildRedFlags(cutoffs, emptyRetrievals, capabilities)
	return {
		artifactPath,
		missAnalysisPath,
		generatedAt,
		benchmark: "mem0-longmemeval",
		metadata: asRecord(artifact.metadata),
		cutoffs,
		emptyRetrievals,
		capabilities,
		redFlags,
		nextActions: buildNextActions(capabilities),
		publicationStatus: publicationStatus(
			cutoffs,
			capabilities,
			emptyRetrievals,
		),
	}
}

export function renderMemoryCapabilityMarkdown(
	report: MemoryCapabilityReport,
): string {
	const lines = [
		"# Memory Capability Report",
		"",
		`Artifact: \`${report.artifactPath}\``,
		`Miss analysis: \`${report.missAnalysisPath}\``,
		`Run ID: \`${asString(report.metadata.run_id) || "unknown"}\``,
		`Publication status: \`${report.publicationStatus}\``,
		"",
		"## Competitor Target Delta",
		"",
		"| Cutoff | Memongo | Target | Target Accuracy | Cases Needed To Beat | Status |",
		"| --- | ---: | --- | ---: | ---: | --- |",
	]
	for (const cutoff of report.cutoffs) {
		for (const target of cutoff.targets) {
			lines.push(
				`| ${cutoff.cutoff} | ${cutoff.correct}/${cutoff.total} (${cutoff.accuracy.toFixed(1)}%) | ${target.label} | ${target.accuracy.toFixed(1)}% | ${target.casesToBeat} | ${target.beatsTarget ? "beats" : "blocked"} |`,
			)
		}
	}

	lines.push(
		"",
		"## Capability Blockers",
		"",
		"| Capability | Severity | Misses | Evidence | Next Gate |",
		"| --- | --- | ---: | --- | --- |",
	)
	for (const capability of report.capabilities) {
		lines.push(
			`| ${capability.label} | ${capability.severity} | ${capability.misses} | ${capability.evidence.join("<br>")} | ${capability.nextGate} |`,
		)
	}

	lines.push(
		"",
		"## Product Fixture Gates",
		"",
		"| Capability | Fixture | MongoDB Capabilities | Stop Condition |",
		"| --- | --- | --- | --- |",
	)
	for (const capability of report.capabilities) {
		lines.push(
			`| ${capability.label} | ${capability.fixtureId}: ${capability.smallestFixture} | ${capability.mongoCapabilities.join("<br>") || "n/a"} | ${capability.stopCondition} |`,
		)
	}

	lines.push("", "## Red Flags", "")
	for (const redFlag of report.redFlags) {
		lines.push(`- ${redFlag}`)
	}

	lines.push("", "## Next Actions", "")
	for (const action of report.nextActions) {
		lines.push(`- ${action}`)
	}

	return `${lines.join("\n")}\n`
}

function parseArgs(argv: string[]): {
	artifactPath?: string
	missAnalysisPath?: string
	outDir?: string
	jsonOnly: boolean
} {
	let artifactPath: string | undefined
	let missAnalysisPath: string | undefined
	let outDir: string | undefined
	let jsonOnly = false
	for (const arg of argv) {
		if (arg === "--json") {
			jsonOnly = true
		} else if (arg.startsWith("--miss-analysis=")) {
			missAnalysisPath = arg.slice("--miss-analysis=".length)
		} else if (arg.startsWith("--out-dir=")) {
			outDir = arg.slice("--out-dir=".length)
		} else if (!arg.startsWith("--") && !artifactPath) {
			artifactPath = arg
		} else {
			throw new Error(`unknown argument: ${arg}`)
		}
	}
	return { artifactPath, missAnalysisPath, outDir, jsonOnly }
}

function readJson(path: string): JsonRecord {
	if (!existsSync(path)) {
		throw new Error(`artifact not found: ${path}`)
	}
	return JSON.parse(readFileSync(path, "utf8")) as JsonRecord
}

if (import.meta.main) {
	try {
		const { artifactPath, missAnalysisPath, outDir, jsonOnly } = parseArgs(
			process.argv.slice(2),
		)
		if (!artifactPath) {
			throw new Error(
				"usage: bun scripts/memory-capability-report.ts <longmemeval_results.json> --miss-analysis=answerer-miss-analysis.json [--out-dir=DIR] [--json]",
			)
		}
		const resolvedMissAnalysisPath =
			missAnalysisPath ??
			join(dirname(artifactPath), "answerer-miss-analysis.json")
		const artifact = readJson(artifactPath)
		const missAnalysis = readJson(resolvedMissAnalysisPath)
		const report = buildMemoryCapabilityReport(
			artifact,
			missAnalysis,
			artifactPath,
			resolvedMissAnalysisPath,
		)
		if (outDir) {
			mkdirSync(outDir, { recursive: true })
			writeFileSync(
				join(outDir, "memory-capability-report.json"),
				JSON.stringify(report, null, 2),
			)
			writeFileSync(
				join(outDir, "memory-capability-report.md"),
				renderMemoryCapabilityMarkdown(report),
			)
		} else if (jsonOnly) {
			console.log(JSON.stringify(report, null, 2))
		} else {
			console.log(renderMemoryCapabilityMarkdown(report))
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
