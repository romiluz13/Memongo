import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
	HELD25_DATASET_RELATIVE,
	HELD25_IDENTITY_PIN_RELATIVE,
	HELD25_MATERIALIZED_OUTPUT_RELATIVE,
	HELD25_SIZE,
	held25ExcludedIds,
	readCommittedHeld25Exclusions,
	selectHeld25,
} from "./longmemeval-held25.js"
import { NEW25_EXCLUDED_IDS, repoRootFromHere } from "./longmemeval-new25.js"

type Held25IdentityPin = {
	version: number
	parentSha256: string
	subsetSha256: string
	excludedIds: string[]
	ids: string[]
}

function entry(question_id: string, question_type: string) {
	return { question_id, question_type }
}

describe("held25ExcludedIds", () => {
	it("unions the new25 exclusions, the new25 set and the frozen-50 set without duplicates", () => {
		expect(
			held25ExcludedIds({
				new25Excluded: ["x1", "x2"],
				new25Ids: ["n1", "x2"],
				frozen50Ids: ["f1", "n1", "x1"],
			}),
		).toEqual(["x1", "x2", "n1", "f1"])
	})
})

describe("selectHeld25", () => {
	const types = ["alpha", "beta", "gamma"]
	const entries = Array.from({ length: 60 }, (_, index) =>
		entry(`q${index}`, types[index % types.length] as string),
	)
	const exclusions = {
		new25Excluded: ["q0", "q1"],
		new25Ids: ["q2", "q3", "q4"],
		frozen50Ids: ["q5", "q6", "q7", "q8"],
	}

	it("selects 25 questions disjoint from every excluded id", () => {
		const ids = selectHeld25(entries, exclusions)
		expect(ids).toHaveLength(HELD25_SIZE)
		expect(new Set(ids).size).toBe(HELD25_SIZE)
		for (const id of held25ExcludedIds(exclusions)) {
			expect(ids).not.toContain(id)
		}
	})

	it("is deterministic and keeps the round-robin rule", () => {
		const first = selectHeld25(entries, exclusions)
		expect(selectHeld25(entries, exclusions)).toEqual(first)
		expect(first.slice(0, 6)).toEqual(["q9", "q10", "q11", "q12", "q13", "q14"])
	})
})

const root = repoRootFromHere(import.meta.url)

describe("committed held-25 identity pin", () => {
	it("is disjoint from every earlier set and names its exclusions", async () => {
		const pin = JSON.parse(
			await readFile(path.join(root, HELD25_IDENTITY_PIN_RELATIVE), "utf8"),
		) as Held25IdentityPin
		const exclusions = await readCommittedHeld25Exclusions(root)
		expect(exclusions.new25Excluded).toEqual([...NEW25_EXCLUDED_IDS])
		expect(exclusions.new25Ids).toHaveLength(25)
		expect(exclusions.frozen50Ids).toHaveLength(50)
		expect(pin.excludedIds).toEqual(held25ExcludedIds(exclusions))
		expect(pin.ids).toHaveLength(HELD25_SIZE)
		expect(new Set(pin.ids).size).toBe(HELD25_SIZE)
		const excluded = new Set(pin.excludedIds)
		expect(pin.ids.filter((id) => excluded.has(id))).toEqual([])
	})

	describe.skipIf(!existsSync(path.join(root, HELD25_DATASET_RELATIVE)))(
		"against the parent dataset",
		() => {
			it("matches a fresh selection from the pinned parent dataset", async () => {
				const pin = JSON.parse(
					await readFile(path.join(root, HELD25_IDENTITY_PIN_RELATIVE), "utf8"),
				) as Held25IdentityPin
				const datasetBytes = await readFile(
					path.join(root, HELD25_DATASET_RELATIVE),
				)
				expect(createHash("sha256").update(datasetBytes).digest("hex")).toBe(
					pin.parentSha256,
				)
				const parsed = JSON.parse(datasetBytes.toString("utf8")) as {
					question_id: string
					question_type: string
				}[]
				expect(
					selectHeld25(parsed, await readCommittedHeld25Exclusions(root)),
				).toEqual(pin.ids)
				const materializedPath = path.join(
					root,
					HELD25_MATERIALIZED_OUTPUT_RELATIVE,
				)
				if (existsSync(materializedPath)) {
					expect(
						createHash("sha256")
							.update(await readFile(materializedPath))
							.digest("hex"),
					).toBe(pin.subsetSha256)
				}
			})
		},
	)
})
