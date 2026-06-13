import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { evaluateAnswererArtifact } from "./check-memory-benchmarks-answerer-artifact.js"
import {
	buildArithmeticTotalEvidenceResults,
	buildAssistantRecallEvidenceResults,
	buildCountEvidenceResults,
	buildCurrentStateEvidenceResults,
	buildPreferenceEvidenceResults,
	buildSupplementalSearchQueries,
	buildTemporalOrderEvidenceResults,
	type AssistantRecallResult,
	type BridgeSearchResult,
	type Mem0CompatSearchResult,
} from "./mem0-compat-count-policy.js"
import type { MemoryCapabilityId } from "./memory-capability-fixtures.js"

type FixtureGateResult = {
	id: string
	capabilityId: MemoryCapabilityId
	label: string
	ok: boolean
	failures: string[]
	details: Record<string, unknown>
}

type FixtureGateReport = {
	generatedAt: string
	total: number
	passed: number
	failed: number
	ok: boolean
	results: FixtureGateResult[]
}

function result(snippet: string, date = "2023-05-30"): BridgeSearchResult {
	return {
		snippet,
		timestamp: new Date(`${date}T00:00:00.000Z`),
		score: 0.5,
	}
}

function memoryText(results: Mem0CompatSearchResult[]): string {
	return results.map((entry) => entry.memory).join("\n")
}

function expectContains(text: string, expected: string): string[] {
	return text.toLowerCase().includes(expected.toLowerCase())
		? []
		: [`missing expected text: ${expected}`]
}

function expectNotContains(text: string, forbidden: string): string[] {
	return text.toLowerCase().includes(forbidden.toLowerCase())
		? [`unexpected text present: ${forbidden}`]
		: []
}

function countCurrentStateGate(): FixtureGateResult {
	const query = "How many projects have I led or am currently leading?"
	const evidence = buildCountEvidenceResults(query, [
		result("user: I led the Atlas migration project last quarter."),
		result("user: I currently lead the search relevance project."),
		result("user: I advised Sam while he led the onboarding project."),
		result("assistant: You could lead future launch planning projects."),
		result("user: I am considering leading a volunteer project next year."),
		result("user: My team has eight projects in the roadmap."),
	])
	const text = memoryText(evidence)
	const failures = [
		...expectContains(text, "count answer = 2"),
		...expectContains(text, "Atlas migration project"),
		...expectContains(text, "search relevance project"),
		...expectNotContains(text, "Sam while he led"),
		...expectNotContains(text, "future launch planning"),
		...expectNotContains(text, "volunteer project next year"),
		...expectNotContains(text, "eight projects in the roadmap"),
	]
	return {
		id: "gate-count-current-state-led-projects",
		capabilityId: "count-current-state",
		label: "Count source-backed current-state project leadership",
		ok: failures.length === 0,
		failures,
		details: { query, evidence },
	}
}

