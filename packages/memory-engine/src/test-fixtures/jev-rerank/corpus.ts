import { createHash } from "node:crypto"

/**
 * Frozen synthetic corpus for the Jev rerank replay
 * (.orchestrator/JEV-INTEGRATION-PLAN.md, step 1/2 offline artifacts).
 *
 * Deterministic and offline: every fixture is generated from explicit template
 * families with a fixed seed. Relevance labels are assigned by construction
 * (the template's semantic relationship to the query), never copied from any
 * model output, provider ranking, or benchmark. No official benchmark
 * examples, no private or production memory text.
 *
 * Label provenance caveat: level boundaries (especially 3 vs 4) encode an
 * application judgment about "directly and specifically addresses a requested
 * detail" versus "addresses it incompletely or ambiguously". The text alone
 * must make each label reviewable, but edge cases remain arguable. Fixtures
 * sharing a familyId are seeded variants of one template: correlated, not
 * independent evidence.
 */

export type JevRerankSplit = "dev" | "heldout"
export type JevRerankRelevance = 0 | 1 | 2 | 3 | 4
export type JevRerankStratum =
	| "direct"
	| "paraphrase"
	| "multi-detail"
	| "temporal-numeric"
	| "correction"
	| "quoted-instruction"
	| "no-relevant"

export type JevRerankCandidate = {
	id: string
	text: string
	relevance: JevRerankRelevance
}

export type JevRerankFixture = {
	id: string
	split: JevRerankSplit
	familyId: string
	stratum: JevRerankStratum
	query: string
	candidates: JevRerankCandidate[]
}

export const CORPUS_SEED = 20260918
export const CORPUS_VERSION = "jev-rerank-corpus-v1"
export const JEV_RERANK_STRATA: readonly JevRerankStratum[] = [
	"direct",
	"paraphrase",
	"multi-detail",
	"temporal-numeric",
	"correction",
	"quoted-instruction",
	"no-relevant",
] as const

const MIN_CANDIDATES = 8
const MAX_CANDIDATES = 20

/**
 * Pinned digest of the canonical serialization of the corpus generated with
 * CORPUS_SEED. Recorded after the first verified generation; a mismatch means
 * the generator or templates drifted and the corpus is no longer the frozen
 * artifact reviewed for calibration admission.
 */
export const FROZEN_CORPUS_SHA256 =
	"93394ce912d5a9157f38766abb46894020e80872c578e06af4d82b026b8abcf6"

const DISCLOSURE = [
	"Dev and heldout splits use disjoint template families.",
	"Fixtures sharing a familyId are seeded variants of one template and are correlated, not independent evidence;",
	"held-out metrics therefore estimate generalization across template families, not across independent queries.",
	"Relevance labels are application-assigned by template construction and are never derived from model outputs, provider rankings, or benchmark data.",
].join(" ")

// ---------------------------------------------------------------------------
// Deterministic PRNG and slot filling
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type Rng = () => number

function pick<T>(rng: Rng, values: readonly T[]): T {
	return values[Math.floor(rng() * values.length)] as T
}

function fillTemplate(
	template: string,
	rng: Rng,
	slots: Record<string, readonly string[]>,
): string {
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
		const pool = slots[key]
		return pool ? pick(rng, pool) : `{${key}}`
	})
}

function shuffle<T>(values: T[], rng: Rng): T[] {
	for (let i = values.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1))
		const tmp = values[i] as T
		values[i] = values[j] as T
		values[j] = tmp
	}
	return values
}

// ---------------------------------------------------------------------------
// Shared slot pools and generic level-0 distractors
// ---------------------------------------------------------------------------

