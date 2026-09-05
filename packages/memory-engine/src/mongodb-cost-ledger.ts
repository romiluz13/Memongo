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
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { costLedgerCollection } from "./mongodb-schema-collections.js"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"

const log = createSubsystemLogger("memory:mongodb:cost-ledger")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Ledger channels. "llm" counts provider tokens; the rest count embedding
 * units by the pipeline that triggered them:
 * - "search": query-time lane probes (from the per-request search budget)
 * - "cache-probe": query-cache tier-2 semantic lookups
 * - "consolidation": consolidator similarity probes
 * - "indexing": writes that trigger a server-side re-embed of indexed text
 */
export type CostSpendKind =
	| "llm"
	| "search"
	| "cache-probe"
	| "consolidation"
	| "indexing"

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

/**
 * Fire-and-forget $inc upsert onto the (agentId, day, kind) counter doc.
 * Never throws, never blocks: a failed ledger write logs and drops — cost
 * accounting must not be able to fail a memory operation. The try/catch
 * wraps the collection accessor too: a synchronous driver failure (bad Db
 * handle, pool shutdown) must degrade exactly like a rejected promise.
 */
function incrementLedger(params: {
	db: Db
	prefix: string
	agentId: string
	day: string
	kind: CostSpendKind
	inc: Record<string, number>
}): void {
	const now = new Date()
	try {
		costLedgerCollection(params.db, params.prefix)
			.updateOne(
				{ agentId: params.agentId, day: params.day, kind: params.kind },
				{
					$inc: params.inc,
					$set: { updatedAt: now },
					$setOnInsert: { createdAt: now },
				},
				{ upsert: true },
			)
			.catch((err) => {
				log.warn("cost ledger write failed", {
					agentId: params.agentId,
					kind: params.kind,
					error: err instanceof Error ? err.message : String(err),
				})
			})
	} catch (err) {
		log.warn("cost ledger write failed", {
			agentId: params.agentId,
			kind: params.kind,
			error: err instanceof Error ? err.message : String(err),
		})
	}
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
): void {
	const inputTokens = positiveCount(spend.inputTokens)
	const outputTokens = positiveCount(spend.outputTokens)
	if (inputTokens === null && outputTokens === null) {
		return
	}
	incrementLedger({
		db,
		prefix,
		agentId,
		day: costLedgerDay(),
		kind: "llm",
		inc: {
			...(inputTokens !== null ? { inputTokens } : {}),
			...(outputTokens !== null ? { outputTokens } : {}),
		},
	})
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
): void {
	if (!Number.isFinite(units) || units <= 0) {
		return
	}
	incrementLedger({
		db,
		prefix,
		agentId,
		day: costLedgerDay(),
		kind,
		inc: { embedUnits: Math.floor(units) },
	})
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
			error: err instanceof Error ? err.message : String(err),
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
}): EnrichmentProvider {
	return {
		...params.provider,
		async chatCompletion(request) {
			const response = await params.provider.chatCompletion(request)
			if (response.usage) {
				recordLLMSpend(params.db, params.prefix, params.agentId, response.usage)
			}
			return response
		},
	}
}