function countEntityExtractionGate(): FixtureGateResult {
	const modelKitText = memoryText(
		buildCountEvidenceResults(
			"How many model kits have I worked on or bought?",
			[
				result(
					"user: I have worked on or bought five model kits: Revell F-15 Eagle, Tamiya 1/48 scale Spitfire Mk.V, a 1/16 scale German Tiger I tank, a 1/72 scale B-29 bomber, and a 1/24 scale '69 Camaro.",
				),
				result(
					"user: I bought a 2TB external hard drive from Western Digital.",
				),
			],
		),
	)
	const plantText = memoryText(
		buildCountEvidenceResults(
			"How many plants did I acquire in the last month?",
			[
				result(
					"user: I bought the peace lily and a succulent plant two weeks ago.",
				),
				result("user: I picked up a Boston fern from the nursery yesterday."),
				result(
					"assistant: A humidifier is an excellent investment for plants.",
				),
			],
		),
	)
	const doctorText = memoryText(
		buildCountEvidenceResults("How many different doctors did I visit?", [
			result("user: I visited my primary care physician on Monday."),
			result("user: I went to an ENT specialist for my sinus issue."),
			result("user: I saw a dermatologist about the rash."),
			result("user: I need to visit my family for the holidays."),
			result("user: Our clinic sent a message to the provider called Yezza."),
		]),
	)
	const cuisineText = memoryText(
		buildCountEvidenceResults(
			"How many different cuisines have I learned to cook or tried out in the past few months?",
			[
				result("user: I tried out an Ethiopian stew recipe last month."),
				result("user: I learned to cook an Indian-inspired dal for dinner."),
				result("user: I tried making Korean japchae for meal prep."),
				result(
					"user: I cooked German and Eastern European dishes like sauerkraut.",
				),
				result(
					"user: I want to incorporate more fermented foods and vegan meals.",
				),
			],
		),
	)
	const weddingText = memoryText(
		buildCountEvidenceResults(
			"How many weddings have I attended in this year?",
			[
				result("user: I attended Rachel and Mike's wedding in April."),
				result("user: I went to Emily and Sarah's wedding over the summer."),
				result("user: I was at Jen and Tom's wedding last fall."),
				result("user: I'm planning my own wedding and need venue ideas."),
			],
		),
	)
	const propertyText = memoryText(
		buildCountEvidenceResults(
			"How many properties did I view before making an offer on the townhouse in the Brookside neighborhood?",
			[
				result("user: I toured a bungalow, but the kitchen needed renovation."),
				result(
					"user: I viewed a property in Cedar Creek that was out of budget.",
				),
				result("user: I saw a 1-bedroom condo but the highway noise was bad."),
				result("user: I viewed a 2-bedroom condo and lost it to a higher bid."),
				result(
					"user: I saw the 3-bedroom townhouse in the Brookside neighborhood and put in an offer.",
				),
				result(
					"user: I had a home inspection done on the Brookside townhouse.",
				),
			],
		),
	)
	const kitchenText = memoryText(
		buildCountEvidenceResults("How many kitchen items did I replace or fix?", [
			result("user: I replaced the kitchen faucet last month."),
			result("user: I bought a new kitchen mat to replace the old one."),
			result("user: I fixed the toaster after breakfast."),
			result("user: I replaced the coffee maker when it stopped working."),
			result("user: I finally fixed the kitchen shelves."),
			result("user: I think I'll try making my own peanut sauce."),
		]),
	)
	const furnitureText = memoryText(
		buildCountEvidenceResults(
			"How many pieces of furniture did I buy, assemble, sell, or fix in the past few months?",
			[
				result("user: I bought a new coffee table for the living room."),
				result("user: I assembled an IKEA bookshelf about two months ago."),
				result("user: I sold my old couch online."),
				result("user: I fixed the wobbly dining chair."),
				result("user: I'm thinking of getting some new throw pillows."),
				result(
					"user: I rearranged the furniture after buying the coffee table.",
				),
			],
		),
	)
	const deliveryText = memoryText(
		buildCountEvidenceResults(
			"How many different types of food delivery services have I used recently?",
			[
				result("user: I used Domino's for delivery twice this month."),
				result("user: I ordered from Fresh Fusion through their delivery app."),
				result("user: I also used Uber Eats recently."),
				result("user: I tried a vegan mac and cheese recipe."),
			],
		),
	)
	const text = [
		modelKitText,
		plantText,
		doctorText,
		cuisineText,
		weddingText,
		propertyText,
		kitchenText,
		furnitureText,
		deliveryText,
	].join("\n")
	const failures = [
		...expectContains(modelKitText, "count answer = 5"),
		...expectContains(modelKitText, "Revell F-15 Eagle"),
		...expectContains(modelKitText, "1/24 scale '69 Camaro"),
		...expectNotContains(modelKitText, "hard drive"),
		...expectContains(plantText, "count answer = 3"),
		...expectContains(plantText, "peace lily"),
		...expectContains(plantText, "Boston fern"),
		...expectNotContains(plantText, "humidifier"),
		...expectContains(doctorText, "count answer = 3"),
		...expectContains(doctorText, "ENT specialist"),
		...expectContains(doctorText, "dermatologist"),
		...expectNotContains(doctorText, "family"),
		...expectNotContains(doctorText, "Yezza"),
		...expectContains(cuisineText, "count answer = 4"),
		...expectContains(cuisineText, "German/Eastern European"),
		...expectNotContains(cuisineText, "vegan"),
		...expectContains(weddingText, "count answer = 3"),
		...expectContains(weddingText, "Jen and Tom"),
		...expectNotContains(weddingText, "own wedding"),
		...expectContains(propertyText, "count answer = 4"),
		...expectContains(propertyText, "bungalow"),
		...expectContains(propertyText, "2-bedroom condo"),
		...expectNotContains(propertyText, "3-bedroom townhouse"),
		...expectNotContains(propertyText, "home inspection"),
		...expectContains(kitchenText, "count answer = 5"),
		...expectContains(kitchenText, "kitchen faucet"),
		...expectContains(kitchenText, "coffee maker"),
		...expectNotContains(kitchenText, "peanut sauce"),
		...expectContains(furnitureText, "count answer = 4"),
		...expectContains(furnitureText, "coffee table"),
		...expectContains(furnitureText, "IKEA bookshelf"),
		...expectNotContains(furnitureText, "throw pillows"),
		...expectNotContains(furnitureText, "rearranged"),
		...expectContains(deliveryText, "count answer = 3"),
		...expectContains(deliveryText, "Domino's"),
		...expectContains(deliveryText, "Fresh Fusion"),
		...expectContains(deliveryText, "Uber Eats"),
		...expectNotContains(deliveryText, "vegan mac"),
	]
	return {
		id: "gate-count-source-backed-entity-extraction",
		capabilityId: "count-current-state",
		label: "Count source-backed entity extraction",
		ok: failures.length === 0,
		failures,
		details: { evidenceText: text },
	}
}

