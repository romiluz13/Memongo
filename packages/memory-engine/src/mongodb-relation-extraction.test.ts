import { afterEach, describe, expect, it, vi } from "vitest"
import {
	EnrichmentParseError,
	EnrichmentResponseError,
	type EnrichmentChatUsage,
	type EnrichmentProvider,
	type EnrichmentResponseMeta,
} from "./mongodb-llm-enrichment.js"
import { extractTypedRelations } from "./mongodb-relation-extraction.js"

function providerReturning(content: string): EnrichmentProvider {
	return { name: "mock", chatCompletion: vi.fn(async () => ({ content })) }
}

const ENTITIES = [
	{ entityId: "e-alice", name: "Alice" },
	{ entityId: "e-api", name: "the API service" },
	{ entityId: "e-mongo", name: "MongoDB" },
]

describe("extractTypedRelations", () => {
	it("extracts a typed edge between two provided entities", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{
						from: "e-alice",
						to: "e-api",
						type: "works_on",
						confidence: 0.9,
						rationale: "Alice builds the API",
					},
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "Alice works on the API service, which depends on MongoDB.",
			entities: ENTITIES,
		})
		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			fromEntityId: "e-alice",
			toEntityId: "e-api",
			type: "works_on",
		})
		expect(result[0].confidence).toBeCloseTo(0.9)
	})

	it("drops relations referencing an entity id not in the provided set", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{
						from: "e-alice",
						to: "e-ghost",
						type: "depends_on",
						confidence: 0.8,
					},
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("drops 'owns' — it is not LLM-extractable (destructive write-side exclusivity)", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-alice", to: "e-api", type: "owns", confidence: 0.95 },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("drops edges below the minimum confidence floor", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-api", to: "e-mongo", type: "depends_on", confidence: 0.2 },
					{ from: "e-alice", to: "e-api", type: "works_on", confidence: 0.8 },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result.map((r) => r.type)).toEqual(["works_on"])
	})

	it("drops self-relations and the co-occurrence type mentioned_with", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-alice", to: "e-alice", type: "works_on", confidence: 1 },
					{
						from: "e-alice",
						to: "e-api",
						type: "mentioned_with",
						confidence: 1,
					},
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("drops an unknown relation type", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-api", to: "e-mongo", type: "loves", confidence: 0.7 },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toEqual([])
	})

	it("clamps confidence into [0,1] and defaults when missing", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-api", to: "e-mongo", type: "depends_on", confidence: 5 },
					{ from: "e-mongo", to: "e-api", type: "related_to" },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		const depends = result.find((r) => r.type === "depends_on")
		expect(depends?.confidence).toBe(1)
		const related = result.find((r) => r.type === "related_to")
		expect(related?.confidence).toBeGreaterThan(0)
		expect(related?.confidence).toBeLessThanOrEqual(1)
	})

	it("does not call the LLM when fewer than two entities are present", async () => {
		const provider = providerReturning(JSON.stringify({ relations: [] }))
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: [{ entityId: "e-alice", name: "Alice" }],
		})
		expect(result).toEqual([])
		expect(provider.chatCompletion).not.toHaveBeenCalled()
	})

	it("surfaces LLM failures so the durable job can retry", async () => {
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn(async () => {
				throw new Error("boom")
			}),
		}
		await expect(
			extractTypedRelations({
				provider,
				model: "m",
				text: "x",
				entities: ENTITIES,
			}),
		).rejects.toThrow("boom")
	})

	it("surfaces unparseable responses so the durable job can retry", async () => {
		const provider = providerReturning("not json")
		await expect(
			extractTypedRelations({
				provider,
				model: "m",
				text: "x",
				entities: ENTITIES,
			}),
		).rejects.toThrow()
	})

	it("deduplicates identical (from,to,type) triples", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-api", to: "e-mongo", type: "depends_on", confidence: 0.9 },
					{ from: "e-api", to: "e-mongo", type: "depends_on", confidence: 0.7 },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: "x",
			entities: ENTITIES,
		})
		expect(result).toHaveLength(1)
	})
})

