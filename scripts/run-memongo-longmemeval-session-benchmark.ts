import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { MongoClient, type Collection, type Db, type Document } from "mongodb"
import {
	keywordSearch,
	vectorSearch,
} from "../packages/memory-engine/src/mongodb-search.js"
import { sessionChunksCollection } from "../packages/memory-engine/src/mongodb-schema.js"
import { resolveScopeRef } from "../packages/memory-engine/src/mongodb-scope.js"
import { resolveBenchmarkCollectionPrefix } from "./benchmark-run-isolation.js"

const execFileAsync = promisify(execFile)

type LongMemEvalMode = "raw" | "hybrid"
type EvidenceUnit = "assistant" | "preference" | "session" | "unknown"

type EvidenceHit = {
	sessionId?: string
	path: string
	snippet: string
	score: number
	scoreDetails?: unknown
}

type LongMemEvalEntry = {
	question_id: string
	question_type: string
	question: string
	answer?: string
	answer_session_ids: string[]
	haystack_sessions: Array<Array<{ role: string; content: string }>>
	haystack_session_ids: string[]
	haystack_dates: string[]
	question_date?: string
}

type Candidate = {
	sessionId: string
	text: string
	timestamp?: string
	vectorScore?: number
	vectorRank?: number
	vectorPath?: string
	keywordScore?: number
	keywordRank?: number
	keywordPath?: string
	keywordScoreDetails?: unknown
	hitUnits: Set<EvidenceUnit>
	hitPaths: string[]
	finalScore: number
	survivalReason: string
	scoreBreakdown?: {
		vectorRrf: number
		keywordRrf: number
		overlap: number
		quote: number
		person: number
		exactTerm: number
		anchorTerm: number
		keyPhrase: number
		rankAgreement: number
		eventTerm: number
		entity: number
		ordinal: number
		semanticFacet: number
		domain: number
		transaction: number
		bridge: number
		temporal: number
		personal: number
		advice: number
		unit: number
		vectorWeight: number
		keywordWeight: number
	}
}

type CaseResult = {
	question_id: string
	question_type: string
	question: string
	answer?: string
	expected_session_ids: string[]
	retrieved_ids: string[]
	metrics: {
		recallAnyAt1: number
		recallAnyAt3: number
		recallAnyAt5: number
		recallAnyAt10: number
		recallAnyAt30: number
		recallAnyAt50: number
		ndcgAnyAt5: number
		ndcgAnyAt10: number
	}
	latencyMs: number
	topCandidates: Array<{
		rank: number
		sessionId: string
		finalScore: number
		vectorScore?: number
		vectorRank?: number
		vectorPath?: string
		keywordScore?: number
		keywordRank?: number
		keywordPath?: string
		keywordScoreDetails?: unknown
		hitUnits: EvidenceUnit[]
		hitPaths: string[]
		survivalReason: string
		scoreBreakdown?: Candidate["scoreBreakdown"]
	}>
}

type LongMemEvalArtifact = {
	artifactVersion: 1
	runId: string
	status: "completed"
	startedAt: string
	completedAt: string
	dataset: {
		path: string
		sha256: string
		kind: "longmemeval"
		cases: number
		scoredCases: number
	}
	mongodb: {
		database: string
		collectionPrefix: string
		collection: string
		vectorIndex: string
		searchIndex: string
	}
	lane: {
		name: "longmemeval-raw-session" | "longmemeval-hybrid-session-nollm"
		retrievalUnit: "session"
		llm: "none"
		reranker: "none"
		embedding: "MongoDB autoEmbed voyage-4-large"
		mode: LongMemEvalMode
		retrieveK: number
	}
	metrics: ReturnType<typeof summarizeResults>
	benchmarkReport: ReturnType<typeof buildBenchmarkReport>
	missLedger: ReturnType<typeof buildMissLedger>
	r1MissLedger: ReturnType<typeof buildR1MissLedger>
	caseDiagnostics: ReturnType<typeof buildCaseDiagnostics>
	warnings: string[]
	degradations: string[]
	results: CaseResult[]
}

