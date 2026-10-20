import { describe, expect, it } from "vitest"
import {
	bodyContains,
	bodyMarkers,
	containsMarker,
	findMarkers,
	rawContains,
} from "./markers.ts"
import type { Observation } from "./types.ts"

const MARKER = "zqmarker0001"

const response = (body: unknown): Observation => ({
	kind: "response",
	route: "searchDetailed",
	body,
})

describe("containsMarker looks only at returned content", () => {
	it("finds a marker in a returned result", () => {
		expect(
			containsMarker(
				response({ results: [{ snippet: `value ${MARKER}` }] }),
				MARKER,
			),
		).toBe(true)
	})

	it("does not find a marker that only an echoed pass query carries", () => {
		const echoed = response({
			results: [{ snippet: "something else" }],
			metadata: {
				passes: [{ pass: 1, query: `what is ${MARKER}`, resultCount: 1 }],
				queriesTried: [`what is ${MARKER}`],
				queryUsed: `what is ${MARKER}`,
			},
		})
		expect(containsMarker(echoed, MARKER)).toBe(false)
	})

	it("does not find a marker that only an echoed discovery or bundle query carries", () => {
		expect(
			containsMarker(
				response({ kind: "topic-brief", query: `about ${MARKER}`, items: [] }),
				MARKER,
			),
		).toBe(false)
	})

	it("still finds the marker in a result when the query echoes it too", () => {
		expect(
			containsMarker(
				response({
					results: [{ snippet: MARKER }],
					metadata: { passes: [{ query: MARKER }] },
				}),
				MARKER,
			),
		).toBe(true)
	})

	it("does not find a marker in an error message, a transport error or an outcomes descriptor", () => {
		const httpError: Observation = {
			kind: "http-error",
			route: "search",
			status: 400,
			message: `bad request for ${MARKER}`,
			outcomes: { note: MARKER },
		}
		const transport: Observation = {
			kind: "transport-error",
			route: "search",
			message: `failed ${MARKER}`,
		}
		expect(containsMarker(httpError, MARKER)).toBe(false)
		expect(containsMarker(transport, MARKER)).toBe(false)
	})

	it("refuses an empty or blank marker instead of matching everything", () => {
		const read = response({ results: [{ snippet: "anything" }] })
		for (const blank of ["", "   "]) {
			expect(() => containsMarker(read, blank)).toThrow(/marker/)
			expect(() => bodyContains({ a: "x" }, blank)).toThrow(/marker/)
			expect(() => rawContains({ a: "x" }, blank)).toThrow(/marker/)
			expect(() => findMarkers(read, { old: blank })).toThrow(/marker/)
			expect(() => bodyMarkers({ a: "x" }, { old: blank })).toThrow(/marker/)
		}
	})
})

describe("bodyContains and bodyMarkers", () => {
	it("skip echoed query fields on bodies and rows", () => {
		expect(bodyContains({ query: MARKER, rows: [] }, MARKER)).toBe(false)
		expect(bodyContains({ rows: [{ text: MARKER }] }, MARKER)).toBe(true)
		expect(
			bodyMarkers({ query: MARKER, rows: [{ text: "other" }] }, { m: MARKER }),
		).toEqual([])
		expect(bodyMarkers({ rows: [{ text: MARKER }] }, { m: MARKER })).toEqual([
			"m",
		])
	})

	it("keep every role that appears in returned content", () => {
		const read = response({ results: [{ snippet: "a zqa and zqb" }] })
		expect(findMarkers(read, { a: "zqa", b: "zqb", c: "zqc" })).toEqual([
			"a",
			"b",
		])
	})
})

describe("rawContains", () => {
	it("sees every string, including request fields and echoes", () => {
		expect(rawContains({ query: MARKER }, MARKER)).toBe(true)
		expect(rawContains({ nested: [{ deep: `x ${MARKER}` }] }, MARKER)).toBe(
			true,
		)
		expect(rawContains({ nested: "nothing" }, MARKER)).toBe(false)
	})
})
