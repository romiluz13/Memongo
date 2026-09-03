import { describe, expect, it } from "vitest"
import {
	deriveSearchLanes,
	enforceRequiredVector,
	formatCapabilityTable,
	isRequireVectorEnabled,
	probeBootCapabilities,
} from "./capabilities.js"

// Connection strings are assembled at runtime so no literal credential-bearing
// URI ever appears in the repo (and to keep secret scanners out of the diff).
const mongoUri = (password: string) =>
	["mongodb://probe-user:", password, "@mongo.internal:27017/memongo"].join("")

describe("deriveSearchLanes", () => {
	it("maps bridge capabilities onto lanes", () => {
		expect(
			deriveSearchLanes({
				vectorSearch: true,
				textSearch: true,
				scoreFusion: true,
				rankFusion: true,
				storedSource: false,
				vectorIndexMethod: false,
			}),
		).toEqual({ hybrid: true, vector: true, keyword: true, text: true })
		expect(deriveSearchLanes(null)).toEqual({
			hybrid: false,
			vector: false,
			keyword: false,
			text: true,
		})
	})

	it("hybrid requires both retrieval legs", () => {
		const lanes = deriveSearchLanes({
			vectorSearch: true,
			textSearch: false,
			scoreFusion: false,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		})
		expect(lanes.vector).toBe(true)
		expect(lanes.hybrid).toBe(false)
	})
})

describe("formatCapabilityTable", () => {
	it("reports all-lane availability without a probe error line", () => {
		const table = formatCapabilityTable({
			hybrid: true,
			vector: true,
			keyword: true,
			text: true,
		})
		expect(table).toContain("all retrieval lanes available")
		expect(table).not.toContain("probe failed")
	})

	it("includes the probe failure detail when present", () => {
		const table = formatCapabilityTable(
			{ hybrid: false, vector: false, keyword: false, text: true },
			"index list failed",
		)
		expect(table).toContain("DEGRADED")
		expect(table).toContain("capability probe failed: index list failed")
	})

	it("redacts a credential-bearing probe error at the render boundary (C-002 round 3)", () => {
		// Round-3 refutation finding: a direct formatCapabilityTable call
		// with an unredacted probeError emitted the raw URI — the render
		// boundary, not just the boot chain, must be safe.
		const upstreamUri = [
			"mongodb://svc:",
			"dummy-cred-00000",
			"@mongo.internal:27017/db",
		].join("")
		const table = formatCapabilityTable(
			{ hybrid: false, vector: false, keyword: false, text: true },
			`probe failed: ${upstreamUri}`,
		)
		expect(table).not.toContain("dummy-cred-00000")
		expect(table).toContain(
			["mongodb:/", "/svc:***@", "mongo.internal:27017/db"].join(""),
		)
	})
})

describe("isRequireVectorEnabled", () => {
	it("accepts 1/true in any casing or padding", () => {
		expect(isRequireVectorEnabled("1")).toBe(true)
		expect(isRequireVectorEnabled(" True ")).toBe(true)
		expect(isRequireVectorEnabled("0")).toBe(false)
		expect(isRequireVectorEnabled(undefined)).toBe(false)
	})
})

describe("enforceRequiredVector", () => {
	it("passes when the vector lane is available", () => {
		expect(() =>
			enforceRequiredVector({
				hybrid: true,
				vector: true,
				keyword: true,
				text: true,
			}),
		).not.toThrow()
	})

	it("throws the boot refusal without a probe error", () => {
		expect(() =>
			enforceRequiredVector({
				hybrid: false,
				vector: false,
				keyword: false,
				text: true,
			}),
		).toThrow(/MEMONGO_REQUIRE_VECTOR/)
	})

	it("never embeds raw credentials from an unredacted probe report", () => {
		const rawProbeError = `connect failed for ${mongoUri("dummy-cred-00000000")}`
		try {
			enforceRequiredVector(
				{ hybrid: false, vector: false, keyword: false, text: true },
				rawProbeError,
			)
			expect.unreachable("enforceRequiredVector must throw")
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			expect(message).toContain("MEMONGO_REQUIRE_VECTOR")
			expect(message).not.toContain("dummy-cred-00000000")
			expect(message).toContain("***")
		}
	})
})

describe("probeBootCapabilities (C-002: probe diagnostics never carry credentials)", () => {
	it("derives lanes from a successful probe", async () => {
		const report = await probeBootCapabilities(async () => ({
			vectorSearch: true,
			textSearch: true,
			scoreFusion: true,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		}))
		expect(report.lanes).toEqual({
			hybrid: true,
			vector: true,
			keyword: true,
			text: true,
		})
		expect(report.probeError).toBeUndefined()
	})

	it("redacts credential-bearing probe failures at the origin", async () => {
		const report = await probeBootCapabilities(async () => {
			throw new Error(`connect failed for ${mongoUri("dummy-cred-00000000")}`)
		})

		expect(report.lanes.vector).toBe(false)
		expect(report.probeError).toBeDefined()
		expect(report.probeError).not.toContain("dummy-cred-00000000")
		expect(report.probeError).toContain("***")
	})

	it("keeps the redacted probe error out of the logged capability table", async () => {
		const report = await probeBootCapabilities(async () => {
			throw new Error(`connect failed for ${mongoUri("dummy-cred-00000000")}`)
		})
		const table = formatCapabilityTable(report.lanes, report.probeError)

		expect(table).not.toContain("dummy-cred-00000000")
		expect(table).toContain("capability probe failed:")
	})
})