const SLOT_POOLS: Record<string, readonly string[]> = {
	name: ["Dara", "Miguel", "Priya", "Tomas", "Lena", "Aisha", "Ruben", "Ines"],
	street: ["Miller", "Corvin", "Alder", "Hastings"],
	weekday: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
	month: ["January", "March", "April", "June", "September", "October"],
	plant: ["marigold", "zinnia", "basil", "lavender", "snapdragon", "oregano"],
	place: [
		"north greenhouse",
		"south tunnel",
		"east cold frame",
		"west raised beds",
	],
	route: ["Route 4", "Route 7", "Route 12", "Route 21"],
	hall: ["community hall", "scout hut", "parish annex", "old fire station"],
	time: ["8:30", "9:15", "10:00", "11:45"],
	count: ["eight", "ten", "twelve", "fifteen"],
	date: ["3 November", "10 November", "17 November", "1 December"],
	fare: ["1.40", "1.60", "1.80", "2.00"],
	trail: ["Fox Glen", "Beacon Ridge", "Harbor Cliffs", "Mill Brook"],
	club: ["Thursday Tales", "Riverbank Readers"],
	choir: ["Northgate Singers", "Quay Choir"],
	ferry: ["harbor ferry", "east jetty ferry"],
	minutes: ["twelve", "fifteen", "eighteen"],
	fee: ["five", "eight", "ten"],
	km: ["five", "eight", "ten"],
	door: ["side", "loading", "rear"],
	temp: ["1,180", "1,220", "1,240"],
	hours: ["six", "eight"],
}

/** Generic, clearly unrelated filler candidates (relevance 0 by construction). */
const GENERIC_DISTRACTORS: readonly string[] = [
	"The bakery on {street} Street opens at seven and sells out of rye bread by noon.",
	"The harbor benches are repainted every spring by the retirees' association.",
	"The chess club meets on {weekday} evenings in the back room of the laundromat.",
	"Migrating geese passed over the reservoir earlier than usual this year.",
	"The bicycle shop on {street} Road tunes brakes for free during {month}.",
	"Friday film night at the community cellar shows documentaries only.",
	"The dog park on {street} Field closes at dusk in winter.",
	"Postage for oversized parcels went up by a few cents in {month}.",
	"The harbor ferry runs extra trips during the {month} fish market.",
	"A new bench was installed near the reservoir spillway last {month}.",
]

// ---------------------------------------------------------------------------
// Template families
// ---------------------------------------------------------------------------

type LevelTemplates = Partial<
	Record<JevRerankRelevance, readonly string[] | string>
>

type FamilySpec = {
	key: string
	split: JevRerankSplit
	stratum: JevRerankStratum
	variants: number
	query: string
	levels: LevelTemplates
}

