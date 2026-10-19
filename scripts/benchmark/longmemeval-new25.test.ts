import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
	NEW25_DATASET_RELATIVE,
	NEW25_EXCLUDED_IDS,
	NEW25_IDENTITY_PIN_RELATIVE,
	NEW25_MATERIALIZED_OUTPUT_RELATIVE,
	NEW25_SIZE,
	materializeNew25Dataset,
	repoRootFromHere,
	selectRoundRobinByType,
} from "./longmemeval-new25.js"

type New25IdentityPin = {
	version: number
	parentSha256: string
	subsetSha256: string
	excludedIds: string[]
	ids: string[]
}

function entry(question_id: string, question_type: string) {
	return { question_id, question_type }
}

describe("selectRoundRobinByType", () => {
	it("cycles question types in order of first appearance, each type's queue in file order", () => {
		const entries = [
			entry("a1", "alpha"),
			entry("b1", "beta"),
			entry("a2", "alpha"),
			entry("c1", "gamma"),
			entry("a3", "alpha"),
			entry("b2", "beta"),
			entry("a4", "alpha"),
		]
		expect(selectRoundRobinByType(entries, { size: 6, excluded: [] })).toEqual([
			"a1",
			"b1",
			"c1",
			"a2",
			"b2",
			"a3",
		])
	})

	it("skips excluded ids and keeps cycling past an exhausted type", () => {
		const entries = [
			entry("a1", "alpha"),
			entry("b1", "beta"),
			entry("a2", "alpha"),
			entry("a3", "alpha"),
		]
		expect(
			selectRoundRobinByType(entries, { size: 3, excluded: ["a1"] }),
		).toEqual(["a2", "b1", "a3"])
	})

	it("refuses when the pool cannot fill the requested size", () => {
		expect(() =>
			selectRoundRobinByType([entry("a1", "alpha"), entry("b1", "beta")], {
				size: 3,
				excluded: ["b1"],
			}),
		).toThrow("only 1 eligible questions for a set of 3")
	})

	it("refuses an excluded id that is not in the dataset", () => {
		expect(() =>
			selectRoundRobinByType([entry("a1", "alpha")], {
				size: 1,
				excluded: ["zz"],
			}),
		).toThrow("excluded question_id absent from the dataset: zz")
	})

	it("refuses duplicate question ids", () => {
		expect(() =>
			selectRoundRobinByType([entry("a1", "alpha"), entry("a1", "beta")], {
				size: 1,
				excluded: [],
			}),
		).toThrow("duplicate question_id: a1")
	})
})

describe("materializeNew25Dataset", () => {
	it("returns the parent records unchanged, in selection order", () => {
		const parent = [
			{ question_id: "a1", question_type: "alpha", extra: [1, { x: "y" }] },
			{ question_id: "b1", question_type: "beta", extra: null },
		]
		const records = materializeNew25Dataset(parent, ["b1", "a1"])
		expect(records).toEqual([parent[1], parent[0]])
		expect(records[0]).toBe(parent[1])
	})
})

const root = repoRootFromHere(import.meta.url)
const datasetPath = path.join(root, NEW25_DATASET_RELATIVE)

describe.skipIf(!existsSync(datasetPath))(
	"committed new-25 identity pin",
	() => {
		it("matches a fresh selection from the pinned parent dataset", async () => {
			const pin = JSON.parse(
				await readFile(path.join(root, NEW25_IDENTITY_PIN_RELATIVE), "utf8"),
			) as New25IdentityPin
			const datasetBytes = await readFile(datasetPath)
			expect(createHash("sha256").update(datasetBytes).digest("hex")).toBe(
				pin.parentSha256,
			)
			const parsed = JSON.parse(datasetBytes.toString("utf8")) as {
				question_id: string
				question_type: string
			}[]
			const ids = selectRoundRobinByType(parsed, {
				size: NEW25_SIZE,
				excluded: NEW25_EXCLUDED_IDS,
			})
			expect(ids).toEqual(pin.ids)
			expect(pin.excludedIds).toEqual([...NEW25_EXCLUDED_IDS])
			const materializedPath = path.join(
				root,
				NEW25_MATERIALIZED_OUTPUT_RELATIVE,
			)
			if (existsSync(materializedPath)) {
				const subsetSha256 = createHash("sha256")
					.update(await readFile(materializedPath))
					.digest("hex")
				expect(subsetSha256).toBe(pin.subsetSha256)
			}
		})
	},
)
