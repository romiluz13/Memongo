/**
 * Comparison eligibility for b2-join inference (B06). Inference is offered
 * only when both runs carry bound identity, differ in at most one declared
 * directly observed scalar treatment, cover the same complete declared
 * population with one case per scenario, and the caller declares the
 * question-level independence assumption (recorded, never verified).
 *
 * executableDigest is an opaque digest: a difference cannot show that only
 * one setting changed, so it must match and is never a treatment. Configuration
 * is compared fieldwise through the hash-bound manifest each checkpoint
 * persists; a treatment may change only the manifest keys it owns.
 */
import { readFile } from "node:fs/promises"
import type { OperationRunConfiguration } from "../../packages/memory-engine/src/mongodb-operation-accounting.js"
import type { RunQuestionMetrics } from "./b2-join.js"
import { parseBoundRunConfiguration } from "./mongodb-benchmark-checkpoint.js"

export const B2_TREATMENT_FIELDS = [
	"answerModel",
	"judgeModel",
	"judgeProtocol",
	"promptVersion",
	"answerPromptVersion",
	"answerTemperature",
	"answerMaxTokens",
] as const

export type B2TreatmentField = (typeof B2_TREATMENT_FIELDS)[number]

export function isB2TreatmentField(value: string): value is B2TreatmentField {
	return (B2_TREATMENT_FIELDS as readonly string[]).includes(value)
}

type Settings = OperationRunConfiguration["settings"]

const DURABLE_PROTOCOL_LABELS: Record<string, string> = {
	official: "official-anscheck",
	"custom-judge": "custom-judge-anscheck",
}

function durableProtocolLabel(value: unknown): string | null {
	return typeof value === "string" &&
		Object.hasOwn(DURABLE_PROTOCOL_LABELS, value)
		? DURABLE_PROTOCOL_LABELS[value]
		: null
}

/**
 * Manifest keys each treatment may change, and the precondition under which
 * that change is the only effective difference. The answerer falls back to
 * the enrichment provider, whose model also drives ingestion, so only a
 * dedicated answerer isolates an answer-model change. Treatments without an
 * entry are source constants: source treatments are deferred.
 */
const TREATMENT_OWNERSHIP: Partial<
	Record<
		B2TreatmentField,
		{ keys: string[]; precondition: (settings: Settings) => string | null }
	>
> = {
	answerModel: {
		keys: ["settings.env.MEMONGO_BENCHMARK_ANSWER_MODEL"],
		precondition: (settings) =>
			settings.answerProviderSource === "dedicated"
				? null
				: "requires a dedicated answer provider in both runs; the enrichment-fallback model also drives ingestion",
	},
	judgeModel: {
		keys: ["settings.env.MEMONGO_BENCHMARK_JUDGE_MODEL"],
		precondition: () => null,
	},
	judgeProtocol: {
		keys: ["settings.env.MEMONGO_BENCHMARK_QA_PROTOCOL"],
		precondition: (settings) =>
			durableProtocolLabel(settings["env.MEMONGO_BENCHMARK_QA_PROTOCOL"])
				? null
				: "requires the official or custom-judge protocol in both runs",
	},
}

// What the answer and judge resolvers actually use, derived from the manifest
// the same way benchmark-answer-provider and the judge resolver read env.
function effectiveLabels(settings: Settings): Record<string, string | null> {
	const text = (key: string) => {
		const value = settings[key]
		return typeof value === "string" ? value : ""
	}
	return {
		answerModel:
			settings.answerProviderSource === "dedicated"
				? text("env.MEMONGO_BENCHMARK_ANSWER_MODEL")
				: text("env.MEMONGO_ENRICHMENT_MODEL"),
		judgeModel: text("env.MEMONGO_BENCHMARK_JUDGE_MODEL"),
		judgeProtocol: durableProtocolLabel(
			settings["env.MEMONGO_BENCHMARK_QA_PROTOCOL"],
		),
	}
}

