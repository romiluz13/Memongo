import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(),
}))

import type { Db } from "mongodb"
import {
	rewriteQuery,
	expandSynonyms,
	type QueryRewriteConfig,
} from "./mongodb-query-rewriter.js"
import { emitTelemetry } from "./mongodb-telemetry.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREFIX = "test_"
const AGENT_ID = "agent-1"

function mockDb(): Db {
	return {} as Db
}

function enabledConfig(
	overrides: Partial<QueryRewriteConfig> = {},
): QueryRewriteConfig {
	return {
		enabled: true,
		method: "synonym-expansion",
		maxTokens: 128,
		...overrides,
	}
}

function disabledConfig(): QueryRewriteConfig {
	return { enabled: false, method: "synonym-expansion", maxTokens: 128 }
}

// ---------------------------------------------------------------------------
// expandSynonyms
// ---------------------------------------------------------------------------

describe("expandSynonyms", () => {
	it("expands known abbreviations", () => {
		const result = expandSynonyms("ts")
		expect(result).toContain("ts")
		expect(result).toContain("typescript")
	})

	it("adds synonyms for recognized terms (capped at 3x)", () => {
		const result = expandSynonyms("auth")
		expect(result).toContain("auth")
		expect(result).toContain("authentication")
		expect(result).toContain("login")
		// H7 audit fix: expansion capped at 3x original word count (1 word * 3 = 3 total)
		// "oauth" may be excluded by the cap — verify total count
		const wordCount = result.split(/\s+/).length
		expect(wordCount).toBeLessThanOrEqual(3)
	})

	it("preserves original words", () => {
		const result = expandSynonyms("hello world")
		expect(result).toContain("hello")
		expect(result).toContain("world")
	})

	it("handles multiple words with different expansions", () => {
		const result = expandSynonyms("auth db")
		expect(result).toContain("auth")
		expect(result).toContain("authentication")
		expect(result).toContain("db")
		expect(result).toContain("database")
	})

	it("is case-insensitive", () => {
		const result = expandSynonyms("AUTH")
		expect(result).toContain("auth")
		expect(result).toContain("authentication")
	})

	it("returns unchanged query when no matches", () => {
		const result = expandSynonyms("xylophone banana")
		expect(result).toBe("xylophone banana")
	})

	it("deduplicates expanded terms", () => {
		// "auth" expands to include "authentication", no duplicate "auth"
		const result = expandSynonyms("auth")
		const words = result.split(" ")
		const unique = new Set(words)
		expect(words.length).toBe(unique.size)
	})

	// H7 audit fix: removed cross-domain expansions
	it("does not expand 'api' to unrelated domains", () => {
		const result = expandSynonyms("api")
		expect(result).not.toContain("route")
		expect(result).not.toContain("rest")
		expect(result).not.toContain("endpoint")
		// Should only contain the original word (no synonyms for 'api' anymore)
		expect(result).toBe("api")
	})

	it("does not expand 'ui' to unrelated domains", () => {
		const result = expandSynonyms("ui")
		expect(result).not.toContain("interface")
		expect(result).not.toContain("frontend")
		expect(result).not.toContain("component")
	})

	// H7 audit fix: expansion ratio cap
	it("respects max expansion ratio of 3x original word count", () => {
		const result = expandSynonyms("auth db bug")
		const originalCount = 3
		const expandedCount = result.split(/\s+/).length
		expect(expandedCount).toBeLessThanOrEqual(originalCount * 3)
	})
})

// ---------------------------------------------------------------------------
// rewriteQuery
// ---------------------------------------------------------------------------

describe("rewriteQuery", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns original when disabled", async () => {
		const result = await rewriteQuery({
			db: mockDb(),
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: "auth problem",
			config: disabledConfig(),
		})
		expect(result.rewritten).toBe(false)
		expect(result.rewrittenQuery).toBe("auth problem")
		expect(result.method).toBe("none")
	})

	it("returns original for empty query", async () => {
		const result = await rewriteQuery({
			db: mockDb(),
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: "   ",
			config: enabledConfig(),
		})
		expect(result.rewritten).toBe(false)
		expect(result.rewrittenQuery).toBe("   ")
	})

	it("truncates to maxTokens", async () => {
		// maxTokens=2 means maxChars=8
		const result = await rewriteQuery({
			db: mockDb(),
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: "auth db config deps deploy docs",
			config: enabledConfig({ maxTokens: 2 }),
		})
		// Rewritten query should be truncated
		expect(result.rewrittenQuery.length).toBeLessThanOrEqual(8)
		expect(result.rewritten).toBe(true)
	})

	it("emits query-rewrite telemetry", async () => {
		await rewriteQuery({
			db: mockDb(),
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: "auth problem",
			config: enabledConfig(),
		})
		expect(emitTelemetry).toHaveBeenCalledWith(
			expect.anything(),
			PREFIX,
			expect.objectContaining({
				meta: { agentId: AGENT_ID, operation: "query-rewrite" },
				ok: true,
				queryRewritten: true,
			}),
		)
	})

	it("reports rewritten:false when no expansion", async () => {
		const result = await rewriteQuery({
			db: mockDb(),
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: "xylophone banana",
			config: enabledConfig(),
		})
		expect(result.rewritten).toBe(false)
		expect(result.rewrittenQuery).toBe("xylophone banana")
	})

	it("throws on llm method (H3 audit fix)", async () => {
		await expect(
			rewriteQuery({
				db: mockDb(),
				prefix: PREFIX,
				agentId: AGENT_ID,
				query: "auth issue",
				config: enabledConfig({ method: "llm" }),
			}),
		).rejects.toThrow(/not yet implemented/)
	})

	it("throws on hyde method (H3 audit fix)", async () => {
		await expect(
			rewriteQuery({
				db: mockDb(),
				prefix: PREFIX,
				agentId: AGENT_ID,
				query: "auth issue",
				config: enabledConfig({ method: "hyde" }),
			}),
		).rejects.toThrow(/not yet implemented/)
	})

	it("handles single-word query", async () => {
		const result = await rewriteQuery({
			db: mockDb(),
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: "ts",
			config: enabledConfig(),
		})
		expect(result.rewritten).toBe(true)
		expect(result.rewrittenQuery).toContain("typescript")
	})

	it("handles query with all known abbreviations", async () => {
		const result = await rewriteQuery({
			db: mockDb(),
			prefix: PREFIX,
			agentId: AGENT_ID,
			query: "ts js py",
			config: enabledConfig(),
		})
		expect(result.rewritten).toBe(true)
		expect(result.rewrittenQuery).toContain("typescript")
		expect(result.rewrittenQuery).toContain("javascript")
		expect(result.rewrittenQuery).toContain("python")
	})
})
