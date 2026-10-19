import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fixture, event } from "./test-helpers/persistence-contract-store.js"
import {
	prepareDerivedMemoryPromotion,
	persistPreparedDerivedMemoryPromotion,
} from "./mongodb-derived-memory.js"

const FACT =
	"From a conversation about parcel pickup: The user's pickup label is NARU-617-QP."
const lines: string[] = []
beforeEach(() => {
	lines.length = 0
	vi.stubEnv("MEMONGO_LOG_LEVEL", "debug")
	vi.spyOn(console, "debug").mockImplementation((line) =>
		lines.push(String(line)),
	)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})
function decisions() {
	return lines
		.filter((line) => line.includes("derived-promotion decision"))
		.map(
			(line) =>
				JSON.parse(line.slice(line.indexOf("{"))) as {
					stage: string
					observation?: string
					reason: string
					count?: number
					event: string
					candidate?: string
				},
		)
}
const prepare = (
	f: ReturnType<typeof fixture>,
	current = event,
	facts = [FACT],
) =>
	prepareDerivedMemoryPromotion({
		db: f.db,
		prefix: "test_",
		event: current,
		prefetchedLlmFacts: facts,
	})
const persist = (
	f: ReturnType<typeof fixture>,
	prepared: Awaited<ReturnType<typeof prepare>>,
) =>
	persistPreparedDerivedMemoryPromotion({
		db: f.db,
		prefix: "test_",
		event,
		prepared,
		embeddingMode: "automated",
	})

