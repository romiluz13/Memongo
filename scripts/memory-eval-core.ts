import type {
	MemongoClient,
	MemongoSearchDetailedResponse,
} from "@memongo/client"
import {
	buildPhase6MemoryEvalFixture,
	type ContextBundleEvalCase,
	type DiscoveryProjectionEvalCase,
	type HydrateActiveSlateEvalCase,
	type MemoryEvalCase,
	type MemoryEvalFixture,
	type MemoryEvalSeedStep,
	type SearchDetailedEvalCase,
} from "../packages/memory-engine/src/test-helpers/memory-eval-fixtures.js"

type EvidenceCoverage = "none" | "indirect" | "partial" | "direct"
type TrustConfidence = "low" | "medium" | "high" | null

export type MemoryEvalCaseResult = {
	id: string
	title?: string
	kind?: MemoryEvalCase["kind"]
	tags?: string[]
	ok: boolean
	score: number
	failures: string[]
	metrics: {
		latencyMs: number
		scopeLeak: boolean
		staleFailure: boolean
		abstentionSuccess: boolean
		evidenceCoverage: EvidenceCoverage
		topConfidence: TrustConfidence
		exactEvidence: boolean
	}
}

export type MemoryEvalRunSummary = {
	label: string
	totalCases: number
	passedCases: number
	failedCases: number
	passRate: number
	averageScore: number
	exactEvidenceRate: number
	scopeLeakFailures: number
	staleFailures: number
	abstentionSuccesses: number
	averageLatencyMs: number
	p95LatencyMs: number
	evidenceCoverage: Record<EvidenceCoverage, number>
	topConfidence: Record<"high" | "medium" | "low" | "none", number>
}

export type MemoryEvalRun = {
	label: string
	fixtureId: string
	agentId: string
	sessionId: string
	cases: MemoryEvalCaseResult[]
	summary: MemoryEvalRunSummary
}

const EVIDENCE_RANK: Record<EvidenceCoverage, number> = {
	none: 0,
	indirect: 1,
	partial: 2,
	direct: 3,
}

const CONFIDENCE_RANK: Record<Exclude<TrustConfidence, null>, number> = {
	low: 1,
	medium: 2,
	high: 3,
}

function normalizeText(value: string): string {
	return value.trim().toLowerCase()
}

function clampScore(value: number): number {
	return Math.max(0, Math.min(1, value))
}

function percentile(values: number[], percentileRank: number): number {
	if (values.length === 0) {
		return 0
	}
	const sorted = [...values].sort((left, right) => left - right)
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1),
	)
	return sorted[index] ?? 0
}

function scoreFromChecks(checks: boolean[]): number {
	if (checks.length === 0) {
		return 1
	}
	const passed = checks.filter(Boolean).length
	return clampScore(passed / checks.length)
}

function inferTopConfidence(
	response: Pick<MemongoSearchDetailedResponse, "metadata">,
): TrustConfidence {
	return response.metadata.trustSummary?.topConfidence ?? null
}

function collectSearchText(response: {
	results?: Array<{ snippet?: string; path?: string }>
}): string {
	return (response.results ?? [])
		.flatMap((result) => [result.path ?? "", result.snippet ?? ""])
		.join("\n")
		.toLowerCase()
}

function collectActiveSlateText(response: {
	items?: Array<{ title?: string; summary?: string; kind?: string }>
}): string {
	return (response.items ?? [])
		.flatMap((item) => [item.kind ?? "", item.title ?? "", item.summary ?? ""])
		.join("\n")
		.toLowerCase()
}

function collectProjectionText(response: {
	title?: string
	summary?: string
	sections?: Array<{
		title?: string
		summary?: string
		evidence?: Array<{ title?: string; summary?: string; path?: string }>
	}>
}): string {
	return [
		response.title ?? "",
		response.summary ?? "",
		...(response.sections ?? []).flatMap((section) => [
			section.title ?? "",
			section.summary ?? "",
			...(section.evidence ?? []).flatMap((entry) => [
				entry.title ?? "",
				entry.summary ?? "",
				entry.path ?? "",
			]),
		]),
	]
		.join("\n")
		.toLowerCase()
}

