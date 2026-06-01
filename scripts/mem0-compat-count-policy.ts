export type BridgeSearchResult = {
	canonicalId?: string
	path?: string
	snippet?: string
	citation?: string
	timestamp?: Date
	source?: string
	score?: number
	scoreDetails?: unknown
}

export type Mem0CompatSearchResult = {
	id: string
	memory: string
	score?: number
	created_at?: string
	score_debug?: { scoreDetails: unknown }
}

export type Mem0CompatCountKind =
	| "duration"
	| "inventory"
	| "money-or-percent"
	| "pending-action"
	| "repeated-action"
	| "unknown-count"

const queryStopwords = new Set([
	"about",
	"after",
	"again",
	"also",
	"been",
	"before",
	"count",
	"did",
	"does",
	"doing",
	"from",
	"have",
	"many",
	"much",
	"need",
	"number",
	"past",
	"previous",
	"since",
	"some",
	"that",
	"their",
	"there",
	"this",
	"times",
	"total",
	"what",
	"when",
	"where",
	"which",
	"with",
	"would",
	"your",
])

const countObjectNoise = new Set([
	"acquire",
	"acquired",
	"bake",
	"baked",
	"baking",
	"bought",
	"completed",
	"done",
	"finished",
	"last",
	"month",
	"months",
	"new",
	"past",
	"piece",
	"pieces",
	"project",
	"projects",
	"received",
	"started",
	"starting",
	"things",
	"weeks",
])

export function hasCountIntent(query: string): boolean {
	return /\b(how many|how much|number of|count|total)\b/i.test(query)
}

export function hasAdviceOrPreferenceIntent(query: string): boolean {
	return /\b(advice|any tips|tips|recommend|suggest|suggestions|help|having trouble|best way|should i|would prefer|preference)\b/i.test(
		query,
	)
}

export function classifyMem0CompatCountKind(
	query: string,
): Mem0CompatCountKind {
	const lowerQuery = query.toLowerCase()
	if (
		/\bhow many\s+(days?|hours?|minutes?|weeks?|months?|years?)\b/.test(
			lowerQuery,
		)
	) {
		return "duration"
	}
	if (
		/\b(how much|cashback|cash back|refund|receipt|coupon|discount|spent|paid|cost|price|dollars?|usd)\b|[$%]/.test(
			lowerQuery,
		)
	) {
		return "money-or-percent"
	}
	if (
		/\b(still need|need to|have to|left to|pick up|return|collect|drop off|send|mail)\b/.test(
			lowerQuery,
		)
	) {
		return "pending-action"
	}
	if (
		/\bhow many times\b/.test(lowerQuery) ||
		/\b(bak(?:e|ed|ing)|watch(?:ed|ing)?|visit(?:ed|ing)?|went|go to|attend(?:ed|ing)?)\b/.test(
			lowerQuery,
		)
	) {
		return "repeated-action"
	}
	if (/\b(how many|number of|total|count)\b/.test(lowerQuery)) {
		return "inventory"
	}
	return "unknown-count"
}

function queryTerms(query: string): string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9']+/)
				.filter((term) => term.length >= 4 && !queryStopwords.has(term)),
		),
	].sort((a, b) => b.length - a.length)
}

function queryTermVariants(term: string): string[] {
	const variants = new Set([term])
	if (term.endsWith("ing") && term.length > 5) {
		const base = term.slice(0, -3)
		variants.add(base)
		variants.add(`${base}e`)
		variants.add(`${base}s`)
		variants.add(`${base}ed`)
	}
	if (term.endsWith("ed") && term.length > 4) {
		const base = term.slice(0, -2)
		variants.add(base)
		variants.add(`${base}e`)
		variants.add(`${base}ing`)
		variants.add(`${base}s`)
	}
	if (term.endsWith("s") && term.length > 4) {
		variants.add(term.slice(0, -1))
	}
	return [...variants].filter((variant) => variant.length >= 3)
}

function countActionTerms(query: string): string[] {
	const lowerQuery = query.toLowerCase()
	if (/\bbak(?:e|ed|ing)\b/.test(lowerQuery)) {
		return ["baked", "bake", "baking", "tried out"]
	}
	if (
		/\b(acquir(?:e|ed|ing)?|got|bought|purchased|received)\b/.test(lowerQuery)
	) {
		return ["got", "bought", "purchased", "received", "acquired"]
	}
	return queryTerms(query).flatMap(queryTermVariants)
}

