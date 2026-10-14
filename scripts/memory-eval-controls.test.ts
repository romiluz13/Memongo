import type { MemongoClient } from "@memongo/client"
import { describe, expect, it } from "vitest"

import { buildPhase6MemoryEvalFixture } from "../packages/memory-engine/src/test-helpers/memory-eval-fixtures.js"
import {
	compareEvalRuns,
	evaluateSearchDetailedCase,
	runMemoryEvalSuite,
	summarizeEvalRun,
} from "./memory-eval-core.js"

const abstentionCase = {
	id: "no-scope-leak-red-kite",
	title: "abstention",
	kind: "search-detailed" as const,
	tags: ["scope-isolation", "abstention"],
	request: { agentId: "owner", query: "Red Kite codeword?" },
	expect: { expectNoResults: true, requireNoDirectEvidenceReason: true },
}

const emptyMetadata = {
	evidenceCoverage: "none",
	noDirectEvidenceReason: "no matching evidence",
}

function fakeClient(
	searchDetailed: (request: { query?: string; agentId?: string }) => unknown,
	contextBundle: unknown = { sections: [], metadata: {} },
): MemongoClient {
	return {
		writeEvent: async () => ({ ok: true }),
		writeStructured: async () => ({ id: "x" }),
		writeProcedure: async () => ({ id: "x" }),
		searchDetailed: async (request: { query?: string; agentId?: string }) =>
			searchDetailed(request),
		hydrateActiveSlate: async () => ({ items: [] }),
		buildDiscoveryProjection: async () => ({ sections: [] }),
		buildContextBundle: async () => contextBundle,
	} as unknown as MemongoClient
}

describe("memory-eval negative-evidence health", () => {
	it("fails abstention when the search was throttled even with a reason string", () => {
		const result = evaluateSearchDetailedCase(
			abstentionCase,
			{
				results: [],
				metadata: { ...emptyMetadata, throttled: { retryAfterMs: 500 } },
			} as never,
			5,
		)
		expect(result.ok).toBe(false)
		expect(result.metrics.abstentionSuccess).toBe(false)
		expect(result.failures.join(" ")).toMatch(/throttled/)
	})

	it("fails abstention when the client attached any degradation marker", () => {
		const result = evaluateSearchDetailedCase(
			abstentionCase,
			{
				results: [],
				metadata: emptyMetadata,
				degradation: { kind: "unavailable", status: 500 },
			} as never,
			5,
		)
		expect(result.ok).toBe(false)
		expect(result.failures.join(" ")).toMatch(/degrad/)
	})

	it("keeps a healthy empty abstention passing on its own observations", () => {
		const result = evaluateSearchDetailedCase(
			abstentionCase,
			{ results: [], metadata: emptyMetadata } as never,
			5,
		)
		expect(result.ok).toBe(true)
	})
})

