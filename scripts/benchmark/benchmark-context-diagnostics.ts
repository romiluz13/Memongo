import { createHash } from "node:crypto"
import type {
	BenchmarkCaseContextDiagnostics,
	BenchmarkContextPassageDiagnostic,
	BenchmarkContextProvenance,
	BenchmarkDiagnosticTruth,
	BenchmarkGoldSentStatus,
	BenchmarkGoldSessionDiagnostic,
	BenchmarkGoldTurnDiagnostic,
	MemoryBenchmarkConversation,
	MemorySearchResult,
} from "../../packages/memory-engine/src/types.js"

/**
 * Diagnostics for the legacy custom-v1 answer path: which passages the
 * answerer was sent and whether each gold session and gold turn was among
 * them. Observation only; nothing here feeds a prompt, a provider call or a
 * verdict.
 */

/** Version of the sent-status rule; bump when the rule changes. */
export const CONTEXT_MATCH_RULE = "containment-v2"

const PREVIEW_CHARACTERS = 200

/** Lineage of one search result, captured at pass 0 beside its text. */
export type ResultLineage = {
	/** 1-based position in the search results. */
	retrievedRank: number
	memoryId: string
	score: number
	sessionIds: string[]
	turnIds: string[]
	provenance: BenchmarkContextProvenance
}

export type GoldSessionTarget = {
	admittedSessionIndex: number
	sessionId: string
}

export type GoldTurnTarget = {
	admittedSessionIndex: number
	sessionId: string
	turnIndex: number
	turnId: string
	/** The admitted turn body, the text the containment rule looks for. */
	text: string
}

/**
 * Pass-0 observations for one case. `sentCandidates` is index-aligned with the
 * case's `contextPassages`; the rank maps cover every search result, including
 * those without text that were never sent.
 */
export type Pass0ContextDiagnostics = {
	sentCandidates: ResultLineage[]
	retrievedSessionRanks: Map<string, number>
	retrievedTurnRanks: Map<string, number>
	gold:
		| { applicable: false; reason: "abstention" | "no-has-answer-marker" }
		| {
				applicable: true
				sessions: GoldSessionTarget[]
				turns: GoldTurnTarget[]
		  }
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}

function preview(text: string): string {
	return Array.from(text).slice(0, PREVIEW_CHARACTERS).join("")
}

export function buildCaseContextDiagnostics(params: {
	contextPassages: string[]
	maxPassages: number
	diagnostics: Pass0ContextDiagnostics
}): BenchmarkCaseContextDiagnostics {
	const { contextPassages, diagnostics } = params
	if (diagnostics.sentCandidates.length !== contextPassages.length) {
		throw new Error(
			`diagnostics describe ${diagnostics.sentCandidates.length} passages but the case has ${contextPassages.length}`,
		)
	}
	const sent = contextPassages.slice(0, params.maxPassages)
	const passages: BenchmarkContextPassageDiagnostic[] = sent.map(
		(text, index) => {
			const lineage = diagnostics.sentCandidates[index] as ResultLineage
			return {
				sentRank: index + 1,
				retrievedRank: lineage.retrievedRank,
				memoryId: lineage.memoryId,
				sessionIds: lineage.sessionIds,
				turnIds: lineage.turnIds,
				provenance: lineage.provenance,
				score: lineage.score,
				sha256: sha256(text),
				preview: preview(text),
			}
		},
	)
	const base = {
		contextPassages: passages,
		passagesSentCount: passages.length,
		matchRule: CONTEXT_MATCH_RULE,
	}
	if (!diagnostics.gold.applicable) {
		return {
			...base,
			gold: {
				status: "not-applicable",
				reason: diagnostics.gold.reason,
				sessions: [],
				turns: [],
			},
		}
	}
	const normalizedSent = sent.map(normalizeWhitespace)
	// Absence needs every sent passage traced to resolved source events. With
	// nothing sent there is nothing left to trace, so absence is then proven.
	const everyPassageTraced = passages.every(
		(passage) => passage.provenance === "complete",
	)
	const sessions: BenchmarkGoldSessionDiagnostic[] =
		diagnostics.gold.sessions.map((target) => {
			const inContext = passages.some((passage) =>
				passage.sessionIds.includes(target.sessionId),
			)
			return {
				admittedSessionIndex: target.admittedSessionIndex,
				sessionId: target.sessionId,
				retrieved: diagnostics.retrievedSessionRanks.has(target.sessionId),
				sentStatus: inContext
					? "present"
					: everyPassageTraced
						? "absent"
						: "unknown",
			}
		})
	const turns: BenchmarkGoldTurnDiagnostic[] = diagnostics.gold.turns.map(
		(target) => {
			const needle = normalizeWhitespace(target.text)
			const holdsText = normalizedSent.map((text) => text.includes(needle))
			const mapsToTurn = passages.map((passage) =>
				passage.turnIds.includes(target.turnId),
			)
			const firstMatch = passages.findIndex(
				(_, index) => holdsText[index] || mapsToTurn[index],
			)
			const sentStatus: BenchmarkGoldSentStatus = holdsText.includes(true)
				? "present"
				: everyPassageTraced && !mapsToTurn.includes(true)
					? "absent"
					: "unknown"
			const retrievedRank =
				diagnostics.retrievedTurnRanks.get(target.turnId) ?? null
			const sessionRetrieved = diagnostics.retrievedSessionRanks.has(
				target.sessionId,
			)
			return {
				admittedSessionIndex: target.admittedSessionIndex,
				sessionId: target.sessionId,
				turnIndex: target.turnIndex,
				turnId: target.turnId,
				retrieved: retrievedRank !== null,
				retrievedRank,
				sentRank: firstMatch >= 0 ? firstMatch + 1 : null,
				sentStatus,
				sessionRetrieved,
				candidateDefect: sessionRetrieved && sentStatus === "absent",
			}
		},
	)
	return {
		...base,
		gold: {
			status: "applicable",
			sessions,
			turns,
			counts: {
				candidate: turns.filter((turn) => turn.candidateDefect).length,
				present: turns.filter((turn) => turn.sentStatus === "present").length,
				unknown: turns.filter((turn) => turn.sentStatus === "unknown").length,
				absentSessionNotRetrieved: turns.filter(
					(turn) => turn.sentStatus === "absent" && !turn.sessionRetrieved,
				).length,
			},
		},
		goldSessionInContext: quantify(sessions.map((s) => s.sentStatus)),
		goldTurnInContext: quantify(turns.map((t) => t.sentStatus)),
	}
}