function collectContextBundleText(response: {
	rendered?: string
	sections?: Array<{
		kind?: string
		title?: string
		summary?: string
		items?: Array<{ title?: string; summary?: string; path?: string }>
	}>
}): string {
	return [
		response.rendered ?? "",
		...(response.sections ?? []).flatMap((section) => [
			section.kind ?? "",
			section.title ?? "",
			section.summary ?? "",
			...(section.items ?? []).flatMap((item) => [
				item.title ?? "",
				item.summary ?? "",
				item.path ?? "",
			]),
		]),
	]
		.join("\n")
		.toLowerCase()
}

export function evaluateSearchDetailedCase(
	testCase: SearchDetailedEvalCase,
	response: Pick<MemongoSearchDetailedResponse, "results" | "metadata">,
	latencyMs: number,
): MemoryEvalCaseResult {
	const failures: string[] = []
	const checks: boolean[] = []
	const haystack = collectSearchText(response)
	const evidenceCoverage = response.metadata
		.evidenceCoverage as EvidenceCoverage
	const topConfidence = inferTopConfidence(response)
	const results = response.results ?? []

	if (testCase.expect.expectNoResults) {
		const ok = results.length === 0
		checks.push(ok)
		if (!ok) {
			failures.push("expected no results")
		}
	}

	if (testCase.expect.requireNoDirectEvidenceReason) {
		const ok = typeof response.metadata.noDirectEvidenceReason === "string"
		checks.push(ok)
		if (!ok) {
			failures.push("expected noDirectEvidenceReason")
		}
	}

	for (const phrase of testCase.expect.mustIncludeAll ?? []) {
		const ok = haystack.includes(normalizeText(phrase))
		checks.push(ok)
		if (!ok) {
			failures.push(`missing required text: ${phrase}`)
		}
	}

	for (const phrase of testCase.expect.mustExcludeAll ?? []) {
		const ok = !haystack.includes(normalizeText(phrase))
		checks.push(ok)
		if (!ok) {
			failures.push(`found disallowed text: ${phrase}`)
		}
	}

	if (testCase.expect.pathPrefixesAny?.length) {
		const ok = results.some((result) =>
			testCase.expect.pathPrefixesAny?.some((prefix) =>
				String(result.path ?? "").startsWith(prefix),
			),
		)
		checks.push(ok)
		if (!ok) {
			failures.push(
				`missing path prefix from set: ${testCase.expect.pathPrefixesAny.join(", ")}`,
			)
		}
	}

	if (testCase.expect.evidenceAtLeast) {
		const ok =
			EVIDENCE_RANK[evidenceCoverage] >=
			EVIDENCE_RANK[testCase.expect.evidenceAtLeast]
		checks.push(ok)
		if (!ok) {
			failures.push(
				`evidence coverage ${evidenceCoverage} below ${testCase.expect.evidenceAtLeast}`,
			)
		}
	}

	if (testCase.expect.topConfidenceAtLeast) {
		const actualRank =
			topConfidence === null ? 0 : CONFIDENCE_RANK[topConfidence]
		const requiredRank = CONFIDENCE_RANK[testCase.expect.topConfidenceAtLeast]
		const ok = actualRank >= requiredRank
		checks.push(ok)
		if (!ok) {
			failures.push(
				`top confidence ${topConfidence ?? "none"} below ${testCase.expect.topConfidenceAtLeast}`,
			)
		}
	}

	const ok = failures.length === 0
	return {
		id: testCase.id,
		title: testCase.title,
		kind: testCase.kind,
		tags: testCase.tags,
		ok,
		score: scoreFromChecks(checks),
		failures,
		metrics: {
			latencyMs,
			scopeLeak:
				testCase.tags?.includes("scope-isolation") === true &&
				failures.length > 0,
			staleFailure:
				testCase.tags?.includes("stale-supersession") === true &&
				failures.length > 0,
			abstentionSuccess: testCase.tags?.includes("abstention") === true && ok,
			evidenceCoverage,
			topConfidence,
			exactEvidence: evidenceCoverage === "direct",
		},
	}
}

