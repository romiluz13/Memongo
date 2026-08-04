import { createHash } from "node:crypto"
import { createSubsystemLogger, type MemoryScope } from "@memongo/lib"
import type {
	MemoryBenchmarkConversation,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkIngestResult,
	MemoryConversationImportResult,
	MemoryBenchmarkTurn,
} from "../../packages/memory-engine/src/types.js"
import {
	loadBenchmarkDataset,
	resolveBenchmarkDatasetPath,
} from "./mongodb-benchmark-dataset.js"

const log = createSubsystemLogger("memory:mongodb:benchmark-harness")

export { loadBenchmarkDataset, resolveBenchmarkDatasetPath }

/**
 * B6: bound for importer write batches submitted to
 * writeConversationEventsBatch. Matches the MAX_WRITE_EVENTS_BATCH envelope
 * the /v1/write-events route enforces (apps/api/src/routes/v1.ts), so an
 * import never submits a batch the canonical write-events API would reject.
 */
export const IMPORT_WRITE_BATCH_SIZE = 500

/** Turn payload the replay loop hands to the per-turn write callback. */
export type ConversationReplayTurn = {
	role: MemoryBenchmarkTurn["role"]
	body: string
	sessionId?: string
	timestamp?: Date
	metadata?: Record<string, unknown>
	scope?: MemoryScope
}

/**
 * B6: batched turn payload. Each item carries a deterministic idempotency
 * key derived from the dataset identity and turn ordinal, so re-running an
 * import replays through the batch write API instead of duplicating events.
 */
export type ConversationReplayBatchTurn = ConversationReplayTurn & {
	idempotencyKey: string
}

/**
 * B6: per-item receipt from a batched write. Mirrors the ok/failed shape of
 * WriteConversationEventReceipt; a failed item never fails its siblings.
 */
export type ConversationReplayReceipt =
	| { ok: true }
	| { ok: false; code?: string; message?: string }

