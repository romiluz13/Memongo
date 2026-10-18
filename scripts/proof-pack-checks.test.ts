import { describe, expect, it } from "vitest"

import {
	evaluateBarrierWrite,
	evaluateSearch,
	evaluateSearchDetailed,
} from "./proof-pack-checks.js"

const marker = "proof-pack-1760000000000"
const agentScopeRef = "agent:proof-ci-1"

describe("evaluateSearch", () => {
	it("passes when a result in the agent partition carries the planted marker", () => {
		const verdict = evaluateSearch(
			[
				{
					path: `structured:preference:${marker}:preference?scope=agent&scopeRef=agent%3Aproof-ci-1`,
					snippet: "prefers concise status reports",
					source: "structured",
					scope: "agent",
					scopeRef: agentScopeRef,
				},
			],
			{ marker, scopeRef: agentScopeRef },
		)
		expect(verdict.ok).toBe(true)
	})

	it("fails on empty results", () => {
		const verdict = evaluateSearch([], { marker, scopeRef: agentScopeRef })
		expect(verdict).toEqual({
			ok: false,
			details: "search returned no results",
		})
	})

	it("fails when results come back without the planted marker", () => {
		const verdict = evaluateSearch(
			[
				{
					path: "structured:preference:other",
					snippet: "prefers concise status reports",
					scope: "agent",
					scopeRef: agentScopeRef,
				},
			],
			{ marker, scopeRef: agentScopeRef },
		)
		expect(verdict.ok).toBe(false)
		expect(verdict.details).toContain("planted marker not returned")
	})

	it("fails when the marker hit comes from another partition", () => {
		const verdict = evaluateSearch(
			[
				{
					path: "events/evt-1",
					snippet: `User: ${marker} user prefers concise updates`,
					source: "conversation",
					scope: "session",
					scopeRef: "session:proof-ci-session-1",
				},
			],
			{ marker, scopeRef: agentScopeRef },
		)
		expect(verdict.ok).toBe(false)
		expect(verdict.details).toContain("outside agent:proof-ci-1")
	})
})

describe("evaluateSearchDetailed", () => {
	const plantedEventIds = ["evt-user-1", "evt-add-1"]
	const plantedTurn = {
		path: "events/evt-user-1",
		canonicalId: "event:evt-user-1",
		snippet: `User: ${marker} user prefers concise updates and deploys on Fridays`,
		source: "conversation",
		role: "user",
		derivation: "user",
		scope: "session",
		scopeRef: "session:proof-ci-session-1",
	}
	const derivedEntry = {
		path: `structured:preference:${marker}:preference`,
		canonicalId: `structured:preference:${marker}:preference`,
		snippet: "prefers concise status reports",
		source: "structured",
		derivation: "derived",
		scope: "agent",
		scopeRef: agentScopeRef,
	}

	it("passes when the marker hit is a planted exact-capable conversation turn", () => {
		const verdict = evaluateSearchDetailed(
			{
				results: [derivedEntry, plantedTurn],
				metadata: { pathsExecuted: ["hybrid", "raw-window"] },
			},
			{ marker, plantedEventIds },
		)
		expect(verdict.ok).toBe(true)
		expect(verdict.details).toContain("event:evt-user-1")
	})

	it("fails when the only marker hit is a derived entry", () => {
		const verdict = evaluateSearchDetailed(
			{
				results: [derivedEntry],
				metadata: { pathsExecuted: ["structured"] },
			},
			{ marker, plantedEventIds },
		)
		expect(verdict.ok).toBe(false)
		expect(verdict.details).toContain("no planted exact-capable conversation")
	})

	it("fails when a conversation marker hit is not one of the planted events", () => {
		const verdict = evaluateSearchDetailed(
			{
				results: [
					{
						...plantedTurn,
						path: "events/evt-other",
						canonicalId: "event:evt-other",
					},
				],
				metadata: { pathsExecuted: ["hybrid"] },
			},
			{ marker, plantedEventIds },
		)
		expect(verdict.ok).toBe(false)
	})

	it("fails when the planted turn is not exact-capable", () => {
		const verdict = evaluateSearchDetailed(
			{
				results: [{ ...plantedTurn, role: "assistant", derivation: "agent" }],
				metadata: { pathsExecuted: ["hybrid"] },
			},
			{ marker, plantedEventIds },
		)
		expect(verdict.ok).toBe(false)
	})

	it("fails on no evidence, naming the engine's no-direct-evidence reason", () => {
		const verdict = evaluateSearchDetailed(
			{
				results: [],
				metadata: {
					pathsExecuted: ["structured"],
					noDirectEvidenceReason: "exact evidence required",
				},
			},
			{ marker, plantedEventIds },
		)
		expect(verdict).toEqual({
			ok: false,
			details:
				"advanced search returned no evidence (noDirectEvidenceReason=exact evidence required)",
		})
	})

	it("fails when pathsExecuted is not an array", () => {
		const verdict = evaluateSearchDetailed(
			{ results: [plantedTurn], metadata: {} },
			{ marker, plantedEventIds },
		)
		expect(verdict.ok).toBe(false)
		expect(verdict.details).toContain("pathsExecuted")
	})
})

describe("evaluateBarrierWrite", () => {
	const written = { ok: true, details: "eventId=evt-user-1" }

	it("passes a written write whose barrier reports searchable", () => {
		const verdict = evaluateBarrierWrite(written, {
			committed: true,
			status: "searchable",
			targets: [
				{ index: "events_text", status: "confirmed", attempts: 1 },
				{ index: "events_vector", status: "confirmed", attempts: 2 },
			],
		})
		expect(verdict).toEqual({
			ok: true,
			details: "eventId=evt-user-1, searchBarrier=searchable (2 targets)",
		})
	})

	it("fails a committed write that is not yet searchable, naming status, reason and targets", () => {
		const verdict = evaluateBarrierWrite(written, {
			committed: true,
			status: "not-yet-searchable",
			reason: "timeout",
			targets: [
				{ index: "chunks_text", status: "confirmed", attempts: 1 },
				{ index: "chunks_vector", status: "pending", attempts: 10 },
			],
		})
		expect(verdict).toEqual({
			ok: false,
			details:
				"eventId=evt-user-1, searchBarrier status=not-yet-searchable reason=timeout targets=chunks_text:confirmed/1,chunks_vector:pending/10",
		})
	})

	it("fails when the write response carries no barrier outcome", () => {
		const verdict = evaluateBarrierWrite(written, undefined)
		expect(verdict.ok).toBe(false)
		expect(verdict.details).toContain("searchBarrier missing")
	})

	it("keeps a failed write failed even when the barrier says searchable", () => {
		const verdict = evaluateBarrierWrite(
			{ ok: false, details: "write-event did not return ok" },
			{ committed: true, status: "searchable", targets: [] },
		)
		expect(verdict.ok).toBe(false)
	})

	it("bounds the failure details however large the barrier payload is", () => {
		const verdict = evaluateBarrierWrite(written, {
			committed: true,
			status: "x".repeat(500),
			reason: "y".repeat(500),
			targets: Array.from({ length: 40 }, (_, i) => ({
				index: `index_${i}_${"z".repeat(200)}`,
				status: "pending",
				attempts: i,
			})),
		})
		expect(verdict.ok).toBe(false)
		expect(verdict.details.length).toBeLessThan(1500)
		expect(verdict.details).toContain("+28 more")
	})
})