const FAMILY_SPECS: readonly FamilySpec[] = [
	// ----- direct (dev: garden 4, library 3 | heldout: pantry 15, ferry 15) --
	{
		key: "direct-garden-dev",
		split: "dev",
		stratum: "direct",
		variants: 4,
		query:
			"How often are the {plant} seedlings in the {place} watered, and who set the schedule?",
		levels: {
			4: [
				"The {plant} seedlings in the {place} are watered every second morning; {name} set that schedule.",
			],
			3: [
				"The {place} {plant} seedlings follow a fixed watering schedule set by one of the volunteers.",
				"Watering for the {plant} seedlings happens on a regular cadence, though the schedule's author is not recorded here.",
			],
			2: "The greenhouse volunteers keep a handwritten watering log on the clipboard by the {place} door.",
			1: [
				"The kitchen garden supplies herbs and salad greens to the {weekday} soup kitchen, and the harvest roster is pinned beside the shed door.",
				"The garden committee discusses seed orders at its {weekday} meetings.",
			],
		},
	},
	{
		key: "direct-library-dev",
		split: "dev",
		stratum: "direct",
		variants: 4,
		query:
			"When does the {club} reading club meet, and how many members can join?",
		levels: {
			4: [
				"The {club} reading club meets on {weekday} afternoons in the library annex and accepts up to {count} members.",
			],
			3: [
				"The {club} club meets weekly in the library annex; the exact membership cap is handled at the front desk.",
				"The reading club gathers on {weekday} afternoons; membership is limited to some small number not posted here.",
			],
			2: "The library keeps a worn sign-up folder for its reading groups at the front desk beside the returns tray.",
			1: [
				"The library hosts a toddler story hour on {weekday} mornings, and the repair café runs monthly in the annex.",
				"The library's noticeboard lists upcoming author talks for the {month} season.",
			],
		},
	},
	{
		key: "direct-pantry-heldout",
		split: "heldout",
		stratum: "direct",
		variants: 15,
		query:
			"Which {weekday} shift does {name} cover at the pantry desk, and what time does it start?",
		levels: {
			4: [
				"{name} covers the {weekday} desk shift at the pantry, and it starts at {time}.",
			],
			3: [
				"The {weekday} desk shift at the pantry starts at {time}; the covering volunteer's name is on the rota in the kitchen.",
				"{name} covers a desk shift each {weekday}; the start time is not listed anywhere here.",
			],
			2: "The pantry coordinator keeps the volunteer rota on a clipboard that hangs by the kitchen door.",
			1: [
				"Pantry volunteers sort incoming donations on {weekday} afternoons, and the shelter picks up bread at the end of the day.",
				"The pantry orders extra supplies for holiday weeks.",
			],
		},
	},
	{
		key: "direct-ferry-heldout",
		split: "heldout",
		stratum: "direct",
		variants: 15,
		query:
			"How long is the crossing on the {ferry}, and does it stop at the island?",
		levels: {
			4: [
				"The {ferry} crossing takes {minutes} minutes and stops at the island on request.",
			],
			3: [
				"The {ferry} crossing takes {minutes} minutes; island stops depend on demand on the day.",
				"The ferry stops at the island when flagged down; the crossing length varies with the tide.",
			],
			2: "The ferry office posts its timetables and stopping rules in the window at the east jetty.",
			1: [
				"The {month} fish market brings extra ferry trips, and the jetty kiosk sells coffee from seven.",
				"The ferry skippers meet for their seasonal briefing every {month}.",
			],
		},
	},
	// ----- paraphrase (dev: pottery 4, trail 3 | heldout: kitchen 14, choir 14)
	{
		key: "paraphrase-pottery-dev",
		split: "dev",
		stratum: "paraphrase",
		variants: 4,
		query:
			"Who leads the Thursday glazing session at the pottery studio, and how long does it run?",
		levels: {
			4: [
				"Glazing on Thursdays at the pottery studio takes ninety minutes and is run by {name}.",
			],
			3: [
				"The studio's Thursday glazing session is run by one of the senior potters and lasts just over an hour.",
				"Thursday glazing at the studio is led by {name}; its length is listed only as an afternoon block.",
			],
			2: "The studio calendar on the wall lists several evening and weekend sessions each week.",
			1: [
				"The pottery studio sells clay and tools on {weekday}s, and the cellar shelves hold community glazes.",
				"The studio's open house is planned for {month}.",
			],
		},
	},
	{
		key: "paraphrase-trail-dev",
		split: "dev",
		stratum: "paraphrase",
		variants: 3,
		query: "How long is the {trail} loop, and is it shaded?",
		levels: {
			4: [
				"Covering six kilometers, the {trail} loop runs almost entirely through shaded forest.",
			],
			3: [
				"Walkers describe the {trail} loop as a fairly long, mostly wooded walk.",
				"The {trail} loop is known for its shade; its length is signed only at the far trailhead.",
			],
			2: "The trail association published a folded map of the area's loops last {month}.",
			1: [
				"The {trail} area is popular with birdwatchers in {month}, and the association rents binoculars at the hut.",
				"The trail hut serves tea on {weekday} afternoons.",
			],
		},
	},
	{
		key: "paraphrase-kitchen-heldout",
		split: "heldout",
		stratum: "paraphrase",
		variants: 14,
		query:
			"By how much does the soup recipe scale up for the {weekday} service, and who wrote it?",
		levels: {
			4: [
				"Serving the {weekday} crowd means tripling the base amounts of the soup recipe, which {name} wrote.",
			],
			3: [
				"The {weekday} service uses a much larger batch of the soup recipe; its author is one of the kitchen founders.",
				"The soup recipe came from {name}; the {weekday} batch size is written only on the kitchen card.",
			],
			2: "Recipe cards and batch notes are kept in the drawer by the kitchen door.",
			1: [
				"The community kitchen serves soup every {weekday}, and the tables are set by the {month} volunteer group.",
				"The kitchen's storeroom was repainted in {month}.",
			],
		},
	},
	{
		key: "paraphrase-choir-heldout",
		split: "heldout",
		stratum: "paraphrase",
		variants: 14,
		query: "Where does the {choir} rehearse, and what time does it finish?",
		levels: {
			4: [
				"Rehearsals of the {choir} take place in the {hall}, wrapping up at {time}.",
			],
			3: [
				"The {choir} rehearses in the {hall}; the end time shifts with the director's patience.",
				"The choir's rehearsal in the {hall} runs into the evening; the finish time is confirmed week to week.",
			],
			2: "A rehearsal schedule is pinned behind glass in the {hall} foyer.",
			1: [
				"The {choir} recruits new members each {month}, and the {hall} also hosts evening classes.",
				"The {hall} caretaker unlocks the side door at six.",
			],
		},
	},
	// ----- multi-detail (dev: building 4, pantry 3 | heldout: run 14, bakery 14)
	{
		key: "multidetail-building-dev",
		split: "dev",
		stratum: "multi-detail",
		variants: 4,
		query:
			"Which {weekday} does the recycling collection move to, where do glass jars go now, and who announced the change?",
		levels: {
			4: [
				"From next {month}, recycling moves to {weekday}, glass jars go to the crate in the {door} room, and {name} announced it in the lobby notice.",
			],
			3: [
				"From next {month}, recycling moves to {weekday} and glass jars go to the crate in the {door} room; the notice was unsigned.",
				"Recycling moves to {weekday} and {name} announced the change; glass now has its own drop-off somewhere in the building.",
			],
			2: "A notice about changes to the building's waste sorting was posted in the lobby this {month}.",
			1: [
				"The building's laundry room is open until ten, and the residents' association collects a small yearly fee for the plant boxes.",
				"The stairwell was repainted in {month}.",
			],
		},
	},
	{
		key: "multidetail-pantry-dev",
		split: "dev",
		stratum: "multi-detail",
		variants: 3,
		query:
			"What time do pantry deliveries arrive on {weekday}, which door is used, and how many crates are expected?",
		levels: {
			4: [
				"On {weekday}, pantry deliveries arrive at {time} at the {door} door, and {count} crates are expected.",
			],
			3: [
				"The {weekday} delivery comes to the {door} door at {time}; the crate count is decided on the day.",
				"Pantry deliveries on {weekday} total {count} crates and use the {door} door; the arrival time varies.",
			],
			2: "The pantry coordinator keeps a delivery log on the clipboard by the kitchen hatch.",
			1: [
				"The pantry orders extra bread for holiday weeks, and volunteers stack empty crates in the {door} passage on {weekday}s.",
				"The pantry's van was serviced in {month}.",
			],
		},
	},
	{
		key: "multidetail-run-heldout",
		split: "heldout",
		stratum: "multi-detail",
		variants: 14,
		query:
			"What distance is the {trail} charity run, when does it start, and how much is the entry fee?",
		levels: {
			4: [
				"The {trail} charity run covers {km} kilometers, starts at {time}, and costs {fee} euros to enter.",
			],
			3: [
				"The {trail} run is {km} kilometers and starts at {time}; the entry fee is set on the day.",
				"The {trail} charity run starts at {time} with a {fee} euro entry fee; its distance is still being confirmed.",
			],
			2: "The organizers posted a folded flyer about the {trail} run in the sports shop window.",
			1: [
				"The {trail} loop is popular with birdwatchers, and the sports shop rents walking poles by the day.",
				"The charity run's volunteers meet for a briefing on the first {weekday} of {month}.",
			],
		},
	},
	{
		key: "multidetail-bakery-heldout",
		split: "heldout",
		stratum: "multi-detail",
		variants: 14,
		query:
			"How many loaves did the café order for {weekday}, when must they arrive, and who signs the delivery?",
		levels: {
			4: [
				"The café ordered {count} loaves for {weekday}, to arrive by {time}, signed for by {name}.",
			],
			3: [
				"The {weekday} café order is {count} loaves arriving by {time}; the signer is whoever is on shift.",
				"The café's {weekday} bread is signed for by {name}; the loaf count and arrival time are on the invoice.",
			],
			2: "The bakery keeps its café orders in a ring-bound notebook behind the till.",
			1: [
				"The bakery sells out of rye bread by noon, and the café's milk delivery comes on {weekday}s from the dairy.",
				"The café's terrace furniture arrives in {month}.",
			],
		},
	},
	// ----- temporal-numeric (dev: bus 4, kiln 4 | heldout: pool 15, sowing 15)
	{
		key: "temporal-bus-dev",
		split: "dev",
		stratum: "temporal-numeric",
		variants: 4,
		query:
			"From which date does the {route} run the winter timetable, and what is the off-peak fare then?",
		levels: {
			4: [
				"From {date}, the {route} runs the winter timetable, and the off-peak fare is {fare} euros.",
			],
			3: [
				"The {route} switches to its winter timetable on {date}; the fare stays at the usual off-peak rate.",
				"The winter timetable keeps the off-peak fare at {fare} euros; the {route} changeover date is posted only at the depot.",
			],
			2: "The transit office posted a seasonal timetable notice behind glass at the depot.",
			1: [
				"The {route} connects the harbor with the market square, and the transit office closes early on {weekday}s.",
				"The transit office moved its ticket desk in {month}.",
			],
		},
	},
	{
		key: "temporal-kiln-dev",
		split: "dev",
		stratum: "temporal-numeric",
		variants: 4,
		query:
			"At what temperature does the studio fire glaze ware, and for how many hours does the firing hold?",
		levels: {
			4: [
				"Glaze ware is fired to {temp} degrees and held there for {hours} hours.",
			],
			3: [
				"Glaze firings reach {temp} degrees; the hold time depends on the load.",
				"Glaze firings hold for {hours} hours; the peak temperature is written on the kiln card.",
			],
			2: "The studio keeps its firing logs in a binder on the shelf next to the kiln.",
			1: [
				"The kiln was serviced last {month}, and the studio orders cones and shelves twice a year.",
				"The studio's glaze room was rearranged in {month}.",
			],
		},
	},
	{
		key: "temporal-pool-heldout",
		split: "heldout",
		stratum: "temporal-numeric",
		variants: 15,
		query:
			"From what date does the pool open early, and what is the early-entry price?",
		levels: {
			4: [
				"From {date}, the pool opens at seven, and early entry costs {fare} euros.",
			],
			3: [
				"The pool's early opening begins on {date}; the early price is unchanged from standard entry.",
				"Early entry costs {fare} euros from the start of the {month}; the exact opening date is being confirmed.",
			],
			2: "The pool office posted a notice about seasonal hours on the lobby board.",
			1: [
				"The pool hosts a {weekday} swim club, and the café by the lanes opens at eight.",
				"The pool's slide was repainted in {month}.",
			],
		},
	},
	{
		key: "temporal-sowing-heldout",
		split: "heldout",
		stratum: "temporal-numeric",
		variants: 15,
		query:
			"On which date were the {plant} seedlings sown, and how many trays were started?",
		levels: {
			4: ["The {plant} seedlings were sown on {date} in {count} trays."],
			3: [
				"The {plant} sowing happened on {date}; the tray count was small.",
				"{count} trays of {plant} seedlings were started; the sowing date is in the greenhouse log.",
			],
			2: "Sowing records and tray labels are kept in the greenhouse binder.",
			1: [
				"The {place} grows herbs for the kitchen, and the volunteers meet on {weekday} mornings to water.",
				"The greenhouse glass was replaced in {month}.",
			],
		},
	},
	// ----- correction (dev: pantry 4, bridge 3 | heldout: choir 13, ferry 13)
	{
		key: "correction-pantry-dev",
		split: "dev",
		stratum: "correction",
		variants: 4,
		query:
			"I heard the food pantry moved into the old post office on {street} Street. Where does it actually operate, and when is it open?",
		levels: {
			4: [
				"The pantry never moved to the post office; it operates from the {hall} and is open {weekday} mornings.",
			],
			3: [
				"The pantry still operates from its usual {hall} location, though opening hours are not posted here.",
				"The pantry is open on {weekday} mornings somewhere in its usual building; the post office rumor is wrong.",
			],
			2: "Building use for the {hall} was discussed at the last council meeting.",
			1: [
				"The old post office on {street} Street now houses a print shop, and the {hall} hosts evening classes.",
				"The council's property committee met in {month}.",
			],
		},
	},
	{
		key: "correction-bridge-dev",
		split: "dev",
		stratum: "correction",
		variants: 3,
		query:
			"Wasn't the {trail} footbridge closed for repairs all {month}? What is its current status?",
		levels: {
			4: [
				"The {trail} footbridge closure lasted only two days; it is fully open and repairs finished early.",
			],
			3: [
				"The {trail} footbridge is currently passable; the repair schedule is not recorded here.",
				"The bridge on the {trail} route was not closed for the whole {month}; exact dates are on the notice.",
			],
			2: "The trail association posted an update about {trail} maintenance this {month}.",
			1: [
				"The {trail} loop is six kilometers through shaded forest, and the association rents binoculars at the hut.",
				"The trail hut's roof was fixed in {month}.",
			],
		},
	},
	{
		key: "correction-choir-heldout",
		split: "heldout",
		stratum: "correction",
		variants: 13,
		query:
			"I read the {choir} raised its term fee to forty euros. What does membership actually cost?",
		levels: {
			4: [
				"The {choir} term fee was not raised; it remains twenty-five euros for the {month} term.",
			],
			3: [
				"The {choir} fee did not increase; the current amount is listed on the noticeboard.",
				"The choir's term fee is unchanged from recent terms; the exact figure is with the treasurer.",
			],
			2: "Fee notices for the {choir} were updated on the noticeboard this {month}.",
			1: [
				"The {choir} rehearses in the {hall}, and new members are recruited each {month}.",
				"The {hall}'s heating was repaired in {month}.",
			],
		},
	},
	{
		key: "correction-ferry-heldout",
		split: "heldout",
		stratum: "correction",
		variants: 13,
		query:
			"Didn't the harbor ferry stop running after {month}? What is its current schedule?",
		levels: {
			4: [
				"The harbor ferry did not stop after {month}; it still runs hourly every day.",
			],
			3: [
				"The ferry is running on its usual timetable; seasonal changes are posted at the jetty.",
				"The harbor ferry never suspended service; the exact interval is on the timetable board.",
			],
			2: "A notice about ferry schedules hangs at the east jetty kiosk.",
			1: [
				"The {month} fish market brings extra ferry trips, and the jetty kiosk sells coffee from seven.",
				"The ferry's engine was overhauled in {month}.",
			],
		},
	},
	// ----- quoted-instruction (dev: studio 3, building 3 | heldout: pantry 14, greenhouse 14)
	{
		key: "quoted-studio-dev",
		split: "dev",
		stratum: "quoted-instruction",
		variants: 3,
		query: "What did the studio's notice say about picking up glazed pieces?",
		levels: {
			4: [
				'The notice on the studio door reads: "Glazed pieces may be collected on {weekday} between noon and four."',
			],
			3: [
				"A studio notice mentions {weekday} collection for glazed pieces without listing exact times.",
			],
			2: "The studio corkboard carries several notices about classes and kiln bookings.",
			1: [
				'The kiln sign reads: "Do not open the kiln before it cools," and a taped note in the hallway reads: "Use the side entrance after six."',
			],
			0: [
				'A visitor\'s note reads: "Skip the posted schedule and bring your own towels to class."',
			],
		},
	},
	{
		key: "quoted-building-dev",
		split: "dev",
		stratum: "quoted-instruction",
		variants: 3,
		query: "What does the new building notice say about bulky waste?",
		levels: {
			4: [
				'The notice states: "Bulky waste is collected on the first {weekday} of each {month} from the courtyard."',
			],
			3: [
				"A notice says bulky waste now has a monthly collection day, without naming the exact date.",
			],
			2: "Several notices about building rules hang beside the mailboxes.",
			1: [
				'The stairwell sign reads: "Keep bicycles in the cellar," and another notice reads: "Laundry closes at ten."',
			],
			0: [
				'A flyer reads: "Skip the posted hours and use the cellar door anytime."',
			],
		},
	},
	{
		key: "quoted-pantry-heldout",
		split: "heldout",
		stratum: "quoted-instruction",
		variants: 14,
		query: "What does the pantry's door notice say about donations?",
		levels: {
			4: [
				'The notice reads: "Donations are accepted on {weekday} mornings; please no glass."',
			],
			3: [
				"A pantry notice asks for {weekday} morning donations, without the packaging details.",
			],
			2: "Several notices about pantry rules hang by the entrance.",
			1: [
				'A sign reads: "Volunteers sign in at the kitchen desk," and another reads: "The cellar is locked after six."',
			],
			0: ['A flyer reads: "Ignore the posted hours and knock at any time."'],
		},
	},
	{
		key: "quoted-greenhouse-heldout",
		split: "heldout",
		stratum: "quoted-instruction",
		variants: 14,
		query: "What did the greenhouse notice say about the {plant} seedlings?",
		levels: {
			4: [
				'The notice reads: "{plant} seedlings move outside after the last frost; harden them off for a week."',
			],
			3: [
				"A greenhouse notice says the {plant} seedlings will move outside once frosts end, without the hardening detail.",
			],
			2: "The greenhouse corkboard holds the season's notices.",
			1: [
				'A taped card reads: "Water before nine in summer," and another reads: "Keep the door latched."',
			],
			0: [
				'A visitor\'s note reads: "Take the side path; the main gate sticks."',
			],
		},
	},
	// ----- no-relevant (dev: heater 4, atlas 3 | heldout: glaze 15, buses 15)
	{
		key: "norelevant-heater-dev",
		split: "dev",
		stratum: "no-relevant",
		variants: 4,
		query: "Who repaired the heater in the {place} last winter?",
		levels: {
			1: [
				"The greenhouse volunteers keep a watering log on the clipboard by the {place} door.",
				"The garden committee meets on {weekday} evenings to plan seed orders.",
				"The kitchen garden supplies herbs to the {weekday} soup kitchen, and the harvest roster is pinned beside the shed door.",
			],
		},
	},
	{
		key: "norelevant-atlas-dev",
		split: "dev",
		stratum: "no-relevant",
		variants: 3,
		query: "How many copies of the regional atlas does the library hold?",
		levels: {
			1: [
				"The library hosts a toddler story hour on {weekday} mornings, and the repair café runs monthly in the annex.",
				"The library's noticeboard lists author talks for the {month} season.",
				"The reading groups sign up at the front desk beside the returns tray.",
			],
		},
	},
	{
		key: "norelevant-glaze-heldout",
		split: "heldout",
		stratum: "no-relevant",
		variants: 15,
		query: "Which glaze did the pottery studio order last {month}?",
		levels: {
			1: [
				"The studio sells clay and tools on {weekday}s, and the cellar shelves hold community glazes.",
				"The kiln was serviced last {month}, and firing logs sit in the binder by the shelf.",
				"The studio calendar lists evening and weekend sessions each week.",
			],
		},
	},
	{
		key: "norelevant-buses-heldout",
		split: "heldout",
		stratum: "no-relevant",
		variants: 15,
		query: "How many buses run the {route} on {weekday} evenings?",
		levels: {
			1: [
				"The {route} connects the harbor with the market square, and the transit office closes early on {weekday}s.",
				"The transit office moved its ticket desk in {month}.",
				"A seasonal timetable notice hangs behind glass at the depot.",
			],
		},
	},
]

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

