import { settledFailureMeta } from "./query-diagnostics.js"
/**
 * C-017 (WS-10): persistent per-tenant per-day spend accounting.
 *
 * The run-scoped accounting in mongodb-operation-accounting.ts answers "what
 * did THIS benchmark run cost in operations?" but production had no ledger:
 * LLM transports discarded the provider usage block, automated embeddings
 * execute inside mongot (invisible to this process), and nothing wrote
 * per-tenant sums anywhere durable.
 *
 * This module closes that gap with one plain collection, memory_cost_ledger:
 * one document per (agentId, UTC day, kind), $inc counters for LLM
 * input/output tokens and embedding units. Recording is fire-and-forget like
 * telemetry emit — a ledger write can never fail a memory operation — but
 * unsampled and 90-day retained, because cost sums are billing-grade data,
 * not observability noise (see mongodb-telemetry.ts for the sampled channel).
 *
 * Embedding units are OPERATION counts, not billable-token counts: with
 * autoEmbed the embedding runs server-side and its token meter is not exposed
 * to the calling process. One unit = one write or query that triggers a
 * server-side embed of one indexed field. The cost model table in
 * docs/cost-model.md converts units to dollars for a configured model.
 */
import type { ClientSession, Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { costLedgerCollection } from "./mongodb-schema-collections.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import {
	type AdmissionToken,
	captureAdmissionToken,
	ErasureGateConflictError,
	withFencedWrite,
} from "./mongodb-write-fence.js"

const log = createSubsystemLogger("memory:mongodb:cost-ledger")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Ledger channels. "llm" counts provider tokens; the rest count embedding
 * units by the pipeline that triggered them:
 * - "search": query-time lane probes (from the per-request search budget)
 * - "consolidation": consolidator similarity probes
 * - "indexing": writes that trigger a server-side re-embed of indexed text
 */
export type CostSpendKind = "llm" | "search" | "consolidation" | "indexing"

export type CostLedgerEmbeddingKind = Exclude<CostSpendKind, "llm">

