import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runBootPreflight } from "./mongodb-boot-preflight.js"
import { buildRequiredIndexManifest } from "./mongodb-required-index-manifest.js"
import {
	type FakeSearchIndex,
	createFakeSearchDb,
	embeddingQueries,
	readyIndex,
	writeCalls,
} from "./test-helpers/fake-search-db.js"

const PREFIX = "t_"
const ENV = {} as NodeJS.ProcessEnv
const manifest = buildRequiredIndexManifest({
	prefix: PREFIX,
	serverVersionArray: [8, 3, 0, 0],
	env: ENV,
})
const collections = [...new Set(manifest.map((entry) => entry.collectionName))]

function indexesExcept(
	patch: Record<string, FakeSearchIndex | null>,
): Record<string, FakeSearchIndex[]> {
	const byCollection: Record<string, FakeSearchIndex[]> = {}
	for (const entry of manifest) {
		const index =
			entry.name in patch
				? patch[entry.name]
				: readyIndex(entry.name, entry.type, entry.definition)
		if (!index) continue
		byCollection[entry.collectionName] = [
			...(byCollection[entry.collectionName] ?? []),
			index,
		]
	}
	return byCollection
}

const fetchSpy = vi.fn()
beforeEach(() => {
	fetchSpy.mockReset()
	vi.stubGlobal("fetch", fetchSpy)
})
afterEach(() => {
	vi.unstubAllGlobals()
})

describe("runBootPreflight", () => {
	it("reports ok and the manifest on a deployment that meets the contract", async () => {
		const { db, calls } = createFakeSearchDb({
			indexes: indexesExcept({}),
			existingCollections: collections,
		})
		const report = await runBootPreflight(db, {
			prefix: PREFIX,
			env: ENV,
			requiredCollections: collections,
		})
		expect(report.ok).toBe(true)
		expect(report.unmet).toEqual([])
		expect(report.serverVersion).toBe("8.3.0")
		expect(report.manifest).toContainEqual({
			collection: "t_chunks",
			index: "t_chunks_vector",
			type: "vectorSearch",
		})
		expect(writeCalls(calls)).toEqual([])
	})

	it("reports every unmet requirement in one pass and performs no write", async () => {
		const { db, calls } = createFakeSearchDb({
			versionArray: [8, 2, 6, 0],
			connectionStatus: {
				authInfo: {
					authenticatedUsers: [{ user: "reader", db: "admin" }],
					authenticatedUserPrivileges: [
						{
							resource: { db: "memongo_test", collection: "" },
							actions: ["listSearchIndexes"],
						},
					],
				},
			},
			indexes: indexesExcept({
				t_chunks_text: null,
				t_events_vector: {
					...readyIndex("t_events_vector", "vectorSearch", {}),
					status: "FAILED",
				},
				t_procedures_text: {
					...readyIndex("t_procedures_text", "search", {}),
					status: "STALE",
				},
				t_kb_chunks_text: {
					...readyIndex("t_kb_chunks_text", "search", {}),
					status: "BUILDING",
				},
			}),
			existingCollections: collections.filter(
				(name) => name !== "t_session_chunks",
			),
		})
		const report = await runBootPreflight(db, {
			prefix: PREFIX,
			env: ENV,
			requiredCollections: collections,
		})
		expect(report.ok).toBe(false)
		const codes = report.unmet.map((unmet) => unmet.code)
		expect(codes).toEqual(
			expect.arrayContaining([
				"server-version-unsupported",
				"search-privileges-denied",
				"collection-absent",
				"index-absent",
				"index-failed",
				"index-stale",
				"index-not-ready",
			]),
		)
		const absent = report.unmet.find((unmet) => unmet.code === "index-absent")
		expect(absent).toMatchObject({ index: "t_chunks_text", repairable: true })
		expect(
			report.unmet.find((unmet) => unmet.code === "index-failed"),
		).toMatchObject({ index: "t_events_vector", repairable: false })
		expect(writeCalls(calls)).toEqual([])
	})

	it("reports a deployment without Search and still writes nothing", async () => {
		const { db, calls } = createFakeSearchDb({
			listError: () =>
				Object.assign(
					new Error("Error connecting to Search Index Management service."),
					{ code: 125, codeName: "CommandFailed" },
				),
			existingCollections: collections,
		})
		const report = await runBootPreflight(db, { prefix: PREFIX, env: ENV })
		expect(report.ok).toBe(false)
		expect(report.unmet.map((unmet) => unmet.code)).toContain(
			"search-management-unavailable",
		)
		expect(writeCalls(calls)).toEqual([])
	})

	it("issues no $vectorSearch and no provider request", async () => {
		const { db, calls } = createFakeSearchDb({ indexes: indexesExcept({}) })
		await runBootPreflight(db, { prefix: PREFIX, env: ENV })
		expect(embeddingQueries(calls)).toEqual([])
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
