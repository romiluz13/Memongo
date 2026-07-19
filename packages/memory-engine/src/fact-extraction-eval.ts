import type { MemoryScope } from "@memongo/lib"

/**
 * Fact-extraction recall evaluation (issue #30, slice 3).
 *
 * Measures how many ground-truth facts an extractor recovers from a labeled
 * conversation fixture, so the LLM extractor can be compared against the
 * deterministic regex baseline on the same cases. The scorer is phrasing-
 * independent: a fact counts as recalled when an extracted value covers enough
 * of its significant terms, regardless of how either extractor words it.
 */

export type FactExtractionEvent = {
	eventId: string
	agentId: string
	role: "user" | "assistant" | "system" | "tool"
	body: string
	timestamp: Date
	scope: MemoryScope
	scopeRef: string
	sessionId?: string
}

export type ExpectedFact = {
	/** Human-readable ground-truth fact. */
	text: string
	/**
	 * Discriminating tokens that MUST appear verbatim in the matched value for
	 * the fact to count as recalled (e.g. "pnpm", "us-east-1"). Guards against a
	 * topical paraphrase scoring a false recall on generic frame alone.
	 */
	mustInclude?: string[]
}

export type FactExtractionCase = {
	name: string
	event: FactExtractionEvent
	/** Atomic ground-truth facts a good extractor should recover. */
	expectedFacts: ExpectedFact[]
}

export type FactRecallReport = {
	recall: number
	perCase: Array<{
		name: string
		recall: number
		matched: number
		total: number
	}>
}

// Minimum share of an expected fact's significant terms that must appear in a
// single extracted value for the fact to count as recalled.
const COVERAGE_THRESHOLD = 0.6

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"for",
	"from",
	"has",
	"have",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"that",
	"the",
	"their",
	"there",
	"this",
	"to",
	"was",
	"we",
	"with",
	"you",
	"your",
])

function significantTerms(text: string): Set<string> {
	const terms = new Set<string>()
	// Length >= 2 so numeric discriminators like "16"/"v9" are not silently
	// dropped; two-letter function words are removed by STOPWORDS instead.
	for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? []) {
		if (!STOPWORDS.has(token)) {
			terms.add(token)
		}
	}
	return terms
}

function coverage(expectedTerms: Set<string>, valueTerms: Set<string>): number {
	if (expectedTerms.size === 0) {
		return 0
	}
	let hits = 0
	for (const term of expectedTerms) {
		if (valueTerms.has(term)) {
			hits += 1
		}
	}
	return hits / expectedTerms.size
}

/**
 * True when a single extracted value both (a) covers COVERAGE_THRESHOLD of the
 * expected fact's significant terms and (b) contains every `mustInclude`
 * discriminator (the ground-truth detail that distinguishes the fact, e.g.
 * "pnpm", "us-east-1", "16"). Requiring the discriminator in the *same* value
 * closes the honesty hole where a topical paraphrase clears the coverage bar on
 * generic frame alone. Facts with no significant terms fall back to a
 * normalized substring check so short literal facts still score.
 */
export function isFactRecalled(
	expectedFact: string,
	extractedValues: string[],
	opts?: { mustInclude?: string[] },
): boolean {
	const required = (opts?.mustInclude ?? []).map((term) => term.toLowerCase())
	const hasRequired = (lowerValue: string) =>
		required.every((term) => lowerValue.includes(term))

	const expectedTerms = significantTerms(expectedFact)
	if (expectedTerms.size === 0) {
		const needle = expectedFact.trim().toLowerCase()
		return (
			needle.length > 0 &&
			extractedValues.some((value) => {
				const lower = value.toLowerCase()
				return hasRequired(lower) && lower.includes(needle)
			})
		)
	}
	return extractedValues.some(
		(value) =>
			hasRequired(value.toLowerCase()) &&
			coverage(expectedTerms, significantTerms(value)) >= COVERAGE_THRESHOLD,
	)
}