// Fieldwise difference; JSON text equality matches how the hash serializes
// (-0 equals 0, an absent key differs from null).
function configurationDifferences(
	a: OperationRunConfiguration,
	b: OperationRunConfiguration,
): string[] {
	const flat = (configuration: OperationRunConfiguration) =>
		new Map<string, unknown>([
			["executionProfile", configuration.executionProfile],
			["retrievalLane", configuration.retrievalLane],
			["maxResults", configuration.maxResults],
			["minScore", configuration.minScore],
			...Object.entries(configuration.settings).map(
				([key, value]) => [`settings.${key}`, value] as [string, unknown],
			),
		])
	const left = flat(a)
	const right = flat(b)
	return [...new Set([...left.keys(), ...right.keys()])]
		.filter(
			(key) => JSON.stringify(left.get(key)) !== JSON.stringify(right.get(key)),
		)
		.sort()
}

const BOUND_FIELDS = ["runId", "datasetSha256", "configurationHash"] as const
const SHARED_DIGESTS = [
	"datasetSha256",
	"configurationHash",
	"executableDigest",
] as const

type CheckpointIdentity = Record<
	"runId" | (typeof SHARED_DIGESTS)[number],
	string
>

export type B2RunIdentity = {
	checkpoint: CheckpointIdentity | null
	/** Names (never values) of missing or malformed checkpoint identity fields. */
	checkpointInvalid: string[]
	/** Hash-bound manifest of supported coverage, or null (legacy/altered). */
	configuration: OperationRunConfiguration | null
	sidecar: Record<string, string> | null
	sidecarInvalid: string[]
	sidecarPresent: boolean
	declared: string[] | null
	completed: string[]
	clusteredScenarios: number
	emptyScenarios: number
	/** Final-pass entries without a meaningful case ID. */
	invalidCaseEntries: number
	selectedCaseIds: string[]
}

export type B2ComparisonEligibility = {
	eligible: boolean
	reasons: string[]
	treatment: B2TreatmentField | null
	independence?: "declared-not-verified" | "not-declared"
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0
}