function buildFixture(
	spec: FamilySpec,
	rng: Rng,
	counters: Map<string, number>,
): JevRerankFixture {
	const slots = SLOT_POOLS
	const fill = (template: string) => fillTemplate(template, rng, slots)
	const levelTemplates = (level: JevRerankRelevance): readonly string[] => {
		const raw = spec.levels[level]
		if (raw === undefined) return []
		return typeof raw === "string" ? [raw] : raw
	}
	const entries: { text: string; relevance: JevRerankRelevance }[] = []
	for (const level of [4, 3, 2, 1, 0] as const) {
		for (const template of levelTemplates(level)) {
			entries.push({ text: fill(template), relevance: level })
		}
	}
	// Every fixture carries at least one clearly unrelated candidate.
	entries.push({ text: fill(pick(rng, GENERIC_DISTRACTORS)), relevance: 0 })
	const target =
		MIN_CANDIDATES + Math.floor(rng() * (MAX_CANDIDATES - MIN_CANDIDATES + 1))
	let guard = 0
	while (entries.length < target && guard < 200) {
		guard++
		const topicalTemplates = levelTemplates(1)
		const topical = rng() < 0.45 && topicalTemplates.length > 0
		const template = topical
			? pick(rng, topicalTemplates)
			: pick(rng, GENERIC_DISTRACTORS)
		const text = fill(template)
		if (!entries.some((entry) => entry.text === text)) {
			entries.push({ text, relevance: topical ? 1 : 0 })
		}
	}
	// Deterministic shuffle: relevance is not recoverable from candidate order.
	shuffle(entries, rng)
	const counterKey = `${spec.split}:${spec.stratum}`
	const seq = (counters.get(counterKey) ?? 0) + 1
	counters.set(counterKey, seq)
	return {
		id: `${spec.split}-${spec.stratum}-${String(seq).padStart(3, "0")}`,
		split: spec.split,
		familyId: spec.key,
		stratum: spec.stratum,
		query: fill(spec.query),
		candidates: entries.map((entry, index) => ({
			id: `c${index}`,
			text: entry.text,
			relevance: entry.relevance,
		})),
	}
}