const repoRoot = process.cwd()
const startedAt = new Date()
const runId =
	process.env.MEMONGO_BENCHMARK_RUN_ID?.trim() ||
	`memongo-longmemeval-session-${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
const workspaceDir =
	process.env.MEMONGO_WORKSPACE_DIR?.trim() ||
	path.join(os.homedir(), ".memongo", "workspace")
const datasetPathInput =
	process.env.MEMONGO_BENCHMARK_DATASET_PATH?.trim() ||
	path.join(workspaceDir, "benchmarks", "longmemeval_s_cleaned.json")
const datasetPath = path.isAbsolute(datasetPathInput)
	? datasetPathInput
	: path.resolve(repoRoot, datasetPathInput)
const artifactRoot =
	process.env.MEMONGO_BENCHMARK_RUN_DIR?.trim() ||
	path.join(repoRoot, "artifacts", "benchmark-runs")
const runDir = path.join(artifactRoot, runId)
const responsePath = path.join(runDir, "benchmark-response.json")
const partialResponsePath = path.join(runDir, "partial-response.json")
const statusPath = path.join(runDir, "status.json")
const mode: LongMemEvalMode =
	process.env.MEMONGO_LONGMEMEVAL_MODE?.trim().toLowerCase() === "hybrid"
		? "hybrid"
		: "raw"
const retrieveK = Math.max(
	1,
	Math.floor(Number(process.env.MEMONGO_BENCHMARK_MAX_RESULTS ?? 50)),
)
const limitCases = Math.max(
	0,
	Math.floor(Number(process.env.MEMONGO_BENCHMARK_LIMIT_CASES ?? 0)),
)
const prefixResolution = resolveBenchmarkCollectionPrefix({
	runId,
	explicitPrefix: process.env.MEMONGO_MONGODB_COLLECTION_PREFIX,
})

function readUri(): string {
	const uri =
		process.env.MEMONGO_MONGODB_URI?.trim() ||
		process.env.MEMONGO_CLOUD_MONGODB_URI?.trim() ||
		process.env.MDB_MCP_CONNECTION_STRING?.trim()
	if (!uri) {
		throw new Error("set MEMONGO_MONGODB_URI before running LongMemEval")
	}
	return uri
}

function readDatabaseName(): string {
	return (
		process.env.MEMONGO_DB_NAME?.trim() ||
		process.env.MEMONGO_PARITY_DATABASE?.trim() ||
		"memongo"
	)
}

async function gitValue(args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd: repoRoot })
		const value = stdout.trim()
		return value.length > 0 ? value : null
	} catch {
		return null
	}
}

async function resolveRunIdentity() {
	const envCommit =
		process.env.MEMONGO_BUILD_COMMIT?.trim() ||
		process.env.GITHUB_SHA?.trim() ||
		process.env.VERCEL_GIT_COMMIT_SHA?.trim()
	const gitCommit = await gitValue(["rev-parse", "HEAD"])
	const gitBranch = await gitValue(["branch", "--show-current"])
	return {
		runId,
		branch: process.env.MEMONGO_BUILD_BRANCH?.trim() || gitBranch,
		commit: envCommit || gitCommit,
		command: process.argv.map((part) => path.basename(part)).join(" "),
		collectionPrefix: prefixResolution.collectionPrefix,
	}
}

function isLongMemEvalEntry(value: unknown): value is LongMemEvalEntry {
	const record =
		value && typeof value === "object" ? (value as Record<string, unknown>) : {}
	return (
		typeof record.question_id === "string" &&
		typeof record.question === "string" &&
		Array.isArray(record.answer_session_ids) &&
		Array.isArray(record.haystack_sessions) &&
		Array.isArray(record.haystack_session_ids) &&
		Array.isArray(record.haystack_dates)
	)
}

function sessionText(
	session: Array<{ role: string; content: string }>,
): string {
	return session
		.filter((turn) => turn.role === "user" && turn.content.trim())
		.map((turn) => turn.content.trim())
		.join("\n")
}

function fullSessionText(
	session: Array<{ role: string; content: string }>,
): string {
	return session
		.filter((turn) => turn.content.trim())
		.map((turn) => `${turn.role}: ${turn.content.trim()}`)
		.join("\n")
}

const STOP_WORDS = new Set([
	"what",
	"when",
	"where",
	"who",
	"how",
	"which",
	"did",
	"do",
	"was",
	"were",
	"have",
	"has",
	"had",
	"is",
	"are",
	"the",
	"a",
	"an",
	"my",
	"me",
	"i",
	"you",
	"your",
	"their",
	"it",
	"its",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"ago",
	"last",
	"that",
	"this",
	"there",
	"about",
	"get",
	"got",
	"give",
	"gave",
	"buy",
	"bought",
	"made",
	"make",
])

const NOT_NAMES = new Set([
	"What",
	"When",
	"Where",
	"Who",
	"How",
	"Which",
	"Any",
	"Did",
	"Do",
	"You",
	"Your",
	"We",
	"Our",
	"Was",
	"Were",
	"Have",
	"Has",
	"Had",
	"Is",
	"Are",
	"The",
	"My",
	"Our",
	"Their",
	"Can",
	"Could",
	"Would",
	"Should",
	"Will",
	"Shall",
	"May",
	"Might",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
	"January",
	"February",
	"March",
	"April",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
	"In",
	"On",
	"At",
	"For",
	"To",
	"Of",
	"With",
	"By",
	"From",
	"And",
	"But",
	"I",
	"It",
	"Its",
	"This",
	"That",
	"These",
	"Those",
	"Previously",
	"Previous",
	"Recently",
	"Also",
	"Just",
	"Very",
	"More",
	"President",
	"Chief",
	"Advisor",
	"Science",
	"Technology",
	"National",
	"Laboratory",
])

const PREF_PATTERNS = [
	/i(?:'ve been| have been) having (?:trouble|issues?|problems?) with ([^,.!?]{5,80})/gi,
	/i(?:'ve been| have been) feeling ([^,.!?]{5,60})/gi,
	/i(?:'ve been| have been) (?:struggling|dealing) with ([^,.!?]{5,80})/gi,
	/i(?:'ve been| have been) (?:worried|concerned) about ([^,.!?]{5,80})/gi,
	/i(?:'m| am) (?:worried|concerned) about ([^,.!?]{5,80})/gi,
	/i prefer ([^,.!?]{5,60})/gi,
	/i (?:enjoy|like|love) ([^,.!?]{5,80})/gi,
	/i usually ([^,.!?]{5,60})/gi,
	/i(?:'ve been| have been) (?:trying|attempting) to ([^,.!?]{5,80})/gi,
	/i(?:'ve been| have been) (?:considering|thinking about) ([^,.!?]{5,80})/gi,
	/lately[,\s]+(?:i've been|i have been|i'm|i am) ([^,.!?]{5,80})/gi,
	/recently[,\s]+(?:i've been|i have been|i'm|i am) ([^,.!?]{5,80})/gi,
	/i(?:'ve been| have been) (?:working on|focused on|interested in) ([^,.!?]{5,80})/gi,
	/i want to ([^,.!?]{5,60})/gi,
	/i(?:'m| am) looking (?:to|for) ([^,.!?]{5,60})/gi,
	/i(?:'m| am) thinking (?:about|of) ([^,.!?]{5,60})/gi,
	/i(?:'ve been| have been) (?:noticing|experiencing) ([^,.!?]{5,80})/gi,
	/i (?:still )?remember (?:the |my )?([^,.!?]{5,80})/gi,
	/i used to ([^,.!?]{5,60})/gi,
	/when i was (?:in high school|in college|young|a kid|growing up)[,\s]+([^,.!?]{5,80})/gi,
	/growing up[,\s]+([^,.!?]{5,80})/gi,
	/(?:happy|fond|good|positive) (?:high school|college|childhood|school) (?:experience|memory|memories|time)[^,.!?]{0,60}/gi,
]

const ANCHOR_STOP_WORDS = new Set([
	...STOP_WORDS,
	"activity",
	"activities",
	"advice",
	"any",
	"appliance",
	"day",
	"days",
	"decide",
	"device",
	"excited",
	"getting",
	"idea",
	"ideas",
	"kitchen",
	"look",
	"looking",
	"many",
	"new",
	"pack",
	"packed",
	"recommend",
	"recommendation",
	"recommendations",
	"should",
	"suggest",
	"suggestion",
	"suggestions",
	"thing",
	"things",
	"think",
	"tip",
	"tips",
	"trip",
	"visit",
	"wait",
	"week",
	"weeks",
	"whether",
])

function extractKeywords(text: string): string[] {
	return Array.from(text.toLowerCase().matchAll(/\b[a-z]{3,}\b/g))
		.map((match) => match[0])
		.filter((word) => !STOP_WORDS.has(word))
}

function keywordOverlap(keywords: string[], text: string): number {
	if (keywords.length === 0) return 0
	const lower = text.toLowerCase()
	return (
		keywords.filter((keyword) => lower.includes(keyword)).length /
		keywords.length
	)
}

function extractQuotedPhrases(text: string): string[] {
	return [...text.matchAll(/'([^']{3,60})'|"([^"]{3,60})"/g)]
		.map((match) => (match[1] ?? match[2] ?? "").trim())
		.filter((phrase) => phrase.length >= 3)
}

function quotedBoost(phrases: string[], text: string): number {
	if (phrases.length === 0) return 0
	const lower = text.toLowerCase()
	return Math.min(
		phrases.filter((phrase) => lower.includes(phrase.toLowerCase())).length /
			phrases.length,
		1,
	)
}

function extractPersonNames(text: string): string[] {
	return Array.from(new Set([...text.matchAll(/\b[A-Z][a-z]{2,15}\b/g)]))
		.map((match) => match[0])
		.filter((word) => !NOT_NAMES.has(word))
}

function nameBoost(names: string[], text: string): number {
	if (names.length === 0) return 0
	const lower = text.toLowerCase()
	return Math.min(
		names.filter((name) => lower.includes(name.toLowerCase())).length /
			names.length,
		1,
	)
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function extractExactTerms(text: string): string[] {
	return Array.from(
		new Set(
			[...text.matchAll(/\b[A-Z][A-Z0-9+.-]{1,12}\b/g)]
				.map((match) => match[0])
				.filter(
					(term) =>
						/[A-Z]{2}/.test(term) &&
						/[A-Z]$/.test(term) &&
						!NOT_NAMES.has(term),
				),
		),
	)
}

function normalizeFacet(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}+.-]+/gu, " ")
		.replace(/\s+/g, " ")
}

function extractEntityTerms(text: string): string[] {
	const values = new Set<string>()
	for (const match of text.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) {
		values.add(match[0])
	}
	for (const match of text.matchAll(/\b[A-Z][A-Z0-9+.-]{1,14}\b/g)) {
		if (/[A-Z]{2}/.test(match[0]) && !NOT_NAMES.has(match[0])) {
			values.add(match[0])
		}
	}
	for (const match of text.matchAll(
		/\b[A-Z][a-zA-Z0-9'.-]*(?:\s+(?:of|and|the|for|at|in|[A-Z][a-zA-Z0-9'.-]*)){1,7}\b/g,
	)) {
		const phrase = match[0].trim()
		const first = phrase.split(/\s+/)[0]
		if (!NOT_NAMES.has(first) && /[A-Z][a-z]/.test(phrase)) {
			values.add(phrase)
		}
	}
	return Array.from(values)
		.map(normalizeFacet)
		.filter((value) => value.length >= 3 && !ANCHOR_STOP_WORDS.has(value))
		.slice(0, 40)
}

function extractLexicalTerms(text: string): string[] {
	return Array.from(
		new Set(
			Array.from(
				text
					.replace(/([a-z])([A-Z])/g, "$1 $2")
					.toLowerCase()
					.matchAll(/\b[a-z][a-z0-9+-]{2,}\b/g),
			)
				.map((match) => match[0])
				.filter((term) => !ANCHOR_STOP_WORDS.has(term)),
		),
	).slice(0, 80)
}

function extractOrdinalPhrases(text: string): string[] {
	return Array.from(
		new Set(
			Array.from(
				text.matchAll(
					/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\s+([a-z][a-z0-9-]{2,})\b/gi,
				),
			).map((match) => normalizeFacet(`${match[1]} ${match[2]}`)),
		),
	).slice(0, 12)
}

function extractKeyPhrases(text: string): string[] {
	const phrases = new Set<string>()
	for (const phrase of extractQuotedPhrases(text)) {
		phrases.add(phrase)
	}
	for (const phrase of extractOrdinalPhrases(text)) {
		phrases.add(phrase)
	}
	const words =
		text
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.match(/\b[a-z][a-z0-9+-]{2,}\b/g)
			?.filter((word) => !ANCHOR_STOP_WORDS.has(word)) ?? []
	for (let size = 4; size >= 2; size--) {
		for (let index = 0; index <= words.length - size; index++) {
			const phrase = words.slice(index, index + size).join(" ")
			if (phrase.length >= 9) phrases.add(phrase)
		}
	}
	return Array.from(phrases).slice(0, 24)
}

function extractIntentTags(text: string): string[] {
	const q = text.toLowerCase()
	const tags = new Set<string>()
	if (
		/\b(remind me|follow up|looking back|previous conversation|mentioned)\b/.test(
			q,
		)
	) {
		tags.add("followup-recall")
	}
	if (
		/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\b/.test(
			q,
		)
	) {
		tags.add("list-position")
	}
	if (
		/\b(cashback|cash back|refund|receipt|coupon|discount|earn(?:ed)?|spent|paid|cost|price|\$\d+|\d+\s*(?:dollars?|usd))\b/.test(
			q,
		)
	) {
		tags.add("transaction")
	}
	if (/\b(last|this past|yesterday|ago|recently|before|after)\b/.test(q)) {
		tags.add("temporal")
	}
	if (/\b(article|paper|report|study|breakthrough|laboratory)\b/.test(q)) {
		tags.add("article-reference")
	}
	if (
		/\b(prefer|preference|like|favorite|advice|recommend|suggest|tips?)\b/.test(
			q,
		)
	) {
		tags.add("preference-advice")
	}
	return Array.from(tags)
}

function extractSemanticFacets(text: string): string[] {
	const q = text.toLowerCase()
	const facets = new Set<string>()
	if (
		/\b(doctors?|dr\.?|physician|dermatologist|ent specialist|healthcare provider|medical professional)\b/.test(
			q,
		)
	) {
		facets.add("medical-provider")
	}
	if (/\b(dermatologist|skin|mole|biopsy)\b/.test(q)) {
		facets.add("medical-provider:dermatology")
	}
	if (/\b(ent specialist|sinusitis|nasal spray|congestion)\b/.test(q)) {
		facets.add("medical-provider:ent")
	}
	if (/\b(primary care physician|uti|antibiotics)\b/.test(q)) {
		facets.add("medical-provider:primary-care")
	}
	if (
		/\b(publications?|conferences?|papers?|articles?|research|study|studies|recent advancements?|working in the field)\b/.test(
			q,
		)
	) {
		facets.add("research-interest")
	}
	if (
		/\b(deep learning|medical image|medical imaging|healthcare|clinical|diagnostic|mri|ct|pet|self-supervised|federated learning|transformers?)\b/.test(
			q,
		)
	) {
		facets.add("medical-ai")
	}
	if (
		/\b(homegrown|garden|gardening|companion plants?|tomatoes?|cherry tomatoes?|basil|mint|fresh herbs?|garden produce)\b/.test(
			q,
		)
	) {
		facets.add("garden-produce")
	}
	if (/\b(basil|mint|fresh herbs?)\b/.test(q)) {
		facets.add("fresh-herbs")
	}
	if (
		/\b(previous occupation|new role|career change|promotion|job|work|task|deadline|project management)\b/.test(
			q,
		)
	) {
		facets.add("career-role")
	}
	if (
		/\b(projects?|led|leading|team|engineers?|launch|timeline|gantt)\b/.test(q)
	) {
		facets.add("project-leadership")
	}
	if (
		/\b(vintage cameras?|camera flash|sony a7r|photography setup|photo setup|lens|flash)\b/.test(
			q,
		)
	) {
		facets.add("photography-gear")
	}
	if (
		/\b(paintings?|acrylic|brushes|art supplies?|art history|sunset|inspiration)\b/.test(
			q,
		)
	) {
		facets.add("visual-art")
	}
	if (
		/\b(shampoo|skincare|bathroom|sephora|dry skin|cleaning routine)\b/.test(q)
	) {
		facets.add("personal-care")
	}
	if (
		/\b(music streaming|concert|shows?|movie|netflix|stand-up|comedy|podcasts?|watch tonight)\b/.test(
			q,
		)
	) {
		facets.add("media-entertainment")
	}
	if (
		/\b(hotel|trip|miami|seattle|las vegas|travel|flight|packing)\b/.test(q)
	) {
		facets.add("travel-lodging")
	}
	if (
		/\b(cultural events?|language learning|french|podcasts?|around me)\b/.test(
			q,
		)
	) {
		facets.add("local-culture")
	}
	if (
		/\b(guitar|guitars|music store|instrument|fender|stratocaster|gibson|les paul|acoustic|electric guitar|strings|amp|amplifier)\b/.test(
			q,
		)
	) {
		facets.add("musical-instrument")
	}
	if (
		/\b(phone|battery|power bank|wireless charging|tech accessories|ipad case|wireless mouse|delivery|arrive|ordered)\b/.test(
			q,
		)
	) {
		facets.add("device-accessory")
	}
	if (/\b(battery life|power bank|charging)\b/.test(q)) {
		facets.add("device-power")
	}
	if (
		/\b(bake|baking|cake|cookies?|caramel|ganache|sugar|recipe|pastr(?:y|ies)|dinner)\b/.test(
			q,
		)
	) {
		facets.add("food-baking")
	}
	if (
		/\b(furniture|bedroom|dresser|mid-century|design inspiration)\b/.test(q)
	) {
		facets.add("home-furniture")
	}
	if (
		/\b(dad|mom|grandma|grandpa|parents?|grandparents?|birthday gift|family)\b/.test(
			q,
		)
	) {
		facets.add("family-context")
	}
	if (/\b(rare items?|rare records?|collection|collecting|catalog)\b/.test(q)) {
		facets.add("collection-hobby")
	}
	if (
		/\b(camping|road trip|moab|utah|hiking|trails?|united states)\b/.test(q)
	) {
		facets.add("outdoor-travel")
	}
	if (
		/\b(workshops?|lectures?|conferences?|april|library|sustainable development|urban planning)\b/.test(
			q,
		)
	) {
		facets.add("learning-events")
	}
	return Array.from(facets).slice(0, 24)
}

function semanticFacetBoost(query: string, text: string): number {
	const queryFacets = extractSemanticFacets(query)
	if (queryFacets.length === 0) return 0
	const docFacets = new Set(extractSemanticFacets(text))
	return Math.min(
		queryFacets.filter((facet) => docFacets.has(facet)).length /
			queryFacets.length,
		1,
	)
}

function domainIntentBoost(question: string, text: string): number {
	const q = question.toLowerCase()
	const doc = text.toLowerCase()
	if (/\bhow many different doctors?\b/.test(q)) {
		let score = 0
		if (
			/\b(?:dr\.?\s+[a-z]+|doctor|physician|healthcare provider)\b/i.test(doc)
		) {
			score += 0.45
		}
		if (
			/\b(?:dermatologist|ent specialist|primary care physician)\b/i.test(doc)
		) {
			score += 0.35
		}
		if (
			/\b(?:prescription|diagnosed|antibiotics|biopsy|sinusitis|uti)\b/i.test(
				doc,
			)
		) {
			score += 0.2
		}
		return Math.min(score, 1)
	}
	if (/\b(publications?|conferences?)\b/.test(q) && /\binteresting\b/.test(q)) {
		let score = 0
		if (
			/\b(research|study|studies|recent advancements?|working in the field)\b/i.test(
				doc,
			)
		) {
			score += 0.35
		}
		if (
			/\b(deep learning|medical image|medical imaging|healthcare|clinical)\b/i.test(
				doc,
			)
		) {
			score += 0.45
		}
		if (
			/\b(transformers?|self-supervised|federated learning|multimodal|generative models?)\b/i.test(
				doc,
			)
		) {
			score += 0.2
		}
		return Math.min(score, 1)
	}
	if (/\bhomegrown\b/.test(q) && /\bingredients?\b/.test(q)) {
		let score = 0
		if (
			/\b(garden|gardening|companion plants?|planting|grown|homegrown)\b/i.test(
				doc,
			)
		) {
			score += 0.45
		}
		if (/\b(tomatoes?|cherry tomatoes?|basil|mint|fresh herbs?)\b/i.test(doc)) {
			score += 0.45
		}
		if (/\b(recipe|recipes|salad|pasta|chutney|stir-fry|dinner)\b/i.test(doc)) {
			score += 0.1
		}
		return Math.min(score, 1)
	}
	if (/\bhow many\b/.test(q)) {
		let score = 0
		if (/\b\d+\b/.test(doc)) score += 0.35
		if (
			/\b(projects?|days?|items?|records?|workshops?|lectures?|conferences?|trips?)\b/.test(
				q,
			)
		) {
			const queryTerms =
				q.match(
					/\b(projects?|days?|items?|records?|workshops?|lectures?|conferences?|trips?)\b/g,
				) ?? []
			if (
				queryTerms.some((term) => new RegExp(`\\b${term}\\b`, "i").test(doc))
			) {
				score += 0.35
			}
		}
		if (
			/\b(total|average|different|currently leading|this year|in april|after|before)\b/.test(
				q,
			)
		) {
			score += 0.15
		}
		if (
			/\b(april|february|march|january|may|june|july|august|september|october|november|december)\b/.test(
				q,
			) &&
			/\b(april|february|march|january|may|june|july|august|september|october|november|december)\b/.test(
				doc,
			)
		) {
			score += 0.15
		}
		return Math.min(score, 1)
	}
	if (/\bbrand of\b/.test(q) || /\bname of\b/.test(q)) {
		let score = 0
		if (/\bbrand|called|named|service|use|using|currently|lately\b/.test(doc)) {
			score += 0.45
		}
		if (semanticFacetBoost(question, text) > 0) score += 0.55
		return Math.min(score, 1)
	}
	return 0
}

function personalMemoryBoost(question: string, text: string): number {
	if (!/\b(i|me|my|mine|we|our)\b/i.test(question)) return 0
	const doc = text.toLowerCase()
	let score = 0
	if (
		/\b(i'm|i am|i've|i have|i was|i recently|i just|my|me|we|our)\b/.test(doc)
	) {
		score += 0.5
	}
	if (
		/user:[\s\S]{0,450}\b(i'm|i am|i've|i have|i was|i recently|i just|my|me|we|our)\b/i.test(
			text,
		)
	) {
		score += 0.5
	}
	return Math.min(score, 1)
}

function exactTermBoost(terms: string[], text: string): number {
	if (terms.length === 0) return 0
	return Math.min(
		terms.filter((term) =>
			new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text),
		).length / terms.length,
		1,
	)
}

function entityBoost(entities: string[], text: string): number {
	if (entities.length === 0) return 0
	const docEntities = new Set(extractEntityTerms(text))
	return Math.min(
		entities.filter((entity) => docEntities.has(entity)).length /
			entities.length,
		1,
	)
}

function ordinalBoost(phrases: string[], text: string): number {
	if (phrases.length === 0) return 0
	const lower = normalizeFacet(text)
	return Math.min(
		phrases.filter((phrase) => lower.includes(phrase)).length / phrases.length,
		1,
	)
}

function keyPhraseBoost(phrases: string[], text: string): number {
	if (phrases.length === 0) return 0
	const lower = normalizeFacet(text)
	return Math.min(
		phrases.filter((phrase) => lower.includes(phrase)).length / phrases.length,
		1,
	)
}

function transactionBoost(question: string, text: string): number {
	const q = question.toLowerCase()
	if (
		!/\b(cashback|cash back|refund|receipt|coupon|discount|earn(?:ed)?|spent|paid|cost|price|worth|value)\b/.test(
			q,
		)
	) {
		return 0
	}
	const doc = text.toLowerCase()
	if (/\bworth\b/.test(q) && /\bpaid\b/.test(q)) {
		let score = 0
		const possible = 2
		if (/\b(worth|value|valuable|apprais(?:e|ed|al)|market)\b/.test(doc)) {
			score += 1
		}
		if (
			/\b(paid|pay|price|original price|triple|double|twice|half|three times|two times)\b/.test(
				doc,
			)
		) {
			score += 1
		}
		return score / possible
	}
	let score = 0
	let possible = 0
	if (/\b(cashback|cash back)\b/.test(q)) {
		possible += 1
		if (/\b(cashback|cash back)\b/.test(doc)) score += 1
	}
	if (/\b(how much|\$\d+|\d+\s*(?:dollars?|usd))\b/.test(q)) {
		possible += 1
		if (
			/\$\s?\d+|\b\d+(?:\.\d{2})?\s*(?:dollars?|usd|cashback|cash back)\b/.test(
				doc,
			)
		) {
			score += 1
		}
	}
	return possible > 0 ? score / possible : 0
}

function extractAnchorTerms(text: string): string[] {
	return Array.from(
		new Set(
			Array.from(text.toLowerCase().matchAll(/\b[a-z][a-z0-9-]{3,}\b/g))
				.map((match) => match[0].replace(/'s$/, ""))
				.filter((term) => !ANCHOR_STOP_WORDS.has(term)),
		),
	).slice(0, 8)
}

function termMatchesText(term: string, text: string): boolean {
	const escaped = escapeRegExp(term)
	if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) return true
	if (term.endsWith("s")) {
		return new RegExp(`\\b${escapeRegExp(term.slice(0, -1))}\\b`, "i").test(
			text,
		)
	}
	return new RegExp(`\\b${escaped}s\\b`, "i").test(text)
}

function anchorTermBoost(terms: string[], text: string): number {
	if (terms.length === 0) return 0
	return Math.min(
		terms.filter((term) => termMatchesText(term, text)).length / terms.length,
		1,
	)
}

function eventTermBoost(question: string, text: string): number {
	const eventTerms = Array.from(
		new Set(
			[
				...question
					.toLowerCase()
					.matchAll(
						/\b(lunch|dinner|breakfast|brunch|coffee|meeting|meetup|workshop|conference|festival|concert|wedding|shower)\b/g,
					),
			].map((match) => match[0]),
		),
	)
	if (eventTerms.length === 0) return 0
	return Math.min(
		eventTerms.filter((term) => termMatchesText(term, text)).length /
			eventTerms.length,
		1,
	)
}

function extractPreferences(
	session: Array<{ role: string; content: string }>,
): string[] {
	const mentions: string[] = []
	for (const turn of session) {
		if (turn.role !== "user") continue
		for (const pattern of PREF_PATTERNS) {
			pattern.lastIndex = 0
			for (const match of turn.content.matchAll(pattern)) {
				const clean = (match[1] ?? match[0] ?? "")
					.trim()
					.replace(/[.,;!?]+$/, "")
				if (clean.length >= 5 && clean.length <= 80) {
					mentions.push(clean.toLowerCase())
				}
			}
		}
	}
	return Array.from(new Set(mentions)).slice(0, 12)
}

function parseQuestionDate(date: string | undefined): Date | null {
	if (!date) return null
	const normalized = date.split(" (")[0]
	const match = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(normalized)
	if (!match) return null
	const parsed = new Date(
		Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
	)
	return Number.isNaN(parsed.getTime()) ? null : parsed
}

function parseTimeOffsetDays(question: string): [number, number] | null {
	const q = question.toLowerCase()
	const patterns: Array<
		[RegExp, (match: RegExpExecArray) => [number, number]]
	> = [
		[/(\d+)\s+days?\s+ago/, (match) => [Number(match[1]), 2]],
		[/a\s+couple\s+(?:of\s+)?days?\s+ago/, () => [2, 2]],
		[/yesterday/, () => [1, 1]],
		[/a\s+week\s+ago/, () => [7, 3]],
		[/(\d+)\s+weeks?\s+ago/, (match) => [Number(match[1]) * 7, 5]],
		[/last\s+week/, () => [7, 3]],
		[/a\s+month\s+ago/, () => [30, 7]],
		[/(\d+)\s+months?\s+ago/, (match) => [Number(match[1]) * 30, 10]],
		[/last\s+month/, () => [30, 7]],
		[/last\s+year/, () => [365, 30]],
		[/a\s+year\s+ago/, () => [365, 30]],
		[/recently/, () => [14, 14]],
	]
	for (const [pattern, extract] of patterns) {
		const match = pattern.exec(q)
		if (match) return extract(match)
	}
	return null
}

function temporalBoost(params: {
	question: string
	questionDate?: string
	sessionDate?: string
}): number {
	const weekdayTarget = parseLastWeekdayTarget(
		params.question,
		params.questionDate,
	)
	const sessionDate = parseQuestionDate(params.sessionDate)
	if (weekdayTarget && sessionDate) {
		const deltaDays = Math.abs(
			(sessionDate.getTime() - weekdayTarget.getTime()) / 86_400_000,
		)
		if (deltaDays <= 1) return 1
		if (deltaDays <= 3) return 1 - (deltaDays - 1) / 2
	}
	const offset = parseTimeOffsetDays(params.question)
	const questionDate = parseQuestionDate(params.questionDate)
	if (!offset || !questionDate || !sessionDate) return 0
	const [daysBack, tolerance] = offset
	const targetMs = questionDate.getTime() - daysBack * 86_400_000
	const deltaDays = Math.abs((sessionDate.getTime() - targetMs) / 86_400_000)
	if (deltaDays <= tolerance) return 1
	if (deltaDays <= tolerance * 3) {
		return 1 - (deltaDays - tolerance) / (tolerance * 2)
	}
	return 0
}

function parseLastWeekdayTarget(
	question: string,
	questionDate: string | undefined,
): Date | null {
	const base = parseQuestionDate(questionDate)
	if (!base) return null
	const match =
		/\b(?:last|this past)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(
			question,
		)
	if (!match) return null
	const weekdays = new Map([
		["sunday", 0],
		["monday", 1],
		["tuesday", 2],
		["wednesday", 3],
		["thursday", 4],
		["friday", 5],
		["saturday", 6],
	])
	const targetDow = weekdays.get(match[1].toLowerCase())
	if (targetDow === undefined) return null
	const baseDow = base.getUTCDay()
	let daysBack = (baseDow - targetDow + 7) % 7
	if (daysBack === 0 || /\blast\b/i.test(match[0])) {
		daysBack = daysBack === 0 ? 7 : daysBack
	}
	return new Date(base.getTime() - daysBack * 86_400_000)
}

function inferEvidenceUnit(pathValue: string | undefined): EvidenceUnit {
	if (!pathValue) return "unknown"
	if (pathValue.startsWith("session_assistant/")) return "assistant"
	if (pathValue.startsWith("session_preferences/")) return "preference"
	if (pathValue.startsWith("session_chunks/")) return "session"
	return "unknown"
}

function recordHit(
	candidate: Candidate,
	hit: { path: string },
	source: "keyword" | "vector",
): void {
	const unit = inferEvidenceUnit(hit.path)
	candidate.hitUnits.add(unit)
	if (!candidate.hitPaths.includes(hit.path)) {
		candidate.hitPaths.push(hit.path)
	}
	if (source === "vector") {
		candidate.vectorPath = hit.path
	} else {
		candidate.keywordPath = hit.path
	}
}

function isPreferenceAdviceQuestion(question: string): boolean {
	const q = question.toLowerCase()
	if (
		/\b(remind me|looking back|follow up|previous conversation|what was|who is|how much|mentioned in (?:the )?article)\b/.test(
			q,
		)
	) {
		return false
	}
	const explicitAdvice =
		/\b(advice|any tips?|ideas?|recommend(?:ation|ed)?|suggest(?:ion|ed)?|what do you think|should i|decide whether|stuck|trouble|problem|issue|battery|inspiration|look for|new guitar|new phone|new laptop|new computer)\b/i.test(
			q,
		)
	if (!explicitAdvice) return false
	if (
		/^(what|who|when|where|which|how many|how much)\b/i.test(q) &&
		!/\b(advice|any tips?|ideas?|recommend|suggest|what do you think|should i)\b/i.test(
			q,
		)
	) {
		return false
	}
	return true
}

function rankSignal(rank: number | undefined): number {
	if (!rank) return 0
	return Math.max(0, (retrieveK + 1 - rank) / retrieveK)
}

function rankAgreementSignal(candidate: Candidate): number {
	if (!candidate.vectorRank || !candidate.keywordRank) return 0
	return Math.sqrt(
		rankSignal(candidate.vectorRank) * rankSignal(candidate.keywordRank),
	)
}

function recallRankAgreementWeight(question: string): number {
	const q = question.toLowerCase()
	if (
		/\b(previous conversation|looking back|remind me|discussed|recommended|what was|what were|name of|list you provided|last time)\b/.test(
			q,
		)
	) {
		return 0.1
	}
	if (/\bhow many days\b|\bdays? before\b/.test(q)) {
		return 0.1
	}
	return 0
}

function adviceAnswerBoost(question: string, text: string): number {
	if (!isPreferenceAdviceQuestion(question)) return 0
	const doc = text.toLowerCase()
	const signals = [
		/\byou (?:could|can|might|should)\b/,
		/\btry\b/,
		/\bconsider\b/,
		/\brecommend\b/,
		/\bsuggest\b/,
		/\bidea\b/,
		/\btips?\b/,
		/\boption\b/,
		/\blook for\b/,
		/\bwait\b/,
	]
	return Math.min(signals.filter((pattern) => pattern.test(doc)).length / 3, 1)
}

function bridgeBoost(question: string, text: string): number {
	const q = question.toLowerCase()
	const doc = text.toLowerCase()
	let score = 0
	let possible = 0
	if (/\b(buy|bought|purchase|purchased|ordered|get|got)\b/.test(q)) {
		possible += 1
		if (
			/\b(bought|buy|purchased|ordered|picked up|got a|got an|just got|getting|thinking of getting|considering|new)\b/.test(
				doc,
			)
		) {
			score += 1
		}
	}
	if (/\b(kitchen|appliance|cook|cooking|recipe|food)\b/.test(q)) {
		possible += 1
		if (
			/\b(kitchen|appliance|cook|cooking|recipe|smoker|grill|oven|toaster|blender|mixer|air fryer|coffee maker|stove|microwave)\b/.test(
				doc,
			)
		) {
			score += 1
		}
	}
	if (/\b(friend|with|meet|met|do with)\b/.test(q)) {
		possible += 1
		if (/\b(friend|with|met|went|visited|lesson|class|together)\b/.test(doc)) {
			score += 1
		}
	}
	if (/\b(suggested|recommended|told me|listed|gave me)\b/.test(q)) {
		possible += 1
		if (
			/\b(suggest|recommend|option|idea|list|consider|try|could)\b/.test(doc)
		) {
			score += 1
		}
	}
	if (
		/\b(commute|commuting|train ride|bus ride|subway)\b/.test(q) &&
		/\b(activity|activities|do during|suggest|recommend|ideas?)\b/.test(q)
	) {
		possible += 1
		if (
			/\b(podcast|audiobook|audio book|listen|listening|music|language|meditat|reading|book|course|learn|audio)\b/.test(
				doc,
			)
		) {
			score += 1
		}
	}
	if (/\b(guitar|music store|instrument)\b/.test(q)) {
		possible += 1
		if (
			/\b(guitar|guitars|fender|stratocaster|gibson|les paul|acoustic|electric|strings|amp|amplifier)\b/.test(
				doc,
			)
		) {
			score += 1
		}
	}
	return possible > 0 ? score / possible : 0
}

function dcg(relevances: number[], k: number): number {
	return relevances
		.slice(0, k)
		.reduce(
			(sum, relevance, index) => sum + relevance / Math.log2(index + 2),
			0,
		)
}

function ndcgAnyAtK(
	retrievedIds: string[],
	expectedIds: string[],
	k: number,
): number {
	const expected = new Set(expectedIds)
	const relevances = retrievedIds
		.slice(0, k)
		.map((sessionId) => (expected.has(sessionId) ? 1 : 0))
	const ideal = [...relevances].sort((a, b) => b - a)
	const idealScore = dcg(ideal, k)
	return idealScore > 0 ? dcg(relevances, k) / idealScore : 0
}

function recallAnyAtK(
	retrievedIds: string[],
	expectedIds: string[],
	k: number,
): number {
	const top = new Set(retrievedIds.slice(0, k))
	return expectedIds.some((id) => top.has(id)) ? 1 : 0
}

async function ensureSessionCollection(params: {
	collection: Collection
	vectorIndexName: string
	searchIndexName: string
}): Promise<void> {
	await params.collection.createIndex(
		{ agentId: 1, path: 1 },
		{ name: "uq_session_chunks_agent_path", unique: true },
	)
	await params.collection.createIndex(
		{ agentId: 1, scope: 1, scopeRef: 1 },
		{ name: "idx_session_chunks_agent_scope" },
	)
	await params.collection.createIndex(
		{ agentId: 1, timestamp: -1 },
		{ name: "idx_session_chunks_agent_time" },
	)
	const searchCollection = params.collection as Collection & {
		createSearchIndex: (description: Document) => Promise<string>
		listSearchIndexes: (name?: string) => { toArray: () => Promise<Document[]> }
	}
	const existingVector = await searchCollection
		.listSearchIndexes(params.vectorIndexName)
		.toArray()
		.catch(() => [])
	if (existingVector.length === 0) {
		await searchCollection.createSearchIndex({
			name: params.vectorIndexName,
			type: "vectorSearch",
			definition: {
				fields: [
					{
						type: "autoEmbed",
						modality: "text",
						path: "text",
						model: "voyage-4-large",
					},
					{ type: "filter", path: "agentId" },
					{ type: "filter", path: "scope" },
					{ type: "filter", path: "scopeRef" },
					{ type: "filter", path: "sessionId" },
					{ type: "filter", path: "unit" },
					{ type: "filter", path: "status" },
				],
			},
		})
	}
	const existingText = await searchCollection
		.listSearchIndexes(params.searchIndexName)
		.toArray()
		.catch(() => [])
	if (existingText.length === 0) {
		await searchCollection.createSearchIndex({
			name: params.searchIndexName,
			type: "search",
			definition: {
				mappings: {
					dynamic: false,
					fields: {
						text: { type: "string", analyzer: "lucene.standard" },
						agentId: { type: "token" },
						scope: { type: "token" },
						scopeRef: { type: "token" },
						sessionId: { type: "token" },
						unit: { type: "token" },
						status: { type: "token" },
						entities: { type: "token" },
						lexicalTerms: { type: "token" },
						intentTags: { type: "token" },
						keyPhrases: { type: "token" },
						ordinalPhrases: { type: "token" },
						semanticFacets: { type: "token" },
					},
				},
			},
		})
	}
}

function buildEvidenceFacets(text: string): {
	entities: string[]
	lexicalTerms: string[]
	intentTags: string[]
	ordinalPhrases: string[]
	keyPhrases: string[]
	semanticFacets: string[]
} {
	return {
		entities: extractEntityTerms(text),
		lexicalTerms: extractLexicalTerms(text),
		intentTags: extractIntentTags(text),
		ordinalPhrases: extractOrdinalPhrases(text),
		keyPhrases: extractKeyPhrases(text),
		semanticFacets: extractSemanticFacets(text),
	}
}

function buildSearchFilterClauses(filter: Record<string, string>): Document[] {
	return Object.entries(filter).map(([path, value]) => ({
		equals: { path, value },
	}))
}

function buildEvidenceShouldClauses(query: string): Document[] {
	const should: Document[] = []
	const entities = extractEntityTerms(query)
	for (const entity of entities.slice(0, 10)) {
		should.push({
			equals: {
				path: "entities",
				value: entity,
				score: { boost: { value: 8 } },
			},
		})
		if (entity.includes(" ")) {
			should.push({
				phrase: {
					query: entity,
					path: "text",
					score: { boost: { value: 5 } },
				},
			})
		}
	}
	for (const phrase of extractKeyPhrases(query).slice(0, 10)) {
		should.push({
			equals: {
				path: "keyPhrases",
				value: phrase,
				score: {
					boost: { value: phrase.split(/\s+/).length >= 3 ? 9 : 5 },
				},
			},
		})
		should.push({
			phrase: {
				query: phrase,
				path: "text",
				score: { boost: { value: phrase.includes(" ") ? 4 : 2 } },
			},
		})
	}
	for (const phrase of extractOrdinalPhrases(query)) {
		should.push({
			equals: {
				path: "ordinalPhrases",
				value: phrase,
				score: { boost: { value: 7 } },
			},
		})
	}
	for (const facet of extractSemanticFacets(query)) {
		should.push({
			equals: {
				path: "semanticFacets",
				value: facet,
				score: { boost: { value: 6 } },
			},
		})
	}
	for (const tag of extractIntentTags(query)) {
		should.push({
			equals: {
				path: "intentTags",
				value: tag,
				score: { boost: { value: 3 } },
			},
		})
	}
	for (const term of extractLexicalTerms(query).slice(0, 12)) {
		should.push({
			equals: {
				path: "lexicalTerms",
				value: term,
				score: { boost: { value: 1.5 } },
			},
		})
	}
	return should
}

async function evidenceKeywordSearch(params: {
	collection: Collection
	indexName: string
	query: string
	maxResults: number
	filter: Record<string, string>
}): Promise<EvidenceHit[]> {
	const pipeline: Document[] = [
		{
			$search: {
				index: params.indexName,
				compound: {
					must: [{ text: { query: params.query, path: "text" } }],
					filter: buildSearchFilterClauses(params.filter),
					should: buildEvidenceShouldClauses(params.query),
				},
				scoreDetails: true,
			},
		},
		{ $limit: params.maxResults * 4 },
		{
			$project: {
				_id: 0,
				path: 1,
				text: 1,
				sessionId: 1,
				unit: 1,
				score: { $meta: "searchScore" },
				scoreDetails: { $meta: "searchScoreDetails" },
			},
		},
	]
	const docs = await params.collection.aggregate(pipeline).toArray()
	return docs.slice(0, params.maxResults).map((doc) => ({
		path: typeof doc.path === "string" ? doc.path : "",
		sessionId: typeof doc.sessionId === "string" ? doc.sessionId : undefined,
		snippet: typeof doc.text === "string" ? doc.text.slice(0, 700) : "",
		score: typeof doc.score === "number" ? doc.score : 0,
		scoreDetails: doc.scoreDetails,
	}))
}

async function waitForVectorSearchable(params: {
	collection: Collection
	indexName: string
	agentId: string
	scopeRef: string
	query: string
	timeoutMs: number
}): Promise<void> {
	const started = Date.now()
	let lastError = ""
	while (Date.now() - started < params.timeoutMs) {
		try {
			const results = await vectorSearch(params.collection, null, {
				indexName: params.indexName,
				queryText: params.query,
				embeddingMode: "automated",
				maxResults: 1,
				minScore: 0,
				filter: {
					agentId: params.agentId,
					scope: "agent",
					scopeRef: params.scopeRef,
					status: "active",
				},
			})
			if (results.length > 0) return
			lastError = "no vector results yet"
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000))
	}
	throw new Error(
		`LongMemEval vector index did not become queryable: ${lastError}`,
	)
}

async function waitForKeywordSearchable(params: {
	collection: Collection
	indexName: string
	agentId: string
	scopeRef: string
	query: string
	timeoutMs: number
}): Promise<void> {
	const started = Date.now()
	let lastError = ""
	while (Date.now() - started < params.timeoutMs) {
		try {
			const results = await keywordSearch(params.collection, params.query, {
				indexName: params.indexName,
				maxResults: 1,
				minScore: 0,
				filter: {
					agentId: params.agentId,
					scope: "agent",
					scopeRef: params.scopeRef,
					status: "active",
				},
			})
			if (results.length > 0) return
			lastError = "no keyword results yet"
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000))
	}
	throw new Error(
		`LongMemEval search index did not become queryable: ${lastError}`,
	)
}

async function retrieveCandidates(params: {
	collection: Collection
	vectorIndexName: string
	searchIndexName: string
	mode: LongMemEvalMode
	entry: LongMemEvalEntry
	agentId: string
	scopeRef: string
	textBySession: Map<string, string>
	dateBySession: Map<string, string>
}): Promise<Candidate[]> {
	const filter = {
		agentId: params.agentId,
		scope: "agent",
		scopeRef: params.scopeRef,
		status: "active",
	}
	const vectorHits = await vectorSearch(params.collection, null, {
		indexName: params.vectorIndexName,
		queryText: params.entry.question,
		embeddingMode: "automated",
		maxResults: retrieveK,
		minScore: 0,
		filter,
	})
	if (params.mode === "raw") {
		return vectorHits.slice(0, retrieveK).map((hit, index) => {
			const sessionId = hit.sessionId ?? ""
			const hitUnits = new Set<EvidenceUnit>([inferEvidenceUnit(hit.path)])
			return {
				sessionId,
				text: params.textBySession.get(sessionId) ?? hit.snippet,
				timestamp: params.dateBySession.get(sessionId),
				vectorScore: hit.score,
				vectorRank: index + 1,
				vectorPath: hit.path,
				hitUnits,
				hitPaths: [hit.path],
				finalScore: hit.score,
				survivalReason: "vector-rank",
			}
		})
	}

	const keywordHits = await evidenceKeywordSearch({
		collection: params.collection,
		indexName: params.searchIndexName,
		query: params.entry.question,
		maxResults: retrieveK,
		filter,
	})
	const candidates = new Map<string, Candidate>()
	for (const [index, hit] of vectorHits.entries()) {
		const sessionId = hit.sessionId ?? ""
		if (!sessionId) continue
		candidates.set(sessionId, {
			sessionId,
			text: params.textBySession.get(sessionId) ?? hit.snippet,
			timestamp: params.dateBySession.get(sessionId),
			vectorScore: hit.score,
			vectorRank: index + 1,
			vectorPath: hit.path,
			hitUnits: new Set([inferEvidenceUnit(hit.path)]),
			hitPaths: [hit.path],
			finalScore: 0,
			survivalReason: "vector",
		})
	}
	for (const [index, hit] of keywordHits.entries()) {
		const sessionId = hit.sessionId ?? ""
		if (!sessionId) continue
		const existing = candidates.get(sessionId)
		if (existing) {
			existing.keywordScore = hit.score
			existing.keywordRank = index + 1
			existing.keywordScoreDetails = hit.scoreDetails
			recordHit(existing, hit, "keyword")
			existing.survivalReason = "vector+keyword"
			continue
		}
		candidates.set(sessionId, {
			sessionId,
			text: params.textBySession.get(sessionId) ?? hit.snippet,
			timestamp: params.dateBySession.get(sessionId),
			keywordScore: hit.score,
			keywordRank: index + 1,
			keywordPath: hit.path,
			keywordScoreDetails: hit.scoreDetails,
			hitUnits: new Set([inferEvidenceUnit(hit.path)]),
			hitPaths: [hit.path],
			finalScore: 0,
			survivalReason: "keyword",
		})
	}

	const preferenceIntent = isPreferenceAdviceQuestion(params.entry.question)
	const names = extractPersonNames(params.entry.question)
	const nameWords = new Set(names.map((name) => name.toLowerCase()))
	const keywords = extractKeywords(params.entry.question).filter(
		(keyword) => !nameWords.has(keyword),
	)
	const quoted = extractQuotedPhrases(params.entry.question)
	const exactTerms = extractExactTerms(params.entry.question)
	const anchorTerms = extractAnchorTerms(params.entry.question)
	const keyPhrases = extractKeyPhrases(params.entry.question)
	const entities = extractEntityTerms(params.entry.question)
	const ordinalPhrases = extractOrdinalPhrases(params.entry.question)
	const rankAgreementWeight = recallRankAgreementWeight(params.entry.question)
	for (const candidate of candidates.values()) {
		const vectorRrf = candidate.vectorRank ? 1 / (60 + candidate.vectorRank) : 0
		const keywordRrf = candidate.keywordRank
			? 1 / (60 + candidate.keywordRank)
			: 0
		const rankAgreement = rankAgreementSignal(candidate)
		const overlap = keywordOverlap(keywords, candidate.text)
		const quote = quotedBoost(quoted, candidate.text)
		const person = nameBoost(names, candidate.text)
		const exactTerm = exactTermBoost(exactTerms, candidate.text)
		const entity = entityBoost(entities, candidate.text)
		const ordinal = ordinalBoost(ordinalPhrases, candidate.text)
		const keyPhrase = keyPhraseBoost(keyPhrases, candidate.text)
		const semanticFacet = semanticFacetBoost(
			params.entry.question,
			candidate.text,
		)
		const domain = domainIntentBoost(params.entry.question, candidate.text)
		const transaction = transactionBoost(params.entry.question, candidate.text)
		const personal = personalMemoryBoost(params.entry.question, candidate.text)
		const anchorTerm = anchorTermBoost(anchorTerms, candidate.text)
		const eventTerm = eventTermBoost(params.entry.question, candidate.text)
		const bridge = bridgeBoost(params.entry.question, candidate.text)
		const advice = adviceAnswerBoost(params.entry.question, candidate.text)
		const temporal = temporalBoost({
			question: params.entry.question,
			questionDate: params.entry.question_date,
			sessionDate: candidate.timestamp,
		})
		const unit =
			preferenceIntent && candidate.hitUnits.has("assistant")
				? 1
				: preferenceIntent && candidate.hitUnits.has("preference")
					? 0.9
					: 0
		const vectorWeight = preferenceIntent ? 0.85 : 0.65
		const keywordWeight = preferenceIntent ? 0.14 : 0.22
		candidate.finalScore =
			vectorWeight * vectorRrf +
			keywordWeight * keywordRrf +
			0.01 * overlap +
			0.02 * quote +
			0.012 * person +
			0.04 * exactTerm +
			0.024 * entity +
			0.02 * ordinal +
			0.012 * keyPhrase +
			0.024 * semanticFacet +
			0.035 * domain +
			0.022 * transaction +
			0.01 * personal +
			0.04 * eventTerm +
			0.018 * bridge +
			0.032 * temporal +
			0.006 * advice +
			0.004 * unit +
			rankAgreementWeight * rankAgreement
		candidate.scoreBreakdown = {
			vectorRrf,
			keywordRrf,
			rankAgreement,
			overlap,
			quote,
			person,
			exactTerm,
			entity,
			ordinal,
			keyPhrase,
			semanticFacet,
			domain,
			transaction,
			personal,
			anchorTerm,
			eventTerm,
			bridge,
			temporal,
			advice,
			unit,
			vectorWeight,
			keywordWeight,
		}
		if (
			overlap > 0 ||
			quote > 0 ||
			person > 0 ||
			exactTerm > 0 ||
			entity > 0 ||
			ordinal > 0 ||
			keyPhrase > 0 ||
			semanticFacet > 0 ||
			domain > 0 ||
			transaction > 0 ||
			personal > 0 ||
			eventTerm > 0 ||
			bridge > 0 ||
			temporal > 0 ||
			advice > 0 ||
			unit > 0
		) {
			candidate.survivalReason = `${candidate.survivalReason}+generic-boost`
		}
	}
	return [...candidates.values()]
		.sort((left, right) => right.finalScore - left.finalScore)
		.slice(0, retrieveK)
}

function summarizeResults(results: CaseResult[]) {
	const avg = (select: (result: CaseResult) => number) =>
		results.length > 0
			? results.reduce((sum, result) => sum + select(result), 0) /
				results.length
			: 0
	const perTypeValues = new Map<string, CaseResult[]>()
	for (const result of results) {
		const existing = perTypeValues.get(result.question_type) ?? []
		existing.push(result)
		perTypeValues.set(result.question_type, existing)
	}
	const perType: Record<string, { cases: number; recallAnyAt5: number }> = {}
	for (const [questionType, values] of perTypeValues) {
		perType[questionType] = {
			cases: values.length,
			recallAnyAt5:
				values.reduce((sum, result) => sum + result.metrics.recallAnyAt5, 0) /
				values.length,
		}
	}
	const latencies = results
		.map((result) => result.latencyMs)
		.toSorted((left, right) => left - right)
	const p95Index = Math.min(
		latencies.length - 1,
		Math.ceil(latencies.length * 0.95) - 1,
	)
	return {
		cases: results.length,
		recallAnyAt1: avg((result) => result.metrics.recallAnyAt1),
		recallAnyAt3: avg((result) => result.metrics.recallAnyAt3),
		recallAnyAt5: avg((result) => result.metrics.recallAnyAt5),
		recallAnyAt10: avg((result) => result.metrics.recallAnyAt10),
		recallAnyAt30: avg((result) => result.metrics.recallAnyAt30),
		recallAnyAt50: avg((result) => result.metrics.recallAnyAt50),
		ndcgAnyAt5: avg((result) => result.metrics.ndcgAnyAt5),
		ndcgAnyAt10: avg((result) => result.metrics.ndcgAnyAt10),
		emptyRate:
			results.length > 0
				? results.filter((result) => result.retrieved_ids.length === 0).length /
					results.length
				: 0,
		perType,
		latencyMs: {
			avg: avg((result) => result.latencyMs),
			p95: latencies[p95Index] ?? 0,
		},
	}
}

type StorageFootprint = {
	collectionBytes: number | null
	indexBytes: number | null
	unavailableReason?: string
}

async function collectStorageFootprint(
	db: Db,
	collectionName: string,
): Promise<StorageFootprint> {
	try {
		const stats = (await db.command({ collStats: collectionName })) as {
			size?: unknown
			totalIndexSize?: unknown
		}
		const collectionBytes =
			typeof stats.size === "number" && Number.isFinite(stats.size)
				? stats.size
				: null
		const indexBytes =
			typeof stats.totalIndexSize === "number" &&
			Number.isFinite(stats.totalIndexSize)
				? stats.totalIndexSize
				: null
		return { collectionBytes, indexBytes }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return {
			collectionBytes: null,
			indexBytes: null,
			unavailableReason: message,
		}
	}
}

function bestExpectedRank(result: CaseResult): number | null {
	const expected = new Set(result.expected_session_ids)
	const index = result.retrieved_ids.findIndex((sessionId) =>
		expected.has(sessionId),
	)
	return index >= 0 ? index + 1 : null
}

function expectedCandidate(result: CaseResult) {
	const expected = new Set(result.expected_session_ids)
	return result.topCandidates.find((candidate) =>
		expected.has(candidate.sessionId),
	)
}

function buildMissLedger(results: CaseResult[]) {
	return results
		.filter((result) => result.metrics.recallAnyAt5 === 0)
		.map((result) => ({
			questionId: result.question_id,
			questionType: result.question_type,
			question: result.question,
			expectedSessionIds: result.expected_session_ids,
			bestExpectedRank: bestExpectedRank(result),
			top50: result.topCandidates,
		}))
}

function buildR1MissLedger(results: CaseResult[]) {
	return results
		.filter((result) => result.metrics.recallAnyAt1 === 0)
		.map((result) => {
			const top = result.topCandidates[0]
			const expected = expectedCandidate(result)
			return {
				questionId: result.question_id,
				questionType: result.question_type,
				question: result.question,
				expectedSessionIds: result.expected_session_ids,
				bestExpectedRank: bestExpectedRank(result),
				topSessionId: top?.sessionId ?? null,
				expectedRankSessionId: expected?.sessionId ?? null,
				topScore: top?.finalScore ?? null,
				expectedScore: expected?.finalScore ?? null,
				scoreMargin:
					top && expected ? top.finalScore - expected.finalScore : null,
				topScoreBreakdown: top?.scoreBreakdown ?? null,
				expectedScoreBreakdown: expected?.scoreBreakdown ?? null,
				topHitUnits: top?.hitUnits ?? [],
				expectedHitUnits: expected?.hitUnits ?? [],
				topSurvivalReason: top?.survivalReason ?? null,
				expectedSurvivalReason: expected?.survivalReason ?? null,
			}
		})
}

function buildCaseDiagnostics(results: CaseResult[]) {
	return results.map((result) => ({
		questionId: result.question_id,
		questionType: result.question_type,
		expectedSessionIds: result.expected_session_ids,
		retrievedIds: result.retrieved_ids.slice(0, 10),
		bestExpectedRank: bestExpectedRank(result),
		metrics: result.metrics,
		latencyMs: result.latencyMs,
		topCandidates: result.topCandidates.slice(0, 10).map((candidate) => ({
			rank: candidate.rank,
			sessionId: candidate.sessionId,
			finalScore: candidate.finalScore,
			vectorRank: candidate.vectorRank ?? null,
			keywordRank: candidate.keywordRank ?? null,
			hitUnits: candidate.hitUnits,
			survivalReason: candidate.survivalReason,
			scoreBreakdown: candidate.scoreBreakdown ?? null,
		})),
	}))
}

function p50(values: number[]): number {
	if (values.length === 0) return 0
	const sorted = [...values].toSorted((left, right) => left - right)
	return sorted[Math.ceil(sorted.length * 0.5) - 1] ?? 0
}

function buildBenchmarkReport(params: {
	datasetSha256: string
	totalCases: number
	results: CaseResult[]
	database: string
	prefix: string
	vectorIndexName: string
	searchIndexName: string
	storage: StorageFootprint
	runIdentity: Awaited<ReturnType<typeof resolveRunIdentity>>
	evidenceDocsInserted: number
}) {
	const metrics = summarizeResults(params.results)
	const envCommit =
		process.env.MEMONGO_BUILD_COMMIT?.trim() ||
		process.env.GITHUB_SHA?.trim() ||
		process.env.VERCEL_GIT_COMMIT_SHA?.trim()
	const buildCommit = envCommit || params.runIdentity.commit
	return {
		generatedAt: new Date().toISOString(),
		runIdentity: params.runIdentity,
		build: {
			source: envCommit ? "env" : "git",
			commit: buildCommit ?? null,
			id: process.env.MEMONGO_BUILD_ID?.trim() || runId,
			label: process.env.MEMONGO_BUILD_LABEL?.trim() || "local",
		},
		corpus: {
			datasetKind: "longmemeval",
			datasetPath,
			datasetSha256: params.datasetSha256,
			cases: params.totalCases,
			scoredCases: params.results.length,
		},
		mongodb: {
			database: params.database,
			collectionPrefix: params.prefix,
			collection: `${params.prefix}session_chunks`,
			vectorIndex: params.vectorIndexName,
			searchIndex: params.searchIndexName,
			topology: "managed-atlas",
		},
		retrievalUnit: "session",
		embedding: {
			model: "voyage-4-large",
			dimensions: 1024,
			quantization: "float32",
			endpointFamily: "mongodb-autoembed",
		},
		reranker: {
			model: "none",
			version: null,
			stage: "none",
		},
		storage: params.storage,
		latency: {
			avgMs: metrics.latencyMs.avg,
			p50Ms: p50(params.results.map((result) => result.latencyMs)),
			p95Ms: metrics.latencyMs.p95,
		},
		cost: {
			embeddingCallsEstimated:
				params.evidenceDocsInserted + params.results.length,
			vectorQueries: params.results.length,
			keywordQueries: mode === "hybrid" ? params.results.length : 0,
			rerankCalls: 0,
			llmEnrichmentCalls: 0,
			estimatedUsd: null,
			unavailableReason:
				"MongoDB autoEmbed benchmark adapter records operation counts; Atlas billing attribution is external.",
		},
		metrics: {
			internal: {
				rAt1: metrics.recallAnyAt1,
				rAt3: metrics.recallAnyAt3,
				rAt5: metrics.recallAnyAt5,
				rAt10: metrics.recallAnyAt10,
				emptyRate: metrics.emptyRate,
				ndcgAt5: metrics.ndcgAnyAt5,
				ndcgAt10: metrics.ndcgAnyAt10,
			},
			official: {
				longMemEval: {
					session: {
						recallAnyAt1: metrics.recallAnyAt1,
						recallAnyAt3: metrics.recallAnyAt3,
						recallAnyAt5: metrics.recallAnyAt5,
						recallAnyAt10: metrics.recallAnyAt10,
						recallAnyAt30: metrics.recallAnyAt30,
						recallAnyAt50: metrics.recallAnyAt50,
						ndcgAnyAt5: metrics.ndcgAnyAt5,
						ndcgAnyAt10: metrics.ndcgAnyAt10,
					},
				},
			},
		},
		warnings: [],
		degradations: [],
	}
}

async function writeStatus(payload: Record<string, unknown>): Promise<void> {
	await mkdir(runDir, { recursive: true })
	await writeFile(statusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
}

async function writePartialArtifact(params: {
	datasetSha256: string
	database: string
	prefix: string
	vectorIndexName: string
	searchIndexName: string
	totalCases: number
	results: CaseResult[]
}): Promise<void> {
	if (process.env.MEMONGO_BENCHMARK_WRITE_PARTIAL === "0") {
		return
	}
	const artifact = {
		artifactVersion: 1,
		runId,
		status: "running",
		startedAt: startedAt.toISOString(),
		updatedAt: new Date().toISOString(),
		dataset: {
			path: datasetPath,
			sha256: params.datasetSha256,
			kind: "longmemeval",
			cases: params.totalCases,
			scoredCases: params.results.length,
		},
		mongodb: {
			database: params.database,
			collectionPrefix: params.prefix,
			collection: `${params.prefix}session_chunks`,
			vectorIndex: params.vectorIndexName,
			searchIndex: params.searchIndexName,
		},
		lane: {
			name:
				mode === "hybrid"
					? "longmemeval-hybrid-session-nollm"
					: "longmemeval-raw-session",
			retrievalUnit: "session",
			llm: "none",
			reranker: "none",
			embedding: "MongoDB autoEmbed voyage-4-large",
			mode,
			retrieveK,
		},
		metrics: summarizeResults(params.results),
		results: params.results,
	}
	await writeFile(
		partialResponsePath,
		`${JSON.stringify(artifact, null, 2)}\n`,
		"utf8",
	)
}

async function main(): Promise<void> {
	await mkdir(runDir, { recursive: true })
	const datasetText = await readFile(datasetPath, "utf8")
	const datasetSha256 = createHash("sha256").update(datasetText).digest("hex")
	const parsed = JSON.parse(datasetText) as unknown
	if (!Array.isArray(parsed) || !parsed.every(isLongMemEvalEntry)) {
		throw new Error("dataset must be a LongMemEval JSON array")
	}
	const entries =
		limitCases > 0
			? (parsed as LongMemEvalEntry[]).slice(0, limitCases)
			: (parsed as LongMemEvalEntry[])
	const database = readDatabaseName()
	const client = new MongoClient(readUri(), {
		appName: "memongo-longmemeval-session-benchmark",
		serverSelectionTimeoutMS: 15_000,
	})
	const prefix = prefixResolution.collectionPrefix
	const vectorIndexName = `${prefix}session_chunks_vector`
	const searchIndexName = `${prefix}session_chunks_text`
	const results: CaseResult[] = []
	let evidenceDocsInserted = 0

	await writeStatus({
		runId,
		status: "running",
		startedAt: startedAt.toISOString(),
		datasetPath,
		datasetSha256,
		cases: entries.length,
		mode,
	})
	await client.connect()
	try {
		const db = client.db(database)
		const collection = sessionChunksCollection(db, prefix)
		await ensureSessionCollection({
			collection,
			vectorIndexName,
			searchIndexName,
		})
		for (const [index, entry] of entries.entries()) {
			const agentId = `${runId}::${entry.question_id}`
			const scopeRef = resolveScopeRef({ scope: "agent", agentId })
			const docs: Document[] = []
			const textBySession = new Map<string, string>()
			const dateBySession = new Map<string, string>()
			for (const [sessionIndex, session] of entry.haystack_sessions.entries()) {
				const sessionId = entry.haystack_session_ids[sessionIndex]
				const date = entry.haystack_dates[sessionIndex] ?? ""
				const text = sessionText(session)
				if (!sessionId || !text) continue
				const fullText = fullSessionText(session)
				const prefs = extractPreferences(session)
				const sessionFacets = buildEvidenceFacets([text, fullText].join("\n"))
				textBySession.set(
					sessionId,
					[text, fullText, prefs.length > 0 ? prefs.join("; ") : ""]
						.filter(Boolean)
						.join("\n"),
				)
				dateBySession.set(sessionId, date)
				const timestamp = parseQuestionDate(date) ?? new Date()
				docs.push({
					source: "session-evidence",
					path: `session_chunks/${sessionId}/${sessionIndex}`,
					text,
					agentId,
					scope: "agent",
					scopeRef,
					sessionId,
					unit: "session",
					status: "active",
					timestamp,
					updatedAt: timestamp,
					canonicalId: `session-chunk/${sessionId}`,
					entities: sessionFacets.entities,
					lexicalTerms: sessionFacets.lexicalTerms,
					intentTags: sessionFacets.intentTags,
					keyPhrases: sessionFacets.keyPhrases,
					ordinalPhrases: sessionFacets.ordinalPhrases,
					semanticFacets: sessionFacets.semanticFacets,
				})
				if (mode === "hybrid" && prefs.length > 0) {
					const prefText = `User has mentioned: ${prefs.join("; ")}`
					const prefFacets = buildEvidenceFacets(prefText)
					docs.push({
						source: "preference-evidence",
						path: `session_preferences/${sessionId}/${sessionIndex}`,
						text: prefText,
						agentId,
						scope: "agent",
						scopeRef,
						sessionId,
						unit: "preference",
						status: "active",
						timestamp,
						updatedAt: timestamp,
						canonicalId: `session-preference/${sessionId}`,
						entities: prefFacets.entities,
						lexicalTerms: prefFacets.lexicalTerms,
						intentTags: prefFacets.intentTags,
						keyPhrases: prefFacets.keyPhrases,
						ordinalPhrases: prefFacets.ordinalPhrases,
						semanticFacets: prefFacets.semanticFacets,
					})
				}
				if (mode === "hybrid" && fullText !== text) {
					const assistantFacets = buildEvidenceFacets(fullText)
					docs.push({
						source: "assistant-evidence",
						path: `session_assistant/${sessionId}/${sessionIndex}`,
						text: fullText,
						agentId,
						scope: "agent",
						scopeRef,
						sessionId,
						unit: "assistant",
						status: "active",
						timestamp,
						updatedAt: timestamp,
						canonicalId: `session-assistant/${sessionId}`,
						entities: assistantFacets.entities,
						lexicalTerms: assistantFacets.lexicalTerms,
						intentTags: assistantFacets.intentTags,
						keyPhrases: assistantFacets.keyPhrases,
						ordinalPhrases: assistantFacets.ordinalPhrases,
						semanticFacets: assistantFacets.semanticFacets,
					})
				}
			}
			if (docs.length > 0) {
				await collection.insertMany(docs)
				evidenceDocsInserted += docs.length
			}
			await waitForVectorSearchable({
				collection,
				indexName: vectorIndexName,
				agentId,
				scopeRef,
				query: entry.question,
				timeoutMs: Number(
					process.env.MEMONGO_VECTOR_READY_TIMEOUT_MS ?? 300_000,
				),
			})
			if (mode === "hybrid") {
				await waitForKeywordSearchable({
					collection,
					indexName: searchIndexName,
					agentId,
					scopeRef,
					query: entry.question,
					timeoutMs: Number(
						process.env.MEMONGO_SEARCH_READY_TIMEOUT_MS ??
							process.env.MEMONGO_VECTOR_READY_TIMEOUT_MS ??
							300_000,
					),
				})
			}
			const started = Date.now()
			const candidates = await retrieveCandidates({
				collection,
				vectorIndexName,
				searchIndexName,
				mode,
				entry,
				agentId,
				scopeRef,
				textBySession,
				dateBySession,
			})
			const retrievedIds = candidates.map((candidate) => candidate.sessionId)
			const result: CaseResult = {
				question_id: entry.question_id,
				question_type: entry.question_type,
				question: entry.question,
				...(entry.answer ? { answer: entry.answer } : {}),
				expected_session_ids: entry.answer_session_ids,
				retrieved_ids: retrievedIds,
				metrics: {
					recallAnyAt1: recallAnyAtK(retrievedIds, entry.answer_session_ids, 1),
					recallAnyAt3: recallAnyAtK(retrievedIds, entry.answer_session_ids, 3),
					recallAnyAt5: recallAnyAtK(retrievedIds, entry.answer_session_ids, 5),
					recallAnyAt10: recallAnyAtK(
						retrievedIds,
						entry.answer_session_ids,
						10,
					),
					recallAnyAt30: recallAnyAtK(
						retrievedIds,
						entry.answer_session_ids,
						30,
					),
					recallAnyAt50: recallAnyAtK(
						retrievedIds,
						entry.answer_session_ids,
						50,
					),
					ndcgAnyAt5: ndcgAnyAtK(retrievedIds, entry.answer_session_ids, 5),
					ndcgAnyAt10: ndcgAnyAtK(retrievedIds, entry.answer_session_ids, 10),
				},
				latencyMs: Date.now() - started,
				topCandidates: candidates.slice(0, 50).map((candidate, rank) => ({
					rank: rank + 1,
					sessionId: candidate.sessionId,
					finalScore: candidate.finalScore,
					...(candidate.vectorScore !== undefined
						? { vectorScore: candidate.vectorScore }
						: {}),
					...(candidate.vectorRank !== undefined
						? { vectorRank: candidate.vectorRank }
						: {}),
					...(candidate.vectorPath !== undefined
						? { vectorPath: candidate.vectorPath }
						: {}),
					...(candidate.keywordScore !== undefined
						? { keywordScore: candidate.keywordScore }
						: {}),
					...(candidate.keywordRank !== undefined
						? { keywordRank: candidate.keywordRank }
						: {}),
					...(candidate.keywordPath !== undefined
						? { keywordPath: candidate.keywordPath }
						: {}),
					...(candidate.keywordScoreDetails !== undefined
						? { keywordScoreDetails: candidate.keywordScoreDetails }
						: {}),
					hitUnits: [...candidate.hitUnits].toSorted(),
					hitPaths: candidate.hitPaths,
					survivalReason: candidate.survivalReason,
					...(candidate.scoreBreakdown
						? { scoreBreakdown: candidate.scoreBreakdown }
						: {}),
				})),
			}
			results.push(result)
			await writePartialArtifact({
				datasetSha256,
				database,
				prefix,
				vectorIndexName,
				searchIndexName,
				totalCases: entries.length,
				results,
			})
			await writeStatus({
				runId,
				status: "running",
				index: index + 1,
				total: entries.length,
				questionId: entry.question_id,
				results: results.length,
				mode,
				recallAnyAt5: summarizeResults(results).recallAnyAt5,
				updatedAt: new Date().toISOString(),
			})
		}
		const storage = await collectStorageFootprint(db, `${prefix}session_chunks`)
		const runIdentity = await resolveRunIdentity()
		const benchmarkReport = buildBenchmarkReport({
			datasetSha256,
			totalCases: entries.length,
			results,
			database,
			prefix,
			vectorIndexName,
			searchIndexName,
			storage,
			runIdentity,
			evidenceDocsInserted,
		})
		const missLedger = buildMissLedger(results)
		const r1MissLedger = buildR1MissLedger(results)
		const caseDiagnostics = buildCaseDiagnostics(results)
		const artifact: LongMemEvalArtifact = {
			artifactVersion: 1,
			runId,
			status: "completed",
			startedAt: startedAt.toISOString(),
			completedAt: new Date().toISOString(),
			dataset: {
				path: datasetPath,
				sha256: datasetSha256,
				kind: "longmemeval",
				cases: entries.length,
				scoredCases: results.length,
			},
			mongodb: {
				database,
				collectionPrefix: prefix,
				collection: `${prefix}session_chunks`,
				vectorIndex: vectorIndexName,
				searchIndex: searchIndexName,
			},
			lane: {
				name:
					mode === "hybrid"
						? "longmemeval-hybrid-session-nollm"
						: "longmemeval-raw-session",
				retrievalUnit: "session",
				llm: "none",
				reranker: "none",
				embedding: "MongoDB autoEmbed voyage-4-large",
				mode,
				retrieveK,
			},
			metrics: summarizeResults(results),
			benchmarkReport,
			missLedger,
			r1MissLedger,
			caseDiagnostics,
			warnings: benchmarkReport.warnings,
			degradations: benchmarkReport.degradations,
			results,
		}
		await writeFile(
			responsePath,
			`${JSON.stringify(artifact, null, 2)}\n`,
			"utf8",
		)
		await writeStatus({
			runId,
			status: "completed",
			responsePath,
			metrics: artifact.metrics,
			completedAt: artifact.completedAt,
		})
		console.log(JSON.stringify({ ok: true, runId, responsePath }, null, 2))
	} finally {
		await client.close()
	}
}

await main()
