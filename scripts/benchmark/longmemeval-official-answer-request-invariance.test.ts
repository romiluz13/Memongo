import { describe, expect, it } from "vitest"
import type { BenchmarkJudgedAnswerMaterial } from "./benchmark-answer-quality.js"
import { buildOfficialDatedAnswerMessages } from "./longmemeval-official-scoring.js"

// The snapshot file was written by this test at 3805b2d7b3, before custom-v2
// shared the dated passage renderer, so it pins the answer messages the
// official protocol sent then. Updating it is an official protocol change.
const SNAPSHOT =
	"./__snapshots__/longmemeval-official-answer-requests.base-3805b2d7b3.json"

type Material = Pick<
	BenchmarkJudgedAnswerMaterial,
	| "question"
	| "contextPassages"
	| "questionDate"
	| "passageDates"
	| "passageRoles"
>

const FIXTURES: Material[] = [
	{
		question: "Where did Zoë’s café ☕ move?",
		questionDate: "2031/02/14 (Fri) 09:30",
		contextPassages: [
			"The café moved to Quillmarsh — שלום 👩‍👩‍👧",
			"The café was in Brindlewick",
			"Undated rumor about the café",
			"The café owner liked teal",
		],
		passageDates: [
			["2031/01/20 (Mon) 10:00"],
			["2030/11/02 (Sat) 18:45", "2030/12/01 (Mon) 08:00"],
			[],
			["2030/11/02 (Sat) 18:45"],
		],
		passageRoles: ["user", "assistant", undefined, "user"],
	},
	{
		question: "Which river?",
		contextPassages: ["  padded\t ", "plain passage"],
		passageDates: [[], []],
	},
	{
		question: "Who named the lighthouse?",
		questionDate: "2031/03/01 (Sat) 12:00",
		contextPassages: [
			"User: I named the lighthouse Pellow",
			"Assistant: Pellow is a fine name.",
			"Assistant: the user said Pellow",
			"System: archived note",
			"Tool: lookup result",
		],
		passageDates: [
			["2031/02/02 (Sun) 07:00"],
			["2031/02/02 (Sun) 07:00"],
			["2031/02/03 (Mon) 07:00"],
			["2031/02/04 (Tue) 07:00"],
			["2031/02/05 (Wed) 07:00"],
		],
		passageRoles: ["user", "assistant", "user", "system", "tool"],
	},
	{
		question: "What did the gardener plant?",
		questionDate: "2031/06/30 (Mon) 20:00",
		contextPassages: Array.from({ length: 24 }, (_, i) => `gardener note ${i}`),
		passageDates: Array.from({ length: 24 }, (_, i) =>
			i % 5 === 0 ? [] : [`2031/0${(i % 4) + 1}/1${i % 10} (Tue) 10:00`],
		),
		passageRoles: Array.from({ length: 24 }, (_, i) =>
			i % 3 === 0 ? undefined : i % 3 === 1 ? "user" : "assistant",
		),
	},
	{
		question: "Is anything known?",
		questionDate: "2031/07/01 (Tue) 08:00",
		contextPassages: [],
		passageDates: [],
		passageRoles: [],
	},
]

describe("official dated answer request invariance", () => {
	it("renders byte-identical answer messages to the base commit", async () => {
		const requests = FIXTURES.map((material) =>
			buildOfficialDatedAnswerMessages(material),
		)
		await expect(
			`${JSON.stringify(requests, null, "\t")}\n`,
		).toMatchFileSnapshot(SNAPSHOT)
	})
})