describe("extractTypedRelations typed response gate (fail-loud)", () => {
	const TEXT = "Alice works on the API service, which depends on MongoDB."

	function providerWithMeta(
		content: string,
		responseMeta: EnrichmentResponseMeta,
		usage?: EnrichmentChatUsage,
	): EnrichmentProvider {
		return {
			name: "mock",
			chatCompletion: vi.fn(async () => ({
				content,
				responseMeta,
				...(usage ? { usage } : {}),
			})),
		}
	}

	async function collectResponseError(
		provider: EnrichmentProvider,
	): Promise<EnrichmentResponseError> {
		try {
			const relations = await extractTypedRelations({
				provider,
				model: "m",
				text: TEXT,
				entities: ENTITIES,
			})
			throw new Error(
				`expected a typed failure, got relations: ${JSON.stringify(relations)}`,
			)
		} catch (err) {
			expect(err).toBeInstanceOf(EnrichmentResponseError)
			return err as EnrichmentResponseError
		}
	}

	it("throws a typed refusal error (never an empty result) — refusal co-occurs with finish_reason=stop", async () => {
		// Structured Outputs fixture: refusal present, no content,
		// finish_reason=stop (refusal is derived before content classification).
		const provider = providerWithMeta("", {
			shape: "refusal",
			finishReason: "stop",
			refusal: true,
		})
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("refusal")
		expect(err.finishReason).toBe("stop")
		expect(err.refusal).toBe(true)
		expect(err.message).toContain("shape=refusal")
		expect(err.message).toContain("finishReason=stop")
		expect(err.message).toContain("refusal=true")
		expect(err.message).toContain("provider=mock")
	})

	it("throws a typed content-filter error for the Azure empty-200 fixture", async () => {
		// Azure content filtering: HTTP 200, no content,
		// finish_reason=content_filter.
		const provider = providerWithMeta("", {
			shape: "content-filter",
			finishReason: "content_filter",
			refusal: true,
		})
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("content-filter")
		expect(err.message).toContain("shape=content-filter")
		expect(err.message).toContain("finishReason=content_filter")
	})

	it("throws a typed length error for an empty completion cut by the token budget", async () => {
		const provider = providerWithMeta("", {
			shape: "length",
			finishReason: "length",
		})
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("length")
		expect(err.message).toContain("shape=length")
	})

	it("throws a typed length error for NON-EMPTY truncated content (typed before parse)", async () => {
		// Truncated mid-JSON by the budget: the gate fires before any parse.
		const provider = providerWithMeta('{"relations":[{"from":"e-alice"', {
			shape: "length",
			finishReason: "length",
		})
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("length")
	})

	it("length + non-empty SYNTACTICALLY VALID JSON still cannot evade the length class", async () => {
		// Lead correction: a completion that parses but was cut by the budget is
		// semantically truncated — it must not masquerade as ok.
		const provider = providerWithMeta(
			JSON.stringify({
				relations: [
					{ from: "e-alice", to: "e-api", type: "works_on", confidence: 0.9 },
				],
			}),
			{ shape: "length", finishReason: "length" },
		)
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("length")
	})

	it("throws for transient empty content with a valid envelope", async () => {
		const provider = providerWithMeta("", {
			shape: "empty-content",
			finishReason: "stop",
		})
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("empty-content")
	})

	it("throws for null content", async () => {
		const provider = providerWithMeta("", { shape: "null-content" })
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("null-content")
	})

	it("throws for the 200 error-object / missing-choices envelope (default-deny)", async () => {
		const provider = providerWithMeta("", { shape: "missing-choices" })
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("missing-choices")
	})

	it("throws for a malformed message envelope", async () => {
		const provider = providerWithMeta("", { shape: "malformed-message" })
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("malformed-message")
	})

	it("throws for a malformed (unparseable) body reported as metadata", async () => {
		const provider = providerWithMeta("", { shape: "malformed-body" })
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("malformed-body")
	})

	it("carries the usage fragment (incl. reasoning tokens) for budget evidence", async () => {
		const provider = providerWithMeta(
			"",
			{ shape: "length", finishReason: "length" },
			{ inputTokens: 410, outputTokens: 2048, reasoningTokens: 1899 },
		)
		const err = await collectResponseError(provider)
		expect(err.usage).toEqual({
			inputTokens: 410,
			outputTokens: 2048,
			reasoningTokens: 1899,
		})
		expect(err.message).toContain("tokens in=410 out=2048 reasoning=1899")
	})

	it("labels parse failures with finishReason/provider and carries NO payload preview (F7)", async () => {
		const provider: EnrichmentProvider = {
			name: "mock",
			chatCompletion: vi.fn(async () => ({
				content: "not json but definitely model output worth keeping private",
				responseMeta: { shape: "ok", finishReason: "stop" },
			})),
		}
		await expect(
			extractTypedRelations({
				provider,
				model: "m",
				text: TEXT,
				entities: ENTITIES,
			}),
		).rejects.toThrow("relation extraction JSON parse failed")
		try {
			await extractTypedRelations({
				provider,
				model: "m",
				text: TEXT,
				entities: ENTITIES,
			})
		} catch (err) {
			expect(err).toBeInstanceOf(EnrichmentParseError)
			const message = (err as EnrichmentParseError).message
			expect(message).toContain("finishReason=stop")
			expect(message).toContain("provider=mock")
			expect(message).not.toContain("not json")
			expect(message).not.toContain("private")
		}
	})

	it("keeps the legacy no-responseMeta valid path unchanged (backward compatibility)", async () => {
		const provider = providerReturning(
			JSON.stringify({
				relations: [
					{ from: "e-alice", to: "e-api", type: "works_on", confidence: 0.9 },
				],
			}),
		)
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: TEXT,
			entities: ENTITIES,
		})
		expect(result).toHaveLength(1)
	})

	it("treats legacy empty content without responseMeta as the empty-content shape", async () => {
		const provider = providerReturning("")
		const err = await collectResponseError(provider)
		expect(err.shape).toBe("empty-content")
		expect(err.message).toContain("shape=empty-content")
	})
})