// Identity text must carry meaning: blank or whitespace-padded values never
// count as bound provenance.
function meaningful(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const SHA256_FIELDS: ReadonlySet<string> = new Set(SHARED_DIGESTS)

function invalidFields(
	source: Record<string, unknown> | undefined,
	fields: readonly string[],
): string[] {
	return fields.filter((field) => {
		const value = source?.[field]
		return SHA256_FIELDS.has(field)
			? typeof value !== "string" || !SHA256_HEX.test(value)
			: !meaningful(value)
	})
}

export async function readB2RunIdentity(
	checkpointPath: string,
): Promise<B2RunIdentity> {
	const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"))
	let sidecarFile: Record<string, unknown> | undefined
	try {
		sidecarFile = JSON.parse(
			await readFile(`${checkpointPath}.predictions.json`, "utf8"),
		)
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
	}
	const fields = ["runId", ...SHARED_DIGESTS] as const
	const checkpointInvalid = [
		...(checkpoint?.version === 2 ? [] : ["version"]),
		...invalidFields(checkpoint, fields),
	]
	const boundCheckpoint =
		checkpointInvalid.length === 0
			? (Object.fromEntries(
					fields.map((field) => [field, checkpoint[field]]),
				) as CheckpointIdentity)
			: null
	const identity = sidecarFile?.identity as Record<string, unknown> | undefined
	const sidecarFields = [...BOUND_FIELDS, ...B2_TREATMENT_FIELDS]
	const sidecarInvalid = [
		...(sidecarFile?.version === "v2" ? [] : ["version"]),
		...invalidFields(identity, sidecarFields),
	]
	const sidecar =
		sidecarInvalid.length === 0
			? (Object.fromEntries(
					sidecarFields.map((field) => [field, identity?.[field]]),
				) as Record<string, string>)
			: null
	const scenarios: Array<{
		scenarioId?: unknown
		executionsByPass?: unknown[][]
	}> = Array.isArray(checkpoint?.completedScenarios)
		? checkpoint.completedScenarios
		: []
	const finalEntries = scenarios.flatMap((scenario) => {
		const last = scenario.executionsByPass?.at(-1)
		return Array.isArray(last) ? last : []
	}) as Array<{ caseId?: unknown } | null>
	const selectedCaseIds = finalEntries
		.map((entry) => entry?.caseId)
		.filter(meaningful)
	return {
		checkpoint: boundCheckpoint,
		checkpointInvalid,
		configuration: parseBoundRunConfiguration(
			checkpoint?.configuration,
			checkpoint?.configurationHash,
		),
		sidecar,
		sidecarInvalid,
		sidecarPresent: sidecarFile !== undefined,
		declared:
			Array.isArray(checkpoint?.scenarioIds) &&
			checkpoint.scenarioIds.every(nonEmpty)
				? checkpoint.scenarioIds
				: null,
		completed: scenarios
			.map((scenario) => scenario.scenarioId)
			.filter(nonEmpty),
		clusteredScenarios: scenarios.filter(
			(scenario) => (scenario.executionsByPass?.at(-1)?.length ?? 0) > 1,
		).length,
		emptyScenarios: scenarios.filter(
			(scenario) => (scenario.executionsByPass?.at(-1)?.length ?? 0) === 0,
		).length,
		invalidCaseEntries: finalEntries.length - selectedCaseIds.length,
		selectedCaseIds,
	}
}

function judgedInBoth(
	runA: Map<string, RunQuestionMetrics>,
	runB: Map<string, RunQuestionMetrics>,
): number {
	let count = 0
	for (const [id, a] of runA) {
		const b = runB.get(id)
		if (
			(a.verdict === "yes" || a.verdict === "no") &&
			(b?.verdict === "yes" || b?.verdict === "no")
		)
			count += 1
	}
	return count
}

export function assessB2Comparison(params: {
	a: B2RunIdentity
	b: B2RunIdentity
	runA: Map<string, RunQuestionMetrics>
	runB: Map<string, RunQuestionMetrics>
	treatment: B2TreatmentField | null
	independenceDeclared: boolean
	rOnly: boolean
	minJudged?: number
}): B2ComparisonEligibility {
	const { a, b, treatment, rOnly } = params
	const reasons: string[] = []
	const runs = [
		["A", a],
		["B", b],
	] as const
	for (const [label, run] of runs) {
		if (!run.checkpoint)
			reasons.push(
				`run ${label}: checkpoint identity is missing or invalid (${run.checkpointInvalid.join(", ")}); version 2 requires runId and lowercase sha256 datasetSha256, configurationHash, executableDigest`,
			)
		if (!run.sidecar && (!rOnly || run.sidecarPresent || treatment))
			reasons.push(
				`run ${label}: prediction sidecar v2 identity is missing or invalid (${run.sidecarInvalid.join(", ")})`,
			)
		if (run.invalidCaseEntries > 0)
			reasons.push(
				`run ${label}: ${run.invalidCaseEntries} final-pass entr${run.invalidCaseEntries === 1 ? "y lacks" : "ies lack"} a valid case ID, so the declared population is not paired`,
			)
		if (run.checkpoint && run.sidecar) {
			for (const field of BOUND_FIELDS) {
				if (run.sidecar[field] !== run.checkpoint[field])
					reasons.push(
						`run ${label}: sidecar ${field} does not match its checkpoint`,
					)
			}
		}
		if (run.checkpoint && !run.configuration)
			reasons.push(
				`run ${label}: configuration manifest is missing, unsupported or does not match configurationHash; legacy or altered artifacts stay descriptive only`,
			)
		if (run.sidecar && run.configuration) {
			for (const [field, effective] of Object.entries(
				effectiveLabels(run.configuration.settings),
			)) {
				if (run.sidecar[field] !== effective)
					reasons.push(
						`run ${label}: sidecar ${field} disagrees with the effective configuration`,
					)
			}
		}
		if (!run.declared)
			reasons.push(`run ${label}: declared population (scenarioIds) is missing`)
		else if (
			run.completed.length !== run.declared.length ||
			!run.declared.every((id) => run.completed.includes(id))
		)
			reasons.push(`run ${label}: declared population is not fully completed`)
		if (run.emptyScenarios > 0)
			reasons.push(
				`run ${label}: ${run.emptyScenarios} completed scenario(s) have no final-pass case, so the declared population is not paired`,
			)
		if (run.clusteredScenarios > 0)
			reasons.push(
				`run ${label}: clustered population: ${run.clusteredScenarios} scenario(s) hold several cases, so question pairs are not independent`,
			)
	}
	if (a.checkpoint && b.checkpoint) {
		if (a.checkpoint.runId === b.checkpoint.runId)
			reasons.push("A and B are the same run (runId)")
		for (const field of ["datasetSha256", "executableDigest"] as const) {
			if (a.checkpoint[field] !== b.checkpoint[field])
				reasons.push(
					`${field} differs between runs; an opaque digest cannot be a declared treatment`,
				)
		}
	}
	if (a.configuration && b.configuration) {
		const ownership = treatment ? TREATMENT_OWNERSHIP[treatment] : undefined
		const differences = configurationDifferences(
			a.configuration,
			b.configuration,
		)
		if (differences.includes("settings.credentialFingerprintKeyId"))
			reasons.push(
				"credential fingerprint key differs between runs; their credential fingerprints cannot be compared",
			)
		for (const key of differences) {
			if (!ownership?.keys.includes(key))
				reasons.push(`undeclared configuration difference: ${key}`)
		}
		if (treatment && !ownership)
			reasons.push(
				`declared treatment ${treatment} is a source constant; source treatments are deferred`,
			)
		if (treatment && ownership) {
			if (!differences.some((key) => ownership.keys.includes(key)))
				reasons.push(
					`declared treatment ${treatment} has no configuration change`,
				)
			const unmet = new Set(
				[a.configuration, b.configuration]
					.map((configuration) =>
						ownership.precondition(configuration.settings),
					)
					.filter((message): message is string => message !== null),
			)
			for (const message of unmet)
				reasons.push(`declared treatment ${treatment} ${message}`)
		}
	}
	if (
		a.declared &&
		b.declared &&
		(a.declared.length !== b.declared.length ||
			!a.declared.every((id) => b.declared?.includes(id)))
	)
		reasons.push("declared populations differ between runs")
	if (
		a.selectedCaseIds.length !== b.selectedCaseIds.length ||
		!a.selectedCaseIds.every((id) => b.selectedCaseIds.includes(id))
	)
		reasons.push("selected case IDs differ between runs")
	if (a.sidecar && b.sidecar) {
		const differing = B2_TREATMENT_FIELDS.filter(
			(field) => a.sidecar?.[field] !== b.sidecar?.[field],
		)
		if (treatment && !differing.includes(treatment))
			reasons.push(`declared treatment ${treatment} does not differ`)
		for (const field of differing) {
			if (field !== treatment) reasons.push(`undeclared ${field} difference`)
		}
	}
	if (!params.independenceDeclared)
		reasons.push(
			"question-level independence was not declared (--assume-independent-questions); it is an assumption and is never verified",
		)
	if (params.minJudged != null) {
		const judged = judgedInBoth(params.runA, params.runB)
		if (judged < params.minJudged)
			reasons.push(
				`judged-in-both ${judged} is below --min-judged ${params.minJudged}`,
			)
	}
	return {
		eligible: reasons.length === 0,
		reasons,
		treatment,
		independence: params.independenceDeclared
			? "declared-not-verified"
			: "not-declared",
	}
}
