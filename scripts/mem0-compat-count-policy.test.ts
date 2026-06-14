import { describe, expect, it } from "vitest"
import {
	buildActionEvidenceResults,
	buildArithmeticTotalEvidenceResults,
	buildAttributeEvidenceResults,
	buildAssistantRecallEvidenceResults,
	buildAssistantRecallQueries,
	buildCompiledAnswerEvidenceResults,
	buildCountEvidenceResults,
	buildCurrentStateEvidenceResults,
	buildPercentageComparisonEvidenceResults,
	buildPreferenceEvidenceResults,
	buildRemainingTotalEvidenceResults,
	buildSupplementalSearchQueries,
	buildTemporalOrderEvidenceResults,
	classifyMem0CompatCountKind,
	hasCountIntent,
	selectCountSupportingRawResults,
	type BridgeSearchResult,
} from "./mem0-compat-count-policy.js"

function result(snippet: string, date = "2023-05-30"): BridgeSearchResult {
	return {
		snippet,
		timestamp: new Date(`${date}T00:00:00.000Z`),
		score: 0.5,
	}
}

function bulletCount(memory: string): number {
	return (memory.match(/\b\d+\./g) ?? []).length
}

describe("mem0 compat count policy", () => {
	it("classifies broad quantitative queries without treating every number as an item count", () => {
		expect(hasCountIntent("How much did I spend on shipping?")).toBe(true)
		expect(
			classifyMem0CompatCountKind(
				"How many days ago did I watch the Super Bowl?",
			),
		).toBe("duration")
		expect(classifyMem0CompatCountKind("How much cashback did I earn?")).toBe(
			"money-or-percent",
		)
		expect(
			classifyMem0CompatCountKind(
				"How many things do I still need to pick up?",
			),
		).toBe("pending-action")
		expect(
			classifyMem0CompatCountKind("How many times did I bake something?"),
		).toBe("repeated-action")
	})

	it("does not inject derived count evidence for duration or money questions", () => {
		expect(
			buildCountEvidenceResults(
				"How many days ago did I watch the Super Bowl?",
				[result("I watched the Super Bowl today.")],
			),
		).toEqual([])
		expect(
			buildCountEvidenceResults("How much cashback did I earn?", [
				result("I earned $12 cashback."),
			]),
		).toEqual([])
	})

	it("does not inject count evidence into recommendation or advice queries", () => {
		expect(
			classifyMem0CompatCountKind(
				"Can you recommend a show or movie for me to watch tonight?",
			),
		).toBe("unknown-count")
		expect(
			buildCountEvidenceResults(
				"Can you recommend a show or movie for me to watch tonight?",
				[
					result(
						"As an aspiring stand-up comedian, I'm looking for some advice on how to improve my craft. Can you recommend some stand-up comedy specials on Netflix with strong storytelling?",
					),
				],
			),
		).toEqual([])
	})

	it("does not turn numeric attribute questions into candidate counts", () => {
		const query =
			"How many copies of my favorite artist's debut album were released worldwide?"
		const results = [
			result("The limited debut album pressing was released worldwide."),
			result("I placed three orders last week."),
		]

		expect(buildCountEvidenceResults(query, results)).toEqual([])
		expect(selectCountSupportingRawResults(query, results)).toEqual(results)
	})

	it("builds numeric attribute evidence for source-backed limited release counts", () => {
		const [evidence] = buildAttributeEvidenceResults(
			"How many copies of my favorite artist's debut album were released worldwide?",
			[
				result(
					"I was thinking of displaying my signed poster from my favorite artist's debut album, which is a limited edition of only 500 copies worldwide.",
				),
			],
		)

		expect(evidence?.memory).toContain("ANSWER EVIDENCE: answer = 500 copies")
		expect(evidence?.memory).toContain(
			'queried object "favorite artist debut album"',
		)
		expect(evidence?.memory).toContain("limited-edition")
	})

	it("builds timestamp-anchored temporal order evidence for trip sequence queries", () => {
		const [evidence] = buildTemporalOrderEvidenceResults(
			"What is the order of the three trips I took in the past three months, from earliest to latest?",
			[
				result(
					"user: I just got back from a road trip with friends to Big Sur and Monterey today, and it was amazing!",
					"2023-04-20",
				),
				result(
					"assistant: I'm glad to hear that you had an amazing road trip, though!",
					"2023-04-20",
				),
				result(
					"I'm glad to hear that you had an amazing road trip, though!",
					"2023-04-20",
				),
				result(
					"user: I started my solo camping trip to Yosemite National Park today, but I want a secluded campsite next time.",
					"2023-05-15",
				),
				result(
					"user: I just got back from a day hike to Muir Woods National Monument with my family today, and it was amazing!",
					"2023-03-10",
				),
				result(
					"user: By the way, I've been getting more comfortable with my daily commute to Roppongi for my English teaching job, which I started about 4 months ago.",
					"2023-02-15",
				),
				result(
					"user: I cleaned out my old messenger bag and found receipts from January and February.",
					"2023-03-09",
				),
				result(
					"user: I'm planning a future trip to the Eastern Sierra.",
					"2023-05-16",
				),
			],
		)

		expect(evidence?.memory).toContain("derived chronological order")
		expect(evidence?.memory).toContain("2023-03-10")
		expect(evidence?.memory).toContain("2023-04-20")
		expect(evidence?.memory).toContain("2023-05-15")
		expect(evidence?.memory).toContain("timestamps as event dates")
		expect(evidence?.memory).not.toContain("future trip")
		expect(evidence?.memory).not.toContain("commute")
		expect(evidence?.memory).not.toContain("receipts")
		expect(evidence?.memory).toContain("Big Sur and Monterey")
		expect(evidence?.memory).not.toContain("amazing road trip, though")
		expect(bulletCount(evidence?.memory ?? "")).toBe(3)
	})

	it("builds supplemental art-event search queries without question ids", () => {
		const queries = buildSupplementalSearchQueries(
			"How many different art-related events did I attend in the past month?",
		)

		expect(queries.join(" ")).toContain("exhibition")
		expect(queries.join(" ")).toContain("workshop")
		expect(queries.join(" ")).toContain("volunteered")
		expect(queries.join(" ")).not.toContain("2ce6a0f2")
	})

	it("builds supplemental current-state change queries without question ids", () => {
		const queries = buildSupplementalSearchQueries(
			"Did I mostly recently increase or decrease the limit on the number of cups of coffee in the morning?",
		)
		const text = queries.join(" ")

		expect(text).toContain("most recently")
		expect(text).toContain("coffee")
		expect(text).toContain("increased")
		expect(text).toContain("decreased")
		expect(text).toContain("limit")
		expect(text).not.toContain("c6853660")
	})

	it("counts volunteered art events as completed attended-event evidence", () => {
		const [evidence] = buildCountEvidenceResults(
			"How many different art-related events did I attend in the past month?",
			[
				result(
					"I volunteered at the city museum for their community art workshop event last month.",
				),
				result(
					"I recently attended a lecture at the Art Gallery on street art.",
				),
			],
		)

		expect(evidence?.memory).toContain("count answer = 2")
		expect(evidence?.memory).toContain("volunteered")
	})

	it("builds percentage comparison evidence from named source-backed discounts", () => {
		const [evidence] = buildPercentageComparisonEvidenceResults(
			"Did I receive a higher percentage discount from HelloFresh compared to UberEats?",
			[
				result("I recently tried HelloFresh and got a 40% discount."),
				result("Last week I got 20% off my UberEats order."),
			],
		)

		expect(evidence?.memory).toContain("HelloFresh has the higher")
		expect(evidence?.memory).toContain("40%")
		expect(evidence?.memory).toContain("20%")
	})

	it("builds remaining-total evidence for points needed to reach a target", () => {
		const [evidence] = buildRemainingTotalEvidenceResults(
			"How many points do I need to earn to redeem a free skincare product?",
			[
				result("I earned 50 points, bringing my total to 200 points so far."),
				result("I just need a total of 300 points and I'm all set."),
			],
		)

		expect(evidence?.memory).toContain("remaining amount")
		expect(evidence?.memory).toContain("100")
		expect(evidence?.memory).toContain("current sourced total 200")
		expect(evidence?.memory).toContain("target sourced total 300")
	})

	it("builds arithmetic-total evidence for source-backed views and comments", () => {
		const [viewsEvidence] = buildArithmeticTotalEvidenceResults(
			"What is the total number of views on my most popular videos on YouTube and TikTok?",
			[
				result("user: My most popular YouTube tutorial has 542 views."),
				result(
					"user: My TikTok video of Luna chasing a laser pointer now has 1,456 views.",
				),
				result("user: I uploaded a second YouTube clip yesterday."),
			],
		)
		const [commentsEvidence] = buildArithmeticTotalEvidenceResults(
			"What is the total number of comments on my recent Facebook Live session and my most popular YouTube video?",
			[
				result("user: My recent Facebook Live session got 12 comments."),
				result("user: The YouTube video has 21 comments."),
				result("user: I posted the video on Tuesday."),
			],
		)

		expect(viewsEvidence?.memory).toContain("total answer = 1998 views")
		expect(viewsEvidence?.memory).toContain("542 views")
		expect(viewsEvidence?.memory).toContain("1456 views")
		expect(commentsEvidence?.memory).toContain("total answer = 33 comments")
		expect(commentsEvidence?.memory).toContain("12 comments")
		expect(commentsEvidence?.memory).toContain("21 comments")
	})

	it("builds arithmetic-total evidence for source-backed weight, pages, meals, and money", () => {
		const [weightEvidence] = buildArithmeticTotalEvidenceResults(
			"What is the total weight of the new feed I purchased in the past two months?",
			[
				result("user: I purchased a 50 pound bag of chicken feed in April."),
				result("user: I bought another 20 pounds of goat feed in May."),
			],
		)
		const [pageEvidence] = buildArithmeticTotalEvidenceResults(
			"What was the page count of the two novels I finished in January and March?",
			[
				result("user: The novel I finished in January was 341 pages."),
				result("user: The novel I finished in March was 515 pages."),
			],
		)
		const [mealEvidence] = buildArithmeticTotalEvidenceResults(
			"What is the total number of lunch meals I got from the chicken fajitas and lentil soup?",
			[
				result("user: The chicken fajitas gave me 3 lunch meals."),
				result("user: The lentil soup gave me 5 meals for lunch."),
			],
		)
		const [moneyEvidence] = buildArithmeticTotalEvidenceResults(
			"How much total money did I spend on attending workshops in the last four months?",
			[
				result("user: I spent $200 on the pottery workshop."),
				result("user: The writing workshop cost $300."),
				result("user: I paid $220 for a weekend photography workshop."),
			],
		)

		expect(weightEvidence?.memory).toContain("total answer = 70 pounds")
		expect(pageEvidence?.memory).toContain("total answer = 856 pages")
		expect(mealEvidence?.memory).toContain("total answer = 8 meals")
		expect(moneyEvidence?.memory).toContain("total answer = $720")
		expect(moneyEvidence?.memory).not.toContain("four months")
	})

	it("builds attribute evidence for brand/current-use questions", () => {
		const [evidence] = buildAttributeEvidenceResults(
			"What brand of shampoo do I currently use?",
			[
				result(
					"I've been using a lavender scented shampoo that I picked up on a whim at Trader Joe's.",
				),
				result("I'm planning to buy a new skincare set from Sephora."),
			],
		)

		expect(evidence?.memory).toContain("attribute value: Trader Joe's")
		expect(evidence?.memory).toContain("answer directly")
		expect(evidence?.memory).not.toContain("attribute value: I've been")
		expect(evidence?.memory).not.toContain("Sephora")
	})

	it("builds current-state evidence from latest source-dated limit changes", () => {
		const [evidence] = buildCurrentStateEvidenceResults(
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
		)

		expect(evidence?.id).toContain("derived-current-state-evidence")
		expect(evidence?.memory).toContain("current answer = increased")
		expect(evidence?.memory).toContain("current/latest: increased")
		expect(evidence?.memory).toContain("superseded or older: decreased")
		expect(evidence?.memory).not.toContain("c6853660")
	})

	it("builds current-state evidence for stocked quantity and location supersession", () => {
		const [eggsEvidence] = buildCurrentStateEvidenceResults(
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
		)
		const [locationEvidence] = buildCurrentStateEvidenceResults(
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
		)

		expect(eggsEvidence?.memory).toContain("current answer = 20 dozen")
		expect(eggsEvidence?.memory).toContain("superseded or older: 30 dozen")
		expect(locationEvidence?.memory).toContain(
			"current answer = a shoe rack in my closet",
		)
		expect(locationEvidence?.memory).toContain("superseded or older")
		expect(locationEvidence?.memory).toContain("under my bed")
	})

	it("builds current-state evidence for possession and personal records", () => {
		const [spareEvidence] = buildCurrentStateEvidenceResults(
			"Do I have a spare screwdriver for opening up my laptop?",
			[
				result(
					"user: I found a spare precision screwdriver in my laptop repair kit.",
					"2023-05-17",
				),
			],
		)
		const [recordEvidence] = buildCurrentStateEvidenceResults(
			"What was my personal best time in the charity 5K run?",
			[
				result(
					"user: My charity 5K personal best was 27:12 last spring.",
					"2023-04-01",
				),
				result(
					"user: I beat my charity 5K personal best with a time of 25:50.",
					"2023-05-26",
				),
			],
		)

		expect(spareEvidence?.memory).toContain("current answer = Yes")
		expect(spareEvidence?.memory).toContain("spare precision screwdriver")
		expect(recordEvidence?.memory).toContain("current answer = 25:50")
		expect(recordEvidence?.memory).toContain("superseded or older: 27:12")
	})

	it("builds a compiled proof pack with current-state evidence ahead of stale and planned facts", () => {
		const [evidence] = buildCompiledAnswerEvidenceResults(
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
				result(
					"user: I plan to move my old sneakers to the garage shelf next month.",
					"2023-05-30",
				),
			],
		)

		expect(evidence?.id).toContain("derived-answer-evidence-pack")
		expect(evidence?.memory).toContain("ANSWER EVIDENCE PACK")
		expect(evidence?.memory).toContain("source-backed proof pack")
		expect(evidence?.memory).toContain("1. current-state")
		expect(evidence?.memory).toContain(
			"current answer = a shoe rack in my closet",
		)
		expect(evidence?.memory).toContain("superseded or older")
		expect(evidence?.memory).toContain("under my bed")
		expect(evidence?.memory).not.toContain("garage shelf")
		expect(evidence?.memory).toContain("answer-context packaging artifact")
		expect(evidence?.memory).toContain(
			"raw MongoDB-ranked memories remain below",
		)
		expect(evidence?.score).toBeUndefined()
		expect(evidence?.score_debug?.scoreDetails).toMatchObject({
			artifactType: "compiledAnswerEvidencePack",
			ranking: "answer-context-packaging",
			mongoScore: null,
			sectionCount: 1,
			sourceResultCount: 3,
		})
	})

	it("builds compiled assistant-recall and preference packs without count evidence", () => {
		const [assistantEvidence] = buildCompiledAnswerEvidenceResults(
			"Can you remind me what specific back-end programming languages you recommended I learn?",
			[],
			[
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
			],
		)
		const [preferenceEvidence] = buildCompiledAnswerEvidenceResults(
			"What are some simple ways to keep my living room dust-free, especially with a cat that sheds a lot?",
			[
				result(
					"user: What are some simple ways to keep my living room dust-free, especially with a cat that sheds a lot?",
				),
				result("user: I should order more of Luna's favorite wet food."),
				result(
					"assistant: Here are generic cleaning tips for your living room.",
				),
			],
		)

		expect(assistantEvidence?.memory).toContain("1. assistant-recall")
		expect(assistantEvidence?.memory).toContain("Ruby, Python, or PHP")
		expect(assistantEvidence?.memory).not.toContain("Can someone learn")
		expect(preferenceEvidence?.memory).toContain("1. preference-context")
		expect(preferenceEvidence?.memory).toContain("Luna")
		expect(preferenceEvidence?.memory).not.toContain("count-current-state")
		expect(preferenceEvidence?.memory).not.toContain("generic cleaning tips")
	})

	it("builds respiratory preference evidence from deeper source context", () => {
		const [evidence] = buildPreferenceEvidenceResults(
			"I've been sneezing quite a bit lately. Do you think it might be my living room?",
			[
				...Array.from({ length: 55 }, (_, index) =>
					result(`Noise sentence ${index} about unrelated errands.`),
				),
				result(
					"I deep cleaned the living room yesterday, and Luna has been shedding a lot on the sofa lately.",
				),
			],
		)

		expect(evidence?.memory).toContain("ANSWER EVIDENCE")
		expect(evidence?.memory).toContain("Luna")
		expect(evidence?.memory).toContain("deep cleaned")
	})

	it("keeps named pet context ahead of unrelated respiratory-advice memories", () => {
		const [evidence] = buildPreferenceEvidenceResults(
			"What are some simple ways to keep my living room dust-free, especially with a cat that sheds a lot?",
			[
				result(
					"User: What are some simple ways to keep my living room dust-free, especially with a cat that sheds a lot?",
				),
				result("User: I'm trying to plan out my pet care tasks for the week."),
				result(
					"User: I need to clean my music festival bag before storing it.",
				),
				result(
					"By the way, I've already got the following reminders on my virtual sticky note for you: Order Luna's grain-free wet food in blue packets.",
				),
				result(
					"And don't worry, I've got a note to remind you to order more of her favorite grain-free wet food in blue packets!",
				),
				result(
					"User: I should order more of Luna's favorite wet food before the weekend.",
				),
				result("User: I like the geometric motif on the new rug."),
				result(
					"I've been noticing some intricate carvings on my armchair, and I'm wondering if you could help me identify the type of wood used.",
				),
			],
		)

		expect(evidence?.memory).toContain("cat that sheds")
		expect(evidence?.memory).toContain("Luna")
		expect(evidence?.memory).not.toContain("sticky note")
		expect(evidence?.memory).not.toContain("note to remind")
		expect(evidence?.memory).not.toContain("music festival")
		expect(evidence?.memory).not.toContain("geometric motif")
		expect(evidence?.memory).not.toContain("armchair")
	})

	it("does not treat contact identifiers as item counts", () => {
		const query = "What's the phone number of the Speyer tourism board?"

		expect(hasCountIntent(query)).toBe(false)
		expect(classifyMem0CompatCountKind(query)).toBe("unknown-count")
		expect(
			buildCountEvidenceResults(query, [
				result(
					"The Speyer tourism board phone number is +49 (0) 62 32 / 14 23 - 0.",
				),
			]),
		).toEqual([])
	})

	it("builds assistant recall query variants for specific recommendation follow-ups", () => {
		const queries = buildAssistantRecallQueries(
			"I wanted to follow up on our previous conversation about front-end and back-end development. Can you remind me of the specific back-end programming languages you recommended I learn?",
		)

		expect(queries).toContain("learn back-end programming language such as")
		expect(
			queries.some((query) => query.includes("programming languages")),
		).toBe(true)
	})

	it("builds assistant recall query variants for alternate terms and options", () => {
		const queries = buildAssistantRecallQueries(
			"In our previous chat, you suggested 'sexual compulsions' and a few other options for alternative terms for certain behaviors. Can you remind me what the other four options were?",
		)

		expect(queries).toContain("alternative terms options suggested")
		expect(queries.some((query) => query.includes("alternative terms"))).toBe(
			true,
		)
	})

	it("packs assistant-only recall evidence before adjacent user turns for recommendation questions", () => {
		const [evidence] = buildAssistantRecallEvidenceResults(
			"Can you remind me what specific back-end programming languages you recommended I learn?",
			[
				{
					citation: {
						eventId: "assistant-1",
						role: "assistant",
						timestamp: "2023-05-26T19:29:00.000Z",
						preview:
							"assistant: Start with the basics, then learn a back-end programming language, such as Ruby, Python, or PHP.",
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
			],
		)

		expect(evidence?.id).toContain("derived-assistant-recall")
		expect(evidence?.memory).toContain("assistant-only conversation recall")
		expect(evidence?.memory).toContain("Ruby, Python, or PHP")
		expect(evidence?.memory).not.toContain("Can someone learn")
		expect(evidence?.score).toBeGreaterThan(1)
	})

	it("preserves full assistant option lists for alternate-term recall", () => {
		const [evidence] = buildAssistantRecallEvidenceResults(
			"In our previous chat, you suggested 'sexual compulsions' and a few other options for alternative terms for certain behaviors. Can you remind me what the other four options were?",
			[
				{
					citation: {
						eventId: "assistant-options",
						role: "assistant",
						timestamp: "2023-05-27T11:16:00.000Z",
						preview:
							"assistant: I apologize if my previous suggestions were not helpful. Here are some other alternatives: 1. Sexual fixations - This term implies a strong preoccupation with sexual thoughts or behaviors. 2. Problematic sexual behaviors - This phrase is straightforward. 3. Sexual impulsivity - This term emphasizes the impulsive nature. 4. Compulsive sexuality - This phrase emphasizes the compulsive nature.",
					},
					score: 0.6,
				},
			],
		)

		expect(evidence?.memory).toContain("ANSWER EVIDENCE")
		expect(evidence?.memory).toContain("Sexual fixations")
		expect(evidence?.memory).toContain("Problematic sexual behaviors")
		expect(evidence?.memory).toContain("Sexual impulsivity")
		expect(evidence?.memory).toContain("Compulsive sexuality")
	})

	it("preserves the query-answering span from long assistant recall previews", () => {
		const [evidence] = buildAssistantRecallEvidenceResults(
			"I wanted to follow up on our previous conversation about front-end and back-end development. Can you remind me of the specific back-end programming languages you recommended I learn?",
			[
				{
					citation: {
						eventId: "assistant-long",
						role: "assistant",
						timestamp: "2023-05-26T19:29:00.000Z",
						preview:
							"assistant: Yes, there's no denying that becoming a full-stack developer requires a lot of time and dedication. Here are a few tips to help you get started. Start with the basics before delving into the more advanced topics. Learn a back-end programming language: Once you've got a good grasp of front-end development, start learning a back-end programming language, focus on server-side concepts, APIs, databases, routing, authentication, deployment, and practical exercises, such as Ruby, Python, or PHP. Build projects that incorporate both front-end and back-end development.",
					},
					score: 0.5,
				},
			],
		)

		expect(evidence?.memory).toContain("Ruby, Python, or PHP")
		expect(evidence?.memory).toContain("Learn a back-end programming language")
	})

	it("turns progress-total questions into total evidence, not countable bullets", () => {
		const [evidence] = buildCountEvidenceResults(
			"How many projects have I completed since starting painting classes?",
			[
				result("I've completed 4 projects since starting painting classes."),
				result(
					"By the way, I just finished my 5th project since starting painting classes.",
				),
				result(
					"I'm looking for some inspiration for my next painting project.",
				),
			],
		)

		expect(evidence?.id).toContain("derived-current-total-evidence")
		expect(evidence?.memory).toContain("current answer 5")
		expect(evidence?.memory).toContain("stated total 5")
		expect(evidence?.memory).toContain("do not count the bullets")
		expect(evidence?.memory).not.toContain("derived countable evidence")
	})

	it("uses explicit current totals for how-many-times status questions", () => {
		const [evidence] = buildCountEvidenceResults(
			"How many times have I worn my new black Converse Chuck Taylor All Star sneakers?",
			[
				result(
					"I've been loving my new black Converse Chuck Taylor All Star sneakers, I've worn them four times already.",
					"2023-05-30",
				),
				result(
					"By the way, I just wore my new black Converse to run some errands yesterday, so that's six times now that I've worn them.",
					"2023-05-30",
				),
			],
		)

		expect(evidence?.id).toContain("derived-current-total-evidence")
		expect(evidence?.memory).toContain("current answer 6")
		expect(evidence?.memory).toContain("stated total 6")
		expect(evidence?.memory).toContain("stated total 4")
		expect(evidence?.memory).toContain("do not count the bullets")
	})

	it("keeps jewelry acquisition evidence user-owned and object-specific", () => {
		const [evidence] = buildCountEvidenceResults(
			"How many pieces of jewelry did I acquire in the last two months?",
			[
				result(
					"I got my engagement ring a month ago, and it is still a bit too loose.",
				),
				result(
					"I just got a new pair of earrings last weekend at a flea market.",
				),
				result(
					"Can you help me clean my jewelry? By the way, I got a new silver necklace with a small pendant on the 15th of last month.",
				),
				result(
					"My siblings got some other amazing pieces, like a vintage sewing machine.",
				),
				result("I renewed my registration online about a month ago."),
			],
		)

		expect(evidence?.memory).toContain("engagement ring")
		expect(evidence?.memory).toContain("earrings")
		expect(evidence?.memory).toContain("silver necklace")
		expect(evidence?.memory).not.toContain("siblings")
		expect(evidence?.memory).not.toContain("registration")
		expect(bulletCount(evidence?.memory ?? "")).toBe(3)
	})

	it("keeps repeated baking evidence completed and avoids broad made-pie distractors", () => {
		const query = "How many times did I bake something in the past two weeks?"
		const results = [
			result("I just baked a chocolate cake for my sister's birthday party."),
			result("I used the oven to bake a batch of cookies last Thursday."),
			result(
				"I recently tried out a new bread recipe using sourdough starter on Tuesday.",
			),
			result(
				"I just baked a chocolate cake for my sister's birthday party last weekend and it turned out amazing.",
				"2023-05-30",
			),
			result(
				"Also, I'm curious - how did you find the experience of baking a cake compared to baking bread?",
			),
			result(
				"I just used my oven's convection setting for the first time last Thursday to bake a batch of cookies.",
				"2023-05-28",
			),
			result("I made a delicious whole wheat baguette last Saturday."),
			result(
				"I made the apple pie in my cast iron skillet and it turned out amazing.",
			),
			result("Do you have recommendations for whole wheat bread recipes?"),
		]
		const [evidence] = buildCountEvidenceResults(query, results)

		expect(evidence?.memory).toContain("chocolate cake")
		expect(evidence?.memory).toContain("cookies")
		expect(evidence?.memory).toContain("sourdough bread")
		expect(evidence?.memory).toContain("whole wheat baguette")
		expect(evidence?.memory).toContain("computed repeated-action count = 4")
		expect(evidence?.memory).not.toContain("apple pie")
		expect(evidence?.memory).not.toContain("recommendations")
		expect(bulletCount(evidence?.memory ?? "")).toBe(4)

		const supportingRaw = selectCountSupportingRawResults(query, results)
		expect(supportingRaw.map((entry) => entry.snippet)).toHaveLength(4)
		expect(
			supportingRaw.filter((entry) =>
				entry.snippet?.includes("chocolate cake"),
			),
		).toHaveLength(1)
		expect(
			supportingRaw.filter((entry) => entry.snippet?.includes("cookies")),
		).toHaveLength(1)
		expect(
			supportingRaw.some((entry) => entry.snippet?.includes("apple pie")),
		).toBe(false)
		expect(
			supportingRaw.some((entry) => entry.snippet?.includes("recommendations")),
		).toBe(false)
	})

	it("does not count assistant disclaimers or future plans as attended event evidence", () => {
		const query =
			"How many different art-related events did I attend in the past month?"
		const results = [
			result(
				"assistant: Unfortunately, I'm a large language model, I don't have access to real-time information about specific local art events and exhibitions.",
			),
			result(
				"user: I'll definitely check out the Modern Art Museum's website and social media to stay updated on their upcoming events and exhibitions.",
			),
			result(
				'user: I was particularly drawn to the works of local artist, Rachel Lee, at the "Women in Art" exhibition which I attended on February 10.',
			),
			result(
				'user: I recently attended a lecture at the Art Gallery on "The Evolution of Street Art" on March 3rd.',
			),
			result(
				'user: I went to the Children\'s Museum for their "Art Afternoon" event on February 17th, and it was amazing.',
			),
		]
		const [evidence] = buildCountEvidenceResults(query, results)
		const supportingRaw = selectCountSupportingRawResults(query, results)

		expect(evidence?.memory).toContain("Women in Art")
		expect(evidence?.memory).toContain("Evolution of Street Art")
		expect(evidence?.memory).toContain("Art Afternoon")
		expect(evidence?.memory).not.toContain("large language model")
		expect(evidence?.memory).not.toContain("definitely check")
		expect(supportingRaw.map((entry) => entry.snippet)).toHaveLength(3)
	})

	it("does not count future-looking event wishes when speaker labels are stripped", () => {
		const [evidence] = buildCountEvidenceResults(
			"How many different art-related events did I attend in the past month?",
			[
				result(
					"Otherwise, happy art exploring, and I hope you enjoy the next event or exhibition you attend!",
				),
				result("I attended the Women in Art exhibition on February 10th."),
				result("I recently attended a street art lecture at the Art Gallery."),
			],
		)

		expect(evidence?.memory).toContain("computed repeated-action count = 2")
		expect(evidence?.memory).not.toContain("hope you enjoy")
	})

	it("uses explicit first-person inventory totals instead of counting related mentions", () => {
		const query = "How many playlists do I have on Spotify?"
		const results = [
			result(
				"user: By the way, I have 20 playlists on Spotify already, and I am looking to organize them better.",
				"2023-05-20",
			),
			result(
				'user: I have a lot of playlists for different moods or activities, like "Morning Boost" and "Focus Flow".',
				"2023-05-20",
			),
			result(
				"assistant: You can organize playlists by mood, activity, or genre.",
				"2023-05-20",
			),
		]

		const [evidence] = buildCountEvidenceResults(query, results)
		const supportingRaw = selectCountSupportingRawResults(query, results)

		expect(evidence?.id).toContain("explicit-count-evidence")
		expect(evidence?.memory).toContain("count answer = 20")
		expect(evidence?.memory).toContain("explicit source-stated current total")
		expect(evidence?.memory).not.toContain("computed repeated-action count = 2")
		expect(supportingRaw[0]?.snippet).toContain("I have 20 playlists")
	})

	it("requires real attendance verbs before counting broad event nouns", () => {
		const query =
			"How many different art-related events did I attend in the past month?"
		const results = [
			result(
				"assistant: Check Eventbrite, Meetup, or Facebook Events that list local art events, exhibitions, and festivals.",
			),
			result(
				"user: I remember the museum might be hosting more events and exhibitions focused on local artists.",
			),
			result('user: I attended the "Women in Art" exhibition on February 10.'),
			result(
				'user: I went to the Children\'s Museum for their "Art Afternoon" event on February 17.',
			),
			result(
				'user: I attended a lecture called "The Evolution of Street Art" on March 3.',
			),
		]

		const [evidence] = buildCountEvidenceResults(query, results)
		const supportingRaw = selectCountSupportingRawResults(query, results)

		expect(evidence?.memory).toContain("computed repeated-action count = 3")
		expect(evidence?.memory).not.toContain("Eventbrite")
		expect(evidence?.memory).not.toContain("museum might be hosting")
		expect(supportingRaw.map((entry) => entry.snippet)).toHaveLength(3)
	})

	it("counts attended dinner-party experiences without counting hosted plans", () => {
		const query = "How many dinner parties have I attended in the past month?"
		const results = [
			result(
				"user: I'm hosting a dinner party soon and need recipe ideas.",
				"2023-05-20",
			),
			result(
				"user: We had a potluck dinner at Alex's place yesterday.",
				"2023-05-21",
			),
			result(
				"user: I attended a lovely Italian feast at Sarah's place last week.",
				"2023-05-22",
			),
			result(
				"user: I had a BBQ at Mike's place where we watched a football game together.",
				"2023-05-21",
			),
		]

		const [evidence] = buildCountEvidenceResults(query, results)
		const supportingRaw = selectCountSupportingRawResults(query, results)

		expect(evidence?.memory).toContain("computed repeated-action count = 3")
		expect(evidence?.memory).toContain("potluck")
		expect(evidence?.memory).toContain("Italian feast")
		expect(evidence?.memory).toContain("BBQ")
		expect(evidence?.memory).not.toContain("hosting a dinner party soon")
		expect(supportingRaw.map((entry) => entry.snippet)).toHaveLength(3)
	})

	it("does not turn planned aquarium additions into owned fish inventory", () => {
		const query = "How many fish are there in total in both of my aquariums?"
		const results = [
			result(
				"user: I upgraded my old 10-gallon tank, which has my betta fish, Bubbles.",
			),
			result(
				"user: I'll consider adding some schooling fish, but I'll make sure to introduce them in a group.",
			),
			result(
				"assistant: I'm glad you're considering adding schooling fish to distract your gouramis.",
			),
		]
		const [evidence] = buildCountEvidenceResults(query, results)
		const supportingRaw = selectCountSupportingRawResults(query, results)

		expect(evidence?.memory).toContain("betta fish")
		expect(evidence?.memory).not.toContain("schooling fish")
		expect(evidence?.memory).not.toContain("considering")
		expect(supportingRaw.map((entry) => entry.snippet)).toHaveLength(1)
	})

	it("keeps pending action checklist separate from countable evidence", () => {
		const actionEvidence = buildActionEvidenceResults(
			"How many things do I still need to pick up or return?",
			[
				result("I still need to pick up the dry cleaning for my suit."),
				result("I need to return my library books."),
			],
		)
		const countEvidence = buildCountEvidenceResults(
			"How many things do I still need to pick up or return?",
			[result("I still need to pick up the dry cleaning for my suit.")],
		)

		expect(actionEvidence[0]?.id).toContain("derived-action-checklist")
		expect(actionEvidence[0]?.memory).toContain(
			"ANSWER EVIDENCE: answer = 2 clothing-store pending actions",
		)
		expect(actionEvidence[0]?.memory).toContain(
			"computed pending-action count: 2",
		)
		expect(countEvidence).toEqual([])
	})

	it("counts only user-owned led projects for first-person leadership questions", () => {
		const query = "How many projects have I led or am currently leading?"
		const results = [
			result("user: I led the Atlas migration project last quarter."),
			result("user: I currently lead the search relevance project."),
			result("user: I advised Sam while he led the onboarding project."),
			result("assistant: You could lead future launch planning projects."),
			result("user: I am considering leading a volunteer project next year."),
			result("user: My team has eight projects in the roadmap."),
		]

		const [evidence] = buildCountEvidenceResults(query, results)
		const supportingRaw = selectCountSupportingRawResults(query, results)

		expect(evidence?.memory).toContain("count answer = 2")
		expect(evidence?.memory).toContain("Atlas migration project")
		expect(evidence?.memory).toContain("search relevance project")
		expect(evidence?.memory).not.toContain("Sam while he led")
		expect(evidence?.memory).not.toContain("future launch planning")
		expect(evidence?.memory).not.toContain("volunteer project next year")
		expect(evidence?.memory).not.toContain("eight projects in the roadmap")
		expect(supportingRaw.map((entry) => entry.snippet)).toHaveLength(2)
	})

	it("extracts multiple model-kit entities from source-backed count memories", () => {
		const query = "How many model kits have I worked on or bought?"
		const [evidence] = buildCountEvidenceResults(query, [
			result(
				"user: I have worked on or bought five model kits: Revell F-15 Eagle, Tamiya 1/48 scale Spitfire Mk.V, a 1/16 scale German Tiger I tank, a 1/72 scale B-29 bomber, and a 1/24 scale '69 Camaro.",
			),
			result(
				"user: By the way, I bought a 2TB external hard drive from Western Digital.",
			),
		])

		expect(evidence?.memory).toContain("count answer = 5")
		expect(evidence?.memory).toContain("Revell F-15 Eagle")
		expect(evidence?.memory).toContain("Tamiya 1/48 scale Spitfire Mk.V")
		expect(evidence?.memory).toContain("1/16 scale German Tiger I tank")
		expect(evidence?.memory).toContain("1/72 scale B-29 bomber")
		expect(evidence?.memory).toContain("1/24 scale '69 Camaro")
		expect(evidence?.memory).not.toContain("hard drive")
	})

	it("extracts multiple acquired plant entities from one source memory", () => {
		const query = "How many plants did I acquire in the last month?"
		const [evidence] = buildCountEvidenceResults(query, [
			result(
				"user: I bought the peace lily and a succulent plant two weeks ago.",
			),
			result("user: I picked up a Boston fern from the nursery yesterday."),
			result("assistant: A humidifier is an excellent investment for plants."),
		])

		expect(evidence?.memory).toContain("count answer = 3")
		expect(evidence?.memory).toContain("peace lily")
		expect(evidence?.memory).toContain("succulent plant")
		expect(evidence?.memory).toContain("Boston fern")
		expect(evidence?.memory).not.toContain("humidifier")
	})

	it("counts doctor visits by provider type without counting clinics or family visits", () => {
		const query = "How many different doctors did I visit?"
		const [evidence] = buildCountEvidenceResults(query, [
			result("user: I visited my primary care physician on Monday."),
			result("user: I went to an ENT specialist for my sinus issue."),
			result("user: I saw a dermatologist about the rash."),
			result("user: I need to visit my family for the holidays."),
			result(
				"user: Please correct this message from our clinic to the service provider called Yezza.",
			),
		])

		expect(evidence?.memory).toContain("count answer = 3")
		expect(evidence?.memory).toContain("primary care physician")
		expect(evidence?.memory).toContain("ENT specialist")
		expect(evidence?.memory).toContain("dermatologist")
		expect(evidence?.memory).not.toContain("family")
		expect(evidence?.memory).not.toContain("Yezza")
	})

	it("counts source-backed cuisines without treating dietary labels as cuisines", () => {
		const query =
			"How many different cuisines have I learned to cook or tried out in the past few months?"
		const [evidence] = buildCountEvidenceResults(query, [
			result("user: I tried out an Ethiopian stew recipe last month."),
			result("user: I learned to cook an Indian-inspired dal for dinner."),
			result("user: I tried making Korean japchae for meal prep."),
			result(
				"user: I cooked German and Eastern European dishes like sauerkraut.",
			),
			result(
				"user: I want to incorporate more fermented foods and vegan meals.",
			),
		])

		expect(evidence?.memory).toContain("count answer = 4")
		expect(evidence?.memory).toContain("Ethiopian")
		expect(evidence?.memory).toContain("Indian")
		expect(evidence?.memory).toContain("Korean")
		expect(evidence?.memory).toContain("German/Eastern European")
		expect(evidence?.memory).not.toContain("vegan")
		expect(evidence?.memory).not.toContain("fermented foods")
	})

	it("counts attended movie festivals by event name without counting film advice", () => {
		const query = "How many movie festivals that I attended?"
		const [evidence] = buildCountEvidenceResults(query, [
			result("user: I attended Sundance Film Festival earlier this year."),
			result(
				"user: I went to the Toronto International Film Festival with friends.",
			),
			result("user: I attended Tribeca Film Festival last spring."),
			result("user: I also attended a local documentary film festival."),
			result("user: I'm interested in learning more about independent films."),
		])

		expect(evidence?.memory).toContain("count answer = 4")
		expect(evidence?.memory).toContain("Sundance Film Festival")
		expect(evidence?.memory).toContain("Toronto International Film Festival")
		expect(evidence?.memory).toContain("Tribeca Film Festival")
		expect(evidence?.memory).toContain("local documentary film festival")
		expect(evidence?.memory).not.toContain("independent films")
	})

	it("counts attended weddings by couple without counting own wedding planning", () => {
		const query = "How many weddings have I attended in this year?"
		const [evidence] = buildCountEvidenceResults(query, [
			result("user: I attended Rachel and Mike's wedding in April."),
			result("user: I went to Emily and Sarah's wedding over the summer."),
			result("user: I was at Jen and Tom's wedding last fall."),
			result("user: I'm planning my own wedding and need venue ideas."),
			result(
				"user: I'm getting married soon and thinking about the guest list.",
			),
		])

		expect(evidence?.memory).toContain("count answer = 3")
		expect(evidence?.memory).toContain("Rachel and Mike")
		expect(evidence?.memory).toContain("Emily and Sarah")
		expect(evidence?.memory).toContain("Jen and Tom")
		expect(evidence?.memory).not.toContain("own wedding")
		expect(evidence?.memory).not.toContain("getting married")
	})

	it("counts properties viewed before an offer without counting the target townhouse", () => {
		const query =
			"How many properties did I view before making an offer on the townhouse in the Brookside neighborhood?"
		const [evidence] = buildCountEvidenceResults(query, [
			result("user: I toured a bungalow, but the kitchen needed renovation."),
			result(
				"user: I viewed a property in Cedar Creek that was out of budget.",
			),
			result("user: I saw a 1-bedroom condo but the highway noise was bad."),
			result("user: I viewed a 2-bedroom condo and lost it to a higher bid."),
			result(
				"user: I saw the 3-bedroom townhouse in the Brookside neighborhood and put in an offer.",
			),
			result("user: I had a home inspection done on the Brookside townhouse."),
		])

		expect(evidence?.memory).toContain("count answer = 4")
		expect(evidence?.memory).toContain("bungalow")
		expect(evidence?.memory).toContain("property in Cedar Creek")
		expect(evidence?.memory).toContain("1-bedroom condo")
		expect(evidence?.memory).toContain("2-bedroom condo")
		expect(evidence?.memory).not.toContain("3-bedroom townhouse")
		expect(evidence?.memory).not.toContain("home inspection")
	})

	it("counts kitchen items replaced or fixed without counting unrelated cooking", () => {
		const query = "How many kitchen items did I replace or fix?"
		const [evidence] = buildCountEvidenceResults(query, [
			result("user: I replaced the kitchen faucet last month."),
			result("user: I bought a new kitchen mat to replace the old one."),
			result("user: I fixed the toaster after breakfast."),
			result("user: I replaced the coffee maker when it stopped working."),
			result("user: I finally fixed the kitchen shelves."),
			result("user: I think I'll try making my own peanut sauce."),
			result("user: My sister gave me a fancy new espresso machine."),
		])

		expect(evidence?.memory).toContain("count answer = 5")
		expect(evidence?.memory).toContain("kitchen faucet")
		expect(evidence?.memory).toContain("kitchen mat")
		expect(evidence?.memory).toContain("toaster")
		expect(evidence?.memory).toContain("coffee maker")
		expect(evidence?.memory).toContain("kitchen shelves")
		expect(evidence?.memory).not.toContain("peanut sauce")
		expect(evidence?.memory).not.toContain("espresso machine")
	})

	it("counts furniture actions without counting shopping advice or rearranging", () => {
		const query =
			"How many pieces of furniture did I buy, assemble, sell, or fix in the past few months?"
		const [evidence] = buildCountEvidenceResults(query, [
			result("user: I bought a new coffee table for the living room."),
			result("user: I assembled an IKEA bookshelf about two months ago."),
			result("user: I sold my old couch online."),
			result("user: I fixed the wobbly dining chair."),
			result("user: I'm thinking of getting some new throw pillows."),
			result("user: I rearranged the furniture after buying the coffee table."),
		])

		expect(evidence?.memory).toContain("count answer = 4")
		expect(evidence?.memory).toContain("coffee table")
		expect(evidence?.memory).toContain("IKEA bookshelf")
		expect(evidence?.memory).toContain("old couch")
		expect(evidence?.memory).toContain("dining chair")
		expect(evidence?.memory).not.toContain("throw pillows")
		expect(evidence?.memory).not.toContain("rearranged")
	})

	it("counts food delivery services used without counting food types", () => {
		const query =
			"How many different types of food delivery services have I used recently?"
		const [evidence] = buildCountEvidenceResults(query, [
			result("user: I used Domino's for delivery twice this month."),
			result("user: I ordered from Fresh Fusion through their delivery app."),
			result("user: I also used Uber Eats recently."),
			result("user: I tried a vegan mac and cheese recipe."),
			result("assistant: Ships in a fleet have different roles and services."),
		])

		expect(evidence?.memory).toContain("count answer = 3")
		expect(evidence?.memory).toContain("Domino's")
		expect(evidence?.memory).toContain("Fresh Fusion")
		expect(evidence?.memory).toContain("Uber Eats")
		expect(evidence?.memory).not.toContain("vegan mac")
		expect(evidence?.memory).not.toContain("fleet")
	})

	it("builds generic supplemental queries for count retrieval coverage", () => {
		const healthQueries = buildSupplementalSearchQueries(
			"How many health-related devices do I use in a day?",
		).join(" ")
		const magazineQueries = buildSupplementalSearchQueries(
			"How many magazine subscriptions do I currently have?",
		).join(" ")

		expect(healthQueries).toContain("blood pressure monitor")
		expect(healthQueries).toContain("fitness tracker")
		expect(magazineQueries).toContain("subscription")
		expect(magazineQueries).toContain("currently")
		expect(`${healthQueries} ${magazineQueries}`).not.toMatch(
			/\b[a-f0-9]{8}\b/i,
		)
	})

	it("counts expanded current inventory domains from source-backed entities", () => {
		const [healthEvidence] = buildCountEvidenceResults(
			"How many health-related devices do I use in a day?",
			[
				result("user: I use my Fitbit every morning."),
				result("user: I check my blood pressure monitor after lunch."),
				result("user: I step on the smart scale before bed."),
				result("user: I use a glucose monitor with dinner."),
				result("assistant: You could buy a thermometer too."),
			],
		)
		const [subscriptionEvidence] = buildCountEvidenceResults(
			"How many magazine subscriptions do I currently have?",
			[
				result("user: I currently subscribe to Wired and The Atlantic."),
				result("user: I cancelled my old gardening magazine subscription."),
			],
		)
		const [instrumentEvidence] = buildCountEvidenceResults(
			"How many musical instruments do I currently own?",
			[
				result("user: I own a Fender Stratocaster electric guitar."),
				result("user: I still have my Yamaha FG800 acoustic guitar."),
				result("user: My Pearl Export drum set is in the garage."),
				result("user: I keep my Korg B1 piano in the living room."),
				result("user: I want to learn violin someday."),
			],
		)

		expect(healthEvidence?.memory).toContain("count answer = 4")
		expect(healthEvidence?.memory).toContain("Fitbit")
		expect(healthEvidence?.memory).toContain("blood pressure monitor")
		expect(healthEvidence?.memory).not.toContain("thermometer")
		expect(subscriptionEvidence?.memory).toContain("count answer = 2")
		expect(subscriptionEvidence?.memory).toContain("Wired")
		expect(subscriptionEvidence?.memory).toContain("The Atlantic")
		expect(subscriptionEvidence?.memory).not.toContain("cancelled")
		expect(instrumentEvidence?.memory).toContain("count answer = 4")
		expect(instrumentEvidence?.memory).toContain("electric guitar")
		expect(instrumentEvidence?.memory).toContain("drum set")
		expect(instrumentEvidence?.memory).not.toContain("violin")
	})

	it("counts expanded event and collection domains without future plans", () => {
		const [citrusEvidence] = buildCountEvidenceResults(
			"How many different types of citrus fruits have I used in my cocktail recipes?",
			[
				result("user: I used lemon in the gin fizz recipe."),
				result("user: I added lime to the margarita."),
				result("user: I tried grapefruit juice in a paloma."),
				result("user: I might buy yuzu for a future cocktail."),
			],
		)
		const [antiqueEvidence] = buildCountEvidenceResults(
			"How many antique items did I inherit or acquire from my family members?",
			[
				result(
					"user: I inherited an antique vase and a brass clock from my grandmother.",
				),
				result("user: I received a silver necklace from my aunt."),
				result("user: I acquired an antique chair from my uncle."),
				result("user: I went to an antique shop to look around."),
			],
		)
		const [sportEvidence] = buildCountEvidenceResults(
			"How many sports have I played competitively in the past?",
			[
				result("user: I played soccer competitively in high school."),
				result("user: I was on the swimming team in college."),
				result("user: I watch basketball now but never competed."),
			],
		)
		const [courseEvidence] = buildCountEvidenceResults(
			"What is the total number of online courses I've completed?",
			[
				result("user: I completed an online course on data visualization."),
				result("user: I finished online course called Python for Finance."),
				result("user: I want to take a machine learning course next."),
			],
		)

		expect(citrusEvidence?.memory).toContain("count answer = 3")
		expect(citrusEvidence?.memory).toContain("lemon")
		expect(citrusEvidence?.memory).not.toContain("yuzu")
		expect(antiqueEvidence?.memory).toContain("count answer = 4")
		expect(antiqueEvidence?.memory).toContain("antique vase")
		expect(antiqueEvidence?.memory).toContain("brass clock")
		expect(antiqueEvidence?.memory).not.toContain("look around")
		expect(sportEvidence?.memory).toContain("count answer = 2")
		expect(sportEvidence?.memory).toContain("soccer")
		expect(sportEvidence?.memory).toContain("swimming")
		expect(sportEvidence?.memory).not.toContain("basketball")
		expect(courseEvidence?.memory).toContain("count answer = 2")
		expect(courseEvidence?.memory).toContain("data visualization")
		expect(courseEvidence?.memory).toContain("Python for Finance")
		expect(courseEvidence?.memory).not.toContain("machine learning")
	})
})

describe("mem0 compat preference evidence policy", () => {
	it("promotes source-backed user context for advice questions", () => {
		const [evidence] = buildPreferenceEvidenceResults(
			"I've been having trouble with the battery life on my phone lately. Any tips?",
			[
				result(
					"I'm looking for some advice on the best way to organize my tech accessories, like my new portable power bank and wireless charging pad, when I'm traveling.",
					"2023-05-27",
				),
				result(
					"Assistant: Here are some generic battery-saving tips for your phone.",
					"2023-05-27",
				),
			],
		)

		expect(evidence?.memory).toContain("derived preference/context evidence")
		expect(evidence?.memory).toContain("portable power bank")
		expect(evidence?.memory).toContain("wireless charging pad")
		expect(evidence?.memory).not.toContain("generic battery-saving tips")
	})

	it("treats good-idea questions as preference advice and scans wider retrieved context", () => {
		const filler = Array.from({ length: 35 }, (_, index) =>
			result(
				`user: unrelated memory ${index} about daily errands.`,
				"2023-05-20",
			),
		)
		const [evidence] = buildPreferenceEvidenceResults(
			"I've been feeling nostalgic lately. Do you think it would be a good idea to attend my high school reunion?",
			[
				...filler,
				result(
					"user: I still remember the happy high school experiences such as being part of the debate team and taking advanced placement courses in economics.",
					"2023-05-23",
				),
			],
		)

		expect(evidence?.memory).toContain("debate team")
		expect(evidence?.memory).toContain("advanced placement courses")
	})

	it("does not treat timestamped assistant memories as user preference context", () => {
		const [evidence] = buildPreferenceEvidenceResults(
			"My kitchen's becoming a bit of a mess again. Any tips for keeping it clean?",
			[
				result(
					"2023-05-22 conversation memory: timestamp: 2023-05-22T05:54:00.000Z assistant: Organizing kitchen utensils can be a challenge! Here are generic tips for cleaning.",
					"2023-05-22",
				),
				result(
					"2023-05-22 conversation memory: timestamp: 2023-05-22T05:54:00.000Z user: I recently bought a new utensil holder to keep countertops clutter-free.",
					"2023-05-22",
				),
			],
		)

		expect(evidence?.memory).toContain("new utensil holder")
		expect(evidence?.memory).not.toContain("assistant: Organizing")
	})

	it("does not create preference evidence for ordinary factual lookup", () => {
		expect(
			buildPreferenceEvidenceResults("When did I watch the Super Bowl?", [
				result("I watched the Super Bowl 17 days ago."),
			]),
		).toEqual([])
	})
})
