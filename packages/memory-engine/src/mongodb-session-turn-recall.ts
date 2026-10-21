/**
 * C-1 stage 2: session-scoped turn recall. Opt-in through
 * `MEMONGO_SESSION_TURN_RECALL=enabled`; unset, nothing here runs and the
 * session cap keeps its original order.
 */

import { createHash } from "node:crypto"
import type { Db } from "mongodb"
import type { ResolvedMongoDBConfig } from "./backend-config.js"
import type { DetectedCapabilities } from "./mongodb-schema.js"
import { searchResultIdentityKey } from "./mongodb-search-ranking.js"
import {
	type SessionNamespace,
	type SessionScopedTurn,
	selectSessionScopedTurns,
} from "./mongodb-session-scoped-selector.js"
import type { SearchTierOutcomeSink } from "./search-outcomes.js"
import type { MemorySearchResult } from "./types.js"

export const SESSION_TURN_RECALL_ENV = "MEMONGO_SESSION_TURN_RECALL"

/** R: stage-1 results scanned for seed sessions. */
export const SESSION_TURN_RECALL_SEED_RESULTS = 20
/** S: seed sessions recalled into. */
export const SESSION_TURN_RECALL_SEED_SESSIONS = 8
/** T: turns kept per seed session. */
export const SESSION_TURN_RECALL_TURNS_PER_SESSION = 3

export function isSessionTurnRecallEnabled(): boolean {
	return process.env[SESSION_TURN_RECALL_ENV] === "enabled"
}

/**
 * Stage 2: seeds are the distinct sessions of the first R stage-1 results,
 * up to S, in rank order. One session-scoped fused query (namespace and
 * seeds on both inputs) keeps the top T turns per seed. Each recalled turn
 * goes right after its session's best stage-1 result, unless its canonical
 * id or its text is already present. Stage-1 results keep their order.
 */
export async function recallSessionTurns(params: {
	db: Db
	prefix: string
	query: string
	questionDate: Date | undefined
	namespace: SessionNamespace
	/** Stage-1 results in final order. */
	results: MemorySearchResult[]
	numCandidates: number
	capabilities: DetectedCapabilities
	embeddingMode: ResolvedMongoDBConfig["embeddingMode"]
	queryEmbeddingModel: ResolvedMongoDBConfig["queryEmbeddingModel"]
	onTierOutcome?: SearchTierOutcomeSink
}): Promise<MemorySearchResult[]> {
	const seeds = selectSeedSessions(params.results)
	const recalled = await selectSessionScopedTurns({
		db: params.db,
		prefix: params.prefix,
		namespace: params.namespace,
		sessionIds: seeds,
		asOf: params.questionDate,
		perSession: SESSION_TURN_RECALL_TURNS_PER_SESSION,
		policy: {
			kind: "fused",
			query: params.query,
			numCandidates: params.numCandidates,
			capabilities: params.capabilities,
			embeddingMode: params.embeddingMode,
			queryEmbeddingModel: params.queryEmbeddingModel,
		},
		onTierOutcome: params.onTierOutcome,
	})
	return mergeRecalledTurns(params.results, recalled, seeds)
}

function selectSeedSessions(results: MemorySearchResult[]): string[] {
	const seeds: string[] = []
	for (const result of results.slice(0, SESSION_TURN_RECALL_SEED_RESULTS)) {
		const sessionId = result.sessionId?.trim()
		if (!sessionId || seeds.includes(sessionId)) continue
		seeds.push(sessionId)
		if (seeds.length >= SESSION_TURN_RECALL_SEED_SESSIONS) break
	}
	return seeds
}

function textDigest(result: MemorySearchResult): string {
	return createHash("sha256")
		.update(result.text ?? result.snippet, "utf8")
		.digest("hex")
}

function mergeRecalledTurns(
	results: MemorySearchResult[],
	recalled: SessionScopedTurn[],
	seeds: string[],
): MemorySearchResult[] {
	const seenIds = new Set(results.map(searchResultIdentityKey))
	const seenTexts = new Set(results.map(textDigest))
	const bySession = new Map<string, MemorySearchResult[]>()
	for (const { result, sessionId, inSessionRank } of recalled) {
		const id = searchResultIdentityKey(result)
		const digest = textDigest(result)
		if (seenIds.has(id) || seenTexts.has(digest)) continue
		seenIds.add(id)
		seenTexts.add(digest)
		const bucket = bySession.get(sessionId) ?? []
		bucket.push({
			...result,
			provenance: {
				...(result.provenance ?? {}),
				lane: "session-turn-recall",
				sessionTurnRecall: true,
				seedRank: seeds.indexOf(sessionId) + 1,
				inSessionRank,
				fusedScore: result.score,
			},
		})
		bySession.set(sessionId, bucket)
	}
	const merged: MemorySearchResult[] = []
	for (const result of results) {
		merged.push(result)
		const sessionId = result.sessionId?.trim()
		const turns = sessionId ? bySession.get(sessionId) : undefined
		if (!sessionId || !turns) continue
		// The best stage-1 result of a session is its first; its score is
		// the recalled turns' place in the final, order-preserving scale.
		merged.push(...turns.map((turn) => ({ ...turn, score: result.score })))
		bySession.delete(sessionId)
	}
	return merged
}