describe("memory-eval run verdict controls", () => {
	it("no-op backend fails positive controls, abstention and the run verdict", async () => {
		const run = await runMemoryEvalSuite({
			client: fakeClient(() => ({ results: [], metadata: emptyMetadata })),
			label: "noop",
			seed: "noop",
		})
		expect(run.ok).toBe(false)
		const abstention = run.cases.find(
			(entry) => entry.id === "no-scope-leak-red-kite",
		)
		expect(abstention?.ok).toBe(false)
		expect(abstention?.failures.join(" ")).toMatch(/positive control/)
		expect(run.summary.abstentionSuccesses).toBe(0)
	})

	it("stale expected value fails the update check", () => {
		const fixture = buildPhase6MemoryEvalFixture("stale")
		const staleCase = fixture.cases.find(
			(entry) => entry.id === "current-release-window",
		)
		if (staleCase?.kind !== "search-detailed") throw new Error("fixture")
		const result = evaluateSearchDetailedCase(
			staleCase,
			{
				results: [
					{
						path: "structured:decision:release-window",
						snippet: "Phoenix release window is Monday, previously Friday.",
					},
				],
				metadata: {
					evidenceCoverage: "direct",
					trustSummary: { topConfidence: "high" },
				},
			} as never,
			5,
		)
		expect(result.ok).toBe(false)
		expect(result.metrics.staleFailure).toBe(true)
		expect(result.metrics.scopeLeak).toBe(false)
	})

	it("wrong-tenant sentinel fails isolation and counts as an observed leak", () => {
		const fixture = buildPhase6MemoryEvalFixture("tenant")
		const isolation = fixture.cases.find(
			(entry) => entry.id === "session-owner-isolation",
		)
		if (isolation?.kind !== "search-detailed") throw new Error("fixture")
		const result = evaluateSearchDetailedCase(
			isolation,
			{
				results: [
					{ path: "events/a", snippet: "Marcus owns the rollback." },
					{ path: "events/b", snippet: "Sarah owns the rollback." },
				],
				metadata: { evidenceCoverage: "direct" },
			} as never,
			5,
		)
		expect(result.ok).toBe(false)
		expect(result.metrics.scopeLeak).toBe(true)
	})

	it("a missing positive answer is a failure but not an observed scope leak", () => {
		const fixture = buildPhase6MemoryEvalFixture("tenant")
		const isolation = fixture.cases.find(
			(entry) => entry.id === "session-owner-isolation",
		)
		if (isolation?.kind !== "search-detailed") throw new Error("fixture")
		const result = evaluateSearchDetailedCase(
			isolation,
			{ results: [], metadata: { evidenceCoverage: "none" } } as never,
			5,
		)
		expect(result.ok).toBe(false)
		expect(result.metrics.scopeLeak).toBe(false)
	})

	it("abstention passes only alongside a passing same-agent positive control", async () => {
		const fixture = buildPhase6MemoryEvalFixture("owner")
		const run = await runMemoryEvalSuite({
			client: fakeClient((request) =>
				request.agentId === fixture.secondaryAgentId
					? {
							results: [
								{ path: "events/f", snippet: "The codeword is Red Kite." },
							],
							metadata: { evidenceCoverage: "direct" },
						}
					: /release window/i.test(request.query ?? "")
						? {
								results: [
									{
										path: "structured:decision:release-window",
										snippet: "Phoenix release window is Monday.",
									},
								],
								metadata: {
									evidenceCoverage: "direct",
									trustSummary: { topConfidence: "high" },
								},
							}
						: { results: [], metadata: emptyMetadata },
			),
			label: "owner",
			fixture,
		})
		const positive = run.cases.find(
			(entry) => entry.id === "current-release-window",
		)
		const abstention = run.cases.find(
			(entry) => entry.id === "no-scope-leak-red-kite",
		)
		expect(positive?.ok).toBe(true)
		expect(abstention?.ok).toBe(true)
		expect(run.ok).toBe(false)
	})

	it("context bundle counts a leak only when disallowed text is observed", async () => {
		const empty = await runMemoryEvalSuite({
			client: fakeClient(() => ({ results: [], metadata: emptyMetadata })),
			label: "bundle-empty",
			seed: "bundle",
		})
		const emptyBundle = empty.cases.find(
			(entry) => entry.id === "context-bundle-handoff",
		)
		expect(emptyBundle?.ok).toBe(false)
		expect(emptyBundle?.metrics.scopeLeak).toBe(false)
		expect(emptyBundle?.metrics.staleFailure).toBe(false)

		const leaked = await runMemoryEvalSuite({
			client: fakeClient(() => ({ results: [], metadata: emptyMetadata }), {
				rendered: "Sarah owns the rollback.",
				sections: [],
				metadata: {},
			}),
			label: "bundle-leak",
			seed: "bundle",
		})
		const leakedBundle = leaked.cases.find(
			(entry) => entry.id === "context-bundle-handoff",
		)
		expect(leakedBundle?.metrics.scopeLeak).toBe(true)
	})

	it("abstention fails when the foreign sentinel was never retrievable by its owner", async () => {
		const fixture = buildPhase6MemoryEvalFixture("sentinel")
		const run = await runMemoryEvalSuite({
			client: fakeClient((request) =>
				/release window/i.test(request.query ?? "")
					? {
							results: [
								{
									path: "structured:decision:release-window",
									snippet: "Phoenix release window is Monday.",
								},
							],
							metadata: {
								evidenceCoverage: "direct",
								trustSummary: { topConfidence: "high" },
							},
						}
					: { results: [], metadata: emptyMetadata },
			),
			label: "sentinel",
			fixture,
		})
		const foreignOwner = run.cases.find(
			(entry) => entry.id === "foreign-owner-red-kite",
		)
		const abstention = run.cases.find(
			(entry) => entry.id === "no-scope-leak-red-kite",
		)
		expect(foreignOwner?.ok).toBe(false)
		expect(abstention?.ok).toBe(false)
		expect(abstention?.failures.join(" ")).toMatch(/foreign-owner-red-kite/)
	})
})

describe("memory-eval comparison gate", () => {
	const passing = {
		id: "p",
		ok: true,
		score: 1,
		failures: [],
		metrics: {
			latencyMs: 10,
			scopeLeak: false,
			staleFailure: false,
			abstentionSuccess: false,
			evidenceCoverage: "direct" as const,
			topConfidence: "high" as const,
			exactEvidence: true,
		},
	}
	const failing = { ...passing, ok: false, score: 0, failures: ["x"] }

	it("empty runs never establish release readiness", () => {
		const empty = summarizeEvalRun({ label: "empty", cases: [] })
		expect(
			compareEvalRuns({ baseline: empty, candidate: empty }).summary
				.releaseReady,
		).toBe(false)
	})

	it("equally failing runs never establish release readiness", () => {
		const bad = summarizeEvalRun({ label: "bad", cases: [failing, failing] })
		expect(
			compareEvalRuns({ baseline: bad, candidate: bad }).summary.releaseReady,
		).toBe(false)
	})

	it("a fully passing candidate against a passing baseline is release ready", () => {
		const good = summarizeEvalRun({ label: "good", cases: [passing, passing] })
		expect(
			compareEvalRuns({ baseline: good, candidate: good }).summary.releaseReady,
		).toBe(true)
	})
})