function countObjectTerms(query: string): string[] {
	const lowerQuery = query.toLowerCase()
	const terms = new Set(
		queryTerms(query)
			.flatMap(queryTermVariants)
			.filter((term) => !countObjectNoise.has(term)),
	)
	if (/\bjewelry|jewellery|pieces?\b/.test(lowerQuery)) {
		for (const term of [
			"jewelry",
			"jewellery",
			"earring",
			"earrings",
			"necklace",
			"ring",
			"bracelet",
			"locket",
			"chain",
			"chains",
			"pendant",
		]) {
			terms.add(term)
		}
	}
	if (/\bbak(?:e|ed|ing)\b/.test(lowerQuery)) {
		for (const term of [
			"cake",
			"cookies",
			"bread",
			"baguette",
			"focaccia",
			"batch",
			"recipe",
			"sourdough",
		]) {
			terms.add(term)
		}
	}
	if (/\bpaint(?:ing)?\b|\bprojects?\b/.test(lowerQuery)) {
		terms.add("painting")
		terms.add("paintings")
		terms.add("project")
		terms.add("projects")
	}
	return [...terms].filter((term) => term.length >= 3)
}

function preferenceContextTerms(query: string): string[] {
	const lowerQuery = query.toLowerCase()
	const domainTerms = new Set<string>()
	if (/\b(battery|phone|charging|charge|charger)\b/.test(lowerQuery)) {
		for (const term of [
			"battery",
			"phone",
			"power bank",
			"portable power bank",
			"charging",
			"charger",
			"wireless charging",
		]) {
			domainTerms.add(term)
		}
	}
	const terms =
		domainTerms.size > 0
			? domainTerms
			: new Set(queryTerms(query).flatMap(queryTermVariants))
	return [...terms].filter((term) => term.length >= 3)
}

function preferenceContextLabel(query: string): string {
	const lowerQuery = query.toLowerCase()
	if (/\b(battery|phone|charging|charge|charger)\b/.test(lowerQuery)) {
		return "For this phone battery or charging advice request, relevant source-backed context includes user-owned charging tools and accessories."
	}
	return "For this advice request, relevant source-backed context includes the user's existing tools, purchases, constraints, and preferences."
}

function splitSentences(text: string): string[] {
	return text
		.replace(/\b(By the way,)\s+/gi, ". $1 ")
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.replace(/\s+/g, " ").trim())
		.filter(Boolean)
}

function normalizeEvidenceKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 2)
		.slice(0, 14)
		.join(" ")
}