function parseTimestamp(value?: string): Date | undefined {
	if (!value) {
		return undefined
	}
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function buildReplayMetadata(params: {
	baseMetadata?: Record<string, unknown>
	turnMetadata?: Record<string, unknown>
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind
	conversationId: string
	metadataFlavor: "benchmark" | "import"
}): Record<string, unknown> {
	if (params.metadataFlavor === "benchmark") {
		return {
			...(params.baseMetadata ?? {}),
			...(params.turnMetadata ?? {}),
			benchmarkDataset: params.datasetName,
			benchmarkDatasetKind: params.datasetKind,
			benchmarkConversationId: params.conversationId,
		}
	}
	return {
		...(params.baseMetadata ?? {}),
		...(params.turnMetadata ?? {}),
		importDataset: params.datasetName,
		importDatasetKind: params.datasetKind,
		importConversationId: params.conversationId,
	}
}

/**
 * B6: deterministic idempotency identity for a replayed turn. The key mixes
 * the dataset path with the running turn ordinal and the turn content, so
 * re-running the same import reproduces the same keys (the batch write API
 * replays them instead of duplicating) while a content change under an
 * existing key surfaces as an idempotency conflict rather than a silent
 * wrong replay.
 */
function buildReplayIdempotencyKey(params: {
	datasetPath: string
	metadataFlavor: "benchmark" | "import"
	turnOrdinal: number
	sessionId: string
	role: MemoryBenchmarkTurn["role"]
	body: string
	timestamp?: Date
}): string {
	const fingerprint = createHash("sha256")
		.update(
			[
				params.datasetPath,
				String(params.turnOrdinal),
				params.sessionId,
				params.role,
				params.body,
				params.timestamp?.toISOString() ?? "",
			].join("\n"),
		)
		.digest("hex")
	return `dataset-replay-${params.metadataFlavor}:${fingerprint}`
}

async function replayConversationDataset(params: {
	datasetPath: string
	datasetName?: string
	datasetKind?: MemoryBenchmarkDatasetKind
	conversations: MemoryBenchmarkConversation[]
	failedLines?: number
	scope?: MemoryScope
	limitConversations?: number
	limitTurnsPerConversation?: number
	metadata?: Record<string, unknown>
	metadataFlavor: "benchmark" | "import"
	writeTurn?: (turn: ConversationReplayTurn) => Promise<void>
	writeTurns?: (
		turns: ConversationReplayBatchTurn[],
	) => Promise<ConversationReplayReceipt[]>
}): Promise<MemoryConversationImportResult> {
	const startedAt = new Date()
	const conversationLimit =
		typeof params.limitConversations === "number" &&
		params.limitConversations > 0
			? Math.floor(params.limitConversations)
			: Number.POSITIVE_INFINITY
	const turnLimit =
		typeof params.limitTurnsPerConversation === "number" &&
		params.limitTurnsPerConversation > 0
			? Math.floor(params.limitTurnsPerConversation)
			: Number.POSITIVE_INFINITY
	const batchWrite = params.writeTurns
	if (!batchWrite && typeof params.writeTurn !== "function") {
		throw new Error(
			"replayConversationDataset requires a writeTurn or writeTurns callback",
		)
	}

	let conversationsImported = 0
	let turnsImported = 0
	let skippedConversations = 0
	let failedTurns = 0
	// Running per-replay ordinal. Combined with the dataset path it makes each
	// batched item's idempotency key deterministic across re-runs of the same
	// import without being confused by repeated turn bodies inside a dataset.
	let turnOrdinal = 0

	const logTurnFailure = (context: {
		sessionId: string
		role: MemoryBenchmarkTurn["role"]
		error: string
	}): void => {
		failedTurns++
		// Log the message, never the error object. A driver error carries the
		// entire replica-set topology — every host, every field — which
		// serializes to roughly 3 KB per failed turn. A full LongMemEval run
		// replays ~269,000 turns, so one sustained outage buried the actual
		// signal under gigabytes of identical topology dumps.
		log.warn("conversation dataset replay turn failed", {
			datasetPath: params.datasetPath,
			datasetName: params.datasetName,
			sessionId: context.sessionId,
			role: context.role,
			error: context.error,
		})
	}

	// B6: batch flush. Awaits sequentially in dataset order, so chunking never
	// reorders the replay. Per-item receipts map onto the same failure
	// contract as the per-turn path (failedTurns++ and continue); a
	// batch-level throw fails every item in the chunk and the replay
	// continues with the next chunk.
	type PendingBatchItem = {
		payload: ConversationReplayBatchTurn
		sessionId: string
		role: MemoryBenchmarkTurn["role"]
	}
	const pendingBatch: PendingBatchItem[] = []
	const flushBatch = async (): Promise<void> => {
		if (pendingBatch.length === 0 || !batchWrite) {
			return
		}
		const chunk = pendingBatch.splice(0, pendingBatch.length)
		let receipts: ConversationReplayReceipt[] | undefined
		try {
			receipts = await batchWrite(chunk.map((item) => item.payload))
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err)
			for (const item of chunk) {
				logTurnFailure({ sessionId: item.sessionId, role: item.role, error })
			}
			return
		}
		for (const [index, item] of chunk.entries()) {
			const receipt = receipts?.[index]
			if (receipt?.ok === true) {
				turnsImported++
				continue
			}
			logTurnFailure({
				sessionId: item.sessionId,
				role: item.role,
				error:
					receipt && receipt.ok === false
						? (receipt.message ?? receipt.code ?? "write failed")
						: "write failed",
			})
		}
	}

	for (const [index, conversation] of params.conversations.entries()) {
		if (conversationsImported >= conversationLimit) {
			break
		}
		const turns = conversation.turns.slice(0, turnLimit)
		if (turns.length === 0) {
			skippedConversations++
			continue
		}
		const sessionId =
			conversation.sessionId ??
			conversation.conversationId ??
			`conversation-${index + 1}`
		const scope = conversation.scope ?? params.scope
		for (const turn of turns) {
			const payload: ConversationReplayTurn = {
				role: turn.role,
				body: turn.body,
				sessionId,
				timestamp: parseTimestamp(turn.timestamp),
				metadata: buildReplayMetadata({
					baseMetadata: params.metadata,
					turnMetadata: turn.metadata,
					datasetName: params.datasetName,
					datasetKind: params.datasetKind,
					conversationId: conversation.conversationId ?? sessionId,
					metadataFlavor: params.metadataFlavor,
				}),
				scope,
			}
			const ordinal = turnOrdinal++
			if (batchWrite) {
				pendingBatch.push({
					payload: {
						...payload,
						idempotencyKey: buildReplayIdempotencyKey({
							datasetPath: params.datasetPath,
							metadataFlavor: params.metadataFlavor,
							turnOrdinal: ordinal,
							sessionId,
							role: turn.role,
							body: turn.body,
							timestamp: payload.timestamp,
						}),
					},
					sessionId,
					role: turn.role,
				})
				if (pendingBatch.length >= IMPORT_WRITE_BATCH_SIZE) {
					await flushBatch()
				}
				continue
			}
			try {
				await params.writeTurn?.(payload)
				turnsImported++
			} catch (err) {
				logTurnFailure({
					sessionId,
					role: turn.role,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
		conversationsImported++
	}
	await flushBatch()

	return {
		datasetPath: params.datasetPath,
		datasetName: params.datasetName,
		datasetKind: params.datasetKind,
		conversationsImported,
		turnsImported,
		skippedConversations,
		failedLines: params.failedLines ?? 0,
		failedTurns,
		startedAt,
		completedAt: new Date(),
	}
}

export async function ingestBenchmarkConversations(params: {
	datasetPath: string
	datasetName?: string
	conversations: MemoryBenchmarkConversation[]
	failedLines?: number
	scope?: MemoryScope
	limitConversations?: number
	limitTurnsPerConversation?: number
	metadata?: Record<string, unknown>
	writeTurn?: (turn: ConversationReplayTurn) => Promise<void>
	writeTurns?: (
		turns: ConversationReplayBatchTurn[],
	) => Promise<ConversationReplayReceipt[]>
}): Promise<MemoryBenchmarkIngestResult> {
	const result = await replayConversationDataset({
		datasetPath: params.datasetPath,
		datasetName: params.datasetName,
		conversations: params.conversations,
		failedLines: params.failedLines,
		scope: params.scope,
		limitConversations: params.limitConversations,
		limitTurnsPerConversation: params.limitTurnsPerConversation,
		metadata: params.metadata,
		metadataFlavor: "benchmark",
		writeTurn: params.writeTurn,
		writeTurns: params.writeTurns,
	})
	return {
		datasetPath: result.datasetPath,
		datasetName: result.datasetName,
		conversationsIngested: result.conversationsImported,
		turnsIngested: result.turnsImported,
		skippedConversations: result.skippedConversations,
		failedLines: result.failedLines,
		failedTurns: result.failedTurns,
		startedAt: result.startedAt,
		completedAt: result.completedAt,
	}
}

export async function ingestBenchmarkDataset(params: {
	datasetPath: string
	baseDir?: string
	allowedRoots?: string[]
	scope?: MemoryScope
	limitConversations?: number
	limitTurnsPerConversation?: number
	metadata?: Record<string, unknown>
	writeTurn?: (turn: ConversationReplayTurn) => Promise<void>
	writeTurns?: (
		turns: ConversationReplayBatchTurn[],
	) => Promise<ConversationReplayReceipt[]>
}): Promise<MemoryBenchmarkIngestResult> {
	const dataset = await loadBenchmarkDataset(params.datasetPath, {
		baseDir: params.baseDir,
		allowedRoots: params.allowedRoots,
	})
	return ingestBenchmarkConversations({
		datasetPath: params.datasetPath,
		datasetName: dataset.name,
		conversations: dataset.conversations,
		failedLines: dataset.failedLines,
		scope: params.scope,
		limitConversations: params.limitConversations,
		limitTurnsPerConversation: params.limitTurnsPerConversation,
		metadata: params.metadata,
		writeTurn: params.writeTurn,
		writeTurns: params.writeTurns,
	})
}

export async function importConversationDataset(params: {
	datasetPath: string
	baseDir?: string
	allowedRoots?: string[]
	scope?: MemoryScope
	limitConversations?: number
	limitTurnsPerConversation?: number
	metadata?: Record<string, unknown>
	writeTurn?: (turn: ConversationReplayTurn) => Promise<void>
	writeTurns?: (
		turns: ConversationReplayBatchTurn[],
	) => Promise<ConversationReplayReceipt[]>
}): Promise<MemoryConversationImportResult> {
	const dataset = await loadBenchmarkDataset(params.datasetPath, {
		baseDir: params.baseDir,
		allowedRoots: params.allowedRoots,
	})
	return replayConversationDataset({
		datasetPath: params.datasetPath,
		datasetName: dataset.name,
		datasetKind: dataset.datasetKind,
		conversations: dataset.conversations,
		failedLines: dataset.failedLines,
		scope: params.scope,
		limitConversations: params.limitConversations,
		limitTurnsPerConversation: params.limitTurnsPerConversation,
		metadata: params.metadata,
		metadataFlavor: "import",
		writeTurn: params.writeTurn,
		writeTurns: params.writeTurns,
	})
}
