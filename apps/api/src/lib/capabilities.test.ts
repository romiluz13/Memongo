import { MemongoBootError } from "@memongo/memory-bridge"
import { describe, expect, it, vi } from "vitest"
import {
	bootOrRefuse,
	deriveSearchLanes,
	formatBootFailure,
	formatCapabilityTable,
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
