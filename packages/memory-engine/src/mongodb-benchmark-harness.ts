import { createSubsystemLogger, type MemoryScope } from "@memongo/lib"
import type {
	MemoryBenchmarkConversation,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkIngestResult,
	MemoryConversationImportResult,
	MemoryBenchmarkTurn,
} from "./types.js"
import {
	loadBenchmarkDataset,
	resolveBenchmarkDatasetPath,
} from "./mongodb-benchmark-dataset.js"

const log = createSubsystemLogger("memory:mongodb:benchmark-harness")

export { loadBenchmarkDataset, resolveBenchmarkDatasetPath }

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
	writeTurn: (turn: {
		role: MemoryBenchmarkTurn["role"]
		body: string
		sessionId?: string
		timestamp?: Date
		metadata?: Record<string, unknown>
		scope?: MemoryScope
	}) => Promise<void>
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

	let conversationsImported = 0
	let turnsImported = 0
	let skippedConversations = 0
	let failedTurns = 0

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
			try {
				await params.writeTurn({
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
				})
				turnsImported++
			} catch (err) {
				failedTurns++
				log.warn("conversation dataset replay turn failed", {
					datasetPath: params.datasetPath,
					datasetName: params.datasetName,
					sessionId,
					role: turn.role,
					error: err,
				})
			}
		}
		conversationsImported++
	}

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
	writeTurn: (turn: {
		role: MemoryBenchmarkTurn["role"]
		body: string
		sessionId?: string
		timestamp?: Date
		metadata?: Record<string, unknown>
		scope?: MemoryScope
	}) => Promise<void>
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
	writeTurn: (turn: {
		role: MemoryBenchmarkTurn["role"]
		body: string
		sessionId?: string
		timestamp?: Date
		metadata?: Record<string, unknown>
		scope?: MemoryScope
	}) => Promise<void>
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
	writeTurn: (turn: {
		role: MemoryBenchmarkTurn["role"]
		body: string
		sessionId?: string
		timestamp?: Date
		metadata?: Record<string, unknown>
		scope?: MemoryScope
	}) => Promise<void>
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
	})
}