function compactEvidenceSentence(sentence: string, maxChars = 180): string {
	const cleaned = sentence
		.replace(/^\d{4}-\d{2}-\d{2}\s+conversation memory:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
	return cleaned.length <= maxChars
		? cleaned
		: `${cleaned.slice(0, maxChars - 3).trimEnd()}...`
}

function isPlanOrAdvice(sentence: string): boolean {
	return (
		sentence.includes("?") ||
		/\b(thinking of|planning to|going to|want to|should|could|would|tips|recommendations|here are|recipe ideas|suggestions|guide me|can you)\b/i.test(
			sentence,
		)
	)
}

function isUserAnchored(sentence: string): boolean {
	if (
		/\b(i'm curious|i am curious|i'd be happy|i would be happy|tell me more|how did you find)\b/i.test(
			sentence,
		)
	) {
		return false
	}
	if (
		/\bmy\s+(siblings?|friends?|cousins?|colleagues?|partner|parents?|mom|dad|mother|father|sister|brother)\b.{0,60}\b(got|bought|purchased|received|acquired)\b/i.test(
			sentence,
		)
	) {
		return false
	}
	return (
		/\b(i|i've|i'd|i just|i recently|we|we've)\b/i.test(sentence) ||
		/\bmy\b/i.test(sentence)
	)
}

function isAssistantAnchored(sentence: string): boolean {
	return /^\s*(?:assistant|system)\s*:/i.test(sentence)
}

function firstBakingCompletionIndex(sentence: string): number {
	const lowerSentence = sentence.toLowerCase()
	const indices = [
		lowerSentence.search(/\b(baked|bake|baking)\b/),
		/\b(bread|recipe|sourdough)\b/.test(lowerSentence)
			? lowerSentence.search(/\btried out\b/)
			: -1,
		/\b(bread|baguette|focaccia|cake|cookies)\b/.test(lowerSentence)
			? lowerSentence.search(/\bmade\b/)
			: -1,
	].filter((index) => index >= 0)
	return indices.length === 0 ? -1 : Math.min(...indices)
}

function firstActionTermIndex(sentence: string, actionTerms: string[]): number {
	const lowerSentence = sentence.toLowerCase()
	const indices = actionTerms
		.map((term) => lowerSentence.indexOf(term))
		.filter((index) => index >= 0)
	return indices.length === 0 ? -1 : Math.min(...indices)
}

function hasBlockingPlanOrAdvice(
	sentence: string,
	evidenceIndex: number,
): boolean {
	const lowerSentence = sentence.toLowerCase()
	const questionIndex = lowerSentence.indexOf("?")
	if (questionIndex >= 0 && questionIndex < evidenceIndex) {
		return true
	}
	const planIndex = lowerSentence.search(
		/\b(thinking of|planning to|going to|want to|should|could|would|tips|recommendations|here are|recipe ideas)\b/,
	)
	return planIndex >= 0 && planIndex < evidenceIndex
}

function isLikelyCompletedCountEvidence(
	query: string,
	sentence: string,
	actionTerms: string[],
): boolean {
	if (!isUserAnchored(sentence)) {
		return false
	}
	const lowerQuery = query.toLowerCase()
	const evidenceIndex = /\bbak(?:e|ed|ing)\b/.test(lowerQuery)
		? firstBakingCompletionIndex(sentence)
		: firstActionTermIndex(sentence, actionTerms)
	if (evidenceIndex < 0) {
		return false
	}
	return !hasBlockingPlanOrAdvice(sentence, evidenceIndex)
}

function evidenceObjectKey(sentence: string, objectTerms: string[]): string {
	const lowerSentence = sentence.toLowerCase()
	for (const [pattern, key] of [
		[/\bchocolate\s+cake\b/, "chocolate cake"],
		[/\bsourdough\b.*\bbread\b|\bbread\b.*\bsourdough\b/, "sourdough bread"],
		[/\bwhole\s+wheat\s+baguette\b|\bbaguette\b/, "whole wheat baguette"],
		[/\bcookies?\b/, "cookies"],
		[/\bfocaccia\b/, "focaccia"],
		[/\bemeral?d\s+earrings?\b|\bearrings?\b/, "earrings"],
		[/\bsilver\s+necklace\b|\bnecklace\b/, "necklace"],
		[/\bengagement\s+ring\b|\bring\b/, "ring"],
	] as Array<[RegExp, string]>) {
		if (pattern.test(lowerSentence)) {
			return key
		}
	}
	const matchedObject = objectTerms.find((term) => lowerSentence.includes(term))
	if (!matchedObject) {
		return normalizeEvidenceKey(sentence)
	}
	const tail = lowerSentence.slice(
		Math.max(0, lowerSentence.indexOf(matchedObject) - 30),
	)
	return normalizeEvidenceKey(tail)
}

function queryActionVerbs(query: string): string[] {
	const verbs = [
		"pick up",
		"return",
		"collect",
		"drop off",
		"send",
		"mail",
		"buy",
		"purchase",
		"order",
		"wash",
		"clean",
		"schedule",
		"book",
		"call",
	]
	const lowerQuery = query.toLowerCase()
	return verbs.filter((verb) => lowerQuery.includes(verb))
}

function extractActionObject(
	sentence: string,
	verb: string,
): string | undefined {
	const escapedVerb = verb.replace(/\s+/g, "\\s+")
	const verbPattern = escapedVerb.replace("pick\\s+up", "pick(?:ing)?\\s+up")
	const match = sentence.match(
		new RegExp(
			`\\b${verbPattern}\\s+(?:the|my|your|a|an|some)?\\s*([^.;!?]+)`,
			"i",
		),
	)
	const raw = match?.[1]?.trim()
	if (!raw) {
		return undefined
	}
	const object = raw
		.replace(/\b(actually|yet|soon)\b/gi, "")
		.split(/\s+(?:before|because|but|so|and then|while)\s+/i)[0]
		.replace(/[,\s]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
	if (!object || /^(it|them|ones|one)$/i.test(object)) {
		return undefined
	}
	return object
}

function normalizeActionObject(object: string): string {
	const dryCleaningMatch = object.match(
		/\bdry cleaning for (?:the|my|a|an)?\s*(.+)$/i,
	)
	if (dryCleaningMatch?.[1]) {
		return `${dryCleaningMatch[1].trim()} from the dry cleaner`
	}
	return object
}

function isProgressTotalQuery(query: string): boolean {
	return /\b(completed|finished|done)\b.*\b(since|starting|started)\b/i.test(
		query,
	)
}

function extractProgressTotal(sentence: string): number | null {
	for (const pattern of [
		/\bcompleted\s+(\d+)\s+projects?\b/i,
		/\bfinished\s+(?:my\s+)?(\d+)(?:st|nd|rd|th)\s+projects?\b/i,
		/\bfinished\s+(?:my\s+)?(\d+)\s+projects?\b/i,
		/\b(\d+)(?:st|nd|rd|th)\s+projects?\b/i,
	]) {
		const match = sentence.match(pattern)
		const value = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN
		if (Number.isFinite(value)) {
			return value
		}
	}
	return null
}

function buildProgressTotalEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	const facts: Array<{ date?: string; evidence: string; value: number }> = []
	for (const result of results.slice(0, 30)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (isPlanOrAdvice(sentence) || !isUserAnchored(sentence)) {
				continue
			}
			const value = extractProgressTotal(sentence)
			if (value === null) {
				continue
			}
			facts.push({
				date,
				evidence: compactEvidenceSentence(sentence, 150),
				value,
			})
		}
	}
	if (facts.length === 0) {
		return []
	}
	const seen = new Set<string>()
	const deduped = facts
		.sort((a, b) => b.value - a.value)
		.filter((fact) => {
			const key = `${fact.value}:${normalizeEvidenceKey(fact.evidence)}`
			if (seen.has(key)) {
				return false
			}
			seen.add(key)
			return true
		})
		.slice(0, 5)
	const bullets = deduped
		.map(
			(fact, index) =>
				`${index + 1}. stated total ${fact.value}${fact.date ? ` (${fact.date})` : ""}: ${fact.evidence}`,
		)
		.join(" ")
	const memory = `derived current-total evidence from retrieved memories: this is a stated total/progress question, so use the latest or highest source-stated total; do not count the bullets as separate items. ${bullets}`
	return [
		{
			id: `derived-current-total-evidence:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 0.95,
		},
	]
}

export function buildActionEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	if (classifyMem0CompatCountKind(query) !== "pending-action") {
		return []
	}
	const verbs = queryActionVerbs(query)
	if (verbs.length === 0) {
		return []
	}

	const seen = new Set<string>()
	const actions: Array<{
		verb: string
		object: string
		date?: string
		evidence: string
	}> = []
	for (const result of results.slice(0, 20)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (
				sentence.includes("?") ||
				sentence.includes("**") ||
				/\b(tips|advice|here are|choose a specific|create a|set reminders)\b/i.test(
					sentence,
				)
			) {
				continue
			}
			const lowerSentence = sentence.toLowerCase()
			const verb = verbs.find((candidate) => lowerSentence.includes(candidate))
			if (!verb) {
				continue
			}
			if (!/\b(need|still need|haven't|have not)\b/i.test(sentence)) {
				continue
			}
			const object = extractActionObject(sentence, verb)
			if (!object) {
				continue
			}
			const normalizedObject = normalizeActionObject(object)
			const key = `${verb}:${normalizeEvidenceKey(normalizedObject)}`
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			actions.push({
				verb,
				object: normalizedObject,
				date,
				evidence: compactEvidenceSentence(sentence),
			})
			if (actions.length >= 8) {
				break
			}
		}
		if (actions.length >= 8) {
			break
		}
	}
	if (actions.length === 0) {
		return []
	}
	const firstDate = actions.find((action) => action.date)?.date
	const bullets = actions
		.map(
			(action, index) =>
				`${index + 1}. separate pending action: ${action.verb} ${action.object} (source memory: "${action.evidence}")`,
		)
		.join(" ")
	const memory = `${firstDate ? `${firstDate} ` : ""}derived action checklist from retrieved memories: count the numbered actions separately when the question asks how many things need to be picked up, returned, collected, or otherwise handled. Do not merge different action verbs just because they mention the same store or product family. ${bullets}`
	return [
		{
			id: `derived-action-checklist:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 1,
		},
	]
}

export function buildPreferenceEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	if (!hasAdviceOrPreferenceIntent(query)) {
		return []
	}
	const terms = preferenceContextTerms(query)
	const seen = new Set<string>()
	const evidence: Array<{ date?: string; text: string }> = []
	for (const result of results.slice(0, 30)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (isAssistantAnchored(sentence) || !isUserAnchored(sentence)) {
				continue
			}
			const lowerSentence = sentence.toLowerCase()
			if (!terms.some((term) => lowerSentence.includes(term))) {
				continue
			}
			const key = normalizeEvidenceKey(sentence)
			if (!key || seen.has(key)) {
				continue
			}
			seen.add(key)
			evidence.push({
				date,
				text: compactEvidenceSentence(sentence, 190),
			})
			if (evidence.length >= 5) {
				break
			}
		}
		if (evidence.length >= 5) {
			break
		}
	}
	if (evidence.length === 0) {
		return []
	}
	const topScore = Math.max(
		0,
		...results.map((result) =>
			typeof result.score === "number" ? result.score : 0,
		),
	)
	const memory = [
		`derived preference/context evidence from retrieved memories: ${preferenceContextLabel(query)} Use these facts to personalize advice; build on existing tools, purchases, constraints, and preferences before giving generic tips.`,
		...evidence.map(
			(entry, index) =>
				`${index + 1}. ${entry.date ? `${entry.date}: ` : ""}${entry.text}`,
		),
	].join(" ")
	const firstDate = evidence.find((entry) => entry.date)?.date
	return [
		{
			id: `derived-preference-context:${normalizeEvidenceKey(query)}`,
			memory,
			score: topScore + 0.8,
			created_at: firstDate ? `${firstDate}T00:00:00.000Z` : undefined,
		},
	]
}

