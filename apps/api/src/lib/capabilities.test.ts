import { MemongoBootError } from "@memongo/memory-bridge"
import { describe, expect, it, vi } from "vitest"
import {
	bootOrRefuse,
	deriveSearchLanes,
	formatBootFailure,
	formatCapabilityTable,
	formatPreflightReport,
} from "./capabilities.js"

// Connection strings are assembled at runtime so no literal credential-bearing
// URI ever appears in the repo (and to keep secret scanners out of the diff).
const mongoUri = (password: string) =>
	["mongodb://probe-user:", password, "@mongo.internal:27017/memongo"].join("")

const fullCaps = {
	vectorSearch: true,
	textSearch: true,
	scoreFusion: true,
	rankFusion: true,
	storedSource: false,
	vectorIndexMethod: false,
}

class ExitCalled extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`)
	}
}

function refusalDeps() {
	const log = vi.fn()
	const error = vi.fn()
	const exit = vi.fn((code: number): never => {
		throw new ExitCalled(code)
	})
	return { log, error, exit }
}

describe("deriveSearchLanes", () => {
	it("reports every lane on a Search deployment", () => {
		expect(deriveSearchLanes(fullCaps)).toEqual({
			hybrid: true,
			vector: true,
			keyword: true,
		})
	})

	it("hybrid requires both retrieval legs", () => {
		const lanes = deriveSearchLanes({ ...fullCaps, textSearch: false })
		expect(lanes.vector).toBe(true)
		expect(lanes.hybrid).toBe(false)
	})

	it("has no classic $text lane", () => {
		expect(Object.keys(deriveSearchLanes(fullCaps))).not.toContain("text")
		expect(formatCapabilityTable(deriveSearchLanes(fullCaps))).not.toContain(
			"$text",
		)
	})
})

describe("bootOrRefuse (X-06: the API never warns and serves)", () => {
	it("logs the lanes and returns them when the startup contract passes", async () => {
		const deps = refusalDeps()
		const lanes = await bootOrRefuse(async () => fullCaps, deps)
		expect(lanes).toEqual({ hybrid: true, vector: true, keyword: true })
		expect(deps.log).toHaveBeenCalledWith(
			expect.stringContaining("hybrid:  available"),
		)
		expect(deps.exit).not.toHaveBeenCalled()
	})

	it("refuses to serve on a typed boot failure, naming the code and index", async () => {
		const deps = refusalDeps()
		const failure = new MemongoBootError(
			{
				code: "index-stale",
				requirement: "a READY index",
				index: "memongo_chunks_vector",
				collection: "memongo_chunks",
				status: "STALE",
			},
			"boot refused: memongo_chunks_vector (memongo_chunks) is STALE",
		)
		await expect(
			bootOrRefuse(async () => {
				throw failure
			}, deps),
		).rejects.toThrow(ExitCalled)
		expect(deps.exit).toHaveBeenCalledExactlyOnceWith(1)
		expect(deps.log).not.toHaveBeenCalled()
		const message = deps.error.mock.calls[0]?.[0] as string
		expect(message).toContain("boot failure index-stale")
		expect(message).toContain("memongo_chunks_vector")
	})

	it("refuses to serve on an untyped failure too, with no credential in the line", async () => {
		const deps = refusalDeps()
		await expect(
			bootOrRefuse(async () => {
				throw new Error(`connect failed for ${mongoUri("dummy-cred-00000000")}`)
			}, deps),
		).rejects.toThrow(ExitCalled)
		expect(deps.exit).toHaveBeenCalledExactlyOnceWith(1)
		const message = deps.error.mock.calls[0]?.[0] as string
		expect(message).toContain("refused to start")
		expect(message).not.toContain("dummy-cred-00000000")
	})
})

describe("formatBootFailure", () => {
	it("redacts a credential-bearing typed failure message", () => {
		const failure = new MemongoBootError(
			{ code: "search-management-unavailable", requirement: "Search" },
			`boot refused: ${mongoUri("dummy-cred-11111111")} has no Search`,
		)
		expect(formatBootFailure(failure)).not.toContain("dummy-cred-11111111")
	})
})

describe("boot output carries no URI, host, database or secret (F5)", () => {
	const SECRET = "dummy-cred-22222222"
	const URI = mongoUri(SECRET).replace(
		"mongo.internal:27017/memongo",
		"private-host.example.net/tenant-db",
	)
	const FORBIDDEN = [
		SECRET,
		"private-host",
		"tenant-db",
		"mongodb://",
		"10.1.2.3",
	]

	function expectClean(text: string) {
		for (const forbidden of FORBIDDEN) expect(text).not.toContain(forbidden)
	}

	it("removes a whole URI from a typed boot failure line", () => {
		const failure = new MemongoBootError(
			{ code: "index-not-ready", requirement: "READY index", index: "idx" },
			`boot refused: connection to ${URI} failed`,
		)
		const line = formatBootFailure(failure)
		expectClean(line)
		expect(line).toContain("boot failure index-not-ready")
	})

	it("removes a URI, host and address from an untyped failure line", () => {
		const line = formatBootFailure(
			new Error(
				`failed to connect to MongoDB (${URI}): connect ECONNREFUSED 10.1.2.3:27017`,
			),
		)
		expectClean(line)
		expect(line).toContain("refused to start")
	})

	it("writes the refusal line to the error channel without a URI", async () => {
		const deps = refusalDeps()
		await expect(
			bootOrRefuse(async () => {
				throw new Error(`connect failed for ${URI}`)
			}, deps),
		).rejects.toThrow(ExitCalled)
		expectClean(deps.error.mock.calls.map((call) => call.join(" ")).join("\n"))
	})

	it("serializes the preflight report with every string rendered safe", () => {
		const report = {
			ok: false,
			serverVersion: "8.3.0",
			manifest: [{ collection: "c", index: "i", type: "search" }],
			unmet: [
				{
					code: "server-unreachable" as const,
					requirement: `reachable ${URI}`,
					collection: URI,
					message: `MongoDB is unreachable (${URI}) at 10.1.2.3:27017`,
					repairable: false,
				},
			],
		}
		const json = formatPreflightReport(report)
		expectClean(json)
		expect(JSON.parse(json)).toMatchObject({
			ok: false,
			serverVersion: "8.3.0",
			unmet: [{ code: "server-unreachable", repairable: false }],
		})
	})
})
