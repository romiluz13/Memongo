import type { Db } from "mongodb"
import { redactSensitiveText } from "@memongo/lib"
import { describe, expect, it, vi } from "vitest"
import { planRetrieval } from "./mongodb-retrieval-planner.js"
import { searchV2 } from "./mongodb-search-v2.js"
import { queryFailureMeta } from "./query-diagnostics.js"

// The searchV2 catch-seam test needs lane coverage to load (a failed read
// is swallowed by design) with a poisoned lastUpdated so the plan call
// throws inside the funnel's outer try.
vi.mock("./mongodb-lane-coverage.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-lane-coverage.js")>()),
	getLaneCoverage: vi.fn(),
}))

describe("queryFailureMeta (C-002: raw query text never enters diagnostics)", () => {
	it("never includes the raw query text", () => {
		const query = "the launch code is azure-spoon-77"
		const meta = queryFailureMeta(query, new Error("boom"))

		expect(JSON.stringify(meta)).not.toContain("azure-spoon-77")
		expect(meta.queryLength).toBe(query.length)
	})

	it("produces a stable, correlatable digest", () => {
		const a = queryFailureMeta("same query", new Error("x"))
		const b = queryFailureMeta("same query", new Error("y"))
		const c = queryFailureMeta("other query", new Error("x"))

		expect(a.queryDigest).toBe(b.queryDigest)
		expect(a.queryDigest).not.toBe(c.queryDigest)
		expect(a.queryDigest).toMatch(/^[0-9a-f]{12}$/)
	})

	it("redacts credential-bearing error chains", () => {
		const meta = queryFailureMeta(
			"q",
			new Error(
				[
					"failed to reach ",
					"mongodb://svc:",
					"dummy-cred-000@",
					"host.example.net:27017",
				].join(""),
			),
		)

		expect(meta.error).toContain("failed to reach")
		expect(meta.error).not.toContain("dummy-cred-000")
		expect(meta.error).toContain("***")
	})

	it("replaces a downstream error that echoes the query verbatim", () => {
		const query = "SEARCH-NEEDLE-xyzzy SELECT secret"
		const meta = queryFailureMeta(query, new Error(`command failed: ${query}`))

		expect(meta.error).not.toContain("SEARCH-NEEDLE")
		expect(meta.error).not.toContain("SELECT secret")
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
		expect(meta.error).toContain("command failed:")
	})

	it("replaces the echo even after credential redaction altered it", () => {
		const query = [
			"connect via ",
			"mongodb+srv://us",
			"er:dummy00000000@",
			"host.local/db please",
		].join("")
		const meta = queryFailureMeta(query, new Error(`lookup failed: ${query}`))

		// formatErrorMessage redacts the credential inside the echo first;
		// the redacted variant of the query must still be fully replaced.
		expect(meta.error).not.toContain("dummy00000000")
		expect(meta.error).not.toContain("connect via")
		expect(meta.error).not.toContain(redactSensitiveText(query))
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
	})

	it("leaves short fragments intact to avoid mangling log detail", () => {
		const meta = queryFailureMeta("ab", new Error("ab failed"))

		expect(meta.error).toBe("ab failed")
	})
})