function arithmeticTotalGate(): FixtureGateResult {
	const viewsText = memoryText(
		buildArithmeticTotalEvidenceResults(
			"What is the total number of views on my most popular videos on YouTube and TikTok?",
			[
				result("user: My most popular YouTube tutorial has 542 views."),
				result(
					"user: My TikTok video of Luna chasing a laser pointer now has 1,456 views.",
				),
				result("user: I uploaded another video yesterday."),
			],
		),
	)
	const weightText = memoryText(
		buildArithmeticTotalEvidenceResults(
			"What is the total weight of the new feed I purchased in the past two months?",
			[
				result("user: I purchased a 50 pound bag of chicken feed in April."),
				result("user: I bought another 20 pounds of goat feed in May."),
			],
		),
	)
	const pageText = memoryText(
		buildArithmeticTotalEvidenceResults(
			"What was the page count of the two novels I finished in January and March?",
			[
				result("user: The novel I finished in January was 341 pages."),
				result("user: The novel I finished in March was 515 pages."),
			],
		),
	)
	const mealText = memoryText(
		buildArithmeticTotalEvidenceResults(
			"What is the total number of lunch meals I got from the chicken fajitas and lentil soup?",
			[
				result("user: The chicken fajitas gave me 3 lunch meals."),
				result("user: The lentil soup gave me 5 meals for lunch."),
			],
		),
	)
	const moneyText = memoryText(
		buildArithmeticTotalEvidenceResults(
			"How much total money did I spend on attending workshops in the last four months?",
			[
				result("user: I spent $200 on the pottery workshop."),
				result("user: The writing workshop cost $300."),
				result("user: I paid $220 for a weekend photography workshop."),
			],
		),
	)
	const text = [viewsText, weightText, pageText, mealText, moneyText].join("\n")
	const failures = [
		...expectContains(viewsText, "total answer = 1998 views"),
		...expectContains(viewsText, "542 views"),
		...expectContains(viewsText, "1456 views"),
		...expectContains(weightText, "total answer = 70 pounds"),
		...expectContains(pageText, "total answer = 856 pages"),
		...expectContains(mealText, "total answer = 8 meals"),
		...expectContains(moneyText, "total answer = $720"),
		...expectNotContains(moneyText, "four months"),
	]
	return {
		id: "gate-count-arithmetic-source-backed-totals",
		capabilityId: "count-current-state",
		label: "Count source-backed arithmetic totals",
		ok: failures.length === 0,
		failures,
		details: { evidenceText: text },
	}
}

