import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
	CLIENT_METHOD_DECISIONS,
	READ_ROWS,
	requiredCaseIds,
	TENANT_ROLES,
} from "./route-matrix.ts"

const CLIENT_SOURCE = readFileSync(
	new URL("../../packages/client/src/client.ts", import.meta.url),
	"utf8",
)

const TYPES_SOURCE = readFileSync(
	new URL("../../packages/client/src/types.ts", import.meta.url),
	"utf8",
)

function discoveryKinds(): string[] {
	const block = TYPES_SOURCE.split(
		"export type MemongoDiscoveryProjectionInput = {",
	)[1]
	const line =
		block
			?.split("\n")
			.find((candidate) => candidate.trim().startsWith("kind:")) ?? ""
	return [...line.matchAll(/"([a-z-]+)"/g)].map((match) => match[1] as string)
}

function clientMethods(): string[] {
	const names: string[] = []
	for (const line of CLIENT_SOURCE.split("\n")) {
		const match = /^\tasync (\w+)\(/.exec(line)
		if (match?.[1]) names.push(match[1])
	}
	return names
}

describe("route matrix inventory", () => {
	it("classifies every public client method: covered row, write, or an explicit coverage decision", () => {
		const methods = clientMethods()
		expect(methods.length).toBeGreaterThan(30)
		const covered = new Set(READ_ROWS.map((row) => row.clientMethod))
		const unclassified = methods.filter(
			(name) => !covered.has(name) && !(name in CLIENT_METHOD_DECISIONS),
		)
		expect(unclassified).toEqual([])
	})

	it("names no method that the client does not have", () => {
		const methods = new Set(clientMethods())
		const named = [
			...READ_ROWS.map((row) => row.clientMethod),
			...Object.keys(CLIENT_METHOD_DECISIONS),
		]
		expect(named.filter((name) => !methods.has(name))).toEqual([])
	})

	it("gives every non-write decision a reason", () => {
		for (const [name, decision] of Object.entries(CLIENT_METHOD_DECISIONS)) {
			expect(decision.reason.length, name).toBeGreaterThan(10)
		}
	})

	it("describes setup, control, extraction and post-erase expectation for every row", () => {
		const ids = new Set<string>()
		for (const row of READ_ROWS) {
			expect(ids.has(row.id), `duplicate ${row.id}`).toBe(false)
			ids.add(row.id)
			for (const field of [
				row.setup,
				row.control,
				row.extraction,
				row.postErase,
			]) {
				expect(field.length, row.id).toBeGreaterThan(10)
			}
			expect(row.partitions.length, row.id).toBeGreaterThan(0)
			if (row.coverage === "gap") {
				expect(row.gapReason?.length ?? 0, row.id).toBeGreaterThan(10)
			}
		}
	})

	it("lists the searchKB row as an explicit coverage gap because the API cannot seed KB content", () => {
		const kb = READ_ROWS.find((row) => row.clientMethod === "searchKB")
		expect(kb?.coverage).toBe("gap")
	})

	it("covers all four partitions across the matrix and declares agent-only routes", () => {
		const union = new Set(READ_ROWS.flatMap((row) => row.partitions))
		expect([...union].sort()).toEqual(["agent", "ref", "scope"])
		const agentOnly = READ_ROWS.filter(
			(row) => row.partitions.length === 1,
		).map((row) => row.id)
		expect(agentOnly).toEqual(["relevanceExplain"])
	})

	it("addresses readFile by agent, scope and scopeRef because its locator carries all three", () => {
		const readFile = READ_ROWS.find((row) => row.clientMethod === "readFile")
		expect(readFile?.partitions).toEqual(["agent", "scope", "ref"])
	})

	it("covers every discovery projection kind the client exposes, or declares it a gap with a reason", () => {
		const kinds = discoveryKinds()
		expect(kinds).toEqual([
			"entity-brief",
			"topic-brief",
			"what-changed",
			"contradiction-report",
		])
		for (const kind of kinds) {
			const row = READ_ROWS.find(
				(candidate) => candidate.id === `discovery:${kind}`,
			)
			expect(row, kind).toBeDefined()
			expect(row?.route).toBe("buildDiscoveryProjection")
			if (row?.coverage === "gap") {
				expect(row.gapReason?.length ?? 0, kind).toBeGreaterThan(30)
			}
		}
	})
})

describe("requiredCaseIds", () => {
	it("derives stable semantic ids for covered rows only, in both phases", () => {
		const ids = requiredCaseIds()
		expect(ids).toContain("A/search/reader=self/foreign=agent/pre-erase")
		expect(ids).toContain("A/search/reader=self/control/pre-erase")
		expect(ids).toContain("A/search/erased=self/post-erase")
		expect(ids).toContain("A/search/untouched=agent/control/post-erase")
		expect(ids.some((id) => id.includes("searchKB"))).toBe(false)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("requires the scope and scopeRef partitions of the readFile locator", () => {
		const ids = requiredCaseIds()
		for (const foreign of ["agent", "scope", "ref"]) {
			expect(ids).toContain(
				`A/readFile:structured-locator/reader=self/foreign=${foreign}/pre-erase`,
			)
		}
	})

	it("does not require partitions a route cannot express", () => {
		const ids = requiredCaseIds()
		expect(ids).toContain(
			"A/relevanceExplain/reader=self/foreign=agent/pre-erase",
		)
		expect(ids).not.toContain(
			"A/relevanceExplain/reader=self/foreign=scope/pre-erase",
		)
		expect(ids).not.toContain(
			"A/relevanceExplain/reader=self/foreign=ref/pre-erase",
		)
	})

	it("requires the covered discovery kinds and leaves the declared gap out", () => {
		const ids = requiredCaseIds()
		expect(ids).toContain(
			"A/discovery:entity-brief/reader=self/control/pre-erase",
		)
		expect(ids).toContain("A/discovery:what-changed/erased=self/post-erase")
		expect(ids.some((id) => id.includes("contradiction-report"))).toBe(false)
	})

	it("uses four tenant roles", () => {
		expect([...TENANT_ROLES]).toEqual(["self", "scope", "ref", "agent"])
	})
})