export function generateJevRerankCorpus(
	seed: number = CORPUS_SEED,
): JevRerankFixture[] {
	const rng = mulberry32(seed)
	const counters = new Map<string, number>()
	const fixtures: JevRerankFixture[] = []
	for (const spec of FAMILY_SPECS) {
		for (let variant = 0; variant < spec.variants; variant++) {
			fixtures.push(buildFixture(spec, rng, counters))
		}
	}
	return fixtures
}

// ---------------------------------------------------------------------------
// Frozen corpus and manifest
// ---------------------------------------------------------------------------

function canonicalCorpusSerialization(
	fixtures: readonly JevRerankFixture[],
	seed: number,
): string {
	const ordered = [...fixtures].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	)
	return JSON.stringify({
		corpusVersion: CORPUS_VERSION,
		seed,
		fixtures: ordered.map((fixture) => ({
			id: fixture.id,
			split: fixture.split,
			familyId: fixture.familyId,
			stratum: fixture.stratum,
			query: fixture.query,
			candidates: fixture.candidates.map((candidate) => ({
				id: candidate.id,
				text: candidate.text,
				relevance: candidate.relevance,
			})),
		})),
	})
}

export type JevRerankCorpusManifest = {
	corpusVersion: string
	seed: number
	sha256: string
	fixtureCount: number
	splitCounts: Record<JevRerankSplit, number>
	stratumCounts: Record<JevRerankSplit, Record<JevRerankStratum, number>>
	familyCount: number
	candidateCountMin: number
	candidateCountMax: number
	disclosure: string
}