function currentStateSupersessionGate(): FixtureGateResult {
	const coffeeText = memoryText(
		buildCurrentStateEvidenceResults(
			"Did I mostly recently increase or decrease the limit on the number of cups of coffee in the morning?",
			[
				result(
					"user: I decreased my morning coffee limit from two cups to one cup.",
					"2023-05-10",
				),
				result(
					"user: I increased the limit on my morning coffee from one cup to two cups.",
					"2023-05-24",
				),
			],
		),
	)
	const eggsText = memoryText(
		buildCurrentStateEvidenceResults(
			"How many dozen eggs do we currently have stocked up in our refrigerator?",
			[
				result(
					"user: We had 30 dozen eggs stocked up in the refrigerator before the bake sale.",
					"2023-05-01",
				),
				result(
					"user: We currently have 20 dozen eggs stocked up in our refrigerator.",
					"2023-05-28",
				),
			],
		),
	)
	const sneakersText = memoryText(
		buildCurrentStateEvidenceResults(
			"Where do I currently keep my old sneakers?",
			[
				result(
					"user: I used to keep my old sneakers under my bed.",
					"2023-04-01",
				),
				result(
					"user: I moved my old sneakers to a shoe rack in my closet.",
					"2023-05-20",
				),
			],
		),
	)
	const text = [coffeeText, eggsText, sneakersText].join("\n")
	const failures = [
		...expectContains(coffeeText, "current answer = increased"),
		...expectContains(coffeeText, "superseded or older: decreased"),
		...expectContains(eggsText, "current answer = 20 dozen"),
		...expectContains(eggsText, "superseded or older: 30 dozen"),
		...expectContains(
			sneakersText,
			"current answer = a shoe rack in my closet",
		),
		...expectContains(sneakersText, "under my bed"),
		...expectNotContains(text, "c6853660"),
	]
	return {
		id: "gate-current-state-supersession",
		capabilityId: "multi-session-current-state",
		label: "Current-state supersession and stale evidence labeling",
		ok: failures.length === 0,
		failures,
		details: { evidenceText: text },
	}
}

function retrievalCoverageSupplementalGate(): FixtureGateResult {
	const query =
		"Did I mostly recently increase or decrease the limit on the number of cups of coffee in the morning?"
	const queries = buildSupplementalSearchQueries(query)
	const text = queries.join(" ")
	const failures = [
		...expectContains(text, "most recently"),
		...expectContains(text, "coffee"),
		...expectContains(text, "increased"),
		...expectContains(text, "decreased"),
		...expectContains(text, "limit"),
		...expectNotContains(text, "c6853660"),
	]
	return {
		id: "gate-retrieval-coverage-current-state-change-query",
		capabilityId: "retrieval-coverage",
		label: "Current-state change supplemental retrieval query",
		ok: failures.length === 0,
		failures,
		details: { query, supplementalQueries: queries },
	}
}