const RELATION_CAP_ENV = "MEMONGO_LLM_RELATION_EXTRACTION_MAX_TOKENS"

function requestCapturingProvider(response: {
	content: string
	responseMeta?: EnrichmentResponseMeta
	usage?: EnrichmentChatUsage
}): EnrichmentProvider {
	return {
		name: "mock",
		chatCompletion: vi.fn(async () => response),
	}
}

describe("relation extraction completion limit (released repair 2026-09-21)", () => {
	const TEXT = "Alice works on the API service, which depends on MongoDB."

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("sends the default 2048 completion limit when no override is configured", async () => {
		// Hermetic default: explicitly unset so an inherited ambient value
		// can never masquerade as the default.
		vi.stubEnv(RELATION_CAP_ENV, undefined)
		const provider = requestCapturingProvider({
			content: '{"relations":[]}',
			responseMeta: { shape: "ok", finishReason: "stop" },
		})
		const result = await extractTypedRelations({
			provider,
			model: "m",
			text: TEXT,
			entities: ENTITIES,
		})
		expect(result).toEqual([])
		expect(provider.chatCompletion).toHaveBeenCalledWith(
			expect.objectContaining({ maxTokens: 2048 }),
		)
	})

	it("treats an empty override value as unset (facts-lane convention)", async () => {
		vi.stubEnv(RELATION_CAP_ENV, "")
		const provider = requestCapturingProvider({
			content: '{"relations":[]}',
			responseMeta: { shape: "ok", finishReason: "stop" },
		})
		await extractTypedRelations({
			provider,
			model: "m",
			text: TEXT,
			entities: ENTITIES,
		})
		expect(provider.chatCompletion).toHaveBeenCalledWith(
			expect.objectContaining({ maxTokens: 2048 }),
		)
	})

	it("sends an explicit positive-integer override as the completion limit", async () => {
		vi.stubEnv(RELATION_CAP_ENV, "4096")
		const provider = requestCapturingProvider({
			content: '{"relations":[]}',
			responseMeta: { shape: "ok", finishReason: "stop" },
		})
		await extractTypedRelations({
			provider,
			model: "m",
			text: TEXT,
			entities: ENTITIES,
		})
		expect(provider.chatCompletion).toHaveBeenCalledWith(
			expect.objectContaining({ maxTokens: 4096 }),
		)
	})

	it.each([
		"0",
		"-5",
		"12.5",
		"abc",
		"9007199254740992",
	])("refuses an invalid override (%s) BEFORE dispatch, sanitized", async (raw) => {
		vi.stubEnv(RELATION_CAP_ENV, raw)
		const provider = requestCapturingProvider({
			content: '{"relations":[]}',
			responseMeta: { shape: "ok", finishReason: "stop" },
		})
		let caught: Error | undefined
		try {
			await extractTypedRelations({
				provider,
				model: "m",
				text: TEXT,
				entities: ENTITIES,
			})
		} catch (err) {
			caught = err as Error
		}
		expect(caught).toBeInstanceOf(Error)
		expect(caught?.message).toContain(
			"MEMONGO_LLM_RELATION_EXTRACTION_MAX_TOKENS must be a positive integer",
		)
		// Sanitized refusal: the raw env value never enters the diagnostic.
		expect(caught?.message).not.toContain(raw)
		expect(provider.chatCompletion).not.toHaveBeenCalled()
	})

	it("still propagates a typed length failure at an increased cap (no error hiding)", async () => {
		vi.stubEnv(RELATION_CAP_ENV, "4096")
		const provider = requestCapturingProvider({
			content: '{"relations":',
			responseMeta: { shape: "length", finishReason: "length" },
		})
		let caught: unknown
		try {
			await extractTypedRelations({
				provider,
				model: "m",
				text: TEXT,
				entities: ENTITIES,
			})
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(EnrichmentResponseError)
		const err = caught as EnrichmentResponseError
		expect(err.shape).toBe("length")
		expect(err.message).toContain("shape=length")
		expect(err.message).toContain("finishReason=length")
		expect(provider.chatCompletion).toHaveBeenCalledWith(
			expect.objectContaining({ maxTokens: 4096 }),
		)
	})
})
