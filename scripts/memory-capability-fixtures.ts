import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type MemoryCapabilityId =
	| "multi-session-current-state"
	| "retrieval-coverage"
	| "temporal-reasoning"
	| "assistant-recall"
	| "count-current-state"
	| "answer-context-packing"
	| "preference-memory"
	| "judge-contract"
	| "unexplained-target-gap"

type CapabilityFixture = {
	id: string
	capabilityId: MemoryCapabilityId
	label: string
	purpose: string
	minimumScenario: string
	mongoCapabilities: string[]
	acceptance: string[]
	stopCondition: string
}

export const memoryCapabilityFixtures: CapabilityFixture[] = [
	{
		id: "fixture-multi-session-supersession",
		capabilityId: "multi-session-current-state",
		label: "Multi-session current-state and supersession",
		purpose:
			"Prove Memongo can preserve older evidence while ranking the latest source-backed state first.",
		minimumScenario:
			"Three sessions for one user where a limit/preference/status changes twice; the query asks for the most recent state and the evidence must expose the superseded states.",
		mongoCapabilities: [
			"Atlas Search lexical/date evidence",
			"Vector Search semantic recall",
			"Hybrid fusion with source timestamp and provenance",
			"Aggregation-side source-date ordering",
		],
		acceptance: [
			"latest state appears in top evidence",
			"older conflicting states remain labeled as superseded",
			"source dates are preserved in answer context",
			"no question-id or gold-answer logic",
		],
		stopCondition:
			"Stop if the implementation needs a benchmark question id or hides conflicting evidence instead of labeling it.",
	},
	{
		id: "fixture-retrieval-coverage-zero-empty",
		capabilityId: "retrieval-coverage",
		label: "Retrieval coverage and zero-empty guard",
		purpose:
			"Prove a benchmark-shaped corpus never returns an empty retrieval when ingestion succeeded.",
		minimumScenario:
			"One user with hundreds of mixed-role turns, including a sparse exact answer and several lexical distractors; retrieve at top-50 and top-200.",
		mongoCapabilities: [
			"$listSearchIndexes/queryable readiness",
			"Atlas Search lexical fallback only as explicit lane evidence",
			"Vector Search with documented numCandidates policy",
			"Score/rank diagnostics for miss analysis",
		],
		acceptance: [
			"retrieval count is greater than zero",
			"expected evidence appears by top-50 or miss report explains why not",
			"index status is READY and queryable before measurement",
			"no hidden fallback marker appears",
		],
		stopCondition:
			"Stop if MongoDB Search/Vector indexes are stale, not queryable, or the run falls back silently.",
	},
	{
		id: "fixture-temporal-earliest-latest",
		capabilityId: "temporal-reasoning",
		label: "Temporal earliest/latest ordering",
		purpose:
			"Prove event dates, source dates, and recency language are handled without scorer-specific rules.",
		minimumScenario:
			"Four dated sessions with similar activities; ask earliest, latest, and most-recently-changed variants.",
		mongoCapabilities: [
			"Atlas Search date/proper-name evidence",
			"Aggregation-side date extraction and ordering",
			"Hybrid fusion with temporal lane preference",
		],
		acceptance: [
			"earliest/latest answers match source event order",
			"createdAt and source text date do not conflict silently",
			"answer context shows the ordered evidence list",
		],
		stopCondition:
			"Stop if runtime ingestion timestamps are used as the answer date when source dates are available.",
	},
	{
		id: "fixture-assistant-authored-facts",
		capabilityId: "assistant-recall",
		label: "Assistant-authored fact recall",
		purpose:
			"Prove assistant-side memories remain recallable without polluting user preference/current-state answers.",
		minimumScenario:
			"An assistant recommends, computes, or states a concrete fact in one session; later query asks what the assistant said.",
		mongoCapabilities: [
			"role-aware Search filters",
			"Vector Search semantic recall",
			"provenance-preserving answer context",
		],
		acceptance: [
			"assistant-authored evidence is retrieved for assistant-recall queries",
			"user-authored facts are not overwritten by assistant suggestions",
			"role provenance is visible to the answerer",
		],
		stopCondition:
			"Stop if the fix merges assistant advice into user current-state memory without role provenance.",
	},
	{
		id: "fixture-count-source-backed-candidates",
		capabilityId: "count-current-state",
		label: "Count source-backed candidates",
		purpose:
			"Prove counts are derived from source-backed candidate lists rather than session counts or overconfident summaries.",
		minimumScenario:
			"Several sessions mention planned, completed, duplicate, and superseded actions; query asks how many completed/current items remain.",
		mongoCapabilities: [
			"Atlas Search exact action/entity evidence",
			"Aggregation-side dedupe/grouping",
			"Hybrid retrieval with provenance for each candidate",
		],
		acceptance: [
			"candidate list is shown with source snippets",
			"duplicates and plans are excluded with a reason",
			"uncertain counts are labeled instead of forced",
			"answer_session_ids length is never used as the count",
		],
		stopCondition:
			"Stop if the count can only be made correct by question id, answer-session count, or gold-answer matching.",
	},
	{
		id: "fixture-context-top50-top200-packaging",
		capabilityId: "answer-context-packing",
		label: "Top-50/top-200 answer-context packing",
		purpose:
			"Prove larger retrieval sets help or stay neutral instead of distracting the answerer.",
		minimumScenario:
			"One query with relevant evidence, duplicate snippets, stale evidence, and high-scoring distractors; compare top-50 and top-200 rendered context.",
		mongoCapabilities: [
			"Search score and scoreDetails diagnostics",
			"hybrid rank metadata",
			"aggregation-side grouping by source event/session",
		],
		acceptance: [
			"top-200 context does not demote the best current evidence below stale duplicates",
			"duplicates are compressed by source",
			"current, stale, and conflicting evidence labels are visible",
		],
		stopCondition:
			"Stop if top-200 only passes by deleting retrieved evidence instead of packing/labelling it generically.",
	},
	{
		id: "fixture-preference-source-scope",
		capabilityId: "preference-memory",
		label: "Preference source scope",
		purpose:
			"Prove explicit user preferences keep wording, timestamp, and scope without being buried.",
		minimumScenario:
			"User states a preference, later modifies it, and asks for advice scoped to the latest preference.",
		mongoCapabilities: [
			"Atlas Search preference phrase evidence",
			"Vector Search semantic preference recall",
			"scope/scopeRef filters",
		],
		acceptance: [
			"latest preference appears before older preferences",
			"older preferences are not discarded",
			"scope and source date are visible",
		],
		stopCondition:
			"Stop if preference ranking requires benchmark-specific wording or removes superseded source evidence.",
	},
	{
		id: "fixture-judge-contract-rejudge",
		capabilityId: "judge-contract",
		label: "Judge contract and saved-artifact rejudge",
		purpose: "Keep retrieval quality separate from answerer/judge instability.",
		minimumScenario:
			"Run evaluate-only twice from identical prediction files and compare metadata, blank answers, and score drift.",
		mongoCapabilities: [
			"saved MongoDB retrieval artifacts",
			"artifact hashing",
			"no MongoDB rerun during judge-only evaluation",
		],
		acceptance: [
			"model and transport metadata are preserved",
			"no blank non-abstention generated answers",
			"score drift is recorded instead of hidden",
		],
		stopCondition:
			"Stop if judged QA is improved by rerunning retrieval rather than evaluating saved artifacts.",
	},
	{
		id: "fixture-unexplained-target-gap",
		capabilityId: "unexplained-target-gap",
		label: "Unexplained target gap",
		purpose:
			"Prevent a score gap from becoming a blind rerun loop when miss analysis does not explain the loss.",
		minimumScenario:
			"Use the latest result artifact and scorer output to regenerate miss analysis; every missed case must map to a capability family or be marked judge-contract watch.",
		mongoCapabilities: [
			"artifact-level retrieval diagnostics",
			"Search score and rank evidence",
			"saved prediction artifacts",
		],
		acceptance: [
			"every target delta maps to capability evidence",
			"unknown misses are investigated before a rerun",
			"no publication run starts from an unexplained score gap",
		],
		stopCondition:
			"Stop if the team cannot explain the target gap from raw artifacts, miss analysis, and MongoDB retrieval diagnostics.",
	},
]