function zeroEmptyRetrievalArtifactGate(): FixtureGateResult {
	const artifact = {
		metadata: { mode: "answerer" },
		evaluations: [
			{
				question_id: "fixture-covered",
				question_type: "multi-session",
				is_abstention: false,
				retrieval: {
					search_results: [{ memory: "source-backed evidence", score: 1 }],
				},
				cutoff_results: {
					top_50: { generated_answer: "covered", judge_raw: "yes" },
				},
			},
			{
				question_id: "fixture-empty",
				question_type: "knowledge-update",
				is_abstention: false,
				retrieval: { search_results: [] },
				cutoff_results: {
					top_50: { generated_answer: "unsupported", judge_raw: "no" },
				},
			},
		],
	}
	const status = evaluateAnswererArtifact(artifact, "fixture-answerer.json", {
		cutoff: "top_50",
	})
	const repaired = structuredClone(artifact)
	repaired.evaluations[1].retrieval.search_results = [
		{ memory: "recovered source-backed evidence", score: 0.9 },
	]
	const repairedStatus = evaluateAnswererArtifact(
		repaired,
		"fixture-answerer-repaired.json",
		{ cutoff: "top_50" },
	)
	const failures = [
		...(status.ok ? ["empty retrieval fixture unexpectedly passed"] : []),
		...expectContains(status.failures.join("\n"), "fixture-empty"),
		...expectContains(
			status.failures.join("\n"),
			"retrieval.search_results empty",
		),
		...(status.emptyRetrievals === 1
			? []
			: [`expected one empty retrieval, got ${status.emptyRetrievals}`]),
		...(repairedStatus.ok ? [] : repairedStatus.failures),
		...(repairedStatus.emptyRetrievals === 0
			? []
			: [
					`expected repaired fixture to have zero empty retrievals, got ${repairedStatus.emptyRetrievals}`,
				]),
	]
	return {
		id: "gate-retrieval-zero-empty-answerer-artifact",
		capabilityId: "retrieval-coverage",
		label: "Zero-empty retrieval answerer artifact guard",
		ok: failures.length === 0,
		failures,
		details: { status, repairedStatus },
	}
}

function temporalOrderGate(): FixtureGateResult {
	const query =
		"What is the order of the three trips I took in the past three months, from earliest to latest?"
	const evidence = buildTemporalOrderEvidenceResults(query, [
		result(
			"user: I just got back from a road trip with friends to Big Sur and Monterey today.",
			"2023-04-20",
		),
		result(
			"user: I started my solo camping trip to Yosemite National Park today.",
			"2023-05-15",
		),
		result(
			"user: I just got back from a day hike to Muir Woods National Monument with my family today.",
			"2023-03-10",
		),
		result(
			"user: I'm planning a future trip to the Eastern Sierra.",
			"2023-05-16",
		),
	])
	const text = memoryText(evidence)
	const failures = [
		...expectContains(text, "2023-03-10"),
		...expectContains(text, "2023-04-20"),
		...expectContains(text, "2023-05-15"),
		...expectNotContains(text, "future trip"),
	]
	return {
		id: "gate-temporal-earliest-latest",
		capabilityId: "temporal-reasoning",
		label: "Temporal source-date ordering",
		ok: failures.length === 0,
		failures,
		details: { query, evidence },
	}
}

function assistantRecallGate(): FixtureGateResult {
	const query =
		"Can you remind me what specific back-end programming languages you recommended I learn?"
	const recallResults: AssistantRecallResult[] = [
		{
			citation: {
				eventId: "assistant-1",
				role: "assistant",
				timestamp: "2023-05-26T19:29:00.000Z",
				preview:
					"assistant: Learn a back-end programming language, such as Ruby, Python, or PHP.",
			},
			score: 0.42,
		},
		{
			citation: {
				eventId: "user-1",
				role: "user",
				preview: "user: Can someone learn front-end and back-end?",
			},
		},
	]
	const evidence = buildAssistantRecallEvidenceResults(query, recallResults)
	const text = memoryText(evidence)
	const failures = [
		...expectContains(text, "assistant-authored source"),
		...expectContains(text, "Ruby, Python, or PHP"),
		...expectNotContains(text, "Can someone learn"),
	]
	return {
		id: "gate-assistant-authored-recall",
		capabilityId: "assistant-recall",
		label: "Assistant-authored fact recall",
		ok: failures.length === 0,
		failures,
		details: { query, evidence },
	}
}

