import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MemorySearchResult } from "../../packages/memory-engine/src/types.js"
import {
	buildPass0ContextDiagnostics,
	captureContextDiagnostics,
} from "./benchmark-context-diagnostics.js"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("buildPass0ContextDiagnostics retrieved ranks", () => {
	const TURN_ID = "q::s1::turn_1"
	const TURN_TEXT = "I adopted a cat named Miso."

	function result(
		path: string,
		text: string,
		extra: Partial<MemorySearchResult> = {},
	): MemorySearchResult {
		return {
			path,
			startLine: 1,
			endLine: 1,
			score: 1,
			snippet: text,
			text,
			source: "conversation",
			...extra,
		}
	}

	function build(
		results: MemorySearchResult[],
		resolved: Record<string, { session?: string; turn?: string }>,
	) {
		return buildPass0ContextDiagnostics({
			results,
			keptRanks: results.map((_, index) => index + 1),
			evidence: { sessionIds: new Map(), turnIds: new Map() },
			collectSourceEventIds: () => [],
			resolveSessionIds: (r) => {
				const session = resolved[r.path]?.session
				return session ? [session] : []
			},
			resolveTurnIds: (r) => {
				const turn = resolved[r.path]?.turn
				return turn ? [turn] : []
			},
			evaluation: {
				expectedSessionIds: ["q::s1"],
				expectedTurnIds: [TURN_ID],
			},
			conversations: [
				{
					sessionId: "q::s1",
					turns: [
						{
							role: "user",
							body: TURN_TEXT,
							metadata: { benchmarkTurnId: TURN_ID, benchmarkHasAnswer: true },
						},
					],
				},
			],
		})
	}

	it("ranks a turn by the first result holding its text after whitespace collapse, even without ids", () => {
		const diagnostics = build(
			[
				result("a", "unrelated"),
				result("b", "  I  adopted a cat\tnamed Miso.\n"),
				result("c", "later", {}),
			],
			{ c: { turn: TURN_ID } },
		)
		expect(diagnostics.retrievedTurnRanks.get(TURN_ID)).toBe(2)
	})

	it("ranks a turn by the earlier of an id match and a text match", () => {
		const diagnostics = build([result("a", "by id"), result("b", TURN_TEXT)], {
			a: { turn: TURN_ID },
		})
		expect(diagnostics.retrievedTurnRanks.get(TURN_ID)).toBe(1)
	})

	it("does not fold case when matching a turn's text", () => {
		const diagnostics = build([result("a", TURN_TEXT.toUpperCase())], {})
		expect(diagnostics.retrievedTurnRanks.has(TURN_ID)).toBe(false)
	})

	it("keeps session retrieval id-based, so a text match alone retrieves no session", () => {
		const diagnostics = build([result("a", TURN_TEXT)], {})
		expect(diagnostics.retrievedSessionRanks.has("q::s1")).toBe(false)
	})
})

describe("captureContextDiagnostics failures", () => {
	let warn: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	it("names the failure when the thrown error has an empty message", () => {
		expect(
			captureContextDiagnostics("case-1", () => {
				throw new Error("")
			}),
		).toEqual({ diagnosticsError: "diagnostics failed: Error" })
	})

	it("names the failure when something other than an error is thrown", () => {
		expect(
			captureContextDiagnostics("case-1", () => {
				throw ""
			}),
		).toEqual({ diagnosticsError: "diagnostics failed: string" })
	})

	it("logs a warning that names the case and the reason", () => {
		const outcome = captureContextDiagnostics("case-9", () => {
			throw new Error("boom")
		})
		expect(outcome).toEqual({ diagnosticsError: "boom" })
		expect(warn).toHaveBeenCalledTimes(1)
		expect(String(warn.mock.calls[0]?.[0])).toContain("case-9")
		expect(String(warn.mock.calls[0]?.[0])).toContain("boom")
	})
})