// C-002 round-2 refutation: echoes of the query that are not byte-identical
// (case-folded, whitespace-mangled, split with separators, truncated, or
// middle fragments) previously survived redactQueryEcho's exact-match pass.
// These tests pin the variant-tolerant word-window matching.
describe("queryFailureMeta echo variants (C-002 round 2)", () => {
	it("replaces a case-folded echo of the query", () => {
		const query = "Deploy the Cluster NOW please"
		const meta = queryFailureMeta(
			query,
			new Error(`command failed: deploy the cluster now please`),
		)

		expect(meta.error).not.toContain("deploy the cluster")
		expect(meta.error).not.toContain("cluster now")
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
		expect(meta.error).toContain("command failed:")
	})

	it("replaces a whitespace-mangled echo of the query", () => {
		const query = "rotate the credentials next quarter"
		const meta = queryFailureMeta(
			query,
			new Error(`lookup failed: rotate\tthe\ncredentials  next   quarter`),
		)

		expect(meta.error).not.toContain("rotate")
		expect(meta.error).not.toContain("next   quarter")
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
	})

	it("replaces a query echo split with separator junk", () => {
		const query = "reindex the vector store overnight"
		const meta = queryFailureMeta(
			query,
			new Error(`plan failed: reindex 'the vector' store -- overnight`),
		)

		expect(meta.error).not.toContain("reindex")
		expect(meta.error).not.toContain("vector")
		expect(meta.error).not.toContain("overnight")
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
	})

	it("replaces a truncated echo of the query prefix", () => {
		const query = "purge the orphaned episodes before friday"
		const meta = queryFailureMeta(
			query,
			new Error(`command failed: purge the orphaned`),
		)

		expect(meta.error).not.toContain("purge the orphaned")
		expect(meta.error).not.toContain("the orphaned")
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
	})

	it("replaces a middle fragment echo of the query", () => {
		const query = "summarize the incident channel for the oncall"
		const meta = queryFailureMeta(
			query,
			new Error(`while reading: the incident channel for the`),
		)

		expect(meta.error).not.toContain("incident channel")
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
		expect(meta.error).toContain("while reading:")
	})

	it("replaces an echo of a long single-word query", () => {
		const query = "dummy-project-name-0000"
		const meta = queryFailureMeta(
			query,
			new Error("resolver failed for dummy-project-name-0000 at stage 2"),
		)

		expect(meta.error).not.toContain("dummy-project-name-0000")
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
		expect(meta.error).toContain("at stage 2")
	})

	it("replaces a mid-word fragment of a long single-word query (C-002 round 3)", () => {
		// Round-3 refutation payload: the echo truncates INSIDE the query
		// word, so no complete word from the query appears in the error —
		// window matching alone let the fragment through.
		const query = "dummyprojectname0000000"
		const meta = queryFailureMeta(
			query,
			new Error("resolver failed for dummyprojectname000 at stage 2"),
		)

		expect(meta.error).not.toContain("dummyprojectname000")
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
		expect(meta.error).toContain("at stage 2")
	})

	it("replaces a re-segmented fragment of a long query word (C-002 round 3)", () => {
		const query = "rotate the serviceaccount credentials soon"
		const meta = queryFailureMeta(
			query,
			new Error("auth rejected for x-serviceaccount-credentials-y"),
		)

		expect(meta.error).not.toContain("serviceaccount-credentials")
		expect(meta.error).toContain(`[query:${meta.queryDigest}]`)
	})

	it("replaces a four-character full-query echo (exact-pass floor)", () => {
		const meta = queryFailureMeta("abcd", new Error("failed at abcd stage"))

		expect(meta.error).toBe(`failed at [query:${meta.queryDigest}] stage`)
	})

	it("does not scrub ordinary two-word collisions from unrelated detail", () => {
		const query = "how do i reset the deployment"
		const meta = queryFailureMeta(
			query,
			new Error("lane coverage expired: retry with a fresh plan"),
		)

		expect(meta.error).toBe("lane coverage expired: retry with a fresh plan")
	})
})