function preferenceGate(): FixtureGateResult {
	const query =
		"What are some simple ways to keep my living room dust-free, especially with a cat that sheds a lot?"
	const evidence = buildPreferenceEvidenceResults(query, [
		result(
			"user: What are some simple ways to keep my living room dust-free, especially with a cat that sheds a lot?",
		),
		result("user: I should order more of Luna's favorite wet food."),
		result("assistant: Here are generic cleaning tips for your living room."),
		result("user: I need to clean my music festival bag before storing it."),
	])
	const text = memoryText(evidence)
	const failures = [
		...expectContains(text, "cat that sheds"),
		...expectContains(text, "Luna"),
		...expectNotContains(text, "generic cleaning tips"),
		...expectNotContains(text, "music festival"),
	]
	return {
		id: "gate-preference-source-scope",
		capabilityId: "preference-memory",
		label: "Preference and source-scoped advice context",
		ok: failures.length === 0,
		failures,
		details: { query, evidence },
	}
}

export function runMemoryCapabilityFixtureGates(
	generatedAt = new Date().toISOString(),
): FixtureGateReport {
	const results = [
		countCurrentStateGate(),
		countEntityExtractionGate(),
		arithmeticTotalGate(),
		currentStateSupersessionGate(),
		retrievalCoverageSupplementalGate(),
		zeroEmptyRetrievalArtifactGate(),
		temporalOrderGate(),
		assistantRecallGate(),
		preferenceGate(),
	]
	const passed = results.filter((entry) => entry.ok).length
	return {
		generatedAt,
		total: results.length,
		passed,
		failed: results.length - passed,
		ok: passed === results.length,
		results,
	}
}

export function renderMemoryCapabilityFixtureGatesMarkdown(
	report: FixtureGateReport,
): string {
	const lines = [
		"# Memory Capability Fixture Gate Results",
		"",
		`Status: \`${report.ok ? "pass" : "fail"}\``,
		`Passed: ${report.passed}/${report.total}`,
		"",
		"| Gate | Capability | Status | Failures |",
		"| --- | --- | --- | --- |",
	]
	for (const result of report.results) {
		lines.push(
			`| ${result.label} | ${result.capabilityId} | ${result.ok ? "pass" : "fail"} | ${result.failures.join("<br>") || "none"} |`,
		)
	}
	return `${lines.join("\n")}\n`
}

function parseArgs(argv: string[]): {
	outDir?: string
	jsonOnly: boolean
	failOnError: boolean
} {
	let outDir: string | undefined
	let jsonOnly = false
	let failOnError = false
	for (const arg of argv) {
		if (arg === "--json") {
			jsonOnly = true
		} else if (arg === "--fail-on-error") {
			failOnError = true
		} else if (arg.startsWith("--out-dir=")) {
			outDir = arg.slice("--out-dir=".length)
		} else {
			throw new Error(`unknown argument: ${arg}`)
		}
	}
	return { outDir, jsonOnly, failOnError }
}

if (import.meta.main) {
	try {
		const { outDir, jsonOnly, failOnError } = parseArgs(process.argv.slice(2))
		const report = runMemoryCapabilityFixtureGates()
		if (outDir) {
			mkdirSync(outDir, { recursive: true })
			writeFileSync(
				join(outDir, "memory-capability-fixture-gates.json"),
				JSON.stringify(report, null, 2),
			)
			writeFileSync(
				join(outDir, "memory-capability-fixture-gates.md"),
				renderMemoryCapabilityFixtureGatesMarkdown(report),
			)
		} else if (jsonOnly) {
			console.log(JSON.stringify(report, null, 2))
		} else {
			console.log(renderMemoryCapabilityFixtureGatesMarkdown(report))
		}
		if (failOnError && !report.ok) {
			process.exit(1)
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
}