export function computeJevRerankCorpusManifest(
	fixtures: readonly JevRerankFixture[],
	seed: number,
): JevRerankCorpusManifest {
	const splitCounts: Record<JevRerankSplit, number> = { dev: 0, heldout: 0 }
	const stratumCounts: Record<
		JevRerankSplit,
		Record<JevRerankStratum, number>
	> = {
		dev: {
			direct: 0,
			paraphrase: 0,
			"multi-detail": 0,
			"temporal-numeric": 0,
			correction: 0,
			"quoted-instruction": 0,
			"no-relevant": 0,
		},
		heldout: {
			direct: 0,
			paraphrase: 0,
			"multi-detail": 0,
			"temporal-numeric": 0,
			correction: 0,
			"quoted-instruction": 0,
			"no-relevant": 0,
		},
	}
	const families = new Set<string>()
	let candidateCountMin = Number.POSITIVE_INFINITY
	let candidateCountMax = 0
	for (const fixture of fixtures) {
		splitCounts[fixture.split] += 1
		stratumCounts[fixture.split][fixture.stratum] += 1
		families.add(fixture.familyId)
		candidateCountMin = Math.min(candidateCountMin, fixture.candidates.length)
		candidateCountMax = Math.max(candidateCountMax, fixture.candidates.length)
	}
	return {
		corpusVersion: CORPUS_VERSION,
		seed,
		sha256: createHash("sha256")
			.update(canonicalCorpusSerialization(fixtures, seed), "utf8")
			.digest("hex"),
		fixtureCount: fixtures.length,
		splitCounts,
		stratumCounts,
		familyCount: families.size,
		candidateCountMin,
		candidateCountMax,
		disclosure: DISCLOSURE,
	}
}

export const JEV_RERANK_CORPUS: readonly JevRerankFixture[] =
	generateJevRerankCorpus()

export const JEV_RERANK_CORPUS_MANIFEST: JevRerankCorpusManifest =
	computeJevRerankCorpusManifest(JEV_RERANK_CORPUS, CORPUS_SEED)