/** Whitespace collapse and trim, and nothing else: no case or punctuation folding. */
function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

/**
 * Three-valued any/all over sent statuses: `absent` is false, `present` is
 * true, `unknown` stays unknown. No targets means nothing was measured, which
 * is unknown rather than a vacuous truth.
 */
function quantify(statuses: BenchmarkGoldSentStatus[]): {
	any: BenchmarkDiagnosticTruth
	all: BenchmarkDiagnosticTruth
} {
	if (statuses.length === 0) return { any: "unknown", all: "unknown" }
	const unknown = statuses.includes("unknown")
	return {
		any: statuses.includes("present") ? true : unknown ? "unknown" : false,
		all: statuses.includes("absent") ? false : unknown ? "unknown" : true,
	}
}

/** The part of the event evidence maps that lineage classification reads. */
export type ContextEvidenceMaps = {
	sessionIds: Map<string, string>
	turnIds: Map<string, string>
}

// The collector trims and drops blank ids, so a blank or non-string id in the
// raw lists would otherwise vanish and leave a broken lineage looking whole.
function hasDefectiveSourceEventId(result: MemorySearchResult): boolean {
	const lists: unknown[] = [
		result.sourceEventIds,
		(result.provenance as { sourceEventIds?: unknown } | undefined)
			?.sourceEventIds,
	]
	return lists.some(
		(list) =>
			Array.isArray(list) &&
			list.some((id) => typeof id !== "string" || id.trim().length === 0),
	)
}

function classifyProvenance(
	result: MemorySearchResult,
	sourceEventIds: string[],
	evidence: ContextEvidenceMaps,
): BenchmarkContextProvenance {
	const resolved = sourceEventIds.filter(
		(id) => evidence.sessionIds.has(id) && evidence.turnIds.has(id),
	)
	if (resolved.length === 0) return "none"
	return resolved.length === sourceEventIds.length &&
		!hasDefectiveSourceEventId(result)
		? "complete"
		: "partial"
}