export function scoreFactRecall(
	expectedFacts: string[],
	extractedValues: string[],
): { recall: number; matched: number; total: number } {
	const total = expectedFacts.length
	if (total === 0) {
		return { recall: 0, matched: 0, total: 0 }
	}
	let matched = 0
	for (const fact of expectedFacts) {
		if (isFactRecalled(fact, extractedValues)) {
			matched += 1
		}
	}
	return { recall: matched / total, matched, total }
}

/**
 * Run an extractor over the labeled cases and report micro-averaged recall
 * (total facts matched / total facts expected) plus per-case detail.
 */
export async function evaluateFactExtractor(params: {
	cases: FactExtractionCase[]
	extract: (event: FactExtractionEvent) => Promise<string[]> | string[]
}): Promise<FactRecallReport> {
	const perCase: FactRecallReport["perCase"] = []
	let totalMatched = 0
	let totalExpected = 0

	for (const testCase of params.cases) {
		const extracted = await params.extract(testCase.event)
		const total = testCase.expectedFacts.length
		let matched = 0
		for (const fact of testCase.expectedFacts) {
			if (
				isFactRecalled(fact.text, extracted, { mustInclude: fact.mustInclude })
			) {
				matched += 1
			}
		}
		perCase.push({
			name: testCase.name,
			recall: total === 0 ? 0 : matched / total,
			matched,
			total,
		})
		totalMatched += matched
		totalExpected += total
	}

	return {
		recall: totalExpected === 0 ? 0 : totalMatched / totalExpected,
		perCase,
	}
}

const FIXTURE_TIMESTAMP = new Date("2026-03-21T10:00:00Z")

function fixtureEvent(
	eventId: string,
	body: string,
	role: FactExtractionEvent["role"] = "user",
): FactExtractionEvent {
	return {
		eventId,
		agentId: "agent-eval",
		role,
		body,
		timestamp: FIXTURE_TIMESTAMP,
		scope: "agent",
		scopeRef: "agent:agent-eval",
		sessionId: "session-eval",
	}
}

/**
 * Labeled fixture spanning facts the deterministic regex extractor can catch
 * (explicit "remember"/preference/project triggers) and facts stated
 * conversationally with no trigger word — the headroom the LLM arm should
 * close. The regex baseline intentionally scores below 1.0 here.
 */
export const FACT_EXTRACTION_FIXTURE: FactExtractionCase[] = [
	{
		name: "explicit-remember-database",
		event: fixtureEvent(
			"evt-eval-1",
			"Remember that our primary database is PostgreSQL version 16.",
		),
		expectedFacts: [
			{
				text: "The primary database is PostgreSQL version 16",
				mustInclude: ["postgresql", "16"],
			},
		],
	},
	{
		name: "explicit-preference-answers",
		event: fixtureEvent(
			"evt-eval-2",
			"I prefer concise answers with explicit tradeoffs.",
		),
		expectedFacts: [
			{
				text: "The user prefers concise answers with explicit tradeoffs",
				mustInclude: ["concise"],
			},
		],
	},
	{
		name: "implicit-office-relocation",
		event: fixtureEvent(
			"evt-eval-3",
			"By the way, the office moved to the Lisbon branch last month.",
		),
		expectedFacts: [
			{
				text: "The office relocated to the Lisbon branch",
				mustInclude: ["lisbon"],
			},
		],
	},
	{
		name: "implicit-tooling-switch",
		event: fixtureEvent(
			"evt-eval-4",
			"I switched all of my repositories over to pnpm instead of npm.",
		),
		expectedFacts: [
			{
				text: "The user uses pnpm as the package manager",
				mustInclude: ["pnpm"],
			},
		],
	},
	{
		name: "implicit-deployment-region",
		event: fixtureEvent(
			"evt-eval-5",
			"We just cut over production to the AWS us-east-1 region.",
		),
		expectedFacts: [
			{
				text: "Production runs in the AWS us-east-1 region",
				mustInclude: ["us-east-1"],
			},
		],
	},
]
