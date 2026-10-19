import { describe, expect, it } from "vitest"
import {
	RequestIndexHealth,
	activeIndexHealth,
	assertCollectionIndexesHealthy,
	assertLaneIndexesHealthy,
	capabilitiesFromHealth,
	classifyIndexHealth,
	deploymentFactsOf,
	runWithIndexHealth,
} from "./mongodb-index-health.js"
import {
	type RequiredSearchIndex,
	buildRequiredIndexManifest,
} from "./mongodb-required-index-manifest.js"
import { SearchLaneError } from "./search-outcomes.js"
import {
	type FakeSearchDbOptions,
	type FakeSearchIndex,
	createFakeSearchDb,
	readyIndex,
} from "./test-helpers/fake-search-db.js"

const PREFIX = "t_"
const MANIFEST = buildRequiredIndexManifest({
	prefix: PREFIX,
	serverVersionArray: [8, 3, 0, 0],
	env: {} as NodeJS.ProcessEnv,
})

const FACTS = deploymentFactsOf({
	vectorSearch: true,
	textSearch: true,
	scoreFusion: true,
	rankFusion: true,
	storedSource: true,
	vectorIndexMethod: true,
	queryableSearchIndexes: ["boot-snapshot-only"],
})

function entryNamed(name: string): RequiredSearchIndex {
	const entry = MANIFEST.find((candidate) => candidate.name === name)
	if (!entry) throw new Error(`no manifest entry ${name}`)
	return entry
}

function healthyIndexes(): Record<string, FakeSearchIndex[]> {
	const byCollection: Record<string, FakeSearchIndex[]> = {}
	for (const entry of MANIFEST) {
		byCollection[entry.collectionName] = [
			...(byCollection[entry.collectionName] ?? []),
			readyIndex(entry.name, entry.type, entry.definition),
		]
	}
	return byCollection
}

function harness(options: FakeSearchDbOptions = {}) {
	const fake = createFakeSearchDb({ indexes: healthyIndexes(), ...options })
	const source = {
		db: fake.db,
		prefix: PREFIX,
		manifest: MANIFEST,
		facts: FACTS,
	}
	const listReads = () =>
		fake.calls.filter(
			(call) =>
				call.op === "aggregate" && "$listSearchIndexes" in call.pipeline[0],
		)
	return { ...fake, source, listReads }
}

function replace(
	indexes: Record<string, FakeSearchIndex[]>,
	collection: string,
	name: string,
	patch: Partial<FakeSearchIndex> | null,
) {
	indexes[collection] = (indexes[collection] ?? []).flatMap((index) =>
		index.name !== name
			? [index]
			: patch === null
				? []
				: [{ ...index, ...patch }],
	)
}

const CHUNKS_VECTOR = `${PREFIX}chunks_vector`
const CHUNKS_TEXT = `${PREFIX}chunks_text`
const CHUNKS = `${PREFIX}chunks`

describe("classifyIndexHealth (M2 decision 8)", () => {
	const entry = entryNamed(CHUNKS_VECTOR)
	const serving = readyIndex(entry.name, entry.type, entry.definition)

	it("a READY, queryable index serving its definition is healthy", () => {
		expect(classifyIndexHealth(entry, serving)).toEqual({
			healthy: true,
			index: CHUNKS_VECTOR,
		})
	})

	it.each([
		{
			name: "STALE",
			index: { ...serving, status: "STALE" },
			reason: "index-stale",
			cause: "stale",
		},
		{
			name: "a READY index serving a drifted definition",
			index: { ...serving, latestDefinition: { fields: [] } },
			reason: "index-stale",
			cause: "definition-drift",
		},
		{
			name: "a READY index still building an updated definition",
			index: {
				...serving,
				statusDetail: [
					{
						hostname: "h1",
						mainIndex: { status: "READY", queryable: true },
						stagedIndex: { status: "BUILDING" },
					},
				],
			},
			reason: "index-stale",
			cause: "definition-pending",
		},
		{
			name: "absent",
			index: undefined,
			reason: "index-unavailable",
			cause: "absent",
		},
		{
			name: "BUILDING",
			index: { ...serving, status: "BUILDING", queryable: false },
			reason: "index-unavailable",
			cause: "not-ready",
		},
		{
			name: "PENDING",
			index: { ...serving, status: "PENDING", queryable: false },
			reason: "index-unavailable",
			cause: "not-ready",
		},
		{
			name: "DOES_NOT_EXIST",
			index: { ...serving, status: "DOES_NOT_EXIST", queryable: false },
			reason: "index-unavailable",
			cause: "absent",
		},
		{
			name: "FAILED",
			index: { ...serving, status: "FAILED", queryable: false },
			reason: "index-unavailable",
			cause: "failed",
		},
		{
			name: "READY but not queryable",
			index: { ...serving, queryable: false },
			reason: "index-unavailable",
			cause: "unqueryable",
		},
		{
			name: "an unknown status",
			index: { ...serving, status: "EXPLODED" },
			reason: "index-unavailable",
			cause: "metadata-unknown",
		},
		{
			name: "the wrong index type",
			index: { ...serving, type: "search" },
			reason: "index-unavailable",
			cause: "metadata-unknown",
		},
	])("$name gives $reason", ({ index, reason, cause }) => {
		expect(classifyIndexHealth(entry, index)).toMatchObject({
			healthy: false,
			index: CHUNKS_VECTOR,
			collection: CHUNKS,
			reason,
			cause,
		})
	})
})