export type DailyCostSum = {
	/** UTC calendar day, "YYYY-MM-DD". */
	day: string
	inputTokens: number
	outputTokens: number
	embedUnits: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UTC calendar day for a ledger document key. */
export function costLedgerDay(date: Date = new Date()): string {
	return date.toISOString().slice(0, 10)
}

function positiveCount(value: number | undefined): number | null {
	if (value === undefined) return null
	if (!Number.isFinite(value) || value <= 0) return null
	return Math.floor(value)
}

async function incrementLedger(params: {
	db: Db
	prefix: string
	agentId: string
	day: string
	kind: CostSpendKind
	inc: Record<string, number>
	admission?: AdmissionToken
}): Promise<void> {
	const now = new Date()
	const admission = params.admission ?? (await captureAdmissionToken(params))
	if (admission.agentId !== params.agentId)
		throw new ErasureGateConflictError(params.agentId)
	await withFencedWrite({
		db: params.db,
		prefix: params.prefix,
		token: admission,
		fn: async (session) => {
			await costLedgerCollection(params.db, params.prefix).updateOne(
				{ agentId: params.agentId, day: params.day, kind: params.kind },
				{
					$inc: params.inc,
					$set: { updatedAt: now },
					$setOnInsert: { createdAt: now },
				},
				{ upsert: true, session },
			)
		},
	})
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record LLM token spend from a provider transport usage block
 * (EnrichmentChatUsage). No-op when either count is missing or non-positive.
 */
export function recordLLMSpend(
	db: Db,
	prefix: string,
	agentId: string,
	spend: { inputTokens?: number; outputTokens?: number },
): void
export function recordLLMSpend(
	db: Db,
	prefix: string,
	agentId: string,
	spend: { inputTokens?: number; outputTokens?: number },
	options: { admission?: AdmissionToken },
): Promise<void>
export function recordLLMSpend(
	db: Db,
	prefix: string,
	agentId: string,
	spend: { inputTokens?: number; outputTokens?: number },
	options?: { admission?: AdmissionToken },
): void | Promise<void> {
	const inputTokens = positiveCount(spend.inputTokens)
	const outputTokens = positiveCount(spend.outputTokens)
	if (inputTokens === null && outputTokens === null) {
		return options ? Promise.resolve() : undefined
	}
	const pending = incrementLedger({
		db,
		prefix,
		agentId,
		day: costLedgerDay(),
		kind: "llm",
		admission: options?.admission,
		inc: {
			...(inputTokens !== null ? { inputTokens } : {}),
			...(outputTokens !== null ? { outputTokens } : {}),
		},
	})
	if (options) return pending
	void pending.catch((err) => {
		log.warn("cost ledger write failed", {
			agentId,
			kind: "llm",
			...settledFailureMeta(err),
		})
	})
}

/**
 * Awaited/session-bound variant for guarded worker batches. Unlike the
 * fire-and-forget public recorder, a rejection aborts the caller transaction.
 */
export async function recordLLMSpendInSession(params: {
	db: Db
	prefix: string
	agentId: string
	spend: { inputTokens?: number; outputTokens?: number }
	session: ClientSession
	at?: Date
}): Promise<void> {
	const inputTokens = positiveCount(params.spend.inputTokens)
	const outputTokens = positiveCount(params.spend.outputTokens)
	if (inputTokens === null && outputTokens === null) {
		return
	}
	const now = params.at ?? new Date()
	await costLedgerCollection(params.db, params.prefix).updateOne(
		{
			agentId: params.agentId,
			day: costLedgerDay(now),
			kind: "llm",
		},
		{
			$inc: {
				...(inputTokens !== null ? { inputTokens } : {}),
				...(outputTokens !== null ? { outputTokens } : {}),
			},
			$set: { updatedAt: now },
			$setOnInsert: { createdAt: now },
		},
		{ upsert: true, session: params.session },
	)
}

/**
 * Record embedding-unit spend for a non-LLM channel. One unit = one
 * operation that triggers a server-side autoEmbed. No-op for units <= 0 so
 * call sites can pass counts unconditionally (e.g. a search budget snapshot
 * with zero embeds).
 */
export function recordEmbeddingSpend(
	db: Db,
	prefix: string,
	agentId: string,
	kind: CostLedgerEmbeddingKind,
	units: number,
): void
export function recordEmbeddingSpend(
	db: Db,
	prefix: string,
	agentId: string,
	kind: CostLedgerEmbeddingKind,
	units: number,
	options: { admission?: AdmissionToken },
): Promise<void>
export function recordEmbeddingSpend(
	db: Db,
	prefix: string,
	agentId: string,
	kind: CostLedgerEmbeddingKind,
	units: number,
	options?: { admission?: AdmissionToken },
): void | Promise<void> {
	if (!Number.isFinite(units) || units <= 0) {
		return options ? Promise.resolve() : undefined
	}
	const pending = incrementLedger({
		db,
		prefix,
		agentId,
		day: costLedgerDay(),
		kind,
		admission: options?.admission,
		inc: { embedUnits: Math.floor(units) },
	})
	if (options) return pending
	void pending.catch((err) => {
		log.warn("cost ledger write failed", {
			agentId,
			kind,
			...settledFailureMeta(err),
		})
	})
}

/** Awaited/session-bound embedding ledger update for guarded worker writes. */
export async function recordEmbeddingSpendInSession(params: {
	db: Db
	prefix: string
	agentId: string
	kind: CostLedgerEmbeddingKind
	units: number
	session: ClientSession
	at?: Date
}): Promise<void> {
	if (!Number.isFinite(params.units) || params.units <= 0) {
		return
	}
	const now = params.at ?? new Date()
	await costLedgerCollection(params.db, params.prefix).updateOne(
		{
			agentId: params.agentId,
			day: costLedgerDay(now),
			kind: params.kind,
		},
		{
			$inc: { embedUnits: Math.floor(params.units) },
			$set: { updatedAt: now },
			$setOnInsert: { createdAt: now },
		},
		{ upsert: true, session: params.session },
	)
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Per-day spend sums for one tenant over the last `days` UTC days (inclusive
 * of today). Returns only days with at least one ledger document, ascending.
 * Aggregation failures resolve to [] — the status surface treats cost data
 * as best-effort, same contract as every other getV2Status check.
 */
export async function getDailyCostSums(
	db: Db,
	prefix: string,
	agentId: string,
	days: number,
): Promise<DailyCostSum[]> {
	const windowDays = Math.max(1, Math.floor(days))
	const startDay = costLedgerDay(
		new Date(Date.now() - (windowDays - 1) * 86_400_000),
	)
	try {
		const rows = await costLedgerCollection(db, prefix)
			.aggregate([
				{ $match: { agentId, day: { $gte: startDay } } },
				{
					$group: {
						_id: "$day",
						inputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
						outputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
						embedUnits: { $sum: { $ifNull: ["$embedUnits", 0] } },
					},
				},
				{ $sort: { _id: 1 } },
			])
			.toArray()
		return rows.map((row) => ({
			day: String(row._id),
			inputTokens: Number(row.inputTokens) || 0,
			outputTokens: Number(row.outputTokens) || 0,
			embedUnits: Number(row.embedUnits) || 0,
		}))
	} catch (err) {
		log.warn("cost ledger daily sums failed", {
			agentId,
			...settledFailureMeta(err),
		})
		return []
	}
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/**
 * Wrap a resolved enrichment provider so every successful chat completion
 * records its token usage into the ledger. Applied at the production
 * provider-resolution seams (extraction jobs, session-batched prefetch,
 * consolidator) — benchmarks instead compose this with the run-scoped
 * instrumentOperationProvider wrapper. Failures propagate untouched; spend
 * is only recorded for responses that actually carried a usage block.
 */
export function instrumentProviderCostSpend(params: {
	db: Db
	prefix: string
	agentId: string
	provider: EnrichmentProvider
	onUsage?: (usage: {
		inputTokens?: number
		outputTokens?: number
		at: Date
	}) => void
}): EnrichmentProvider {
	return {
		...params.provider,
		async chatCompletion(request) {
			const response = await params.provider.chatCompletion(request)
			if (response.usage) {
				if (params.onUsage) {
					params.onUsage({ ...response.usage, at: new Date() })
				} else {
					recordLLMSpend(
						params.db,
						params.prefix,
						params.agentId,
						response.usage,
					)
				}
			}
			return response
		},
	}
}
