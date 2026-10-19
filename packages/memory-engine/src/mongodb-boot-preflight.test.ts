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

describe("runBootPreflight: every unmet requirement across collections (F6)", () => {
	const denied = () =>
		Object.assign(new Error("not authorized on memongo_test"), {
			code: 13,
			codeName: "Unauthorized",
		})

	it("reports a failed listing on one collection together with a missing and a STALE index on others", async () => {
		const { db, calls } = createFakeSearchDb({
			indexes: indexesExcept({
				t_events_text: null,
				t_procedures_text: {
					...readyIndex("t_procedures_text", "search", {}),
					status: "STALE",
				},
			}),
			listError: (collection) =>
				collection === "t_chunks" ? denied() : undefined,
		})
		const report = await runBootPreflight(db, { prefix: PREFIX, env: ENV })
		expect(report.ok).toBe(false)
		expect(
			report.unmet.map((unmet) => [unmet.code, unmet.collection, unmet.index]),
		).toEqual(
			expect.arrayContaining([
				["search-privileges-denied", "t_chunks", undefined],
				["index-absent", "t_events", "t_events_text"],
				["index-stale", "t_procedures", "t_procedures_text"],
			]),
		)
		expect(
			report.unmet.filter((unmet) => unmet.collection === "t_chunks"),
		).toHaveLength(1)
		expect(writeCalls(calls)).toEqual([])
	})

	it("does not call an unlisted collection's indexes absent", async () => {
		const { db } = createFakeSearchDb({
			indexes: {},
			listError: (collection) =>
				collection === "t_chunks" ? denied() : undefined,
		})
		const report = await runBootPreflight(db, { prefix: PREFIX, env: ENV })
		const chunkIndexNames = manifest
			.filter((entry) => entry.collectionName === "t_chunks")
			.map((entry) => entry.name)
		expect(chunkIndexNames.length).toBeGreaterThan(0)
		for (const name of chunkIndexNames) {
			expect(
				report.unmet.some(
					(unmet) => unmet.code === "index-absent" && unmet.index === name,
				),
			).toBe(false)
		}
		expect(
			report.unmet.some(
				(unmet) =>
					unmet.code === "index-absent" && unmet.index === "t_events_text",
			),
		).toBe(true)
	})

	it("reports one entry per collection whose listing failed", async () => {
		const { db } = createFakeSearchDb({
			indexes: indexesExcept({}),
			listError: (collection) =>
				collection === "t_chunks" || collection === "t_events"
					? denied()
					: undefined,
		})
		const report = await runBootPreflight(db, { prefix: PREFIX, env: ENV })
		expect(
			report.unmet
				.filter((unmet) => unmet.code === "search-privileges-denied")
				.map((unmet) => unmet.collection)
				.sort(),
		).toEqual(["t_chunks", "t_events"])
	})

	it("keeps the other checks when the version and privilege checks fail too", async () => {
		const { db } = createFakeSearchDb({
			versionArray: [8, 2, 6, 0],
			connectionStatusError: new Error("connectionStatus failed"),
			indexes: indexesExcept({ t_events_text: null }),
			listError: (collection) =>
				collection === "t_chunks" ? denied() : undefined,
		})
		const report = await runBootPreflight(db, { prefix: PREFIX, env: ENV })
		expect(report.unmet.map((unmet) => unmet.code)).toEqual(
			expect.arrayContaining([
				"server-version-unsupported",
				"index-metadata-unknown",
				"search-privileges-denied",
				"index-absent",
			]),
		)
	})
})

describe("runBootPreflight: the deadline bounds the checks", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("reports the expired deadline once, runs no further check and does not hang", async () => {
		vi.useFakeTimers()
		const { db, calls } = createFakeSearchDb({
			indexes: indexesExcept({}),
			before: (op) =>
				op.kind === "listSearchIndexes"
					? new Promise<void>(() => {})
					: undefined,
		})
		const pending = runBootPreflight(db, {
			prefix: PREFIX,
			env: ENV,
			deadlineMs: 5_000,
		})
		await vi.advanceTimersByTimeAsync(5_001)
		const report = await pending
		expect(report.ok).toBe(false)
		const expired = report.unmet.filter(
			(unmet) => unmet.code === "boot-deadline-exceeded",
		)
		expect(expired).toHaveLength(1)
		expect(expired[0].message).toContain("skipped")
		expect(calls.filter((call) => call.op === "aggregate")).toHaveLength(1)
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe("runBootPreflight: no URI, host, database or secret in the report (F5)", () => {
	const SECRET = "s3cr3t-pf"
	const URI = `mongodb+srv://pf-user:${SECRET}@private-host.example.net/tenant-db`
	const FORBIDDEN = [SECRET, "private-host", "tenant-db", "mongodb+srv://"]

	function hostile(text: string) {
		return Object.assign(new Error(text), {
			code: 6,
			codeName: "HostUnreachable",
		})
	}

	it("serializes a report free of every driver-supplied URI, host and database", async () => {
		const texts = [
			`connection to ${URI} failed`,
			"getaddrinfo ENOTFOUND private-host.example.net",
			`not authorized on tenant-db to execute command { uri: "${URI}" }`,
		]
		for (const text of texts) {
			const { db } = createFakeSearchDb({
				buildInfoError: hostile(text),
				connectionStatusError: hostile(text),
				listError: () => hostile(text),
			})
			const report = await runBootPreflight(db, {
				prefix: PREFIX,
				env: ENV,
				requiredCollections: collections,
			})
			expect(report.unmet.length).toBeGreaterThan(0)
			const json = JSON.stringify(report)
			for (const forbidden of FORBIDDEN) expect(json).not.toContain(forbidden)
		}
	})

	it("serializes a report free of a provider-reported host name and status", async () => {
		const { db } = createFakeSearchDb({
			indexes: indexesExcept({
				t_events_text: {
					...readyIndex("t_events_text", "search", {}),
					status: `ACTIVE-${URI}`,
				},
				t_chunks_text: {
					...readyIndex("t_chunks_text", "search", {}),
					statusDetail: [
						{
							hostname: "private-host.example.net:27017",
							status: "READY",
							queryable: true,
						},
					],
				},
			}),
		})
		const report = await runBootPreflight(db, { prefix: PREFIX, env: ENV })
		expect(report.unmet.length).toBeGreaterThan(0)
		const json = JSON.stringify(report)
		for (const forbidden of FORBIDDEN) expect(json).not.toContain(forbidden)
	})
})