describe("RequestIndexHealth", () => {
	it("reads each collection's metadata once per request, however many lanes ask", async () => {
		const { source, listReads } = harness()
		const health = new RequestIndexHealth(source)

		for (let ask = 0; ask < 4; ask += 1) {
			await health.assertHealthy(health.select(["chunks"]))
			await health.assertHealthy(health.select(["chunks", "structured_mem"]))
		}

		expect(
			listReads()
				.map((call) => (call as { collection: string }).collection)
				.sort(),
		).toEqual([CHUNKS, `${PREFIX}structured_mem`].sort())
		expect(health.stats()).toMatchObject({
			metadataReads: 2,
			failedMetadataReads: 0,
		})
	})

	it("reads only the collections a request's planned operations use", async () => {
		const { source, listReads } = harness()
		const health = new RequestIndexHealth(source)

		await health.assertHealthy(health.select(["kb_chunks"]))

		expect(listReads()).toHaveLength(1)
		expect((listReads()[0] as { collection: string }).collection).toBe(
			`${PREFIX}kb_chunks`,
		)
	})

	it("throws a typed index-stale for a STALE index, naming the lane and the stage", async () => {
		const { source, indexes } = harness()
		replace(indexes, CHUNKS, CHUNKS_TEXT, { status: "STALE" })
		const health = new RequestIndexHealth(source)

		const failure = await health
			.assertHealthy(health.select(["chunks"]), "hybrid:chunks")
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(SearchLaneError)
		expect(failure).toMatchObject({
			lane: "hybrid:chunks",
			stage: "index-health",
			reason: "index-stale",
		})
	})

	it("an unavailable index outranks a stale one in the same check", async () => {
		const { source, indexes } = harness()
		replace(indexes, CHUNKS, CHUNKS_TEXT, { status: "STALE" })
		replace(indexes, CHUNKS, CHUNKS_VECTOR, null)
		const health = new RequestIndexHealth(source)

		await expect(
			health.assertHealthy(health.select(["chunks"])),
		).rejects.toMatchObject({ reason: "index-unavailable" })
	})

	it("a failed metadata read is index-unavailable, remembered for the request, with the read error as cause", async () => {
		const readError = new Error("mongot unreachable")
		let failing = true
		const { source, listReads } = harness({
			listError: (collection) =>
				failing && collection === CHUNKS ? readError : undefined,
		})
		const health = new RequestIndexHealth(source)

		const first = await health
			.assertHealthy(health.select(["chunks"]), "hybrid:chunks")
			.catch((err: unknown) => err)
		failing = false
		const second = await health
			.assertHealthy(health.select(["chunks"]), "hybrid:chunks")
			.catch((err: unknown) => err)

		expect(first).toMatchObject({
			reason: "index-unavailable",
			stage: "index-health",
		})
		expect((first as Error).cause).toBe(readError)
		// One request never sees two answers for one collection.
		expect(second).toMatchObject({ reason: "index-unavailable" })
		expect(listReads()).toHaveLength(1)
		expect(health.stats().failedMetadataReads).toBe(1)
	})

	it("a collection that does not exist has no indexes: unavailable, not an empty success", async () => {
		const missing = Object.assign(new Error("ns does not exist"), { code: 26 })
		const { source } = harness({
			listError: (collection) => (collection === CHUNKS ? missing : undefined),
		})
		const health = new RequestIndexHealth(source)

		await expect(
			health.assertHealthy(health.select(["chunks"])),
		).rejects.toMatchObject({ reason: "index-unavailable" })
		expect(health.stats().failedMetadataReads).toBe(0)
	})

	it("narrows to the vector index when only vector entries are selected", async () => {
		const { source, indexes } = harness()
		replace(indexes, CHUNKS, CHUNKS_TEXT, { status: "STALE" })
		const health = new RequestIndexHealth(source)

		await expect(
			health.assertHealthy(health.select(["chunks"], ["vectorSearch"])),
		).resolves.toBeUndefined()
		await expect(
			health.assertHealthy(health.select(["chunks"], ["search"])),
		).rejects.toMatchObject({ reason: "index-stale" })
	})
})