function buildGold(params: {
	evaluation: {
		abstention?: boolean
		expectedSessionIds: string[]
		expectedTurnIds?: string[]
	}
	conversations: MemoryBenchmarkConversation[]
}): Pass0ContextDiagnostics["gold"] {
	const { evaluation, conversations } = params
	if (evaluation.abstention === true) {
		return { applicable: false, reason: "abstention" }
	}
	const expectedTurnIds = evaluation.expectedTurnIds ?? []
	if (expectedTurnIds.length === 0) {
		return { applicable: false, reason: "no-has-answer-marker" }
	}
	const sessionIndexById = new Map<string, number>()
	const turnsById = new Map<
		string,
		{ admittedSessionIndex: number; sessionId: string; text: string }
	>()
	for (const [admittedSessionIndex, conversation] of conversations.entries()) {
		const sessionId = conversation.sessionId
		if (typeof sessionId !== "string") continue
		sessionIndexById.set(sessionId, admittedSessionIndex)
		for (const turn of conversation.turns) {
			const id = turn.metadata?.benchmarkTurnId
			if (typeof id === "string") {
				turnsById.set(id, {
					admittedSessionIndex,
					sessionId,
					text: turn.body,
				})
			}
		}
	}
	const turns = expectedTurnIds.map((turnId): GoldTurnTarget => {
		const turn = turnsById.get(turnId)
		const index = /::turn_(\d+)$/.exec(turnId)?.[1]
		if (!turn || index === undefined) {
			throw new Error(
				`gold turn ${turnId} is not in the scenario conversations`,
			)
		}
		return {
			admittedSessionIndex: turn.admittedSessionIndex,
			sessionId: turn.sessionId,
			turnIndex: Number(index) - 1,
			turnId,
			text: turn.text,
		}
	})
	const sessionIds = [
		...new Set([
			...evaluation.expectedSessionIds,
			...turns.map((turn) => turn.sessionId),
		]),
	]
	const sessions = sessionIds.map((sessionId): GoldSessionTarget => {
		const admittedSessionIndex = sessionIndexById.get(sessionId)
		if (admittedSessionIndex === undefined) {
			throw new Error(
				`gold session ${sessionId} is not in the scenario conversations`,
			)
		}
		return { admittedSessionIndex, sessionId }
	})
	return { applicable: true, sessions, turns }
}

/**
 * Capture the pass-0 observations for one case, using the same resolvers the
 * retrieval metrics use. `keptRanks` are the 1-based ranks of the results whose
 * text became a context passage, in passage order.
 */
export function buildPass0ContextDiagnostics(params: {
	results: MemorySearchResult[]
	keptRanks: number[]
	evidence: ContextEvidenceMaps
	collectSourceEventIds: (result: MemorySearchResult) => string[]
	resolveSessionIds: (result: MemorySearchResult) => string[]
	resolveTurnIds: (result: MemorySearchResult) => string[]
	evaluation: {
		abstention?: boolean
		expectedSessionIds: string[]
		expectedTurnIds?: string[]
	}
	conversations: MemoryBenchmarkConversation[]
}): Pass0ContextDiagnostics {
	const retrievedSessionRanks = new Map<string, number>()
	const retrievedTurnRanks = new Map<string, number>()
	for (const [index, result] of params.results.entries()) {
		for (const sessionId of params.resolveSessionIds(result)) {
			if (!retrievedSessionRanks.has(sessionId)) {
				retrievedSessionRanks.set(sessionId, index + 1)
			}
		}
		for (const turnId of params.resolveTurnIds(result)) {
			if (!retrievedTurnRanks.has(turnId)) {
				retrievedTurnRanks.set(turnId, index + 1)
			}
		}
	}
	const sentCandidates = params.keptRanks.map(
		(retrievedRank): ResultLineage => {
			const result = params.results[retrievedRank - 1] as MemorySearchResult
			return {
				retrievedRank,
				memoryId: result.canonicalId || result.path,
				score: result.score,
				sessionIds: params.resolveSessionIds(result),
				turnIds: params.resolveTurnIds(result),
				provenance: classifyProvenance(
					result,
					params.collectSourceEventIds(result),
					params.evidence,
				),
			}
		},
	)
	return {
		sentCandidates,
		retrievedSessionRanks,
		retrievedTurnRanks,
		gold: buildGold({
			evaluation: params.evaluation,
			conversations: params.conversations,
		}),
	}
}

/** A diagnostics failure becomes a recorded error, never a failed case. */
export function captureContextDiagnostics(
	build: () => Pass0ContextDiagnostics,
): { diagnostics: Pass0ContextDiagnostics } | { diagnosticsError: string } {
	try {
		return { diagnostics: build() }
	} catch (error) {
		return {
			diagnosticsError: error instanceof Error ? error.message : String(error),
		}
	}
}