describe("planRetrieval failure diagnostics (C-002 catch seam)", () => {
	it("logs no raw query text when a lane probe fails with an echoing error", () => {
		const errorLine = vi.spyOn(console, "error").mockImplementation(() => {})
		const query = "SEARCH-NEEDLE-xyzzy recent changes"
		const boom = new Error(`lane probe failed: ${query}`)

		try {
			expect(() =>
				planRetrieval("SEARCH-NEEDLE-xyzzy recent changes", {
					availablePaths: new Set(["hybrid", "graph"]),
					laneCoverage: {
						graph: {
							hasData: true,
							count: 1,
							lastUpdated: {
								getTime: () => {
									throw boom
								},
							} as unknown as Date,
						},
					},
				}),
			).toThrow("lane probe failed")

			expect(errorLine).toHaveBeenCalledTimes(1)
			const logged = errorLine.mock.calls
				.map((args) => args.join(" "))
				.join("\n")
			expect(logged).toContain("planRetrieval failed")
			expect(logged).toMatch(/\[query:[0-9a-f]{12}\]/)
			expect(logged).not.toContain("SEARCH-NEEDLE")
		} finally {
			errorLine.mockRestore()
		}
	})
})

describe("searchV2 failure diagnostics (C-002 catch seam)", () => {
	it("logs no raw query text when the search funnel fails with an echoing error", async () => {
		const errorLine = vi.spyOn(console, "error").mockImplementation(() => {})
		const query = "SEARCH-NEEDLE-xyzzy recent numbers"
		const boom = new Error(`lane sweep failed: ${query}`)
		// Poison lane coverage so planRetrieval (called inside the funnel's
		// outer try) throws an error whose message echoes the query — the
		// rethrow reaches searchV2's catch seam, which must alias it, not
		// log it.
		const { getLaneCoverage } = await import("./mongodb-lane-coverage.js")
		vi.mocked(getLaneCoverage).mockResolvedValue({
			lanes: {
				graph: {
					hasData: true,
					count: 1,
					lastUpdated: {
						getTime: () => {
							throw boom
						},
					} as unknown as Date,
				},
			},
		})

		try {
			await expect(
				searchV2({} as unknown as Db, "memongo", query, "agent-1", {
					availablePaths: new Set(["hybrid", "graph"]),
				}),
			).rejects.toThrow("lane sweep failed")

			const logged = errorLine.mock.calls
				.map((args) => args.join(" "))
				.join("\n")
			expect(logged).toContain("searchV2 failed")
			expect(logged).toMatch(/\[query:[0-9a-f]{12}\]/)
			expect(logged).not.toContain("SEARCH-NEEDLE")
		} finally {
			vi.mocked(getLaneCoverage).mockRestore()
			errorLine.mockRestore()
		}
	})

	it("logs no raw query text when lane coverage itself fails (inner warn, C-002 round 3)", async () => {
		const warnLine = vi.spyOn(console, "warn").mockImplementation(() => {})
		const errorLine = vi.spyOn(console, "error").mockImplementation(() => {})
		const query = "SEARCH-NEEDLE-xyzzy coverage miss"
		// Round-3 refutation finding: the inner lane-coverage catch logged
		// the raw driver message — which can echo the query-bearing filter —
		// without passing the queryFailureMeta boundary.
		const { getLaneCoverage } = await import("./mongodb-lane-coverage.js")
		vi.mocked(getLaneCoverage).mockRejectedValue(
			new Error(`coverage read failed for filter text: ${query}`),
		)

		try {
			// The funnel swallows coverage failures (permissive fallback), so
			// the fake Db may fail further downstream — either way the inner
			// warn is the diagnostic under test.
			await searchV2({} as unknown as Db, "memongo", query, "agent-1", {
				availablePaths: new Set(["text"]),
			}).catch(() => {})
			const logged = warnLine.mock.calls
				.map((args) => args.join(" "))
				.join("\n")
			expect(logged).toContain("Failed to load lane coverage")
			expect(logged).toMatch(/\[query:[0-9a-f]{12}\]/)
			expect(logged).not.toContain("SEARCH-NEEDLE")
			const outerLogged = errorLine.mock.calls
				.map((args) => args.join(" "))
				.join("\n")
			expect(outerLogged).not.toContain("SEARCH-NEEDLE")
		} finally {
			vi.mocked(getLaneCoverage).mockRestore()
			warnLine.mockRestore()
			errorLine.mockRestore()
		}
	})
})
