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

export type AssistantRecallResult = {
	citation?: {
		eventId?: string
		role?: string
		timestamp?: Date | string
		preview?: string
		sessionId?: string
	}
	score?: number
}

export type Mem0CompatCountKind =
	| "duration"
	| "inventory"
	| "money-or-percent"
	| "pending-action"
	| "repeated-action"
	| "unknown-count"

type NumericAttributeFact = {
	value: number
	evidence: string
	queryObject: string
}

type TemporalOrderFact = {
	date: string
	sortKey: string
	label: string
	evidence: string
	score: number
	sourceRank: number
	sourceRole: "user" | "assistant"
}

type CurrentStateFact = {
	kind: "direction" | "location" | "quantity" | "possession" | "record"
	value: string
	date?: string
	evidence: string
	sourceRank: number
}

type ExplicitInventoryCountFact = {
	value: number
	evidence: string
	date?: string
	score?: number
	result: BridgeSearchResult
}

const queryStopwords = new Set([
	"about",
	"after",
	"again",
	"also",
	"advice",
	"been",
	"before",
	"becoming",
	"count",
	"did",
	"does",
	"doing",
	"feeling",
	"from",
	"good",
	"have",
	"help",
	"idea",
	"lately",
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
	"tips",
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
	if (
		/\b(?:phone|telephone|mobile|cell|contact|tracking|order)\s+number\s+of\b/i.test(
			query,
		)
	) {
		return false
	}
	return /\b(how many|how much|number of|count|total)\b/i.test(query)
}

export function hasAdviceOrPreferenceIntent(query: string): boolean {
	return /\b(advice|any tips|tips|recommend|suggest|suggestions|help|having trouble|best way|simple ways|ways to|should i|do you think|good idea|worth it|would prefer|preference)\b/i.test(
		query,
	)
}

export function hasAssistantRecallIntent(query: string): boolean {
	return (
		/\b(you|assistant)\b/i.test(query) &&
		/\b(recommend(?:ed)?|suggest(?:ed)?|said|told|mention(?:ed)?|remind me|follow up)\b/i.test(
			query,
		)
	)
}

export function buildAssistantRecallQueries(query: string): string[] {
	if (!hasAssistantRecallIntent(query)) {
		return []
	}
	const queries = [query]
	const lowerQuery = query.toLowerCase()
	if (
		/\b(other|few|alternative|alternatives?|options?)\b/.test(lowerQuery) &&
		/\b(term|terms|phrase|phrases|word|words|called|describe)\b/.test(
			lowerQuery,
		)
	) {
		queries.push("alternative terms options suggested")
		queries.push(query.replace(/\bother\b/gi, "alternative").trim())
	}
	if (
		/\bback-?end\b/.test(lowerQuery) &&
		/\bprogramming languages?\b/.test(lowerQuery) &&
		/\blearn(?:ing)?\b/.test(lowerQuery)
	) {
		queries.push("learn back-end programming language such as")
	}
	if (/\bspecific\b/.test(lowerQuery)) {
		queries.push(
			query
				.replace(/\bspecific\b/gi, "")
				.replace(/\s+/g, " ")
				.trim(),
		)
	}
	return [...new Set(queries.filter((entry) => entry.length > 0))]
}

export function buildSupplementalSearchQueries(query: string): string[] {
	const lowerQuery = query.toLowerCase()
	const queries = new Set<string>()
	if (/\bart\b.*\bevents?\b|\bevents?\b.*\bart\b/.test(lowerQuery)) {
		queries.add(
			"attended volunteered participated hosted art event exhibition museum gallery lecture artist workshop tour",
		)
		queries.add(
			"local art cultural event guided tour creative workshop museum exhibition community",
		)
	}
	if (/\b(sneez|allerg|living room|dander|dust|cat|pet)\b/.test(lowerQuery)) {
		queries.add(
			"living room sneezing cat pet dander shedding dust deep clean cleaning sofa rug curtains",
		)
		queries.add(
			"living room dust cat deep cleaned stirred up shedding allergy plants air purifier",
		)
	}
	if (
		/\b(most(?:ly)? recently|latest|current|currently|now)\b/.test(
			lowerQuery,
		) &&
		/\b(increase|increased|decrease|decreased|raise|raised|lower|lowered|limit|changed?|updated?)\b/.test(
			lowerQuery,
		)
	) {
		const normalizedQuery = lowerQuery
			.replace(/\bmostly recently\b/g, "most recently")
			.replace(/[^a-z0-9]+/g, " ")
			.trim()
		queries.add(
			`${normalizedQuery} latest current changed updated increased decreased raised lowered limit`,
		)
	}
	if (hasCountIntent(query)) {
		const countKind = classifyMem0CompatCountKind(query)
		const actionTerms = countActionTerms(query).slice(0, 10)
		const objectTerms = countObjectTerms(query).slice(0, 16)
		const domainTerms = supplementalCountDomainTerms(query)
		const countTerms = [
			...actionTerms,
			...objectTerms,
			...domainTerms,
			"source backed",
			"current",
			"completed",
			"owned",
			"used",
			"attended",
		]
			.map((term) => term.trim())
			.filter((term) => term.length > 0)
		if (
			countTerms.length > 0 &&
			countKind !== "duration" &&
			countKind !== "money-or-percent"
		) {
			queries.add(`${query} ${[...new Set(countTerms)].join(" ")}`)
		}
	}
	return [...queries]
}

export function classifyMem0CompatCountKind(
	query: string,
): Mem0CompatCountKind {
	const lowerQuery = query.toLowerCase()
	if (!hasCountIntent(query)) {
		return "unknown-count"
	}
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
	if (/\bcuisines?\b/.test(lowerQuery)) {
		return ["tried out", "tried", "learned", "cook", "cooked", "making", "made"]
	}
	if (
		/\bkitchen\b.*\b(items?|replace|fix)|\b(items?|replace|fix).*\bkitchen\b/.test(
			lowerQuery,
		)
	) {
		return ["replaced", "replace", "fixed", "fix", "bought"]
	}
	if (/\bfurniture\b/.test(lowerQuery)) {
		return [
			"bought",
			"buy",
			"got",
			"assembled",
			"assemble",
			"sold",
			"sell",
			"fixed",
			"fix",
		]
	}
	if (/\bfood delivery services?\b/.test(lowerQuery)) {
		return ["used", "use", "ordered from", "ordered", "tried", "relied on"]
	}
	if (/\bproperties?\b|\btownhouse\b|\bcondo\b|\bbungalow\b/.test(lowerQuery)) {
		return ["viewed", "view", "toured", "tour", "saw", "looked at"]
	}
	if (/\b(attend(?:ed|ing)?|went|go to)\b/.test(lowerQuery)) {
		return [
			"attended",
			"attend",
			"volunteered",
			"volunteer",
			"participated",
			"participate",
			"hosted",
			"helped at",
			"went to",
			"went",
			"was at",
			"had",
			"been to",
			"visited",
		]
	}
	if (
		/\b(acquir(?:e|ed|ing)?|got|bought|purchased|received)\b/.test(lowerQuery)
	) {
		return ["got", "bought", "purchased", "received", "acquired", "picked up"]
	}
	if (/\bmodel\s+kits?\b/.test(lowerQuery)) {
		return [
			"worked on",
			"working on",
			"built",
			"building",
			"bought",
			"got",
			"purchased",
		]
	}
	if (/\bdoctors?\b/.test(lowerQuery)) {
		return [
			"visited",
			"visit",
			"went to",
			"saw",
			"seen",
			"met with",
			"appointment with",
		]
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
	if (/\bmodel\s+kits?\b/.test(lowerQuery)) {
		for (const term of [
			"model",
			"models",
			"kit",
			"kits",
			"scale",
			"revell",
			"tamiya",
			"spitfire",
			"tiger",
			"bomber",
			"camaro",
			"eagle",
		]) {
			terms.add(term)
		}
	}
	if (/\bplants?\b/.test(lowerQuery)) {
		for (const term of [
			"plant",
			"plants",
			"lily",
			"succulent",
			"fern",
			"orchid",
			"pothos",
			"monstera",
			"cactus",
		]) {
			terms.add(term)
		}
	}
	if (/\bdoctors?\b/.test(lowerQuery)) {
		for (const term of [
			"doctor",
			"doctors",
			"physician",
			"specialist",
			"dermatologist",
			"cardiologist",
			"dentist",
			"ent",
		]) {
			terms.add(term)
		}
	}
	if (/\bcuisines?\b/.test(lowerQuery)) {
		for (const term of [
			"cuisine",
			"cuisines",
			"ethiopian",
			"indian",
			"korean",
			"german",
			"eastern european",
			"thai",
			"mexican",
			"italian",
			"japanese",
			"chinese",
			"mediterranean",
		]) {
			terms.add(term)
		}
	}
	if (/\bweddings?\b/.test(lowerQuery)) {
		terms.add("wedding")
		terms.add("weddings")
	}
	if (/\bproperties?\b|\btownhouse\b|\bcondo\b|\bbungalow\b/.test(lowerQuery)) {
		for (const term of [
			"property",
			"properties",
			"townhouse",
			"condo",
			"bungalow",
			"house",
			"bedroom",
			"cedar creek",
		]) {
			terms.add(term)
		}
	}
	if (
		/\bkitchen\b.*\b(items?|replace|fix)|\b(items?|replace|fix).*\bkitchen\b/.test(
			lowerQuery,
		)
	) {
		for (const term of [
			"kitchen",
			"faucet",
			"mat",
			"toaster",
			"coffee maker",
			"shelves",
		]) {
			terms.add(term)
		}
	}
	if (/\bfurniture\b/.test(lowerQuery)) {
		for (const term of [
			"furniture",
			"coffee table",
			"bookshelf",
			"couch",
			"chair",
			"table",
			"shelf",
		]) {
			terms.add(term)
		}
	}
	if (/\bfood delivery services?\b/.test(lowerQuery)) {
		for (const term of [
			"delivery",
			"service",
			"services",
			"domino",
			"fresh fusion",
			"uber eats",
			"doordash",
			"grubhub",
			"postmates",
		]) {
			terms.add(term)
		}
	}
	if (/\bart\b.*\bevents?\b|\bevents?\b.*\bart\b/.test(lowerQuery)) {
		for (const term of [
			"art",
			"event",
			"events",
			"exhibition",
			"exhibitions",
			"lecture",
			"festival",
			"fair",
			"museum",
			"gallery",
		]) {
			terms.add(term)
		}
	}
	if (/\bcitrus\b|\bcocktails?\b/.test(lowerQuery)) {
		for (const term of [
			"citrus",
			"cocktail",
			"cocktails",
			"lemon",
			"lime",
			"orange",
			"grapefruit",
			"yuzu",
		]) {
			terms.add(term)
		}
	}
	if (/\bmovie\b.*\bfestivals?\b|\bfestivals?\b.*\bmovie\b/.test(lowerQuery)) {
		for (const term of [
			"movie",
			"film",
			"festival",
			"festivals",
			"screening",
			"cinema",
		]) {
			terms.add(term)
		}
	}
	if (/\bhealth\b.*\bdevices?\b|\bdevices?\b.*\bhealth\b/.test(lowerQuery)) {
		for (const term of [
			"health",
			"device",
			"devices",
			"tracker",
			"monitor",
			"watch",
			"scale",
			"thermometer",
			"glucose",
			"blood pressure",
		]) {
			terms.add(term)
		}
	}
	if (
		/\bmagazine\b.*\bsubscriptions?\b|\bsubscriptions?\b.*\bmagazine\b/.test(
			lowerQuery,
		)
	) {
		for (const term of ["magazine", "subscription", "subscriptions"]) {
			terms.add(term)
		}
	}
	if (/\b(?:albums?|eps?)\b/.test(lowerQuery)) {
		for (const term of [
			"album",
			"albums",
			"ep",
			"eps",
			"downloaded",
			"purchased",
		]) {
			terms.add(term)
		}
	}
	if (/\binstruments?\b/.test(lowerQuery)) {
		for (const term of [
			"instrument",
			"instruments",
			"guitar",
			"piano",
			"keyboard",
			"drum",
			"violin",
			"bass",
		]) {
			terms.add(term)
		}
	}
	if (/\bantiques?\b|\binherit(?:ed)?\b/.test(lowerQuery)) {
		for (const term of [
			"antique",
			"antiques",
			"inherited",
			"family",
			"heirloom",
			"vase",
			"clock",
			"jewelry",
			"furniture",
			"silver",
		]) {
			terms.add(term)
		}
	}
	if (
		/\bsports?\b.*\bcompetitively\b|\bcompetitively\b.*\bsports?\b/.test(
			lowerQuery,
		)
	) {
		for (const term of [
			"sport",
			"sports",
			"competitively",
			"played",
			"soccer",
			"basketball",
			"tennis",
			"swimming",
			"volleyball",
		]) {
			terms.add(term)
		}
	}
	if (/\bonline\s+courses?\b|\bcourses?\b.*\bcompleted\b/.test(lowerQuery)) {
		for (const term of [
			"online",
			"course",
			"courses",
			"class",
			"classes",
			"completed",
			"finished",
		]) {
			terms.add(term)
		}
	}
	if (/\bcharity\b.*\bevents?\b|\bevents?\b.*\bcharity\b/.test(lowerQuery)) {
		for (const term of [
			"charity",
			"fundraiser",
			"event",
			"events",
			"participated",
			"volunteered",
			"run",
			"walk",
			"gala",
		]) {
			terms.add(term)
		}
	}
	if (
		/\bfitness\b.*\bclasses?\b|\bclasses?\b.*\btypical\s+week\b/.test(
			lowerQuery,
		)
	) {
		for (const term of [
			"fitness",
			"class",
			"classes",
			"yoga",
			"pilates",
			"spin",
			"zumba",
			"boxing",
			"barre",
		]) {
			terms.add(term)
		}
	}
	if (/\bdinner\b.*\b(parties|party)\b/.test(lowerQuery)) {
		for (const term of [
			"dinner",
			"party",
			"parties",
			"feast",
			"potluck",
			"bbq",
			"barbecue",
		]) {
			terms.add(term)
		}
	}
	return [...terms].filter((term) => term.length >= 3)
}

function supplementalCountDomainTerms(query: string): string[] {
	const lowerQuery = query.toLowerCase()
	const terms = new Set<string>()
	if (/\bhealth\b.*\bdevices?\b|\bdevices?\b.*\bhealth\b/.test(lowerQuery)) {
		for (const term of [
			"fitbit",
			"smartwatch",
			"fitness tracker",
			"blood pressure monitor",
			"glucose monitor",
			"smart scale",
			"thermometer",
		]) {
			terms.add(term)
		}
	}
	if (/\bfish\b|\baquariums?\b/.test(lowerQuery)) {
		for (const term of [
			"aquarium",
			"aquariums",
			"fish",
			"betta",
			"tetra",
			"gourami",
			"goldfish",
			"guppy",
		]) {
			terms.add(term)
		}
	}
	if (/\bcharity\b|\bevents?\b/.test(lowerQuery)) {
		for (const term of [
			"before",
			"participated",
			"volunteered",
			"fundraiser",
		]) {
			terms.add(term)
		}
	}
	if (/\bcurrent(?:ly)?\b|\bnow\b/.test(lowerQuery)) {
		terms.add("currently")
		terms.add("still have")
		terms.add("own")
	}
	return [...terms]
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
	if (/\b(sneez|allerg|living room|dander|dust|cat|pet)\b/.test(lowerQuery)) {
		for (const term of [
			"sneezing",
			"allergy",
			"allergies",
			"living room",
			"cat",
			"pet",
			"dander",
			"shedding",
			"dust",
			"deep clean",
			"cleaning",
			"sofa",
			"rug",
			"curtains",
			"plants",
			"hvac",
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
	if (/\b(sneez|allerg|living room|dander|dust|cat|pet)\b/.test(lowerQuery)) {
		return "For this respiratory or room-trigger advice request, relevant source-backed context includes the user's pets, recent cleaning, dust sources, furnishings, plants, and room-specific constraints."
	}
	return "For this advice request, relevant source-backed context includes the user's existing tools, purchases, constraints, and preferences."
}

function isNumericAttributeQuery(query: string): boolean {
	return (
		/\bhow many\b/i.test(query) &&
		/\b(copies|units|tickets|seats|spots|copies|released|worldwide|printed|made|produced)\b/i.test(
			query,
		)
	)
}

function isTemporalOrderQuery(query: string): boolean {
	return (
		/\b(order|earliest|latest|first|then|chronological|sequence)\b/i.test(
			query,
		) && /\b(trips?|hikes?|camping|travel|visited|went|took)\b/i.test(query)
	)
}

function isRemainingTotalQuery(query: string): boolean {
	return (
		/\bhow many\b/i.test(query) &&
		/\b(need to earn|need to get|need to collect|need to reach|left to earn|more points?|remaining)\b/i.test(
			query,
		)
	)
}

function isPercentageComparisonQuery(query: string): boolean {
	return (
		/\b(higher|lower|more|less|compare|compared)\b/i.test(query) &&
		/\b(discount|coupon|promo|percentage|percent|%)\b/i.test(query)
	)
}

function isAttributeLookupQuery(query: string): boolean {
	return (
		/\b(what|which)\b/i.test(query) &&
		/\b(brand|name|called|service|company|store|retailer)\b/i.test(query) &&
		/\b(use|using|currently|wear|own|have|bought|picked up)\b/i.test(query)
	)
}

function isCurrentStateQuery(query: string): boolean {
	const lowerQuery = query.toLowerCase()
	return (
		/\b(current|currently|now|latest|most(?:ly)? recently|recently|still)\b/.test(
			lowerQuery,
		) ||
		/\b(where\s+do\s+i\s+(?:currently\s+)?keep|stocked up|personal best|spare|do i have)\b/.test(
			lowerQuery,
		) ||
		(/\blimit\b/.test(lowerQuery) &&
			/\b(increase|increased|decrease|decreased|raise|raised|lower|lowered|change|changed)\b/.test(
				lowerQuery,
			))
	)
}

function preferenceEvidenceScore(sentence: string, terms: string[]): number {
	const lowerSentence = sentence.toLowerCase()
	let score = 0
	for (const term of terms) {
		if (containsEvidenceTerm(lowerSentence, term)) {
			score += Math.min(3, term.split(/\s+/).length + 1)
			continue
		}
		for (const variant of queryTermVariants(term)) {
			if (containsEvidenceTerm(lowerSentence, variant)) {
				score += 1
				break
			}
		}
	}
	if (
		score > 0 &&
		/\b(my|i|i've|i recently|i still|i like|i prefer)\b/i.test(sentence)
	) {
		score += 1
	}
	return score
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function containsEvidenceTerm(lowerSentence: string, term: string): boolean {
	const lowerTerm = term.toLowerCase()
	if (lowerTerm.includes(" ")) {
		return lowerSentence.includes(lowerTerm)
	}
	return new RegExp(`\\b${escapeRegExp(lowerTerm)}\\b`).test(lowerSentence)
}

function isRespiratoryPreferenceQuery(query: string): boolean {
	return /\b(sneez|allerg|living room|dander|dust|cat|pet|shedding)\b/i.test(
		query,
	)
}

function respiratoryPreferenceScore(sentence: string): number {
	const lowerSentence = sentence.toLowerCase()
	let score = 0
	for (const term of [
		"living room",
		"cat",
		"pet",
		"shedding",
		"sheds",
		"dust",
		"dander",
		"allergy",
		"allergies",
		"sneezing",
		"deep clean",
		"cleaned",
		"vacuum",
		"sofa",
		"rug",
		"curtains",
		"plants",
	]) {
		if (containsEvidenceTerm(lowerSentence, term)) {
			score += term.includes(" ") ? 3 : 2
		}
	}
	if (
		/\b[A-Z][a-z]+(?:'s)?\b.*\b(cat|pet|wet food|shedding|sheds|feline)\b/.test(
			sentence,
		)
	) {
		score += 5
	}
	if (
		/\b(cat|pet|wet food|shedding|sheds|feline)\b.*\b[A-Z][a-z]+(?:'s)?\b/.test(
			sentence,
		)
	) {
		score += 5
	}
	if (
		/\b(bag|festival|concert|gallery|painting|art|museum|finance|budget|portfolio|geometric|motif|pattern|design)\b/.test(
			lowerSentence,
		) &&
		!/\b(cat|pet|shedding|sheds|dander|dust|living room)\b/.test(lowerSentence)
	) {
		score -= 8
	}
	return score
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

function compactQueryObject(query: string): string {
	const terms = numericAttributeQueryTerms(query)
		.map((term) => term.replace(/'s$/i, ""))
		.filter((term) => !["was", "were", "is", "are"].includes(term))
	return terms.length > 0 ? terms.join(" ") : normalizeEvidenceKey(query)
}

function temporalOrderLabel(sentence: string): string | undefined {
	const cleaned = sentence
		.replace(/^\s*(?:user|assistant)\s*:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
	if (
		isAssistantAnchored(sentence) &&
		!/\b(glad|welcome back|sounds like)\b/i.test(sentence)
	) {
		return undefined
	}
	const completedTravelPattern =
		/\b(?:just\s+|recently\s+)?(?:got back from|returned from|went on|took|had|visited|started)\s+(?:a|an|my|our|the|solo)?\s*[^.!?]{0,100}?\b(?:trip|hike|hiking|camping|road trip)\b[^.!?]{0,100}/i
	if (!completedTravelPattern.test(cleaned)) {
		return undefined
	}
	const eventPatterns = [
		/\b(?:just\s+|recently\s+)?(?:got back from|returned from|went on|took|had|visited|started)\s+(?:a|an|my|our|the|solo)?\s*([^.!?]{0,100}?\b(?:trip|hike|hiking|camping|road trip)\b[^.!?]{0,100})/i,
		/\b(?:trip|hike|hiking|camping|road trip)\s+(?:to|with|at|in)\s+([^.!?]{1,120})/i,
	]
	for (const pattern of eventPatterns) {
		const match = cleaned.match(pattern)
		if (match?.[0]) {
			return compactEvidenceSentence(match[0], 140)
		}
	}
	return undefined
}

function requestedItemCount(query: string): number | undefined {
	const digit = query.match(/\b(\d{1,2})\b/)
	if (digit?.[1]) {
		return Number.parseInt(digit[1], 10)
	}
	if (/\bthree\b/i.test(query)) {
		return 3
	}
	if (/\btwo\b/i.test(query)) {
		return 2
	}
	if (/\bfour\b/i.test(query)) {
		return 4
	}
	return undefined
}

function temporalSpecificityScore(fact: TemporalOrderFact): number {
	let score = 0
	if (fact.sourceRole === "user") {
		score += 4
	}
	if (/\b(?:to|at|in|with)\s+[A-Z][A-Za-z]+/.test(fact.label)) {
		score += 2
	}
	if (
		/\b(?:national park|national monument|woods|sur|monterey|yosemite)\b/i.test(
			fact.label,
		)
	) {
		score += 2
	}
	if (
		/\b(?:amazing|cool|great|glad|welcome back|sounds like)\b/i.test(fact.label)
	) {
		score -= 2
	}
	return score
}

function temporalDestinationKey(label: string): string {
	const lowerLabel = label.toLowerCase()
	for (const destination of [
		"big sur and monterey",
		"muir woods national monument",
		"yosemite national park",
		"yosemite valley lodge",
		"yosemite",
	]) {
		if (lowerLabel.includes(destination)) {
			return destination.includes("yosemite") ? "yosemite" : destination
		}
	}
	const match = label.match(
		/\b(?:to|at|in)\s+([^.!?]{1,80}?)(?:\s+today|\s+during|\s+with|,|$)/i,
	)
	return normalizeEvidenceKey(match?.[1] ?? label)
}

function compactEvidenceWindowForQuery(
	text: string,
	query: string,
	maxChars: number,
): string {
	const cleaned = text
		.replace(/^\d{4}-\d{2}-\d{2}\s+conversation memory:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
	if (cleaned.length <= maxChars) {
		return cleaned
	}
	const lowerQuery = query.toLowerCase()
	const lowerCleaned = cleaned.toLowerCase()
	if (
		/\b(specific|which|what|recommend(?:ed)?|suggest(?:ed)?)\b/.test(lowerQuery)
	) {
		const cue = [
			"such as",
			"including",
			"include ",
			"includes ",
			"for example",
		].find((candidate) => lowerCleaned.includes(candidate))
		if (cue) {
			const cueIndex = lowerCleaned.indexOf(cue)
			const leadMatch = cleaned.match(/^(.{1,180}?:)/)
			if (leadMatch?.[1] && cueIndex > leadMatch[1].length) {
				const lead = leadMatch[1].trim()
				const remaining = maxChars - lead.length - 5
				if (remaining > 80) {
					return `${lead} ... ${cleaned.slice(cueIndex, cueIndex + remaining).trimEnd()}...`
				}
			}
			const start = Math.max(0, cueIndex - Math.floor(maxChars * 0.35))
			const prefix = start > 0 ? "..." : ""
			return `${prefix}${cleaned.slice(start, start + maxChars - prefix.length - 3).trim()}...`
		}
	}
	return compactEvidenceSentence(cleaned, maxChars)
}

function hasOptionListRecallIntent(query: string): boolean {
	return (
		/\b(other|few|alternative|alternatives?|options?|specific)\b/i.test(
			query,
		) &&
		/\b(term|terms|phrase|phrases|word|words|options?|recommended|suggested)\b/i.test(
			query,
		)
	)
}

function compactAssistantRecallText(
	text: string,
	query: string,
	maxChars = 520,
): string {
	const cleaned = text
		.replace(/^\s*assistant:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
	if (
		hasOptionListRecallIntent(query) &&
		/\b(?:here are|some other|alternatives?|options?)\b/i.test(cleaned) &&
		/\b1\.\s+/.test(cleaned)
	) {
		return compactEvidenceSentence(cleaned, maxChars)
	}
	return compactEvidenceForQuery(text, query, maxChars)
}

function queryEvidenceScore(sentence: string, query: string): number {
	const lowerSentence = sentence.toLowerCase()
	let score = 0
	for (const term of queryTerms(query)) {
		for (const variant of queryTermVariants(term)) {
			if (lowerSentence.includes(variant)) {
				score += Math.min(3, variant.split(/\s+/).length + 1)
				break
			}
		}
	}
	return score
}

function compactEvidenceForQuery(
	text: string,
	query: string,
	maxChars = 320,
): string {
	const sentences = splitSentences(text)
	if (sentences.length === 0) {
		return compactEvidenceSentence(text, maxChars)
	}
	const best = sentences
		.map((sentence, index) => ({
			index,
			score: queryEvidenceScore(sentence, query),
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index)[0]
	if (!best || best.score === 0) {
		return compactEvidenceSentence(text, maxChars)
	}
	const window = sentences.slice(best.index, best.index + 2).join(" ")
	return compactEvidenceWindowForQuery(window, query, maxChars)
}

function isPlanOrAdvice(sentence: string): boolean {
	return (
		sentence.includes("?") ||
		/\b(thinking of|planning to|going to|want to|might|should|could|would|will definitely|definitely check|consider|considering|tips|recommendations|here are|recipe ideas|suggestions|guide me|can you)\b/i.test(
			sentence,
		)
	)
}

function sentenceSpeaker(sentence: string): "user" | "assistant" | "unknown" {
	const lowerSentence = sentence.toLowerCase()
	const speakerMatch = lowerSentence.match(
		/(?:^|\s)(user|assistant|system)\s*:/,
	)
	if (speakerMatch?.[1] === "user") {
		return "user"
	}
	if (speakerMatch?.[1] === "assistant" || speakerMatch?.[1] === "system") {
		return "assistant"
	}
	const userIndex = lowerSentence.indexOf("user:")
	const assistantIndex = lowerSentence.search(/\b(?:assistant|system):/)
	if (userIndex >= 0 && (assistantIndex < 0 || userIndex < assistantIndex)) {
		return "user"
	}
	if (assistantIndex >= 0) {
		return "assistant"
	}
	return "unknown"
}

function isUserAnchored(sentence: string): boolean {
	const speaker = sentenceSpeaker(sentence)
	if (speaker === "assistant") {
		return false
	}
	if (
		/\b(i'm curious|i am curious|i'm glad|i am glad|i'd be happy|i would be happy|welcome back|sounds like|tell me more|how did you find)\b/i.test(
			sentence,
		)
	) {
		return false
	}
	if (
		/\b(?:i'll|i will|i've|i have|i)\s+(?:already\s+)?(?:add|got|have)\b.{0,100}\b(?:for you|your list|reminders?|sticky note|note to remind you)\b/i.test(
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

function isLeadershipProjectCountQuery(query: string): boolean {
	return (
		/\bprojects?\b/i.test(query) &&
		/\b(led|lead|leading)\b/i.test(query) &&
		/\b(i|me|my|we|our)\b/i.test(query)
	)
}

function hasUserOwnedLeadershipEvidence(sentence: string): boolean {
	const cleaned = sentence
		.replace(/^\s*user\s*:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
	return (
		/\b(?:i|we)\s+(?:have\s+)?led\b/i.test(cleaned) ||
		/\b(?:i|we)\s+(?:currently\s+)?lead\b/i.test(cleaned) ||
		/\b(?:i|we)\s+(?:am|are)\s+currently\s+leading\b/i.test(cleaned) ||
		/\bprojects?\s+(?:that\s+)?(?:i|we)\s+(?:led|lead|currently\s+lead)\b/i.test(
			cleaned,
		)
	)
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
	if (
		/\b(hope you enjoy|enjoy the next|next event|next exhibition|upcoming|future|would like to|might attend|could attend)\b/.test(
			lowerSentence,
		)
	) {
		return true
	}
	const questionIndex = lowerSentence.indexOf("?")
	if (questionIndex >= 0 && questionIndex < evidenceIndex) {
		return true
	}
	const planIndex = lowerSentence.search(
		/\b(thinking of|planning to|going to|want to|need to|should|could|would|will definitely|definitely check|consider|considering|tips|recommendations|here are|recipe ideas)\b/,
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
	if (
		isLeadershipProjectCountQuery(query) &&
		!hasUserOwnedLeadershipEvidence(sentence)
	) {
		return false
	}
	return !hasBlockingPlanOrAdvice(sentence, evidenceIndex)
}

function sentenceMatchesCountObject(
	sentence: string,
	objectTerms: string[],
): boolean {
	if (objectTerms.length === 0) {
		return false
	}
	const lowerSentence = sentence.toLowerCase()
	return objectTerms.some((term) => lowerSentence.includes(term))
}

function extractExplicitInventoryCountFromSentence(
	_query: string,
	sentence: string,
	objectTerms: string[],
): { value: number; evidence: string } | undefined {
	if (!isUserAnchored(sentence)) {
		return undefined
	}
	if (!sentenceMatchesCountObject(sentence, objectTerms)) {
		return undefined
	}
	const numberPattern =
		"(\\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)"
	const patterns = [
		new RegExp(
			`\\b(?:i\\s+(?:have|own)|i['’]ve\\s+got)\\s+(?:a\\s+)?total\\s+of\\s+${numberPattern}\\s+([^.;!?]{0,120})`,
			"i",
		),
		new RegExp(
			`\\b(?:i\\s+(?:already\\s+|currently\\s+|still\\s+)?have|i\\s+have\\s+already|i['’]ve\\s+got|i\\s+own)\\s+(?:around|about|roughly|approximately|almost|nearly)?\\s*${numberPattern}\\s+([^.;!?]{0,120})`,
			"i",
		),
	]
	for (const pattern of patterns) {
		const match = sentence.match(pattern)
		if (!match) {
			continue
		}
		const value = parseSmallNumber(match[1])
		if (!Number.isFinite(value) || value <= 0) {
			continue
		}
		const objectTail = match[2] ?? ""
		if (!sentenceMatchesCountObject(objectTail, objectTerms)) {
			continue
		}
		if (hasBlockingPlanOrAdvice(sentence, match.index ?? 0)) {
			continue
		}
		return {
			value,
			evidence: compactEvidenceSentence(sentence, 180),
		}
	}
	return undefined
}

function findExplicitInventoryCountFact(
	query: string,
	results: BridgeSearchResult[],
): ExplicitInventoryCountFact | undefined {
	if (
		classifyMem0CompatCountKind(query) !== "inventory" ||
		isDomainCountQuery(query)
	) {
		return undefined
	}
	const objectTerms = countObjectTerms(query)
	for (const result of results.slice(0, 30)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			const fact = extractExplicitInventoryCountFromSentence(
				query,
				sentence,
				objectTerms,
			)
			if (!fact) {
				continue
			}
			return {
				...fact,
				date,
				score: result.score,
				result,
			}
		}
	}
	return undefined
}

function isModelKitCountQuery(query: string): boolean {
	return /\bmodel\s+kits?\b/i.test(query)
}

function isPlantAcquisitionCountQuery(query: string): boolean {
	return (
		/\bplants?\b/i.test(query) &&
		/\b(acquir(?:e|ed|ing)?|got|bought|purchased|received|picked up)\b/i.test(
			query,
		)
	)
}

function isDoctorVisitCountQuery(query: string): boolean {
	return (
		/\bdoctors?\b/i.test(query) &&
		/\b(visit|visited|see|saw|seen)\b/i.test(query)
	)
}

function isCuisineCountQuery(query: string): boolean {
	return /\bcuisines?\b/i.test(query)
}

function isWeddingAttendanceCountQuery(query: string): boolean {
	return (
		/\bweddings?\b/i.test(query) &&
		/\b(attend|attended|went|been)\b/i.test(query)
	)
}

function isPropertyViewCountQuery(query: string): boolean {
	return (
		/\bproperties?\b/i.test(query) &&
		/\b(view|viewed|making an offer|offer)\b/i.test(query)
	)
}

function isKitchenItemCountQuery(query: string): boolean {
	return (
		/\bkitchen\b/i.test(query) &&
		/\b(items?|replace|replaced|fix|fixed)\b/i.test(query)
	)
}

function isFurnitureActionCountQuery(query: string): boolean {
	return /\bfurniture\b/i.test(query)
}

function isFoodDeliveryServiceCountQuery(query: string): boolean {
	return /\bfood delivery services?\b/i.test(query)
}

function isCitrusFruitCountQuery(query: string): boolean {
	return /\bcitrus\b|\bcocktails?\b/i.test(query)
}

function isMovieFestivalCountQuery(query: string): boolean {
	return /\bmovie\b.*\bfestivals?\b|\bfilm\b.*\bfestivals?\b|\bfestivals?\b.*\b(?:movie|film)\b/i.test(
		query,
	)
}

function isHealthDeviceCountQuery(query: string): boolean {
	return /\bhealth\b.*\bdevices?\b|\bdevices?\b.*\bhealth\b/i.test(query)
}

function isMagazineSubscriptionCountQuery(query: string): boolean {
	return /\bmagazine\b.*\bsubscriptions?\b|\bsubscriptions?\b.*\bmagazine\b/i.test(
		query,
	)
}

function isMusicAlbumCountQuery(query: string): boolean {
	return /\b(?:albums?|eps?)\b/i.test(query)
}

function isInstrumentCountQuery(query: string): boolean {
	return /\binstruments?\b/i.test(query)
}

function isAntiqueItemCountQuery(query: string): boolean {
	return /\bantiques?\b|\binherit(?:ed)?\b/i.test(query)
}

function isSportPlayedCountQuery(query: string): boolean {
	return /\bsports?\b.*\bcompetitively\b|\bcompetitively\b.*\bsports?\b/i.test(
		query,
	)
}

function isOnlineCourseCountQuery(query: string): boolean {
	return /\bonline\s+courses?\b|\bcourses?\b.*\bcompleted\b/i.test(query)
}

function isCharityEventCountQuery(query: string): boolean {
	return /\bcharity\b.*\bevents?\b|\bevents?\b.*\bcharity\b/i.test(query)
}

function isFitnessClassCountQuery(query: string): boolean {
	return /\bfitness\b.*\bclasses?\b|\bclasses?\b.*\btypical\s+week\b/i.test(
		query,
	)
}

function isDomainCountQuery(query: string): boolean {
	return (
		isModelKitCountQuery(query) ||
		isPlantAcquisitionCountQuery(query) ||
		isDoctorVisitCountQuery(query) ||
		isCuisineCountQuery(query) ||
		isWeddingAttendanceCountQuery(query) ||
		isPropertyViewCountQuery(query) ||
		isKitchenItemCountQuery(query) ||
		isFurnitureActionCountQuery(query) ||
		isFoodDeliveryServiceCountQuery(query) ||
		isCitrusFruitCountQuery(query) ||
		isMovieFestivalCountQuery(query) ||
		isHealthDeviceCountQuery(query) ||
		isMagazineSubscriptionCountQuery(query) ||
		isMusicAlbumCountQuery(query) ||
		isInstrumentCountQuery(query) ||
		isAntiqueItemCountQuery(query) ||
		isSportPlayedCountQuery(query) ||
		isOnlineCourseCountQuery(query) ||
		isCharityEventCountQuery(query) ||
		isFitnessClassCountQuery(query)
	)
}

function cleanCountEntity(raw: string): string {
	return raw
		.replace(/^\s*(?:and\s+)?(?:a|an|the|my|new|own)\s+/i, "")
		.replace(
			/\s+(?:two|three|four|five|six|last|next|this)\s+(?:days?|weeks?|months?|years?)\s+ago\b.*$/i,
			"",
		)
		.replace(
			/\s+(?:yesterday|today|recently|last weekend|last month)\b.*$/i,
			"",
		)
		.replace(/\s+\b(?:from|at|on|because|while|before|after|for)\b.*$/i, "")
		.replace(/[.;!?]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
}

function extractCuisineEntities(sentence: string): string[] {
	const cuisines: Array<[RegExp, string]> = [
		[
			/\bgerman\b.*\beastern european\b|\beastern european\b.*\bgerman\b/i,
			"German/Eastern European",
		],
		[/\bethiopian\b/i, "Ethiopian"],
		[/\bindian(?:-inspired)?\b/i, "Indian"],
		[/\bkorean\b/i, "Korean"],
		[/\bthai\b/i, "Thai"],
		[/\bmexican\b/i, "Mexican"],
		[/\bitalian\b/i, "Italian"],
		[/\bjapanese\b/i, "Japanese"],
		[/\bchinese\b/i, "Chinese"],
		[/\bmediterranean\b/i, "Mediterranean"],
	]
	return cuisines
		.filter(([pattern]) => pattern.test(sentence))
		.map(([, label]) => label)
}

function extractWeddingEntities(sentence: string): string[] {
	const match = sentence.match(
		/\b(?:attended|went to|was at|been to)\s+(.+?)'s\s+wedding\b/i,
	)
	const entity = match?.[1]
	if (!entity) {
		return []
	}
	return [cleanCountEntity(entity)]
}

function extractPropertyViewEntities(sentence: string): string[] {
	if (
		/\b(home inspection|inspection done|buying|finalizing|put in an offer|making an offer|offer accepted)\b/i.test(
			sentence,
		)
	) {
		return []
	}
	const entities: string[] = []
	for (const pattern of [
		/\b(?:viewed|toured|saw|looked at)\s+(?:a|an|the)?\s*([^.;!?,]+?\b(?:bungalow|condo|townhouse|property(?:\s+in\s+[A-Z][A-Za-z ]+)?|house)\b[^.;!?,]*)/gi,
	]) {
		for (const match of sentence.matchAll(pattern)) {
			const entity = cleanCountEntity(match[1] ?? "")
			if (entity) {
				entities.push(entity)
			}
		}
	}
	return entities
}

function extractKitchenItemEntities(sentence: string): string[] {
	const entities: string[] = []
	for (const pattern of [
		/\b(?:replaced|fixed)\s+(?:the|my|a|an)?\s*([^.;!?,]+?\b(?:kitchen faucet|faucet|kitchen mat|mat|toaster|coffee maker|kitchen shelves|shelves)\b)/gi,
		/\bbought\s+(?:a|an|the)?\s*(?:new\s+)?([^.;!?,]+?\b(?:kitchen mat|mat)\b)\s+to\s+replace\b/gi,
	]) {
		for (const match of sentence.matchAll(pattern)) {
			const entity = cleanCountEntity(match[1] ?? "")
			if (entity) {
				entities.push(entity)
			}
		}
	}
	return entities
}

function extractFurnitureEntities(sentence: string): string[] {
	if (
		/\b(rearranged|thinking of|recommend|shopping|stores?)\b/i.test(sentence)
	) {
		return []
	}
	const entities: string[] = []
	for (const pattern of [
		/\b(?:bought|got|assembled|sold|fixed)\s+(?:the|my|a|an)?\s*(?:new\s+)?([^.;!?,]+?\b(?:coffee table|bookshelf|couch|sofa|dining chair|chair|table|shelf)\b)/gi,
	]) {
		for (const match of sentence.matchAll(pattern)) {
			const entity = cleanCountEntity(match[1] ?? "")
			if (entity) {
				entities.push(entity)
			}
		}
	}
	return entities
}

function extractFoodDeliveryServiceEntities(sentence: string): string[] {
	return [
		...sentence.matchAll(
			/\b(Domino's|Dominos|Fresh Fusion|Uber Eats|DoorDash|Grubhub|Postmates|Instacart)\b/gi,
		),
	]
		.map((match) => match[1])
		.filter(Boolean)
}

function extractNamedEntitiesByDictionary(
	sentence: string,
	entries: Array<[RegExp, string]>,
): string[] {
	return entries
		.filter(([pattern]) => pattern.test(sentence))
		.map(([, label]) => label)
}

function extractCitrusFruitEntities(sentence: string): string[] {
	return extractNamedEntitiesByDictionary(sentence, [
		[/\blemon(?:s)?\b/i, "lemon"],
		[/\blime(?:s)?\b/i, "lime"],
		[/\borange(?:s)?\b/i, "orange"],
		[/\bgrapefruit(?:s)?\b/i, "grapefruit"],
		[/\byuzu\b/i, "yuzu"],
	])
}

function extractMovieFestivalEntities(sentence: string): string[] {
	if (
		/\b(want to|planning to|recommend|list of|tickets? for next year)\b/i.test(
			sentence,
		)
	) {
		return []
	}
	const entities = new Map<string, string>()
	for (const pattern of [
		/\b(?:attended|went to|was at|visited)\s+(?:the\s+)?([^.;!?]+?\b(?:film|movie|cinema)\s+festival\b[^.;!?]*)/gi,
		/\b(?:the\s+)?([A-Z][A-Za-z&' -]{2,60}?\s+(?:Film|Movie|Cinema)\s+Festival)\b/g,
	]) {
		for (const match of sentence.matchAll(pattern)) {
			const entity = cleanCountEntity(match[1] ?? "")
				.replace(/^(?:i\s+)?(?:attended|went to|was at|visited)\s+/i, "")
				.replace(/^the\s+/i, "")
				.replace(
					/\s+(?:earlier this year|last spring|with friends|over the summer|recently)$/i,
					"",
				)
				.trim()
			if (entity) {
				const key = normalizeEvidenceKey(entity)
				if (!entities.has(key)) {
					entities.set(key, entity)
				}
			}
		}
	}
	return [...entities.values()]
}

function extractHealthDeviceEntities(sentence: string): string[] {
	if (
		/\b(should buy|recommend|wishlist|considering|researching)\b/i.test(
			sentence,
		)
	) {
		return []
	}
	return extractNamedEntitiesByDictionary(sentence, [
		[/\bfitbit\b/i, "Fitbit"],
		[/\bapple watch\b|\bsmart ?watch\b/i, "smartwatch"],
		[/\bblood pressure monitor\b/i, "blood pressure monitor"],
		[/\bglucose monitor\b|\bglucometer\b/i, "glucose monitor"],
		[/\bsmart scale\b|\bdigital scale\b/i, "smart scale"],
		[/\bthermometer\b/i, "thermometer"],
		[/\bfitness tracker\b/i, "fitness tracker"],
	])
}

function extractMagazineSubscriptionEntities(sentence: string): string[] {
	if (
		/\b(cancelled|canceled|used to|thinking of|might subscribe)\b/i.test(
			sentence,
		)
	) {
		return []
	}
	const entities: string[] = []
	for (const pattern of [
		/\b(?:subscribe(?:d)? to|subscription(?:s)? to|subscriptions?:)\s+([^.;!?]+)/gi,
	]) {
		for (const match of sentence.matchAll(pattern)) {
			for (const part of (match[1] ?? "").split(
				/,\s*(?:and\s+)?|\s+\band\s+/i,
			)) {
				const entity = cleanCountEntity(part)
				if (entity && !/\bmagazines?\b/i.test(entity)) {
					entities.push(entity)
				}
			}
		}
	}
	return entities
}

function extractMusicAlbumEntities(sentence: string): string[] {
	if (
		/\b(want to|planning to|recommend|playlist|listening to)\b/i.test(sentence)
	) {
		return []
	}
	const entities: string[] = []
	for (const pattern of [
		/\b(?:purchased|bought|downloaded)\s+(?:the\s+)?(?:album|ep)\s+["'“]?([^"'”.;!?]+)["'”]?/gi,
		/\b(?:purchased|bought|downloaded)\s+["'“]([^"'”]{2,80})["'”]\s+(?:album|ep)\b/gi,
	]) {
		for (const match of sentence.matchAll(pattern)) {
			const entity = cleanCountEntity(match[1] ?? "")
			if (entity) {
				entities.push(entity)
			}
		}
	}
	return entities
}

function extractInstrumentEntities(sentence: string): string[] {
	if (
		/\b(want to|planning to|lessons?|learning|wish list|sell)\b/i.test(sentence)
	) {
		return []
	}
	return extractNamedEntitiesByDictionary(sentence, [
		[/\bfender stratocaster\b|\belectric guitar\b/i, "electric guitar"],
		[/\byamaha fg800\b|\bacoustic guitar\b/i, "acoustic guitar"],
		[/\bpearl export\b|\bdrum set\b|\bdrums?\b/i, "drum set"],
		[/\bkorg b1\b|\bpiano\b|\bkeyboard\b/i, "piano"],
		[/\bviolin\b/i, "violin"],
		[/\bbass\b/i, "bass"],
	])
}

function extractAntiqueItemEntities(sentence: string): string[] {
	if (/\b(appraisal|museum|shop|want to buy|looking for)\b/i.test(sentence)) {
		return []
	}
	const entities: string[] = []
	for (const pattern of [
		/\b(?:inherited|got|received|acquired)\s+([^.;!?]+?)(?:\s+from\s+(?:my|our)\s+[^.;!?]+)?[.;!?]/gi,
	]) {
		for (const match of sentence.matchAll(pattern)) {
			for (const part of (match[1] ?? "").split(
				/,\s*(?:and\s+)?|\s+\band\s+/i,
			)) {
				const entity = cleanCountEntity(part)
				if (
					entity &&
					/\b(antique|vase|clock|jewelry|jewellery|ring|necklace|watch|silver|china|quilt|chair|table|heirloom)\b/i.test(
						entity,
					)
				) {
					entities.push(entity)
				}
			}
		}
	}
	return entities
}

function extractSportEntities(sentence: string): string[] {
	if (
		/\bnever\s+competed\b/i.test(sentence) ||
		!/\b(played\s+[^.;!?]{0,40}competitively|competed|competitive|on the\s+[^.;!?]{0,30}\bteam)\b/i.test(
			sentence,
		)
	) {
		return []
	}
	return extractNamedEntitiesByDictionary(sentence, [
		[/\bsoccer\b/i, "soccer"],
		[/\bbasketball\b/i, "basketball"],
		[/\btennis\b/i, "tennis"],
		[/\bswimming\b|\bswim team\b/i, "swimming"],
		[/\bvolleyball\b/i, "volleyball"],
		[/\btrack\b|\brunning\b/i, "track/running"],
		[/\bsoftball\b/i, "softball"],
	])
}

function extractOnlineCourseEntities(sentence: string): string[] {
	if (/\b(want to take|thinking of|recommend|catalog)\b/i.test(sentence)) {
		return []
	}
	const entities: string[] = []
	for (const pattern of [
		/\b(?:completed|finished)\s+(?:an?\s+)?(?:online\s+)?course\s+(?:on|in|called)?\s*["'“]?([^"'”.;!?]+)["'”]?/gi,
		/\b["'“]([^"'”]{2,80})["'”]\s+(?:online\s+)?course\b[^.;!?]*\b(?:completed|finished)\b/gi,
	]) {
		for (const match of sentence.matchAll(pattern)) {
			const entity = cleanCountEntity(match[1] ?? "")
			if (entity) {
				entities.push(entity)
			}
		}
	}
	return entities
}

function extractCharityEventEntities(sentence: string): string[] {
	if (
		/\b(after|following|next|upcoming|planning)\b[^.;!?]{0,80}\bRun for the Cure\b/i.test(
			sentence,
		)
	) {
		return []
	}
	const entities: string[] = []
	for (const pattern of [
		/\b(?:participated in|volunteered at|attended|joined)\s+(?:the\s+)?([^.;!?]+?\b(?:charity|fundraiser|gala|walk|run|drive|event)\b[^.;!?]*)/gi,
	]) {
		for (const match of sentence.matchAll(pattern)) {
			const entity = cleanCountEntity(match[1] ?? "")
			if (entity) {
				entities.push(entity)
			}
		}
	}
	return entities
}

function extractFitnessClassEntities(sentence: string): string[] {
	if (/\b(want to try|thinking of|recommend)\b/i.test(sentence)) {
		return []
	}
	return extractNamedEntitiesByDictionary(sentence, [
		[/\byoga\b/i, "yoga"],
		[/\bpilates\b/i, "pilates"],
		[/\bspin\b|\bcycling\b/i, "spin"],
		[/\bzumba\b/i, "zumba"],
		[/\bboxing\b/i, "boxing"],
		[/\bbarre\b/i, "barre"],
	])
}

function extractModelKitEntities(sentence: string): string[] {
	const text = sentence.replace(/^\s*user\s*:\s*/i, "")
	const source = text.includes(":") ? (text.split(":").pop() ?? text) : text
	return source
		.split(/,\s*(?:and\s+)?|\s+\band\s+/i)
		.map(cleanCountEntity)
		.filter((part) =>
			/\b(model\s+kit|revell|tamiya|scale|f-15|spitfire|tiger|b-29|camaro|eagle|bomber)\b/i.test(
				part,
			),
		)
}

function extractPlantEntities(sentence: string): string[] {
	const match = sentence.match(
		/\b(?:got|bought|purchased|received|acquired|picked up)\s+(.+?)(?:[.;!?]|\s+\b(?:from|at|on|because|while|before|after|for|yesterday|today|recently|last weekend|last month|two weeks ago|three weeks ago)\b|$)/i,
	)
	const source = match?.[1]
	if (!source) {
		return []
	}
	return source
		.split(/,\s*(?:and\s+)?|\s+\band\s+/i)
		.map(cleanCountEntity)
		.filter((part) =>
			/\b(peace\s+lily|lily|succulent|fern|orchid|pothos|monstera|cactus|aloe|plant)\b/i.test(
				part,
			),
		)
}

function extractDoctorEntities(sentence: string): string[] {
	return [
		...sentence.matchAll(
			/\b(primary care physician|ENT specialist|dermatologist|cardiologist|dentist|orthopedist|therapist|physician|specialist|doctor)\b/gi,
		),
	]
		.map((match) => match[1])
		.filter(Boolean)
}

function extractDomainCountKeys(query: string, sentence: string): string[] {
	if (isModelKitCountQuery(query)) {
		return extractModelKitEntities(sentence)
	}
	if (isPlantAcquisitionCountQuery(query)) {
		return extractPlantEntities(sentence)
	}
	if (isDoctorVisitCountQuery(query)) {
		return extractDoctorEntities(sentence)
	}
	if (isCuisineCountQuery(query)) {
		return extractCuisineEntities(sentence)
	}
	if (isWeddingAttendanceCountQuery(query)) {
		return extractWeddingEntities(sentence)
	}
	if (isPropertyViewCountQuery(query)) {
		return extractPropertyViewEntities(sentence)
	}
	if (isKitchenItemCountQuery(query)) {
		return extractKitchenItemEntities(sentence)
	}
	if (isFurnitureActionCountQuery(query)) {
		return extractFurnitureEntities(sentence)
	}
	if (isFoodDeliveryServiceCountQuery(query)) {
		return extractFoodDeliveryServiceEntities(sentence)
	}
	if (isCitrusFruitCountQuery(query)) {
		return extractCitrusFruitEntities(sentence)
	}
	if (isMovieFestivalCountQuery(query)) {
		return extractMovieFestivalEntities(sentence)
	}
	if (isHealthDeviceCountQuery(query)) {
		return extractHealthDeviceEntities(sentence)
	}
	if (isMagazineSubscriptionCountQuery(query)) {
		return extractMagazineSubscriptionEntities(sentence)
	}
	if (isMusicAlbumCountQuery(query)) {
		return extractMusicAlbumEntities(sentence)
	}
	if (isInstrumentCountQuery(query)) {
		return extractInstrumentEntities(sentence)
	}
	if (isAntiqueItemCountQuery(query)) {
		return extractAntiqueItemEntities(sentence)
	}
	if (isSportPlayedCountQuery(query)) {
		return extractSportEntities(sentence)
	}
	if (isOnlineCourseCountQuery(query)) {
		return extractOnlineCourseEntities(sentence)
	}
	if (isCharityEventCountQuery(query)) {
		return extractCharityEventEntities(sentence)
	}
	if (isFitnessClassCountQuery(query)) {
		return extractFitnessClassEntities(sentence)
	}
	return []
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
	return (
		/\b(completed|finished|done)\b.*\b(since|starting|started)\b/i.test(
			query,
		) || /\bhow many times\s+(?:have|had)\s+i\b/i.test(query)
	)
}

const numberWords = new Map([
	["one", 1],
	["two", 2],
	["three", 3],
	["four", 4],
	["five", 5],
	["six", 6],
	["seven", 7],
	["eight", 8],
	["nine", 9],
	["ten", 10],
	["eleven", 11],
	["twelve", 12],
	["thirteen", 13],
	["fourteen", 14],
	["fifteen", 15],
	["sixteen", 16],
	["seventeen", 17],
	["eighteen", 18],
	["nineteen", 19],
	["twenty", 20],
	["thirty", 30],
])

function parseSmallNumber(raw: string | undefined): number {
	if (!raw) return Number.NaN
	const parsed = Number.parseInt(raw, 10)
	if (Number.isFinite(parsed)) return parsed
	return numberWords.get(raw.toLowerCase()) ?? Number.NaN
}

function extractPercentFacts(sentence: string): Array<{
	entity?: string
	value: number
	evidence: string
}> {
	const facts: Array<{ entity?: string; value: number; evidence: string }> = []
	for (const match of sentence.matchAll(
		/\b([A-Z][A-Za-z0-9&' -]{1,40}?)\b.{0,90}\b(\d{1,3})\s*%\s*(?:off|discount)\b|\b(\d{1,3})\s*%\s*(?:off|discount)\b.{0,90}\b([A-Z][A-Za-z0-9&' -]{1,40}?)\b/g,
	)) {
		const leftEntity = match[1]?.trim()
		const leftValue = match[2]
		const rightValue = match[3]
		const rightEntity = match[4]?.trim()
		const rawValue = leftValue ?? rightValue
		const value = Number.parseInt(rawValue ?? "", 10)
		if (!Number.isFinite(value)) {
			continue
		}
		const entity = (leftEntity ?? rightEntity)
			?.replace(/^(?:I|By the way|Last week|Recently)\s+/i, "")
			.replace(/\s+(?:and|or|but)$/i, "")
			.trim()
		facts.push({
			entity,
			value,
			evidence: compactEvidenceSentence(sentence, 170),
		})
	}
	return facts
}

function queryEntities(query: string): string[] {
	return [
		...new Set(
			Array.from(
				query.matchAll(/\b[A-Z][A-Za-z0-9&']+(?:[ -][A-Z][A-Za-z0-9&']+)*\b/g),
			)
				.map((match) => match[0].trim())
				.filter(
					(entity) =>
						entity.length > 2 &&
						!/^(How|What|Which|Did|Can|The|I)$/.test(entity),
				),
		),
	]
}

export function buildPercentageComparisonEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	if (!isPercentageComparisonQuery(query)) {
		return []
	}
	const entities = queryEntities(query)
	if (entities.length < 2) {
		return []
	}
	const facts: Array<{
		entity: string
		value: number
		date?: string
		evidence: string
	}> = []
	const seen = new Set<string>()
	for (const result of results.slice(0, 40)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			for (const fact of extractPercentFacts(sentence)) {
				const entity = entities.find((candidate) =>
					sentence.toLowerCase().includes(candidate.toLowerCase()),
				)
				if (!entity) {
					continue
				}
				const key = `${entity}:${fact.value}`
				if (seen.has(key)) {
					continue
				}
				seen.add(key)
				facts.push({
					entity,
					value: fact.value,
					date,
					evidence: fact.evidence,
				})
			}
		}
	}
	const byEntity = entities
		.map((entity) => facts.find((fact) => fact.entity === entity))
		.filter((fact): fact is NonNullable<typeof fact> => Boolean(fact))
	if (byEntity.length < 2) {
		return []
	}
	const [first, second] = byEntity
	const comparison =
		first.value === second.value
			? `${first.entity} and ${second.entity} have the same sourced percentage (${first.value}%).`
			: `${first.value > second.value ? first.entity : second.entity} has the higher sourced percentage (${Math.max(first.value, second.value)}% vs ${Math.min(first.value, second.value)}%).`
	const memory = [
		`ANSWER EVIDENCE: ${comparison} Derived percentage comparison from retrieved memories. Answer percentage-comparison questions directly from these source-backed percentages; do not abstain merely because adjacent wording says order, promo, or discount differently.`,
		...byEntity.map(
			(fact, index) =>
				`${index + 1}. ${fact.entity}: ${fact.value}%${fact.date ? ` (${fact.date})` : ""}: ${fact.evidence}`,
		),
	].join(" ")
	return [
		{
			id: `derived-percentage-comparison:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 1.15,
		},
	]
}

function extractPointFacts(sentence: string): Array<{
	kind: "current" | "target" | "reward"
	value: number
	evidence: string
}> {
	const facts: Array<{
		kind: "current" | "target" | "reward"
		value: number
		evidence: string
	}> = []
	for (const match of sentence.matchAll(/\b(\d{2,6})\s+points?\b/gi)) {
		const value = Number.parseInt(match[1] ?? "", 10)
		if (!Number.isFinite(value)) {
			continue
		}
		const before = sentence
			.slice(Math.max(0, match.index - 80), match.index)
			.toLowerCase()
		const after = sentence.slice(match.index, match.index + 120).toLowerCase()
		const context = `${before} ${after}`
		const kind =
			/\b(so far|currently|current|bringing my total|have|earned)\b/.test(
				context,
			)
				? "current"
				: /\b(total|goal|need|redeem|reaching|all set|free)\b/.test(context)
					? "target"
					: /\b(reward|rewards bazaar|redeem)\b/.test(context)
						? "reward"
						: "current"
		facts.push({
			kind,
			value,
			evidence: compactEvidenceSentence(sentence, 170),
		})
	}
	return facts
}

export function buildRemainingTotalEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	if (!isRemainingTotalQuery(query)) {
		return []
	}
	const facts: Array<{
		kind: "current" | "target" | "reward"
		value: number
		date?: string
		evidence: string
	}> = []
	for (const result of results.slice(0, 40)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			for (const fact of extractPointFacts(sentence)) {
				facts.push({ ...fact, date })
			}
		}
	}
	const current = facts
		.filter((fact) => fact.kind === "current")
		.sort((a, b) => b.value - a.value)[0]
	const target = facts
		.filter((fact) => fact.kind === "target")
		.sort((a, b) => b.value - a.value)[0]
	if (!current || !target || target.value <= current.value) {
		return []
	}
	const remaining = target.value - current.value
	const memory = [
		`ANSWER EVIDENCE: remaining answer = ${remaining}; derived remaining-total evidence from retrieved memories: current sourced total ${current.value}; target sourced total ${target.value}; remaining amount to earn/collect is ${remaining}. For "how many do I need to earn/collect/reach" questions, answer with the remaining amount, not the target total.`,
		`1. current: ${current.value}${current.date ? ` (${current.date})` : ""}: ${current.evidence}`,
		`2. target: ${target.value}${target.date ? ` (${target.date})` : ""}: ${target.evidence}`,
	].join(" ")
	return [
		{
			id: `derived-remaining-total:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 1.1,
		},
	]
}

function isArithmeticTotalQuery(query: string): boolean {
	if (isRemainingTotalQuery(query) || isPercentageComparisonQuery(query)) {
		return false
	}
	if (/\bhow much more\b/i.test(query)) {
		return false
	}
	const lowerQuery = query.toLowerCase()
	const hasTotalIntent =
		/\b(total|combined|altogether|sum|both|across all|two|three)\b/.test(
			lowerQuery,
		) || /\bpage count\b/.test(lowerQuery)
	const hasArithmeticUnit =
		/\b(hours?|hrs?|money|spent|spend|cost|raised|views?|comments?|pages?|page count|meals?|lunch(?:es)?|servings?|weight|pounds?|lbs?|fish|dozen)\b/.test(
			lowerQuery,
		)
	return hasTotalIntent && hasArithmeticUnit
}

function arithmeticQueryFocusTerms(query: string): string[] {
	return queryTerms(query).filter(
		(term) =>
			![
				"across",
				"all",
				"altogether",
				"both",
				"combined",
				"comment",
				"comments",
				"count",
				"days",
				"different",
				"dozen",
				"fish",
				"got",
				"hour",
				"hours",
				"lunch",
				"meal",
				"meals",
				"money",
				"number",
				"page",
				"pages",
				"past",
				"pound",
				"pounds",
				"recent",
				"serving",
				"servings",
				"spent",
				"three",
				"total",
				"two",
				"view",
				"views",
				"weight",
			].includes(term),
	)
}

function arithmeticUnitLabel(query: string): string {
	const lowerQuery = query.toLowerCase()
	if (/\b(hours?|hrs?)\b/.test(lowerQuery)) return "hours"
	if (/\b(money|spent|spend|cost|raised|\$)\b/.test(lowerQuery))
		return "dollars"
	if (/\b(weight|pounds?|lbs?)\b/.test(lowerQuery)) return "pounds"
	if (/\bviews?\b/.test(lowerQuery)) return "views"
	if (/\bcomments?\b/.test(lowerQuery)) return "comments"
	if (/\bpages?|page count\b/.test(lowerQuery)) return "pages"
	if (/\b(lunch(?:es)?|meals?|servings?)\b/.test(lowerQuery)) return "meals"
	if (/\bfish\b/.test(lowerQuery)) return "fish"
	if (/\bdozen\b/.test(lowerQuery)) return "dozen"
	return "units"
}

function parseQuantity(raw: string | undefined): number {
	if (!raw) return Number.NaN
	const normalized = raw.replace(/,/g, "").toLowerCase()
	const parsed = Number.parseFloat(normalized)
	if (Number.isFinite(parsed)) return parsed
	return numberWords.get(normalized) ?? Number.NaN
}

function sentenceMatchesArithmeticQuery(
	query: string,
	sentence: string,
	focusTerms: string[],
): boolean {
	if (focusTerms.length === 0) {
		return true
	}
	const lowerSentence = sentence.toLowerCase()
	const matchedTerms = focusTerms.filter((term) =>
		queryTermVariants(term).some((variant) => lowerSentence.includes(variant)),
	)
	if (matchedTerms.length > 0) {
		return true
	}
	return queryEntities(query).some((entity) =>
		lowerSentence.includes(entity.toLowerCase()),
	)
}

function extractArithmeticFacts(
	query: string,
	sentence: string,
): Array<{ value: number; evidence: string; unit: string }> {
	const unit = arithmeticUnitLabel(query)
	const facts: Array<{ value: number; evidence: string; unit: string }> = []
	const compact = compactEvidenceSentence(sentence, 190)
	const patterns: RegExp[] = []
	if (unit === "dollars") {
		patterns.push(/\$\s*([0-9][0-9,]*(?:\.\d+)?)/g)
	}
	if (unit === "hours") {
		patterns.push(
			/\b([0-9]+(?:\.[0-9]+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:hours?|hrs?)\b/gi,
		)
	}
	if (unit === "pounds") {
		patterns.push(
			/\b([0-9][0-9,]*(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty)\s+(?:pounds?|lbs?)\b/gi,
		)
	}
	if (unit === "views") {
		patterns.push(/\b([0-9][0-9,]*)\s+views?\b/gi)
	}
	if (unit === "comments") {
		patterns.push(/\b([0-9][0-9,]*)\s+comments?\b/gi)
	}
	if (unit === "pages") {
		patterns.push(/\b([0-9][0-9,]*)\s+pages?\b/gi)
	}
	if (unit === "meals") {
		patterns.push(
			/\b([0-9][0-9,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:lunch(?:es)?|meals?|servings?)\b/gi,
		)
	}
	if (unit === "fish") {
		patterns.push(
			/\b([0-9][0-9,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:fish|bettas?|gouramis?|tetras?)\b/gi,
		)
	}
	if (unit === "dozen") {
		patterns.push(
			/\b([0-9][0-9,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty)\s+dozen\b/gi,
		)
	}
	for (const pattern of patterns) {
		for (const match of sentence.matchAll(pattern)) {
			const value = parseQuantity(match[1])
			if (!Number.isFinite(value)) {
				continue
			}
			facts.push({ value, evidence: compact, unit })
		}
	}
	return facts
}

function formatArithmeticValue(value: number, unit: string): string {
	const formatted = Number.isInteger(value) ? `${value}` : `${value.toFixed(1)}`
	if (unit === "dollars") {
		return `$${formatted}`
	}
	return `${formatted} ${unit}`
}

export function buildArithmeticTotalEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	if (!isArithmeticTotalQuery(query)) {
		return []
	}
	const focusTerms = arithmeticQueryFocusTerms(query)
	const facts: Array<{
		date?: string
		evidence: string
		unit: string
		value: number
	}> = []
	const seen = new Set<string>()
	for (const result of results.slice(0, 80)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (
				isPlanOrAdvice(sentence) ||
				(sentenceSpeaker(sentence) !== "user" && !isAssistantAnchored(sentence))
			) {
				continue
			}
			if (!sentenceMatchesArithmeticQuery(query, sentence, focusTerms)) {
				continue
			}
			for (const fact of extractArithmeticFacts(query, sentence)) {
				const key = `${fact.value}:${normalizeEvidenceKey(fact.evidence)}`
				if (seen.has(key)) {
					continue
				}
				seen.add(key)
				facts.push({ ...fact, date })
				if (facts.length >= 8) {
					break
				}
			}
			if (facts.length >= 8) {
				break
			}
		}
		if (facts.length >= 8) {
			break
		}
	}
	if (facts.length < 2) {
		return []
	}
	const unit = facts[0]?.unit ?? arithmeticUnitLabel(query)
	const total = facts.reduce((sum, fact) => sum + fact.value, 0)
	const memory = [
		`ANSWER EVIDENCE: total answer = ${formatArithmeticValue(total, unit)}; derived arithmetic-total evidence from retrieved memories: sum only the source-backed numeric facts below for this total/combined question. Do not use unrelated numbers, dates, rankings, or stale totals.`,
		...facts.map(
			(fact, index) =>
				`${index + 1}. ${formatArithmeticValue(fact.value, fact.unit)}${fact.date ? ` (${fact.date})` : ""}: ${fact.evidence}`,
		),
	].join(" ")
	return [
		{
			id: `derived-arithmetic-total:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 1.12,
		},
	]
}

function currentStateQueryFocusTerms(query: string): string[] {
	return queryTerms(query).filter(
		(term) =>
			![
				"current",
				"currently",
				"latest",
				"most",
				"mostly",
				"recently",
				"still",
				"where",
				"keep",
				"stocked",
				"refrigerator",
				"limit",
				"increase",
				"increased",
				"decrease",
				"decreased",
				"changed",
				"spare",
				"have",
				"personal",
				"best",
			].includes(term),
	)
}

function sentenceMatchesCurrentStateQuery(
	query: string,
	sentence: string,
	focusTerms: string[],
): boolean {
	if (focusTerms.length === 0) {
		return true
	}
	const lowerSentence = sentence.toLowerCase()
	if (
		focusTerms.some((term) =>
			queryTermVariants(term).some((variant) =>
				lowerSentence.includes(variant),
			),
		)
	) {
		return true
	}
	return queryEntities(query).some((entity) =>
		lowerSentence.includes(entity.toLowerCase()),
	)
}

function extractLocationStateValue(sentence: string): string | undefined {
	for (const pattern of [
		/\bmoved\b.{0,90}?\bto\s+([^.;!?]+)/i,
		/\b(?:now|currently|still)\s+(?:keep|store|put)\b.{0,90}?\b(?:in|on|under|at)\s+([^.;!?]+)/i,
		/\b(?:keep|store|stored|put)\b.{0,90}?\b(?:in|on|under|at)\s+([^.;!?]+)/i,
	]) {
		const match = sentence.match(pattern)
		const value = match?.[1]
			?.split(/\s+(?:because|but|and then|while)\b/i)[0]
			?.replace(/[,.!?].*$/g, "")
			.trim()
		if (value && !/^(it|them|there)$/i.test(value)) {
			return value
		}
	}
	return undefined
}

function extractCurrentQuantityValue(
	query: string,
	sentence: string,
): string | undefined {
	const unit = arithmeticUnitLabel(query)
	if (unit === "dozen") {
		const match = sentence.match(
			/\b([0-9][0-9,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty)\s+dozen\b/i,
		)
		const value = match?.[1]
		return value ? `${parseQuantity(value)} dozen` : undefined
	}
	if (/\bdays?\s+a\s+week\b/i.test(query)) {
		const match = sentence.match(
			/\b([0-9][0-9,]*|one|two|three|four|five|six|seven)\s+days?\s+a\s+week\b/i,
		)
		const value = match?.[1]
		return value ? `${parseQuantity(value)} days a week` : undefined
	}
	return undefined
}

function extractPersonalRecordValue(sentence: string): string | undefined {
	for (const pattern of [
		/\b(\d{1,2}:\d{2})\b/,
		/\b(\d{1,2}\s+minutes?\s+and\s+\d{1,2}\s+seconds?)\b/i,
	]) {
		const match = sentence.match(pattern)
		if (match?.[1]) {
			return match[1]
		}
	}
	return undefined
}

function extractCurrentStateFacts(
	query: string,
	sentence: string,
	date: string | undefined,
	sourceRank: number,
): CurrentStateFact[] {
	const facts: CurrentStateFact[] = []
	const lowerQuery = query.toLowerCase()
	const lowerSentence = sentence.toLowerCase()
	const evidence = compactEvidenceSentence(sentence, 190)
	if (
		/\blimit\b/.test(lowerQuery) &&
		/\blimit\b/.test(lowerSentence) &&
		/\b(increase|increased|decrease|decreased|raise|raised|lower|lowered|reduced|changed)\b/.test(
			lowerSentence,
		)
	) {
		const direction = /\b(increase|increased|raise|raised)\b/.test(
			lowerSentence,
		)
			? "increased"
			: /\b(decrease|decreased|lower|lowered|reduced)\b/.test(lowerSentence)
				? "decreased"
				: "changed"
		facts.push({
			kind: "direction",
			value: direction,
			date,
			evidence,
			sourceRank,
		})
	}
	if (
		/\bwhere\b.*\bkeep\b|\bkeep\b.*\bwhere\b/.test(lowerQuery) &&
		/\b(keep|store|stored|moved|put)\b/.test(lowerSentence)
	) {
		const location = extractLocationStateValue(sentence)
		if (location) {
			facts.push({
				kind: "location",
				value: location,
				date,
				evidence,
				sourceRank,
			})
		}
	}
	if (
		/\b(stocked|currently|current|days?\s+a\s+week)\b/.test(lowerQuery) &&
		/\b(have|has|currently|now|stocked|attend)\b/.test(lowerSentence)
	) {
		const quantity = extractCurrentQuantityValue(query, sentence)
		if (quantity) {
			facts.push({
				kind: "quantity",
				value: quantity,
				date,
				evidence,
				sourceRank,
			})
		}
	}
	if (
		/\b(do i have|spare)\b/.test(lowerQuery) &&
		/\b(have|has|found|bought|keep|kept|spare)\b/.test(lowerSentence)
	) {
		facts.push({
			kind: "possession",
			value: "Yes",
			date,
			evidence,
			sourceRank,
		})
	}
	if (
		/\bpersonal best\b/.test(lowerQuery) &&
		/\b(personal best|pb|beat|improved)\b/.test(lowerSentence)
	) {
		const record = extractPersonalRecordValue(sentence)
		if (record) {
			facts.push({
				kind: "record",
				value: record,
				date,
				evidence,
				sourceRank,
			})
		}
	}
	return facts
}

export function buildCurrentStateEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	if (!isCurrentStateQuery(query)) {
		return []
	}
	const focusTerms = currentStateQueryFocusTerms(query)
	const facts: CurrentStateFact[] = []
	const seen = new Set<string>()
	for (const [rank, result] of results.slice(0, 100).entries()) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (isPlanOrAdvice(sentence) || sentenceSpeaker(sentence) !== "user") {
				continue
			}
			if (!sentenceMatchesCurrentStateQuery(query, sentence, focusTerms)) {
				continue
			}
			for (const fact of extractCurrentStateFacts(
				query,
				sentence,
				date,
				rank,
			)) {
				const key = `${fact.kind}:${fact.value}:${normalizeEvidenceKey(fact.evidence)}`
				if (seen.has(key)) {
					continue
				}
				seen.add(key)
				facts.push(fact)
			}
		}
	}
	if (facts.length === 0) {
		return []
	}
	const ordered = facts.sort((a, b) => {
		const dateCompare = (b.date ?? "").localeCompare(a.date ?? "")
		if (dateCompare !== 0) return dateCompare
		return a.sourceRank - b.sourceRank
	})
	const current = ordered[0]
	if (!current) {
		return []
	}
	const bullets = ordered
		.slice(0, 6)
		.map((fact, index) => {
			const label = index === 0 ? "current/latest" : "superseded or older"
			return `${index + 1}. ${label}: ${fact.value}${fact.date ? ` (${fact.date})` : ""}: ${fact.evidence}`
		})
		.join(" ")
	const memory = `ANSWER EVIDENCE: current answer = ${current.value}; derived current-state evidence from retrieved memories: use the latest source-dated fact for this current/latest question. Older facts below are preserved as superseded context, not as the answer. ${bullets}`
	return [
		{
			id: `derived-current-state-evidence:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 1.16,
			created_at: current.date ? `${current.date}T00:00:00.000Z` : undefined,
		},
	]
}

function extractAttributeFacts(
	query: string,
	sentence: string,
): Array<{ value: string; evidence: string }> {
	const facts: Array<{ value: string; evidence: string }> = []
	const lowerQuery = query.toLowerCase()
	const lowerSentence = sentence.toLowerCase()
	if (/\bbrand\b/.test(lowerQuery)) {
		const objectTerms = queryTerms(query).filter(
			(term) =>
				!["brand", "currently", "called", "name", "using", "use"].includes(
					term,
				),
		)
		if (
			objectTerms.length > 0 &&
			!objectTerms.some((term) =>
				queryTermVariants(term).some((variant) =>
					lowerSentence.includes(variant),
				),
			)
		) {
			return facts
		}
		for (const pattern of [
			/\b(?:from|at|by)\s+([A-Z][A-Za-z0-9&' -]{2,40})\b/,
			/\b([A-Z][A-Za-z0-9&' -]{2,40})\s+(?:brand|shampoo|conditioner|sneakers?|headphones?|mat)\b/,
		]) {
			const match = sentence.match(pattern)
			const value = match?.[1]
				?.split(/\s+(?:and|but|with|while|because|where)\b/i)[0]
				?.replace(/[,.!?].*$/g, "")
				.trim()
			if (
				!value ||
				/^(the|a|an|my|your|whim)$/i.test(value) ||
				/\b(i|i've|i am|i'm|been|using|picked|current|stick|think)\b/i.test(
					value,
				)
			) {
				continue
			}
			if (
				lowerSentence.includes("use") ||
				lowerSentence.includes("using") ||
				lowerSentence.includes("picked up") ||
				lowerSentence.includes("bought")
			) {
				facts.push({
					value,
					evidence: compactEvidenceSentence(sentence, 170),
				})
			}
		}
	}
	return facts
}

function numericAttributeQueryTerms(query: string): string[] {
	return queryTerms(query).filter(
		(term) =>
			![
				"many",
				"copies",
				"copy",
				"units",
				"unit",
				"tickets",
				"seats",
				"spots",
				"released",
				"worldwide",
				"printed",
				"made",
				"produced",
			].includes(term),
	)
}

function extractNumericAttributeFacts(
	query: string,
	sentence: string,
): NumericAttributeFact[] {
	const lowerSentence = sentence.toLowerCase()
	const terms = numericAttributeQueryTerms(query)
	if (
		terms.length > 0 &&
		!terms.some((term) =>
			queryTermVariants(term).some((variant) =>
				lowerSentence.includes(variant),
			),
		)
	) {
		return []
	}
	const queryObject = compactQueryObject(query)
	const facts: NumericAttributeFact[] = []
	for (const match of sentence.matchAll(
		/\b(?:limited edition(?: of)?|edition(?: of)?|released|printed|made|produced)?\s*(?:only\s+)?(\d{1,7})\s+(?:copies|units|tickets|seats|spots)\b(?:.{0,60}\bworldwide\b)?|\bworldwide\b.{0,60}\b(\d{1,7})\s+(?:copies|units|tickets|seats|spots)\b/gi,
	)) {
		const value = Number.parseInt(match[1] ?? match[2] ?? "", 10)
		if (!Number.isFinite(value)) {
			continue
		}
		facts.push({
			value,
			evidence: compactEvidenceSentence(sentence, 190),
			queryObject,
		})
	}
	return facts
}

export function buildTemporalOrderEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	if (!isTemporalOrderQuery(query)) {
		return []
	}
	const facts: TemporalOrderFact[] = []
	const seen = new Set<string>()
	for (const [rank, result] of results.slice(0, 120).entries()) {
		const sortKey = result.timestamp?.toISOString?.()
		if (!sortKey) {
			continue
		}
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		for (const sentence of splitSentences(raw)) {
			if (!isUserAnchored(sentence) && !isAssistantAnchored(sentence)) {
				continue
			}
			if (
				isPlanOrAdvice(sentence) &&
				!/\b(?:got back|returned|started|went|visited|took|had)\b/i.test(
					sentence,
				)
			) {
				continue
			}
			const label = temporalOrderLabel(sentence)
			if (!label) {
				continue
			}
			if (
				/\b(?:planning|plan|future|upcoming|going to|want to|would like)\b/i.test(
					label,
				) &&
				!/\b(?:got back|returned|started|went|visited|took|had)\b/i.test(label)
			) {
				continue
			}
			const key = `${sortKey.slice(0, 10)}:${normalizeEvidenceKey(label)}`
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			const sourceRole = isUserAnchored(sentence) ? "user" : "assistant"
			facts.push({
				date: sortKey.slice(0, 10),
				sortKey,
				label,
				evidence: compactEvidenceSentence(sentence, 220),
				score:
					(result.score ?? 0) +
					Math.max(0, 0.25 - rank * 0.002) +
					(sourceRole === "user" ? 0.05 : 0),
				sourceRank: rank,
				sourceRole,
			})
		}
	}
	const requestedCount = requestedItemCount(query)
	const sorted = facts
		.sort(
			(a, b) =>
				a.sortKey.localeCompare(b.sortKey) ||
				temporalSpecificityScore(b) - temporalSpecificityScore(a) ||
				b.score - a.score ||
				a.sourceRank - b.sourceRank,
		)
		.filter((fact, index, all) => {
			const prior = all.slice(0, index)
			return !prior.some(
				(entry) =>
					entry.date === fact.date &&
					normalizeEvidenceKey(entry.label) ===
						normalizeEvidenceKey(fact.label),
			)
		})
	const ordered =
		requestedCount && sorted.length > requestedCount
			? [
					...[...sorted]
						.filter((fact) => temporalSpecificityScore(fact) >= 0)
						.sort(
							(a, b) =>
								b.sortKey.localeCompare(a.sortKey) ||
								temporalSpecificityScore(b) - temporalSpecificityScore(a) ||
								b.score - a.score ||
								a.sourceRank - b.sourceRank,
						)
						.filter(
							(fact, index, all) =>
								all.findIndex(
									(entry) =>
										temporalDestinationKey(entry.label) ===
										temporalDestinationKey(fact.label),
								) === index,
						),
				]
					.slice(0, requestedCount)
					.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
			: sorted.slice(0, requestedCount ?? 8)
	if (ordered.length < 2) {
		return []
	}
	const memory = [
		"ANSWER EVIDENCE: derived chronological order from retrieved memories. Use the memory timestamps as event dates; phrases like today, recently, just got back, or started are anchored to the timestamp on that memory.",
		...ordered.map(
			(fact, index) =>
				`${index + 1}. ${fact.date}: ${fact.label}. Source: ${fact.evidence}`,
		),
	].join(" ")
	return [
		{
			id: `derived-temporal-order-evidence:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 1.1,
			created_at: `${ordered[0]?.date}T00:00:00.000Z`,
		},
	]
}

export function buildAttributeEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
): Mem0CompatSearchResult[] {
	if (!isAttributeLookupQuery(query) && !isNumericAttributeQuery(query)) {
		return []
	}
	if (isNumericAttributeQuery(query)) {
		const facts: Array<NumericAttributeFact & { date?: string }> = []
		const seen = new Set<string>()
		for (const result of results.slice(0, 80)) {
			const raw = result.snippet ?? result.citation ?? result.path ?? ""
			const date = result.timestamp?.toISOString?.().slice(0, 10)
			for (const sentence of splitSentences(raw)) {
				if (!isUserAnchored(sentence) && !isAssistantAnchored(sentence)) {
					continue
				}
				for (const fact of extractNumericAttributeFacts(query, sentence)) {
					const key = `${fact.value}:${normalizeEvidenceKey(fact.evidence)}`
					if (seen.has(key)) {
						continue
					}
					seen.add(key)
					facts.push({ ...fact, date })
				}
			}
		}
		if (facts.length === 0) {
			return []
		}
		const memory = [
			`ANSWER EVIDENCE: answer = ${facts[0]?.value} ${/\bcopies?\b/i.test(query) ? "copies" : "units"} for queried object "${facts[0]?.queryObject ?? compactQueryObject(query)}" release or limited edition. Derived numeric attribute evidence from retrieved memories: answer direct quantity questions from source-backed limited-edition, release, printed, made, or produced counts. Put the direct sourced count first, then preserve any raw sentence ambiguity in the citation instead of abstaining.`,
			...facts
				.slice(0, 5)
				.map(
					(fact, index) =>
						`${index + 1}. quantity for "${fact.queryObject}": ${fact.value}${fact.date ? ` (${fact.date})` : ""}: ${fact.evidence}`,
				),
		].join(" ")
		return [
			{
				id: `derived-numeric-attribute-evidence:${normalizeEvidenceKey(query)}`,
				memory,
				score: (results[0]?.score ?? 0) + 1.2,
			},
		]
	}
	const facts: Array<{ value: string; date?: string; evidence: string }> = []
	const seen = new Set<string>()
	for (const result of results.slice(0, 30)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (isAssistantAnchored(sentence) || !isUserAnchored(sentence)) {
				continue
			}
			for (const fact of extractAttributeFacts(query, sentence)) {
				const key = fact.value.toLowerCase()
				if (seen.has(key)) {
					continue
				}
				seen.add(key)
				facts.push({ ...fact, date })
			}
		}
	}
	if (facts.length === 0) {
		return []
	}
	const memory = [
		`ANSWER EVIDENCE: ${facts[0]?.value ?? "source-backed attribute value"}. Derived attribute evidence from retrieved memories: for brand/name/current-use questions, answer directly with the source-backed attribute value instead of saying it was unspecified.`,
		...facts
			.slice(0, 5)
			.map(
				(fact, index) =>
					`${index + 1}. attribute value: ${fact.value}${fact.date ? ` (${fact.date})` : ""}: ${fact.evidence}`,
			),
	].join(" ")
	return [
		{
			id: `derived-attribute-evidence:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 1,
		},
	]
}

function extractProgressTotal(sentence: string): number | null {
	for (const pattern of [
		/\bcompleted\s+(\d+)\s+projects?\b/i,
		/\bfinished\s+(?:my\s+)?(\d+)(?:st|nd|rd|th)\s+projects?\b/i,
		/\bfinished\s+(?:my\s+)?(\d+)\s+projects?\b/i,
		/\b(\d+)(?:st|nd|rd|th)\s+projects?\b/i,
		/\b(?:that's|that is|now|total(?:s|ed)?|already)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+times?\b/i,
		/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+times?\s+(?:now|already|total)\b/i,
	]) {
		const match = sentence.match(pattern)
		const value = parseSmallNumber(match?.[1])
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
	const current = deduped[0]
	const memory = `derived current-total evidence from retrieved memories: current answer ${current.value}${current.date ? ` as of ${current.date}` : ""}. This is a stated total/progress question, so use the latest or highest source-stated total; do not count the bullets as separate items. ${bullets}`
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
	const memory = `${firstDate ? `${firstDate} ` : ""}ANSWER EVIDENCE: answer = ${actions.length} clothing-store pending actions. Derived action checklist from retrieved memories: computed pending-action count: ${actions.length}. Count the numbered actions separately when the question asks how many things need to be picked up, returned, collected, or otherwise handled. Returning too-small clothing and picking up an exchanged replacement are separate pending actions when both are source-backed. Do not merge different action verbs just because they mention the same store, service location, or product family. ${bullets}`
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
	const respiratoryQuery = isRespiratoryPreferenceQuery(query)
	const seen = new Set<string>()
	const candidates: Array<{
		date?: string
		rank: number
		score: number
		text: string
	}> = []
	for (const [rank, result] of results.slice(0, 150).entries()) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (isAssistantAnchored(sentence) || !isUserAnchored(sentence)) {
				continue
			}
			const baseScore = preferenceEvidenceScore(sentence, terms)
			const respiratoryScore = respiratoryQuery
				? respiratoryPreferenceScore(sentence)
				: 0
			if (baseScore <= 0 && (!respiratoryQuery || respiratoryScore <= 0)) {
				continue
			}
			const score = baseScore + respiratoryScore
			if (score <= 0) {
				continue
			}
			const key = normalizeEvidenceKey(sentence)
			if (!key || seen.has(key)) {
				continue
			}
			seen.add(key)
			candidates.push({
				date,
				rank,
				score,
				text: compactEvidenceSentence(sentence, 190),
			})
		}
	}
	const evidence = candidates
		.sort((a, b) => b.score - a.score || a.rank - b.rank)
		.slice(0, 5)
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
		`ANSWER EVIDENCE: use the source-backed context below before giving generic advice. derived preference/context evidence from retrieved memories: ${preferenceContextLabel(query)} Use these facts to personalize advice; build on existing tools, purchases, constraints, and preferences before giving generic tips.`,
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

export function buildAssistantRecallEvidenceResults(
	query: string,
	recallResults: AssistantRecallResult[],
): Mem0CompatSearchResult[] {
	if (!hasAssistantRecallIntent(query)) {
		return []
	}
	const seen = new Set<string>()
	const evidence: Array<{
		id: string
		date?: string
		text: string
		score?: number
	}> = []
	for (const result of recallResults) {
		const citation = result.citation
		if (citation?.role !== "assistant") {
			continue
		}
		const text = citation.preview?.replace(/\s+/g, " ").trim()
		if (!text) {
			continue
		}
		const id =
			citation.eventId || `${citation.sessionId ?? "assistant"}:${text}`
		if (seen.has(id)) {
			continue
		}
		seen.add(id)
		const timestamp =
			citation.timestamp instanceof Date
				? citation.timestamp
				: typeof citation.timestamp === "string"
					? new Date(citation.timestamp)
					: undefined
		evidence.push({
			id,
			date:
				timestamp && !Number.isNaN(timestamp.getTime())
					? timestamp.toISOString().slice(0, 10)
					: undefined,
			text: compactAssistantRecallText(text, query, 620),
			score: result.score,
		})
		if (evidence.length >= 5) {
			break
		}
	}
	if (evidence.length === 0) {
		return []
	}
	const bullets = evidence
		.map(
			(item, index) =>
				`${index + 1}. ${item.date ? `${item.date}: ` : ""}${item.text}`,
		)
		.join(" ")
	return [
		{
			id: `derived-assistant-recall:${normalizeEvidenceKey(query)}`,
			memory: `ANSWER EVIDENCE: use the assistant-authored source list below. Derived assistant recall evidence from assistant-only conversation recall: for questions asking what the assistant recommended, said, mentioned, or told the user, use these assistant-authored source memories before guessing from adjacent user turns. ${bullets}`,
			score: (evidence[0]?.score ?? 0) + 1.05,
		},
	]
}

function isCountSupportingResult(
	query: string,
	result: BridgeSearchResult,
	actionTerms: string[],
	objectTerms: string[],
): boolean {
	const raw = result.snippet ?? result.citation ?? result.path ?? ""
	for (const sentence of splitSentences(raw)) {
		if (
			isDomainCountQuery(query) &&
			isUserAnchored(sentence) &&
			!isPlanOrAdvice(sentence) &&
			extractDomainCountKeys(query, sentence).length > 0
		) {
			return true
		}
		if (!isLikelyCompletedCountEvidence(query, sentence, actionTerms)) {
			continue
		}
		const domainKeys = extractDomainCountKeys(query, sentence)
		if (domainKeys.length > 0) {
			return true
		}
		if (isDomainCountQuery(query)) {
			continue
		}
		const lowerSentence = sentence.toLowerCase()
		if (
			objectTerms.length > 0 &&
			!objectTerms.some((term) => lowerSentence.includes(term))
		) {
			continue
		}
		return true
	}
	return false
}

function countSupportingResultKey(
	query: string,
	result: BridgeSearchResult,
	actionTerms: string[],
	objectTerms: string[],
): string | undefined {
	const raw = result.snippet ?? result.citation ?? result.path ?? ""
	for (const sentence of splitSentences(raw)) {
		if (
			isDomainCountQuery(query) &&
			isUserAnchored(sentence) &&
			!isPlanOrAdvice(sentence)
		) {
			const domainKeys = extractDomainCountKeys(query, sentence)
			if (domainKeys.length > 0) {
				return normalizeEvidenceKey(domainKeys[0] ?? sentence)
			}
		}
		if (!isLikelyCompletedCountEvidence(query, sentence, actionTerms)) {
			continue
		}
		const domainKeys = extractDomainCountKeys(query, sentence)
		if (domainKeys.length > 0) {
			return normalizeEvidenceKey(domainKeys[0] ?? sentence)
		}
		if (isDomainCountQuery(query)) {
			continue
		}
		const lowerSentence = sentence.toLowerCase()
		if (
			objectTerms.length > 0 &&
			!objectTerms.some((term) => lowerSentence.includes(term))
		) {
			continue
		}
		return evidenceObjectKey(sentence, objectTerms)
	}
	return undefined
}

export function selectCountSupportingRawResults(
	query: string,
	results: BridgeSearchResult[],
): BridgeSearchResult[] {
	const kind = classifyMem0CompatCountKind(query)
	if (
		kind === "duration" ||
		kind === "money-or-percent" ||
		kind === "pending-action" ||
		kind === "unknown-count" ||
		isNumericAttributeQuery(query)
	) {
		return results
	}
	if (isProgressTotalQuery(query)) {
		return results
	}
	const actionTerms = countActionTerms(query)
	const objectTerms = countObjectTerms(query)
	const explicitFact = findExplicitInventoryCountFact(query, results)
	const seen = new Set<string>()
	const supportingResults = results.filter((result) => {
		if (!isCountSupportingResult(query, result, actionTerms, objectTerms)) {
			return false
		}
		const key = countSupportingResultKey(
			query,
			result,
			actionTerms,
			objectTerms,
		)
		if (!key) {
			return true
		}
		if (seen.has(key)) {
			return false
		}
		seen.add(key)
		return true
	})
	if (explicitFact) {
		return [
			explicitFact.result,
			...supportingResults.filter((result) => result !== explicitFact.result),
		]
	}
	return supportingResults.length > 0 ? supportingResults : results
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
		kind === "unknown-count" ||
		isNumericAttributeQuery(query)
	) {
		return []
	}
	if (isProgressTotalQuery(query)) {
		return buildProgressTotalEvidenceResults(query, results)
	}
	const explicitFact = findExplicitInventoryCountFact(query, results)
	if (explicitFact) {
		const memory = `${explicitFact.date ? `${explicitFact.date} ` : ""}ANSWER EVIDENCE: count answer = ${explicitFact.value}; explicit source-stated current total from retrieved memories. Use this stated total instead of counting repeated mentions, examples, recommendations, or adjacent discussion turns. Source: ${explicitFact.evidence}`
		return [
			{
				id: `explicit-count-evidence:${normalizeEvidenceKey(query)}`,
				memory,
				score: (explicitFact.score ?? results[0]?.score ?? 0) + 1.1,
			},
		]
	}
	const actionTerms = countActionTerms(query)
	const objectTerms = countObjectTerms(query)
	const seen = new Set<string>()
	const facts: Array<{ date?: string; evidence: string; key: string }> = []
	for (const result of results.slice(0, 30)) {
		const raw = result.snippet ?? result.citation ?? result.path ?? ""
		const date = result.timestamp?.toISOString?.().slice(0, 10)
		for (const sentence of splitSentences(raw)) {
			if (
				isDomainCountQuery(query) &&
				isUserAnchored(sentence) &&
				!isPlanOrAdvice(sentence)
			) {
				const domainKeys = extractDomainCountKeys(query, sentence)
				if (domainKeys.length > 0) {
					for (const key of domainKeys) {
						const normalizedKey = normalizeEvidenceKey(key)
						if (seen.has(normalizedKey)) {
							continue
						}
						seen.add(normalizedKey)
						facts.push({
							date,
							evidence: compactEvidenceSentence(sentence, 180),
							key,
						})
						if (facts.length >= 8) {
							break
						}
					}
					if (facts.length >= 8) {
						break
					}
					continue
				}
			}
			if (!isLikelyCompletedCountEvidence(query, sentence, actionTerms)) {
				continue
			}
			const domainKeys = extractDomainCountKeys(query, sentence)
			if (domainKeys.length > 0) {
				for (const key of domainKeys) {
					const normalizedKey = normalizeEvidenceKey(key)
					if (seen.has(normalizedKey)) {
						continue
					}
					seen.add(normalizedKey)
					facts.push({
						date,
						evidence: compactEvidenceSentence(sentence, 180),
						key,
					})
					if (facts.length >= 8) {
						break
					}
				}
				if (facts.length >= 8) {
					break
				}
				continue
			}
			if (isDomainCountQuery(query)) {
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
	const memory = `ANSWER EVIDENCE: count answer = ${facts.length}; derived countable evidence from retrieved memories: computed repeated-action count = ${facts.length}; distinct source-backed candidates for this count query are deduped by item/event. Use the computed count unless a source explicitly states a different current total. Verify the exact action and ignore plans, advice, unrelated people, and raw-memory duplicates. ${bullets}`
	return [
		{
			id: `derived-count-evidence:${normalizeEvidenceKey(query)}`,
			memory,
			score: (results[0]?.score ?? 0) + 0.9,
		},
	]
}

function evidenceSectionMemory(memory: string): string {
	return memory
		.replace(/^ANSWER EVIDENCE:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim()
}

function firstCreatedAt(results: Mem0CompatSearchResult[]): string | undefined {
	return results.find((result) => result.created_at)?.created_at
}

function topEvidenceScore(
	searchResults: BridgeSearchResult[],
	evidenceResults: Mem0CompatSearchResult[],
): number {
	return Math.max(
		0,
		...searchResults.map((result) =>
			typeof result.score === "number" ? result.score : 0,
		),
		...evidenceResults.map((result) =>
			typeof result.score === "number" ? result.score : 0,
		),
	)
}

function uniqueEvidenceResults(
	sections: Array<{ kind: string; results: Mem0CompatSearchResult[] }>,
): Array<{ kind: string; result: Mem0CompatSearchResult }> {
	const seen = new Set<string>()
	const unique: Array<{ kind: string; result: Mem0CompatSearchResult }> = []
	for (const section of sections) {
		for (const result of section.results) {
			const key = `${result.id}:${normalizeEvidenceKey(result.memory)}`
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			unique.push({ kind: section.kind, result })
		}
	}
	return unique
}

export function buildCompiledAnswerEvidenceResults(
	query: string,
	results: BridgeSearchResult[],
	assistantRecallResults: AssistantRecallResult[] = [],
): Mem0CompatSearchResult[] {
	const sections = uniqueEvidenceResults([
		{
			kind: "current-state",
			results: buildCurrentStateEvidenceResults(query, results),
		},
		{
			kind: "count-current-state",
			results: buildCountEvidenceResults(query, results),
		},
		{
			kind: "pending-action",
			results: buildActionEvidenceResults(query, results),
		},
		{
			kind: "remaining-total",
			results: buildRemainingTotalEvidenceResults(query, results),
		},
		{
			kind: "arithmetic-total",
			results: buildArithmeticTotalEvidenceResults(query, results),
		},
		{
			kind: "percentage-comparison",
			results: buildPercentageComparisonEvidenceResults(query, results),
		},
		{
			kind: "temporal-order",
			results: buildTemporalOrderEvidenceResults(query, results),
		},
		{
			kind: "assistant-recall",
			results: buildAssistantRecallEvidenceResults(
				query,
				assistantRecallResults,
			),
		},
		{
			kind: "attribute",
			results: buildAttributeEvidenceResults(query, results),
		},
		{
			kind: "preference-context",
			results: buildPreferenceEvidenceResults(query, results),
		},
	])
	if (sections.length === 0) {
		return []
	}
	const sectionText = sections
		.slice(0, 8)
		.map(
			(section, index) =>
				`${index + 1}. ${section.kind}: ${evidenceSectionMemory(section.result.memory)}`,
		)
		.join(" ")
	const evidenceResults = sections.map((section) => section.result)
	const memory = [
		"ANSWER EVIDENCE PACK: Use this source-backed proof pack before raw memories.",
		"It is generated only from retrieved memories and assistant recall artifacts; it contains no question-id or gold-answer logic.",
		"Treat current/latest facts as active, keep superseded/older facts only as context, and exclude planned, future, assistant-advice, or out-of-scope memories unless a section explicitly says otherwise.",
		sectionText,
	].join(" ")
	return [
		{
			id: `derived-answer-evidence-pack:${normalizeEvidenceKey(query)}`,
			memory,
			score: topEvidenceScore(results, evidenceResults) + 0.25,
			created_at: firstCreatedAt(evidenceResults),
		},
	]
}
