// M2 review fix R4: each statusDetail host proves what it serves on its own
// evidence (its own definition, or the latest definition its comparable
// generation is tied to). One host's definition never proves another host's
// generation, and a non-finite generation is unreadable metadata.
import { describe, expect, it } from "vitest"
import { assessRequiredIndex } from "./mongodb-index-assessment.js"
import { classifyIndexHealth } from "./mongodb-index-health.js"
import {
	type RequiredSearchIndex,
	buildRequiredIndexManifest,
} from "./mongodb-required-index-manifest.js"
import type { SearchIndexDescription } from "./mongodb-schema-search-readiness.js"

const READY = { status: "READY", queryable: true } as const

function entry(): RequiredSearchIndex {
	const found = buildRequiredIndexManifest({
		prefix: "t_",
		serverVersionArray: [8, 3, 0, 0],
		env: {},
	}).find((candidate) => candidate.name === "t_chunks_text")
	if (!found) throw new Error("manifest has no t_chunks_text")
	return found
}

function listing(
	required: RequiredSearchIndex,
	overrides: Record<string, unknown>,
): SearchIndexDescription {
	return {
		name: required.name,
		type: required.type,
		...READY,
		latestDefinition: required.definition,
		...overrides,
	} as SearchIndexDescription
}

// The drifted definition is the intended one with its mappings replaced.
function drifted(required: RequiredSearchIndex) {
	return { ...required.definition, mappings: { dynamic: true } }
}

describe("assessRequiredIndex: per-host serving proof (R4)", () => {
	it("does not let one host's definition prove another host's generation", () => {
		const required = entry()
		const assessment = assessRequiredIndex(
			required,
			listing(required, {
				latestDefinition: drifted(required),
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "a",
						...READY,
						mainIndex: { ...READY, definition: required.definition },
					},
					{
						hostname: "b",
						...READY,
						mainIndex: { ...READY, definitionVersion: { version: 2 } },
					},
				],
			}),
		)

		expect(assessment.state).not.toBe("serving")
		expect(assessment).toEqual({ state: "drift", autoEmbedMissing: false })
	})

	it("does not report the mixed-host index healthy on a request", () => {
		const required = entry()
		const verdict = classifyIndexHealth(
			required,
			listing(required, {
				latestDefinition: drifted(required),
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "a",
						...READY,
						mainIndex: { ...READY, definition: required.definition },
					},
					{
						hostname: "b",
						...READY,
						mainIndex: { ...READY, definitionVersion: { version: 2 } },
					},
				],
			}),
		)

		expect(verdict).toMatchObject({
			healthy: false,
			reason: "index-stale",
			cause: "definition-drift",
		})
	})

	it("gives the same verdict whichever host comes first", () => {
		const required = entry()
		const assessment = assessRequiredIndex(
			required,
			listing(required, {
				latestDefinition: drifted(required),
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "b",
						...READY,
						mainIndex: { ...READY, definitionVersion: { version: 2 } },
					},
					{
						hostname: "a",
						...READY,
						mainIndex: { ...READY, definition: required.definition },
					},
				],
			}),
		)

		expect(assessment).toEqual({ state: "drift", autoEmbedMissing: false })
	})

	it("refuses a host tied to a generation when the listing carries no latest definition to tie it to", () => {
		const required = entry()
		const assessment = assessRequiredIndex(
			required,
			listing(required, {
				latestDefinition: undefined,
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "a",
						...READY,
						mainIndex: { ...READY, definition: required.definition },
					},
					{
						hostname: "b",
						...READY,
						mainIndex: { ...READY, definitionVersion: { version: 2 } },
					},
				],
			}),
		)

		expect(assessment).toMatchObject({
			state: "terminal",
			failure: { code: "index-metadata-unknown" },
		})
		expect(assessment.state === "terminal" && assessment.reason).toContain(
			"host 2",
		)
	})

	it("serves when each host proves the intended definition on its own evidence", () => {
		const required = entry()
		const assessment = assessRequiredIndex(
			required,
			listing(required, {
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "a",
						...READY,
						mainIndex: { ...READY, definitionVersion: { version: 2 } },
					},
					{
						hostname: "b",
						...READY,
						mainIndex: { ...READY, definition: required.definition },
					},
				],
			}),
		)

		expect(assessment).toEqual({ state: "serving" })
	})

	it("reports drift when a host's own definition differs, even beside an intended latest definition", () => {
		const required = entry()
		const assessment = assessRequiredIndex(
			required,
			listing(required, {
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "a",
						...READY,
						mainIndex: { ...READY, definitionVersion: { version: 2 } },
					},
					{
						hostname: "b",
						...READY,
						mainIndex: { ...READY, definition: drifted(required) },
					},
				],
			}),
		)

		expect(assessment).toEqual({ state: "drift", autoEmbedMissing: false })
	})

	it.each([
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["-Infinity", Number.NEGATIVE_INFINITY],
		["a string", "2"],
	])("rejects %s as a host generation", (_label, version) => {
		const required = entry()
		const assessment = assessRequiredIndex(
			required,
			listing(required, {
				latestDefinitionVersion: { version: 2 },
				statusDetail: [
					{
						hostname: "a",
						...READY,
						mainIndex: {
							...READY,
							definition: required.definition,
							definitionVersion: { version },
						},
					},
				],
			}),
		)

		expect(assessment).toMatchObject({
			state: "terminal",
			failure: { code: "index-metadata-unknown" },
		})
	})

	it.each([
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["a string", "2"],
	])("rejects %s as the latest generation", (_label, version) => {
		const required = entry()
		const assessment = assessRequiredIndex(
			required,
			listing(required, {
				latestDefinitionVersion: { version },
				statusDetail: [
					{
						hostname: "a",
						...READY,
						mainIndex: { ...READY, definition: required.definition },
					},
				],
			}),
		)

		expect(assessment).toMatchObject({
			state: "terminal",
			failure: { code: "index-metadata-unknown" },
		})
	})
})
