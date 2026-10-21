import type {
	BenchmarkContextProvenance,
	MemoryBenchmarkConversation,
	MemorySearchResult,
} from "../../packages/memory-engine/src/types.js"
import {
	buildPass0ContextDiagnostics,
	type ContextEvidenceMaps,
	captureContextDiagnostics,
	classifyProvenance,
	type Pass0ContextDiagnostics,
	type ResultLineage,
} from "./benchmark-context-diagnostics.js"
import type { ReaderUnit } from "./reader-budget.js"
import { buildRoundUnits } from "./round-units.js"

/**
 * custom-v3 reader units from results searched with `includeRoundPartner`.
 * Each unit carries the best stage-1 rank of the results that formed it,
 * its benchmark session and that session's dates, and its first turn
 * index. A unit that resolves to no session is its own undated session,
 * keyed by its id. `lineage` is index-aligned with `units` and only feeds
 * the after-the-fact context diagnostics.
 */

const EVENT_PREFIX = "event:"
const TURN_INDEX = /::turn_(\d+)$/

function unitKey(result: MemorySearchResult): string {
	return (buildRoundUnits([result])[0] as { key: string }).key
}

function combine(
	statuses: BenchmarkContextProvenance[],
): BenchmarkContextProvenance {
	if (statuses.every((status) => status === "complete")) return "complete"
	if (statuses.every((status) => status === "none")) return "none"
	return "partial"
}

export function buildReaderUnits(params: {
	results: readonly MemorySearchResult[]
	/** False when the search ran without `includeRoundPartner`. */
	roundPartnerRequested: boolean
	evidence: ContextEvidenceMaps
	collectSourceEventIds: (result: MemorySearchResult) => string[]
	resolveSessionIds: (result: MemorySearchResult) => string[]
	resolveTurnIds: (result: MemorySearchResult) => string[]
	sessionDates: (sessionId: string) => string[]
}): { units: ReaderUnit[]; lineage: ResultLineage[] } {
	const keys = params.results.map(unitKey)
	const units: ReaderUnit[] = []
	const lineage: ResultLineage[] = []
	for (const round of buildRoundUnits(params.results)) {
		if (round.passage.trim().length === 0) continue
		const forming = params.results.filter(
			(_, index) => keys[index] === round.key,
		)
		const formingIds = new Set(
			forming.map((result) => result.canonicalId ?? result.path),
		)
		const partners = round.turns
			.filter((turn) => !formingIds.has(turn.canonicalId))
			.map((turn) =>
				turn.canonicalId.startsWith(EVENT_PREFIX)
					? turn.canonicalId.slice(EVENT_PREFIX.length)
					: undefined,
			)
		const sessionIds = new Set<string>()
		const turnIds = new Set<string>()
		const statuses: BenchmarkContextProvenance[] = []
		for (const result of forming) {
			for (const id of params.resolveSessionIds(result)) sessionIds.add(id)
			for (const id of params.resolveTurnIds(result)) turnIds.add(id)
			statuses.push(
				classifyProvenance(
					result,
					params.collectSourceEventIds(result),
					params.evidence,
				),
			)
		}
		for (const eventId of partners) {
			const sessionId =
				eventId === undefined
					? undefined
					: params.evidence.sessionIds.get(eventId)
			const turnId =
				eventId === undefined ? undefined : params.evidence.turnIds.get(eventId)
			if (sessionId) sessionIds.add(sessionId)
			if (turnId) turnIds.add(turnId)
			statuses.push(sessionId && turnId ? "complete" : "none")
		}
		const best = forming[0] as MemorySearchResult
		const rank = keys.indexOf(round.key) + 1
		const turnIndices = [...turnIds].flatMap((id) => {
			const match = TURN_INDEX.exec(id)
			return match ? [Number(match[1])] : []
		})
		const sessions = [...sessionIds]
		const roundPartnerMissing = params.roundPartnerRequested
			? round.roundPartnerMissing
			: "not-requested"
		units.push({
			id: round.key,
			passage: round.passage,
			rank,
			sessionId: sessions[0] ?? round.key,
			sessionDates: [
				...new Set(sessions.flatMap((id) => params.sessionDates(id))),
			].sort(),
			turnOrder: turnIndices.length > 0 ? Math.min(...turnIndices) : null,
			...(roundPartnerMissing ? { roundPartnerMissing } : {}),
		})
		lineage.push({
			retrievedRank: rank,
			memoryId: round.key,
			score: best.score,
			sessionIds: sessions,
			turnIds: [...turnIds],
			provenance: combine(statuses),
		})
	}
	return { units, lineage }
}

type ReaderUnitInputs = Parameters<typeof buildReaderUnits>[0]

/**
 * Pass-0 material for a custom-v3 case: its reader units, and context
 * diagnostics whose `sentCandidates` describe every unit (index-aligned).
 */
export function captureReaderUnits(
	params: ReaderUnitInputs & {
		caseId: string
		evaluation: Parameters<typeof buildPass0ContextDiagnostics>[0]["evaluation"]
		conversations: MemoryBenchmarkConversation[]
	},
): { readerUnits: ReaderUnit[] } & (
	| { diagnostics: Pass0ContextDiagnostics }
	| { diagnosticsError: string }
) {
	const { units, lineage } = buildReaderUnits(params)
	return {
		readerUnits: units,
		...captureContextDiagnostics(params.caseId, () => ({
			...buildPass0ContextDiagnostics({
				results: [...params.results],
				keptRanks: [],
				evidence: params.evidence,
				collectSourceEventIds: params.collectSourceEventIds,
				resolveSessionIds: params.resolveSessionIds,
				resolveTurnIds: params.resolveTurnIds,
				evaluation: params.evaluation,
				conversations: params.conversations,
			}),
			sentCandidates: lineage,
		})),
	}
}