function evaluateActiveSlateCase(
	testCase: HydrateActiveSlateEvalCase,
	response: {
		items?: Array<{ kind?: string; title?: string; summary?: string }>
	},
	latencyMs: number,
): MemoryEvalCaseResult {
	const failures: string[] = []
	const checks: boolean[] = []
	const haystack = collectActiveSlateText(response)
	const items = response.items ?? []

	if (typeof testCase.expect.maxItemsAtMost === "number") {
		const ok = items.length <= testCase.expect.maxItemsAtMost
		checks.push(ok)
		if (!ok) {
			failures.push(`returned ${items.length} items`)
		}
	}

	for (const kind of testCase.expect.mustIncludeKinds ?? []) {
		const ok = items.some((item) => item.kind === kind)
		checks.push(ok)
		if (!ok) {
			failures.push(`missing slate kind: ${kind}`)
		}
	}

	for (const phrase of testCase.expect.mustIncludeText ?? []) {
		const ok = haystack.includes(normalizeText(phrase))
		checks.push(ok)
		if (!ok) {
			failures.push(`missing slate text: ${phrase}`)
		}
	}

	const ok = failures.length === 0
	return {
		id: testCase.id,
		title: testCase.title,
		kind: testCase.kind,
		tags: testCase.tags,
		ok,
		score: scoreFromChecks(checks),
		failures,
		metrics: {
			latencyMs,
			scopeLeak: false,
			staleFailure: false,
			abstentionSuccess: false,
			evidenceCoverage: "none",
			topConfidence: null,
			exactEvidence: false,
		},
	}
}

function evaluateDiscoveryProjectionCase(
	testCase: DiscoveryProjectionEvalCase,
	response: {
		sections?: Array<{
			title?: string
			summary?: string
			evidence?: Array<{ path?: string }>
		}>
		title?: string
		summary?: string
	},
	latencyMs: number,
): MemoryEvalCaseResult {
	const failures: string[] = []
	const checks: boolean[] = []
	const haystack = collectProjectionText(response)
	const sectionTitles = (response.sections ?? []).map((section) =>
		String(section.title ?? ""),
	)
	const evidencePaths = (response.sections ?? []).flatMap((section) =>
		(section.evidence ?? []).map((entry) => String(entry.path ?? "")),
	)

	for (const title of testCase.expect.mustIncludeSectionTitles ?? []) {
		const ok = sectionTitles.some((value) => value === title)
		checks.push(ok)
		if (!ok) {
			failures.push(`missing section title: ${title}`)
		}
	}

	for (const phrase of testCase.expect.mustIncludeText ?? []) {
		const ok = haystack.includes(normalizeText(phrase))
		checks.push(ok)
		if (!ok) {
			failures.push(`missing projection text: ${phrase}`)
		}
	}

	if (testCase.expect.pathPrefixesAny?.length) {
		const ok = evidencePaths.some((path) =>
			testCase.expect.pathPrefixesAny?.some((prefix) =>
				path.startsWith(prefix),
			),
		)
		checks.push(ok)
		if (!ok) {
			failures.push(
				`missing projection path prefix from set: ${testCase.expect.pathPrefixesAny.join(", ")}`,
			)
		}
	}

	const ok = failures.length === 0
	return {
		id: testCase.id,
		title: testCase.title,
		kind: testCase.kind,
		tags: testCase.tags,
		ok,
		score: scoreFromChecks(checks),
		failures,
		metrics: {
			latencyMs,
			scopeLeak: false,
			staleFailure: false,
			abstentionSuccess: false,
			evidenceCoverage: "none",
			topConfidence: null,
			exactEvidence: false,
		},
	}
}

