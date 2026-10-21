import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises"
import os from "node:os"
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
	writePinnedSubset,
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

const sha256 = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex")

describe("writePinnedSubset", () => {
	it("writes the materialized subset and its identity pin, byte for byte", async () => {
		const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "memongo-pin-"))
		try {
			const parent =
				'[{"question_id":"a1","question_type":"alpha","x":1},{"question_id":"b1","question_type":"beta"},{"question_id":"a2","question_type":"alpha"}]'
			await mkdir(path.join(fixtureRoot, "data"))
			await writeFile(path.join(fixtureRoot, "data/parent.json"), parent)
			const pin = await writePinnedSubset({
				root: fixtureRoot,
				datasetRelative: "data/parent.json",
				outputRelative: "data/subset.json",
				pinRelative: "pin.json",
				size: 2,
				excludedIds: ["a1"],
			})
			const subset =
				'[\n\t{\n\t\t"question_id": "a2",\n\t\t"question_type": "alpha"\n\t},\n\t{\n\t\t"question_id": "b1",\n\t\t"question_type": "beta"\n\t}\n]\n'
			const pinFile = `{\n\t"version": 1,\n\t"parentSha256": "${sha256(parent)}",\n\t"subsetSha256": "${sha256(subset)}",\n\t"excludedIds": [\n\t\t"a1"\n\t],\n\t"ids": [\n\t\t"a2",\n\t\t"b1"\n\t]\n}\n`
			expect(
				await readFile(path.join(fixtureRoot, "data/subset.json"), "utf8"),
			).toBe(subset)
			expect(await readFile(path.join(fixtureRoot, "pin.json"), "utf8")).toBe(
				pinFile,
			)
			expect(pin).toEqual(JSON.parse(pinFile))
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true })
		}
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

		// The committed pin is Biome-formatted, so the comparison is with the
		// generator's serialization of its content.
		it("regenerates the committed pin byte for byte through writePinnedSubset", async () => {
			const fixtureRoot = await mkdtemp(
				path.join(os.tmpdir(), "memongo-new25-"),
			)
			try {
				await mkdir(
					path.join(fixtureRoot, path.dirname(NEW25_DATASET_RELATIVE)),
					{
						recursive: true,
					},
				)
				await mkdir(
					path.join(fixtureRoot, path.dirname(NEW25_IDENTITY_PIN_RELATIVE)),
					{ recursive: true },
				)
				await symlink(
					datasetPath,
					path.join(fixtureRoot, NEW25_DATASET_RELATIVE),
				)
				await writePinnedSubset({
					root: fixtureRoot,
					datasetRelative: NEW25_DATASET_RELATIVE,
					outputRelative: NEW25_MATERIALIZED_OUTPUT_RELATIVE,
					pinRelative: NEW25_IDENTITY_PIN_RELATIVE,
					size: NEW25_SIZE,
					excludedIds: NEW25_EXCLUDED_IDS,
				})
				const committed: unknown = JSON.parse(
					await readFile(path.join(root, NEW25_IDENTITY_PIN_RELATIVE), "utf8"),
				)
				expect(
					await readFile(
						path.join(fixtureRoot, NEW25_IDENTITY_PIN_RELATIVE),
						"utf8",
					),
				).toBe(`${JSON.stringify(committed, null, "\t")}\n`)
			} finally {
				await rm(fixtureRoot, { recursive: true, force: true })
			}
		})
	},
)