describe("privacy of added debug extraction/promotion decision records", () => {
	it("marks successful persist as attempt when a later transaction step aborts all rows", async () => {
		const f = fixture(),
			prepared = await prepare(f)
		const session = f.db.client.startSession()
		const laterFailure = Error("offline later transaction step failed")
		try {
			await expect(
				session.withTransaction(async () => {
					const result = await persistPreparedDerivedMemoryPromotion({
						db: f.db,
						prefix: "test_",
						event,
						prepared,
						embeddingMode: "automated",
						session,
					})
					expect(result.structuredCreated).toBe(1)
					expect(f.table("test_structured_mem")).toHaveLength(1)
					expect(decisions()).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								stage: "persist",
								reason: "write-upserted",
							}),
							expect.objectContaining({
								stage: "persist",
								reason: "finished",
								count: 1,
							}),
						]),
					)
					throw laterFailure
				}),
			).rejects.toBe(laterFailure)
		} finally {
			await session.endSession()
		}
		expect(f.table("test_structured_mem")).toHaveLength(0)
		expect(f.transactions).toMatchObject({ committed: 0, aborted: 1, ended: 1 })
		for (const decision of decisions())
			expect(decision.observation).toBe("attempt")
	})

	it.each([
		[
			"assistant-only",
			"user-witness-missing",
			(f: ReturnType<typeof fixture>) => {
				for (const row of f.table("test_events")) row.role = "assistant"
			},
		],
		[
			"stale current claim",
			"claim-mismatch",
			(f: ReturnType<typeof fixture>) => {
				f.table("test_events")[0].body = "private unrelated canonical body"
			},
		],
	] as const)("reports %s admission rejection without weakening it", async (_name, reason, mutate) => {
		const f = fixture()
		mutate(f)
		const prepared = await prepare(f)
		expect(prepared.structuredCandidates).toHaveLength(0)
		expect(decisions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: "prepare", reason }),
			]),
		)
		expect(lines.join("\n")).not.toContain("private unrelated")
		expect(lines.join("\n")).not.toContain(FACT)
	})
	it("distinguishes a successful attempt from an existing receipt and an invalidated guard", async () => {
		const f = fixture()
		const prepared = await prepare(f)
		expect(prepared.structuredCandidates).toHaveLength(1)
		const first = await persist(f, prepared)
		expect(first.structuredCreated).toBe(1)
		expect(f.table("test_structured_mem")).toHaveLength(1)
		const repeated = await persist(f, prepared)
		expect(repeated.skipReason).toBe("already-promoted")
		f.table("test_events")[0].role = "assistant"
		f.table("test_events")[1].role = "assistant"
		const stale = await persist(f, prepared)
		expect(stale.structuredCreated).toBe(0)
		expect(decisions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: "persist", reason: "write-upserted" }),
				expect.objectContaining({ stage: "persist", reason: "receipt-exists" }),
				expect.objectContaining({ stage: "persist", reason: "guard-invalid" }),
			]),
		)
		for (const decision of decisions()) {
			expect(decision.event).toMatch(/^[a-f0-9]{12}$/)
			if (decision.candidate)
				expect(decision.candidate).toMatch(/^[a-f0-9]{12}$/)
		}
		expect(lines.join("\n")).not.toContain(FACT)
	})

	it("reports preparation exceptions and preserves the original opaque error", async () => {
		const f = fixture()
		const poison = vi.fn(() => {
			throw Error("private error getter must not run")
		})
		const error = Object.defineProperties(
			{},
			{
				message: { get: poison },
				code: { get: poison },
				toString: { value: poison },
			},
		)
		vi.spyOn(f.db, "collection").mockImplementation(() => {
			throw error
		})
		await expect(prepare(f)).rejects.toBe(error)
		expect(poison).not.toHaveBeenCalled()
		expect(decisions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: "prepare", reason: "started" }),
				expect.objectContaining({ stage: "prepare", reason: "failed" }),
			]),
		)
	})
	it("reports a transactional write failure without converting it to completion", async () => {
		const f = fixture()
		const prepared = await prepare(f)
		f.controls.failStructuredWrites = 1
		const session = f.db.client.startSession()
		try {
			await expect(
				persistPreparedDerivedMemoryPromotion({
					db: f.db,
					prefix: "test_",
					event,
					prepared,
					embeddingMode: "automated",
					session,
				}),
			).rejects.toThrow("offline structured write failure")
		} finally {
			await session.endSession()
		}
		expect(f.table("test_structured_mem")).toHaveLength(0)
		expect(decisions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: "persist", reason: "started" }),
				expect.objectContaining({ stage: "persist", reason: "write-error" }),
				expect.objectContaining({ stage: "persist", reason: "failed" }),
			]),
		)
		expect(
			decisions().some((d) => d.stage === "persist" && d.reason === "finished"),
		).toBe(false)
		expect(lines.join("\n")).not.toContain("offline structured write failure")
	})
	it.each([
		"user",
		"assistant",
	] as const)("keeps %s witness admission unchanged when the diagnostic sink throws", async (role) => {
		vi.mocked(console.debug).mockImplementation(() => {
			throw Error("offline sink failure")
		})
		const f = fixture()
		for (const row of f.table("test_events")) row.role = role
		const prepared = await prepare(f)
		const result = await persist(f, prepared)
		expect(result.structuredCreated).toBe(role === "user" ? 1 : 0)
		expect(f.table("test_structured_mem")).toHaveLength(role === "user" ? 1 : 0)
	})
	it("remains opt-in at the existing debug log level", async () => {
		vi.stubEnv("MEMONGO_LOG_LEVEL", "info")
		const f = fixture()
		const prepared = await prepare(f)
		expect((await persist(f, prepared)).structuredCreated).toBe(1)
		expect(decisions()).toEqual([])
	})

	it("explains a context-derived candidate rejection", async () => {
		const f = fixture()
		for (const row of f.table("test_events")) row.body = "uses TypeScript"
		const prepared = await prepare(f, { ...event, body: "uses TypeScript" }, [
			"uses TypeScript",
		])
		expect(prepared.structuredCandidates).toHaveLength(0)
		expect(decisions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stage: "prepare",
					reason: "context-derived",
				}),
			]),
		)
	})
	it("explains a vanished current evidence row", async () => {
		const f = fixture()
		f.rows.set("test_events", f.table("test_events").slice(1))
		const prepared = await prepare(f)
		expect(prepared.structuredCandidates).toHaveLength(0)
		expect(decisions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stage: "prepare",
					reason: "evidence-missing",
				}),
			]),
		)
	})
	it("explains an invalid existing durable revision", async () => {
		const f = fixture()
		const first = await prepare(f)
		f.table("test_structured_mem").push({
			...first.structuredCandidates[0],
			revision: 0,
			state: "active",
		})
		const prepared = await prepare(f)
		expect(prepared.structuredCandidates).toHaveLength(0)
		expect(decisions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stage: "prepare",
					reason: "existing-invalid",
				}),
			]),
		)
	})

	it("distinguishes regex-only dispatch, prefetched empty facts and provider failure", async () => {
		const f = fixture()
		const args = { db: f.db, prefix: "test_", event }
		await prepareDerivedMemoryPromotion(args)
		const chatCompletion = vi.fn(async () => {
			throw Error("private provider payload")
		})
		const provider = { name: "offline", chatCompletion }
		await prepareDerivedMemoryPromotion({
			...args,
			provider,
			prefetchedLlmFacts: [],
		})
		expect(chatCompletion).not.toHaveBeenCalled()
		await expect(
			prepareDerivedMemoryPromotion({ ...args, provider }),
		).rejects.toThrow("private provider payload")
		expect(chatCompletion).toHaveBeenCalledTimes(1)
		expect(decisions()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stage: "extraction",
					reason: "regex-only",
					count: 0,
				}),
				expect.objectContaining({
					stage: "extraction",
					reason: "prefetched-facts",
					count: 0,
				}),
				expect.objectContaining({
					stage: "extraction",
					reason: "provider-error",
				}),
			]),
		)
		expect(lines.join("\n")).not.toContain("private provider payload")
	})
})