function evaluateContextBundleCase(
	testCase: ContextBundleEvalCase,
	response: {
		rendered?: string
		sections?: Array<{
			kind?: string
			title?: string
			summary?: string
			items?: Array<{ title?: string; summary?: string; path?: string }>
		}>
		metadata?: {
			estimatedTokensUsed?: number
			trustSummary?: {
				topConfidence?: "low" | "medium" | "high" | null
			}
		}
	},
	latencyMs: number,
): MemoryEvalCaseResult {
	const failures: string[] = []
	const checks: boolean[] = []
	const haystack = collectContextBundleText(response)
	const sectionKinds = (response.sections ?? []).map((section) =>
		String(section.kind ?? ""),
	)
	const topConfidence = response.metadata?.trustSummary?.topConfidence ?? null
	const evidenceCoverage = sectionKinds.includes("query-evidence")
		? "direct"
		: "none"

	for (const kind of testCase.expect.mustIncludeSectionKinds ?? []) {
		const ok = sectionKinds.includes(kind)
		checks.push(ok)
		if (!ok) {
			failures.push(`missing bundle section: ${kind}`)
		}
	}

	for (const phrase of testCase.expect.mustIncludeText ?? []) {
		const ok = haystack.includes(normalizeText(phrase))
		checks.push(ok)
		if (!ok) {
			failures.push(`missing bundle text: ${phrase}`)
		}
	}

	for (const phrase of testCase.expect.mustExcludeText ?? []) {
		const ok = !haystack.includes(normalizeText(phrase))
		checks.push(ok)
		if (!ok) {
			failures.push(`found disallowed bundle text: ${phrase}`)
		}
	}

	if (typeof testCase.expect.maxTokensAtMost === "number") {
		const used =
			response.metadata?.estimatedTokensUsed ?? Number.POSITIVE_INFINITY
		const ok = used <= testCase.expect.maxTokensAtMost
		checks.push(ok)
		if (!ok) {
			failures.push(
				`bundle used ${used} tokens, expected at most ${testCase.expect.maxTokensAtMost}`,
			)
		}
	}

	const ok = failures.length === 0
	return {
		id: testCase.id,
		title: testCase.title,
		kind: testCase.kind,
		tags: testCase.tags,
		ok,
		score: scoreFromChecks(checks),
		failures,
		metrics: {
			latencyMs,
			scopeLeak:
				testCase.tags?.includes("scope-isolation") === true &&
				failures.length > 0,
			staleFailure:
				testCase.tags?.includes("stale-supersession") === true &&
				failures.length > 0,
			abstentionSuccess: false,
			evidenceCoverage,
			topConfidence,
			exactEvidence: evidenceCoverage === "direct",
		},
	}
}

async function executeSeedStep(
	client: MemongoClient,
	step: MemoryEvalSeedStep,
): Promise<void> {
	switch (step.kind) {
		case "write-event":
			await client.writeEvent({
				agentId: step.agentId,
				sessionId: step.sessionId,
				role: step.role,
				body: step.body,
				timestamp: step.timestamp,
				scope: step.scope,
			})
			return
		case "write-structured":
			await client.writeStructured({
				agentId: step.agentId,
				entry: step.entry,
			})
			return
		case "write-procedure":
			await client.writeProcedure({
				agentId: step.agentId,
				entry: step.entry,
			})
			return
	}
}

async function runCase(
	client: MemongoClient,
	testCase: MemoryEvalCase,
): Promise<MemoryEvalCaseResult> {
	const startedAt = Date.now()

	switch (testCase.kind) {
		case "search-detailed": {
			const response = await client.searchDetailed(testCase.request)
			return evaluateSearchDetailedCase(
				testCase,
				response,
				Date.now() - startedAt,
			)
		}
		case "hydrate-active-slate": {
			const response = await client.hydrateActiveSlate(testCase.request)
			return evaluateActiveSlateCase(testCase, response, Date.now() - startedAt)
		}
		case "discovery-projection": {
			const response = await client.buildDiscoveryProjection(testCase.request)
			return evaluateDiscoveryProjectionCase(
				testCase,
				response,
				Date.now() - startedAt,
			)
		}
		case "context-bundle": {
			const response = await client.buildContextBundle(testCase.request)
			return evaluateContextBundleCase(
				testCase,
				response,
				Date.now() - startedAt,
			)
		}
	}
}