export function fixtureForCapability(
	capabilityId: MemoryCapabilityId,
): CapabilityFixture | undefined {
	return memoryCapabilityFixtures.find(
		(fixture) => fixture.capabilityId === capabilityId,
	)
}

export function renderMemoryCapabilityFixturesMarkdown(): string {
	const lines = [
		"# Memory Capability Fixtures",
		"",
		"These fixtures are the product gate before another expensive competitor benchmark run. They are generic by design: no question IDs, no gold-answer shortcuts, no scorer edits.",
		"",
		"| Fixture | Capability | MongoDB capabilities | Acceptance | Stop condition |",
		"| --- | --- | --- | --- | --- |",
	]
	for (const fixture of memoryCapabilityFixtures) {
		lines.push(
			`| ${fixture.label} | ${fixture.capabilityId} | ${fixture.mongoCapabilities.join("<br>")} | ${fixture.acceptance.join("<br>")} | ${fixture.stopCondition} |`,
		)
	}
	return `${lines.join("\n")}\n`
}

function parseArgs(argv: string[]): { outDir?: string; jsonOnly: boolean } {
	let outDir: string | undefined
	let jsonOnly = false
	for (const arg of argv) {
		if (arg === "--json") {
			jsonOnly = true
		} else if (arg.startsWith("--out-dir=")) {
			outDir = arg.slice("--out-dir=".length)
		} else {
			throw new Error(`unknown argument: ${arg}`)
		}
	}
	return { outDir, jsonOnly }
}

if (import.meta.main) {
	try {
		const { outDir, jsonOnly } = parseArgs(process.argv.slice(2))
		if (outDir) {
			mkdirSync(outDir, { recursive: true })
			writeFileSync(
				join(outDir, "memory-capability-fixtures.json"),
				JSON.stringify(memoryCapabilityFixtures, null, 2),
			)
			writeFileSync(
				join(outDir, "memory-capability-fixtures.md"),
				renderMemoryCapabilityFixturesMarkdown(),
			)
		} else if (jsonOnly) {
			console.log(JSON.stringify(memoryCapabilityFixtures, null, 2))
		} else {
			console.log(renderMemoryCapabilityFixturesMarkdown())
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
