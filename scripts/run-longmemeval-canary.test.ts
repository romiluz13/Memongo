import { describe, it, expect } from "vitest"
import {
	resolveCanaryArtifactDir,
	resolveCanaryFullMode,
	resolveCanaryHttpTimeoutMs,
	resolveCanaryResumeMode,
	selectStratifiedSubset,
	type RawLongMemEvalEntry,
} from "./run-longmemeval-canary.js"

function makeEntry(id: string, questionType: string): RawLongMemEvalEntry {
	return {
		question_id: id,
		question_type: questionType,
		question: `Question ${id}`,
		answer: `Answer ${id}`,
		answer_session_ids: [`session-${id}`],
	}
}

describe("selectStratifiedSubset", () => {
	it("selects up to N cases per question type with stable ordering", () => {
		const entries = [
			makeEntry("q001", "multi-session-synthesis"),
			makeEntry("q002", "multi-session-synthesis"),
			makeEntry("q003", "single-session-preference"),
		]

		const { selected, selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			2,
		)

		// 2 per type: 2 multi-session-synthesis + 1 single-session-preference
		expect(selectedQuestionIds).toHaveLength(3)
		expect(breakdown["multi-session-synthesis"]).toBe(2)
		expect(breakdown["single-session-preference"]).toBe(1)
		// Stable order: q001 before q002
		expect(selectedQuestionIds[0]).toBe("q001")
		expect(selectedQuestionIds[1]).toBe("q002")
		expect(selected).toHaveLength(3)
	})

	it("caps at casesPerType even when more are available", () => {
		const entries = Array.from({ length: 20 }, (_, i) =>
			makeEntry(`q${String(i).padStart(3, "0")}`, "knowledge-update"),
		)

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			8,
		)

		expect(selectedQuestionIds).toHaveLength(8)
		expect(breakdown["knowledge-update"]).toBe(8)
		// First 8 by stable sort
		expect(selectedQuestionIds[0]).toBe("q000")
		expect(selectedQuestionIds[7]).toBe("q007")
	})

	it("returns empty when no entries", () => {
		const { selected, selectedQuestionIds, breakdown } = selectStratifiedSubset(
			[],
			8,
		)
		expect(selected).toHaveLength(0)
		expect(selectedQuestionIds).toHaveLength(0)
		expect(Object.keys(breakdown)).toHaveLength(0)
	})

	it("limits the total selected cases after stratified selection", () => {
		const entries = [
			makeEntry("a-001", "alpha"),
			makeEntry("a-002", "alpha"),
			makeEntry("b-001", "beta"),
		]

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			2,
			{ totalCaseLimit: 1 },
		)

		expect(selectedQuestionIds).toEqual(["a-001"])
		expect(breakdown).toEqual({ alpha: 1 })
	})

	it("selects exact question IDs for targeted replay", () => {
		const entries = [
			makeEntry("q001", "alpha"),
			makeEntry("q002", "beta"),
			makeEntry("q003", "beta"),
		]

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			2,
			{ questionIds: ["q003", "q001"] },
		)

		expect(selectedQuestionIds).toEqual(["q001", "q003"])
		expect(breakdown).toEqual({ alpha: 1, beta: 1 })
	})

	it("fails targeted replay when a question ID is missing", () => {
		expect(() =>
			selectStratifiedSubset([makeEntry("q001", "alpha")], 2, {
				questionIds: ["q002"],
			}),
		).toThrow("Requested question_id")
	})

	it("groups entries with missing question_type under unknown", () => {
		const entries = [
			{
				question_id: "q001",
				question_type: "",
				question: "q?",
			} as RawLongMemEvalEntry,
		]

		const { breakdown } = selectStratifiedSubset(entries, 8)
		expect(breakdown.unknown).toBe(1)
	})

	it("produces deterministic selection across 6 question types", () => {
		const types = [
			"single-session-user",
			"single-session-preference",
			"multi-session-synthesis",
			"knowledge-update",
			"temporal-reasoning",
			"multi-session-user",
		]
		const entries: RawLongMemEvalEntry[] = []
		for (const qt of types) {
			for (let i = 0; i < 15; i++) {
				entries.push(makeEntry(`${qt}-${String(i).padStart(3, "0")}`, qt))
			}
		}

		const { selectedQuestionIds, breakdown } = selectStratifiedSubset(
			entries,
			8,
		)

		// 8 per type * 6 types = 48
		expect(selectedQuestionIds).toHaveLength(48)
		for (const qt of types) {
			expect(breakdown[qt]).toBe(8)
		}

		// Same input always produces same output
		const { selectedQuestionIds: second } = selectStratifiedSubset(entries, 8)
		expect(second).toEqual(selectedQuestionIds)
	})
})

describe("resolveCanaryHttpTimeoutMs", () => {
	it("defaults to a bounded benchmark request timeout", () => {
		expect(resolveCanaryHttpTimeoutMs(undefined)).toBe(20 * 60 * 1000)
	})

	it("accepts an explicit non-negative timeout", () => {
		expect(resolveCanaryHttpTimeoutMs("30000")).toBe(30_000)
		expect(resolveCanaryHttpTimeoutMs("0")).toBe(0)
	})

	it("rejects invalid timeout values", () => {
		expect(() => resolveCanaryHttpTimeoutMs("-1")).toThrow(
			"MEMONGO_CANARY_HTTP_TIMEOUT_MS",
		)
		expect(() => resolveCanaryHttpTimeoutMs("forever")).toThrow(
			"MEMONGO_CANARY_HTTP_TIMEOUT_MS",
		)
	})
})

describe("MEMONGO_CANARY_* env var contract (Task 1.0)", () => {
	it("MEMONGO_CANARY_ARTIFACT_DIR overrides the default artifact root exactly", () => {
		expect(
			resolveCanaryArtifactDir({ runId: "abc", envDir: "/tmp/foo" }),
		).toBe("/tmp/foo")
	})

	it("MEMONGO_CANARY_ARTIFACT_DIR absent falls back to default root + runId", () => {
		const out = resolveCanaryArtifactDir({
			runId: "abc",
			envDir: undefined,
			repoRoot: "/repo",
		})
		expect(out).toMatch(
			/\.claude\/cc10x\/v10\/workflows\/memongo-memory-hardening\/artifacts\/canary-runs\/abc$/,
		)
	})

	it("MEMONGO_CANARY_ARTIFACT_DIR blank string falls back to default root + runId", () => {
		const out = resolveCanaryArtifactDir({
			runId: "abc",
			envDir: "  ",
			repoRoot: "/repo",
		})
		expect(out).toMatch(/canary-runs\/abc$/)
	})

	it("MEMONGO_CANARY_FULL=1 enables full mode; anything else is false", () => {
		expect(resolveCanaryFullMode("1")).toBe(true)
		expect(resolveCanaryFullMode("0")).toBe(false)
		expect(resolveCanaryFullMode(undefined)).toBe(false)
		expect(resolveCanaryFullMode("true")).toBe(false)
		expect(resolveCanaryFullMode("")).toBe(false)
	})

	it("MEMONGO_CANARY_RESUME=1 enables resume mode; anything else is false", () => {
		expect(resolveCanaryResumeMode("1")).toBe(true)
		expect(resolveCanaryResumeMode("0")).toBe(false)
		expect(resolveCanaryResumeMode(undefined)).toBe(false)
		expect(resolveCanaryResumeMode("true")).toBe(false)
		expect(resolveCanaryResumeMode("")).toBe(false)
	})
})
