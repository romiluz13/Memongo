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
 * up to S, in rank order. One count and one session-scoped fused query
 * (namespace and seeds on both inputs, each sized to every seed turn in
 * reach) keep the top T turns of each seed among its own turns. Returns only the
 * recalled turns whose canonical id and text are not already present, with
 * their lane, seed rank and in-session rank; `insertRecalledTurns` places
 * them.
 */
export async function recallSessionTurns(params: {
	db: Db
	prefix: string
	query: string
	questionDate: Date | undefined
	namespace: SessionNamespace
	/** Stage-1 results in final order. */
	results: MemorySearchResult[]
	capabilities: DetectedCapabilities
	embeddingMode: ResolvedMongoDBConfig["embeddingMode"]
	queryEmbeddingModel: ResolvedMongoDBConfig["queryEmbeddingModel"]
	onTierOutcome?: SearchTierOutcomeSink
}): Promise<MemorySearchResult[]> {
	const seeds = selectSeedSessions(params.results)
	const picked = await selectSessionScopedTurns({
		db: params.db,
		prefix: params.prefix,
		namespace: params.namespace,
		sessionIds: seeds,
		perSession: SESSION_TURN_RECALL_TURNS_PER_SESSION,
		policy: {
			kind: "fused",
			query: params.query,
			asOf: params.questionDate,
			capabilities: params.capabilities,
			embeddingMode: params.embeddingMode,
			queryEmbeddingModel: params.queryEmbeddingModel,
		},
		onTierOutcome: params.onTierOutcome,
	})
	const seenIds = new Set(params.results.map(searchResultIdentityKey))
	const seenTexts = new Set(params.results.map(textDigest))
	const recalled: MemorySearchResult[] = []
	for (const { result, sessionId, inSessionRank } of picked) {
		const id = searchResultIdentityKey(result)
		const digest = textDigest(result)
		if (seenIds.has(id) || seenTexts.has(digest)) continue
		seenIds.add(id)
		seenTexts.add(digest)
		recalled.push({
			...result,
			sessionId,
			provenance: {
				...(result.provenance ?? {}),
				lane: "session-turn-recall",
				sessionTurnRecall: true,
				seedRank: seeds.indexOf(sessionId) + 1,
				inSessionRank,
				fusedScore: result.score,
			},
		})
	}
	return recalled
}

/** What the capped merge did with the recalled turns, and why. */
export type SessionTurnRecallMergeSummary = {
	recalled: number
	inserted: number
	/** Later stage-1 results of a session that keeps its best one, evicted from the tail for room. */
	stageOneEvicted: number
	/** Recalled turns dropped because no evictable stage-1 result was left. */
	recalledDroppedForRoom: number
	/** Recalled turns whose session's best stage-1 result lies past maxResults. */
	recalledDroppedPastCap: number
}

/**
 * Each recalled turn goes right after the first (best) stage-1 result of its
 * session among the first maxResults, in recall order, and takes that
 * result's score so the final order-preserving normalization keeps it in
 * place. maxResults stays the hard cap. On overflow, stage-1 results leave
 * from the tail only while their session keeps its best result, so every
 * stage-1 session stays represented; if that is not enough, the recalled
 * turns with the highest in-session rank go, the latest inserted first.
 */
export function insertRecalledTurns(
	results: MemorySearchResult[],
	recalled: MemorySearchResult[],
	maxResults: number,
): { results: MemorySearchResult[]; summary: SessionTurnRecallMergeSummary } {
	const base = results.slice(0, maxResults)
	const anchorIndex = new Map<string, number>()
	base.forEach((result, index) => {
		const sessionId = result.sessionId?.trim()
		if (sessionId && !anchorIndex.has(sessionId)) {
			anchorIndex.set(sessionId, index)
		}
	})
	const placed: Array<{ turn: MemorySearchResult; anchor: number }> = []
	let recalledDroppedPastCap = 0
	for (const turn of recalled) {
		const anchor = anchorIndex.get(turn.sessionId as string)
		if (anchor === undefined) {
			recalledDroppedPastCap += 1
		} else {
			placed.push({ turn, anchor })
		}
	}
	let overflow = base.length + placed.length - maxResults
	const evicted = new Set<number>()
	for (let index = base.length - 1; index >= 0 && overflow > 0; index -= 1) {
		const sessionId = base[index]?.sessionId?.trim()
		if (sessionId && anchorIndex.get(sessionId) !== index) {
			evicted.add(index)
			overflow -= 1
		}
	}
	const inMergeOrder = placed
		.map((entry, order) => ({ ...entry, order }))
		.toSorted(
			(left, right) => left.anchor - right.anchor || left.order - right.order,
		)
	const dropped = new Set(
		inMergeOrder
			.map((entry, position) => ({ ...entry, position }))
			.toSorted(
				(left, right) =>
					inSessionRankOf(right.turn) - inSessionRankOf(left.turn) ||
					right.position - left.position,
			)
			.slice(0, Math.max(overflow, 0))
			.map((entry) => entry.turn),
	)
	const merged: MemorySearchResult[] = []
	base.forEach((result, index) => {
		if (evicted.has(index)) return
		merged.push(result)
		for (const entry of inMergeOrder) {
			if (entry.anchor === index && !dropped.has(entry.turn)) {
				merged.push({ ...entry.turn, score: result.score })
			}
		}
	})
	return {
		results: merged,
		summary: {
			recalled: recalled.length,
			inserted: placed.length - dropped.size,
			stageOneEvicted: evicted.size,
			recalledDroppedForRoom: dropped.size,
			recalledDroppedPastCap,
		},
	}
}

function inSessionRankOf(result: MemorySearchResult): number {
	const rank = result.provenance?.inSessionRank
	return typeof rank === "number" ? rank : 0
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