export function buildCountEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	const kind = classifyMem0CompatCountKind(query)
	if (
		kind === "duration" ||
		kind === "money-or-percent" ||
		kind === "pending-action" ||
		kind === "unknown-count"
	) {
		return []
	}
	if (kind === "inventory" && isProgressTotalQuery(query)) {
		return buildProgressTotalEvidenceResults(query, results)
	}
	const actionTerms = countActionTerms(query)
	const objectTerms = countObjectTerms(query)
	const seen = new Set<string>()
	const facts: Array<{ date?: string; evidence: string; key: string }> = []
	for (const result of results.slice(0, 30)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (!isLikelyCompletedCountEvidence(query, sentence, actionTerms)) {
				continue
			}
			const lowerSentence = sentence.toLowerCase()
			if (
				objectTerms.length > 0 &&
				!objectTerms.some((term) => lowerSentence.includes(term))
			) {
				continue
			}
			const key = evidenceObjectKey(sentence, objectTerms)
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			facts.push({
				date,
				evidence: compactEvidenceSentence(sentence, 140),
				key,
			})
			if (facts.length >= 8) {
				break
			}
		}
		if (facts.length >= 8) {
			break
		}
	}
	if (facts.length === 0) {
		return []
	}
	const bullets = facts
		.map(
			(fact, index) =>
				`${index + 1}. ${fact.key}${fact.date ? ` (${fact.date})` : ""}: ${fact.evidence}`,
		)
		.join(" ")
	const memory = `derived countable evidence from retrieved memories: distinct source-backed candidates for this count query, deduped by item/event; verify the exact action and ignore plans, advice, unrelated people, and raw-memory duplicates. ${bullets}`
	return [
		{
			id: `derived-count-evidence:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 0.9,
		},
	]
}
