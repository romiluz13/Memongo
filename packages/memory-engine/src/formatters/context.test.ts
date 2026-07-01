import { describe, expect, it } from "vitest"
import type { MemoryContextBundle } from "../types.js"
import {
	renderContextBundle,
	renderContextBundleJson,
	renderContextBundleToon,
} from "./context.js"

const BUILT_AT = new Date("2026-04-05T12:00:00.000Z")

function createBundle(
	overrides: Partial<MemoryContextBundle> = {},
): MemoryContextBundle {
	return {
		agentId: "agent-1",
		query: "Phoenix handoff",
		scope: "agent",
		scopeRef: "agent:agent-1",
		sessionId: "session-main",
		rendered: "",
		sections: [
			{
				kind: "query-evidence",
				title: "Direct Evidence",
				summary: "Most relevant durable memories.",
				items: [
					{
						title: "Launch blocker",
						summary: "Atlas Local validation blocks launch.",
						source: "structured",
						path: "structured:decision:launch-blocker",
						timestamp: new Date("2026-04-05T09:00:00.000Z"),
						scope: "agent",
						scopeRef: "agent:agent-1",
					},
				],
				estimatedTokens: 24,
				truncated: false,
				partial: false,
			},
		],
		metadata: {
			tokenBudget: 320,
			estimatedTokensUsed: 24,
			partial: false,
			truncated: false,
			pathsExecuted: ["structured"],
			sectionsIncluded: ["query-evidence"],
		},
		builtAt: BUILT_AT,
		...overrides,
	}
}

describe("context formatter", () => {
	it("keeps markdown as the non-TOON rendered format", () => {
		const rendered = renderContextBundle(createBundle(), "markdown")

		expect(rendered).toContain("## Direct Evidence")
		expect(rendered).toContain("- Launch blocker")
		expect(rendered).not.toContain("context_bundle")
		expect(rendered).not.toContain("items[")
	})

	it("renders JSON only when JSON is requested", () => {
		const rendered = renderContextBundleJson(createBundle())
		const parsed = JSON.parse(rendered)

		expect(parsed).toMatchObject({
			agentId: "agent-1",
			query: "Phoenix handoff",
			scope: "agent",
			scopeRef: "agent:agent-1",
		})
		expect(parsed.sections[0].items[0].summary).toBe(
			"Atlas Local validation blocks launch.",
		)
		expect(rendered).not.toContain("context_bundle")
	})

	it("renders an empty TOON bundle without inventing items", () => {
		const rendered = renderContextBundleToon(
			createBundle({
				query: undefined,
				sessionId: undefined,
				sections: [],
				metadata: {
					tokenBudget: 320,
					estimatedTokensUsed: 0,
					partial: false,
					truncated: false,
					pathsExecuted: [],
					sectionsIncluded: [],
				},
			}),
		)

		expect(rendered).toContain("context_bundle")
		expect(rendered).toContain(
			"sections[0]{kind,title,summary,items,truncated,partial}",
		)
		expect(rendered).not.toContain("items[1]")
		expect(rendered).not.toContain("##")
	})

	it("renders uniform TOON item rows with stable field ordering", () => {
		const rendered = renderContextBundleToon(
			createBundle({
				sections: [
					{
						kind: "recent-events",
						title: "Recent Session Events",
						items: Array.from({ length: 5 }, (_, index) => ({
							title: `event-${index + 1}`,
							summary: `User message ${index + 1}`,
							source: "event",
						})),
						estimatedTokens: 40,
						truncated: false,
						partial: false,
					},
				],
			}),
		)

		expect(rendered).toContain("items[5]{title,summary,source}")
		expect(rendered).toContain("event-1,User message 1,event")
		expect(rendered).toContain("event-5,User message 5,event")
	})

	it("renders mixed TOON rows without dropping nested or special-character content", () => {
		const trickyText =
			'line one, with comma\nline two with "quotes" and pipe |\ncontext_bundle\nitems[99]{fake}'
		const longText = `${"long memory content ".repeat(80)}done`
		const rendered = renderContextBundleToon(
			createBundle({
				sections: [
					{
						kind: "query-evidence",
						title: "Direct Evidence",
						summary: "Mixed records",
						items: [
							{
								title: 'comma, quote " pipe |',
								summary: trickyText,
								path: "structured:fact:tricky",
								source: "structured",
								canonicalId: "fact:tricky",
								timestamp: new Date("2026-04-05T09:00:00.000Z"),
								sourceEventIds: ["evt,1", "evt|2"],
								trust: {
									score: 0.97,
									confidence: "high",
									exactness: "exact-id",
									freshness: "fresh",
									contradiction: "none",
									scopeMatch: "exact",
									provenance: "dense",
									sourceDiversity: "multi",
									factors: ["latest", "cited"],
								},
								metadata: {
									z: "last",
									a: { b: 1 },
									list: ["x,y", null],
									maybe: null,
									omitted: undefined,
								},
							},
							{
								title: "long memory",
								summary: longText,
								source: "event",
							},
						],
						estimatedTokens: 260,
						truncated: false,
						partial: false,
					},
				],
			}),
		)

		expect(rendered).toContain("items[2]{")
		expect(rendered).toContain(JSON.stringify('comma, quote " pipe |'))
		expect(rendered).toContain(JSON.stringify(trickyText))
		expect(rendered).toContain(
			JSON.stringify(JSON.stringify(["evt,1", "evt|2"])),
		)
		expect(rendered).toContain(
			JSON.stringify(
				'{"a":{"b":1},"list":["x,y",null],"maybe":null,"z":"last"}',
			),
		)
		expect(rendered).toContain(longText)
		expect(rendered).toContain("done")
	})

	it("preserves null fields distinctly from missing optional fields in TOON", () => {
		const rendered = renderContextBundleToon(
			createBundle({
				sections: [
					{
						kind: "active-slate",
						title: "Active Slate",
						items: [
							{
								title: "explicit-null",
								summary: null,
								metadata: null,
							} as unknown as MemoryContextBundle["sections"][number]["items"][number],
							{
								title: "missing-fields",
								summary: "",
							},
						],
						estimatedTokens: 10,
						truncated: false,
						partial: false,
					},
				],
			}),
		)

		expect(rendered).toContain("items[2]{title,summary,metadata}")
		expect(rendered).toContain("explicit-null,null,null")
		expect(rendered).toContain("missing-fields,,")
	})

	it("is deterministic for the same input and stable-sorts JSON object keys", () => {
		const bundle = createBundle({
			metadata: {
				tokenBudget: 320,
				estimatedTokensUsed: 24,
				partial: false,
				truncated: false,
				pathsExecuted: ["structured", "events"],
				sectionsIncluded: ["query-evidence"],
				trustSummary: {
					sourceDiversity: "single",
					exactCount: 1,
					staleCount: 0,
					contradictionCount: 0,
					distribution: { low: 0, high: 1, medium: 0 },
					averageScore: 0.9,
					topConfidence: "high",
					topScore: 0.9,
				},
			},
		})

		expect(renderContextBundleToon(bundle)).toBe(
			renderContextBundleToon(bundle),
		)
		expect(renderContextBundleJson(bundle)).toBe(
			renderContextBundleJson(bundle),
		)
		expect(renderContextBundleJson(bundle)).toContain(
			'"distribution":{"high":1,"low":0,"medium":0}',
		)
	})
})