export function summarizeEvalRun(params: {
	label: string
	cases: MemoryEvalCaseResult[]
}): MemoryEvalRunSummary {
	const cases = params.cases
	const totalCases = cases.length
	const passedCases = cases.filter((entry) => entry.ok).length
	const failedCases = totalCases - passedCases
	const evidenceCoverage: Record<EvidenceCoverage, number> = {
		none: 0,
		indirect: 0,
		partial: 0,
		direct: 0,
	}
	const topConfidence = {
		high: 0,
		medium: 0,
		low: 0,
		none: 0,
	}

	for (const entry of cases) {
		evidenceCoverage[entry.metrics.evidenceCoverage] += 1
		if (entry.metrics.topConfidence === null) {
			topConfidence.none += 1
		} else {
			topConfidence[entry.metrics.topConfidence] += 1
		}
	}

	const latencies = cases.map((entry) => entry.metrics.latencyMs)
	return {
		label: params.label,
		totalCases,
		passedCases,
		failedCases,
		passRate: totalCases === 0 ? 0 : passedCases / totalCases,
		averageScore:
			totalCases === 0
				? 0
				: cases.reduce((sum, entry) => sum + entry.score, 0) / totalCases,
		exactEvidenceRate:
			totalCases === 0
				? 0
				: cases.filter((entry) => entry.metrics.exactEvidence).length /
					totalCases,
		scopeLeakFailures: cases.filter((entry) => entry.metrics.scopeLeak).length,
		staleFailures: cases.filter((entry) => entry.metrics.staleFailure).length,
		abstentionSuccesses: cases.filter(
			(entry) => entry.metrics.abstentionSuccess,
		).length,
		averageLatencyMs:
			latencies.length === 0
				? 0
				: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
		p95LatencyMs: percentile(latencies, 95),
		evidenceCoverage,
		topConfidence,
	}
}

export function compareEvalRuns(params: {
	baseline: MemoryEvalRunSummary
	candidate: MemoryEvalRunSummary
}): {
	baseline: MemoryEvalRunSummary
	candidate: MemoryEvalRunSummary
	summary: {
		scoreDelta: number
		passRateDelta: number
		exactEvidenceDelta: number
		scopeLeakDelta: number
		staleFailureDelta: number
		abstentionDelta: number
		latencyRatio: number
		releaseReady: boolean
	}
} {
	const { baseline, candidate } = params
	const latencyRatio =
		baseline.p95LatencyMs <= 0
			? candidate.p95LatencyMs <= 0
				? 1
				: Number.POSITIVE_INFINITY
			: candidate.p95LatencyMs / baseline.p95LatencyMs
	const summary = {
		scoreDelta: candidate.averageScore - baseline.averageScore,
		passRateDelta: candidate.passRate - baseline.passRate,
		exactEvidenceDelta:
			candidate.exactEvidenceRate - baseline.exactEvidenceRate,
		scopeLeakDelta: candidate.scopeLeakFailures - baseline.scopeLeakFailures,
		staleFailureDelta: candidate.staleFailures - baseline.staleFailures,
		abstentionDelta:
			candidate.abstentionSuccesses - baseline.abstentionSuccesses,
		latencyRatio,
		releaseReady:
			candidate.scopeLeakFailures === 0 &&
			candidate.staleFailures <= baseline.staleFailures &&
			candidate.averageScore >= baseline.averageScore &&
			candidate.passRate >= baseline.passRate &&
			candidate.exactEvidenceRate >= baseline.exactEvidenceRate &&
			latencyRatio <= 1.25,
	}

	return {
		baseline,
		candidate,
		summary,
	}
}

export async function runMemoryEvalSuite(params: {
	client: MemongoClient
	label: string
	seed?: string
	fixture?: MemoryEvalFixture
}): Promise<MemoryEvalRun> {
	const fixture =
		params.fixture ?? buildPhase6MemoryEvalFixture(params.seed ?? params.label)

	for (const step of fixture.seed) {
		await executeSeedStep(params.client, step)
	}

	const cases: MemoryEvalCaseResult[] = []
	for (const testCase of fixture.cases) {
		cases.push(await runCase(params.client, testCase))
	}

	return {
		label: params.label,
		fixtureId: fixture.id,
		agentId: fixture.primaryAgentId,
		sessionId: fixture.primarySessionId,
		cases,
		summary: summarizeEvalRun({
			label: params.label,
			cases,
		}),
	}
}