describe("request scope", () => {
	it("a later request reads fresh metadata and recovers on a healthy check", async () => {
		const { source, indexes, listReads } = harness()
		replace(indexes, CHUNKS, CHUNKS_VECTOR, { status: "STALE" })

		await expect(
			runWithIndexHealth(source, () =>
				assertLaneIndexesHealthy("hybrid:chunks"),
			),
		).rejects.toMatchObject({ reason: "index-stale" })

		replace(indexes, CHUNKS, CHUNKS_VECTOR, { status: "READY" })
		await expect(
			runWithIndexHealth(source, () =>
				assertLaneIndexesHealthy("hybrid:chunks"),
			),
		).resolves.toBeUndefined()

		expect(listReads()).toHaveLength(2)
	})

	it("nested passes share their parent's snapshot instead of taking a new one", async () => {
		const { source, indexes, listReads } = harness()

		await runWithIndexHealth(source, async () => {
			const outer = activeIndexHealth()
			await assertLaneIndexesHealthy("hybrid:chunks")
			// The index degrades mid-request: the request keeps its admission-time view.
			replace(indexes, CHUNKS, CHUNKS_VECTOR, { status: "STALE" })
			await runWithIndexHealth(source, async () => {
				expect(activeIndexHealth()).toBe(outer)
				await assertLaneIndexesHealthy("hybrid:chunks")
			})
		})

		expect(listReads()).toHaveLength(1)
		expect(activeIndexHealth()).toBeUndefined()
	})

	it("concurrent requests do not share a snapshot", async () => {
		const { source, indexes } = harness()
		replace(indexes, CHUNKS, CHUNKS_VECTOR, { status: "STALE" })

		const [stale, healthy] = await Promise.all([
			runWithIndexHealth(source, () =>
				assertLaneIndexesHealthy("hybrid:chunks").catch((err: unknown) => err),
			),
			runWithIndexHealth(
				{
					...source,
					manifest: MANIFEST.filter((e) => e.name !== CHUNKS_VECTOR),
				},
				() => assertLaneIndexesHealthy("hybrid:chunks").then(() => "ok"),
			),
		])

		expect(stale).toMatchObject({ reason: "index-stale" })
		expect(healthy).toBe("ok")
	})

	it("outside a request scope there is nothing to check (an unmanaged caller)", async () => {
		await expect(
			assertLaneIndexesHealthy("hybrid:chunks"),
		).resolves.toBeUndefined()
		await expect(
			assertCollectionIndexesHealthy(["chunks"]),
		).resolves.toBeUndefined()
	})

	it("a lane that uses no Search index is not gated", async () => {
		const { source, listReads } = harness()
		await runWithIndexHealth(source, () =>
			assertLaneIndexesHealthy("raw-window"),
		)
		expect(listReads()).toHaveLength(0)
	})

	it("hybrid vector-only mode needs only the vector index", async () => {
		const { source, indexes } = harness()
		replace(indexes, CHUNKS, CHUNKS_TEXT, null)

		await expect(
			runWithIndexHealth(source, () =>
				assertLaneIndexesHealthy("hybrid:chunks", { vectorOnly: true }),
			),
		).resolves.toBeUndefined()
		await expect(
			runWithIndexHealth(source, () =>
				assertLaneIndexesHealthy("hybrid:chunks"),
			),
		).rejects.toMatchObject({ reason: "index-unavailable" })
	})

	it("assertCollectionIndexesHealthy gates the named collections", async () => {
		const { source, indexes } = harness()
		replace(indexes, `${PREFIX}events`, `${PREFIX}events_vector`, {
			status: "FAILED",
			queryable: false,
		})

		await expect(
			runWithIndexHealth(source, () =>
				assertCollectionIndexesHealthy(["events"]),
			),
		).rejects.toMatchObject({
			reason: "index-unavailable",
			stage: "index-health",
		})
		await expect(
			runWithIndexHealth(source, () =>
				assertCollectionIndexesHealthy(["kb_chunks"]),
			),
		).resolves.toBeUndefined()
	})
})

describe("capabilitiesFromHealth", () => {
	it("carries the deployment facts and drops the boot health flags", () => {
		expect(FACTS).toEqual({
			scoreFusion: true,
			rankFusion: true,
			storedSource: true,
			vectorIndexMethod: true,
		})
	})

	it("reports vector, text and text-tier availability from this request's snapshot", async () => {
		const { source, indexes } = harness()
		replace(indexes, `${PREFIX}procedures`, `${PREFIX}procedures_text`, {
			status: "BUILDING",
			queryable: false,
		})

		const capabilities = await runWithIndexHealth(source, () =>
			capabilitiesFromHealth(activeIndexHealth()!),
		)

		expect(capabilities).toMatchObject({
			vectorSearch: true,
			textSearch: true,
			scoreFusion: true,
		})
		expect(capabilities.queryableSearchIndexes).toContain(
			`${PREFIX}structured_mem_text`,
		)
		expect(capabilities.queryableSearchIndexes).not.toContain(
			`${PREFIX}procedures_text`,
		)
	})

	it("an unhealthy chunks vector index is not vector capability, and recovers next request", async () => {
		const { source, indexes } = harness()
		replace(indexes, CHUNKS, CHUNKS_VECTOR, { status: "STALE" })

		const during = await runWithIndexHealth(source, () =>
			capabilitiesFromHealth(activeIndexHealth()!),
		)
		replace(indexes, CHUNKS, CHUNKS_VECTOR, { status: "READY" })
		const after = await runWithIndexHealth(source, () =>
			capabilitiesFromHealth(activeIndexHealth()!),
		)

		expect(during.vectorSearch).toBe(false)
		expect(during.textSearch).toBe(true)
		expect(after.vectorSearch).toBe(true)
	})
})
