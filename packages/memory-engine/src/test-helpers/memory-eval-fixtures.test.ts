import { describe, expect, it, vi } from "vitest"

import { resolveScopeIdentity } from "../mongodb-scope.js"
import { buildPhase6MemoryEvalFixture } from "./memory-eval-fixtures.js"

describe("memory-eval-fixtures", () => {
	it("builds a deterministic phase 6 corpus with seeded scope-isolation data", () => {
		const fixture = buildPhase6MemoryEvalFixture("phase6-demo")

		expect(fixture.primaryAgentId).toBe("phase6-demo-primary")
		expect(fixture.secondaryAgentId).toBe("phase6-demo-secondary")
		expect(
			fixture.seed.some((step) => step.agentId === fixture.secondaryAgentId),
		).toBe(true)
		expect(fixture.cases.map((entry) => entry.id)).toEqual([
			"current-release-window",
			"no-scope-leak-red-kite",
			"foreign-owner-red-kite",
			"session-owner-isolation",
			"active-slate",
			"what-changed",
			"contradiction-report",
			"context-bundle-handoff",
		])
	})

	it("keeps projection and hydration expectations inside the current scope contract", () => {
		const fixture = buildPhase6MemoryEvalFixture("phase6-scope")

		const projectionCases = fixture.cases.filter(
			(entry) =>
				entry.kind === "discovery-projection" ||
				entry.kind === "hydrate-active-slate",
		)

		for (const entry of projectionCases) {
			expect(entry.request.scope ?? "agent").toBe("agent")
			expect(entry.request.scopeRef).toBe(`agent:${fixture.primaryAgentId}`)
		}
	})

	it("anchors seeded event timestamps inside the recent raw-window horizon", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-04-06T12:00:00.000Z"))

		const fixture = buildPhase6MemoryEvalFixture("phase6-time")
		const eventTimestamps = fixture.seed
			.filter((step) => step.kind === "write-event")
			.map((step) => new Date(step.timestamp).getTime())
		const now = Date.now()

		expect(eventTimestamps.every((timestamp) => timestamp <= now)).toBe(true)
		expect(
			eventTimestamps.every(
				(timestamp) => timestamp >= now - 24 * 60 * 60 * 1000,
			),
		).toBe(true)

		vi.useRealTimers()
	})
})

describe("foreign sentinel scope", () => {
	it("the foreign owner reads the same scope its sentinel was written to, and the primary reads its own", () => {
		const fixture = buildPhase6MemoryEvalFixture("scope")
		const sentinel = fixture.seed.find(
			(step) =>
				step.kind === "write-event" &&
				step.agentId === fixture.secondaryAgentId,
		)
		const owner = fixture.cases.find((c) => c.id === "foreign-owner-red-kite")
		const abstention = fixture.cases.find(
			(c) => c.id === "no-scope-leak-red-kite",
		)
		if (
			sentinel?.kind !== "write-event" ||
			owner?.kind !== "search-detailed" ||
			abstention?.kind !== "search-detailed"
		)
			throw new Error("fixture")
		const read = (request: typeof owner.request) =>
			resolveScopeIdentity({
				agentId: request.agentId,
				sessionId: request.conversationScope?.sessionKey,
			})
		const written = resolveScopeIdentity(sentinel)
		expect(read(owner.request)).toEqual(written)
		expect(read(abstention.request).scope).toBe(written.scope)
		expect(read(abstention.request).scopeRef).not.toBe(written.scopeRef)
	})
})
