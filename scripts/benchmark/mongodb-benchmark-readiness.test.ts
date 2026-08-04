import { describe, expect, test } from "vitest"
import {
	BENCHMARK_READINESS_FALLBACK,
	readSearchIndexStatus,
	type ReadSearchIndexStatusResult,
	type SearchIndexStatus,
} from "./mongodb-benchmark-readiness.js"

/**
 * Fake Db shim matching Pick<Db, "collection">. Each fake collection exposes
 * just the aggregate().toArray() path used by readSearchIndexStatus. No real
 * MongoDB connection is involved.
 */
function fakeDb(params: {
	// biome-ignore lint/suspicious/noExplicitAny: test shim needs loose typing
	aggregate: () => any
}): Parameters<typeof readSearchIndexStatus>[0] {
	const collection = () => ({ aggregate: params.aggregate })
	return { collection } as Parameters<typeof readSearchIndexStatus>[0]
}

describe("readSearchIndexStatus (Task 1.5)", () => {
	test("returns READY + queryable=true when listSearchIndexes reports a ready index", async () => {
		const db = fakeDb({
			aggregate: () => ({
				toArray: async () => [
					{ name: "events_text", status: "READY", queryable: true },
				],
			}),
		})
		const out = await readSearchIndexStatus(db, "events", "events_text")
		expect(out).toEqual<ReadSearchIndexStatusResult>({
			kind: "ok",
			status: "READY",
			queryable: true,
			indexName: "events_text",
		})
	})

	test("returns STALE + queryable flag when index is STALE", async () => {
		const db = fakeDb({
			aggregate: () => ({
				toArray: async () => [
					{ name: "events_text", status: "STALE", queryable: true },
				],
			}),
		})
		const out = await readSearchIndexStatus(db, "events", "events_text")
		expect(out).toEqual<ReadSearchIndexStatusResult>({
			kind: "ok",
			status: "STALE",
			queryable: true,
			indexName: "events_text",
		})
	})

	test("returns BUILDING + queryable=false during an index rebuild", async () => {
		const db = fakeDb({
			aggregate: () => ({
				toArray: async () => [
					{ name: "events_text", status: "BUILDING", queryable: false },
				],
			}),
		})
		const out = await readSearchIndexStatus(db, "events", "events_text")
		expect(out).toEqual<ReadSearchIndexStatusResult>({
			kind: "ok",
			status: "BUILDING",
			queryable: false,
			indexName: "events_text",
		})
	})

	test("returns DOES_NOT_EXIST when no matching index is reported", async () => {
		const db = fakeDb({
			aggregate: () => ({ toArray: async () => [] }),
		})
		const out = await readSearchIndexStatus(db, "events", "events_text")
		expect(out).toEqual<ReadSearchIndexStatusResult>({
			kind: "ok",
			status: "DOES_NOT_EXIST",
			queryable: false,
			indexName: "events_text",
		})
	})

	test("returns fallback when server rejects listSearchIndexes", async () => {
		const db = fakeDb({
			aggregate: () => {
				throw new Error("command listSearchIndexes not found")
			},
		})
		const out = await readSearchIndexStatus(db, "events", "events_text")
		expect(out.kind).toBe("fallback")
		if (out.kind === "fallback") {
			expect(out.reason).toBe("command-not-found")
		}
	})

	test("returns fallback when toArray rejects with unsupported error", async () => {
		const db = fakeDb({
			aggregate: () => ({
				toArray: async () => {
					throw new Error("$listSearchIndexes is not supported on this server")
				},
			}),
		})
		const out = await readSearchIndexStatus(db, "events", "events_text")
		expect(out.kind).toBe("fallback")
		if (out.kind === "fallback") {
			expect(out.reason).toBe("unsupported")
		}
	})

	test("BENCHMARK_READINESS_FALLBACK symbol is exported and stable", () => {
		expect(typeof BENCHMARK_READINESS_FALLBACK).toBe("symbol")
		expect(BENCHMARK_READINESS_FALLBACK.toString()).toContain(
			"benchmark-readiness-fallback",
		)
	})

	test("SearchIndexStatus type admits the 7 uppercase states", () => {
		// Compile-time assertion only; runtime check keeps the list in sync.
		const states: SearchIndexStatus[] = [
			"PENDING",
			"BUILDING",
			"READY",
			"STALE",
			"FAILED",
			"DELETING",
			"DOES_NOT_EXIST",
		]
		expect(states).toHaveLength(7)
	})

	test("prefers the named index when multiple are returned", async () => {
		const db = fakeDb({
			aggregate: () => ({
				toArray: async () => [
					{ name: "other_text", status: "READY", queryable: true },
					{ name: "events_text", status: "BUILDING", queryable: false },
				],
			}),
		})
		const out = await readSearchIndexStatus(db, "events", "events_text")
		expect(out.kind).toBe("ok")
		if (out.kind === "ok") {
			expect(out.indexName).toBe("events_text")
			expect(out.status).toBe("BUILDING")
			expect(out.queryable).toBe(false)
		}
	})

	test("normalizes lowercase status strings to uppercase (defensive)", async () => {
		const db = fakeDb({
			aggregate: () => ({
				toArray: async () => [
					{ name: "events_text", status: "ready", queryable: true },
				],
			}),
		})
		const out = await readSearchIndexStatus(db, "events", "events_text")
		expect(out.kind).toBe("ok")
		if (out.kind === "ok") {
			expect(out.status).toBe("READY")
		}
	})
})
