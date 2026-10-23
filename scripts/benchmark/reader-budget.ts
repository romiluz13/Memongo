import { createHash } from "node:crypto"
import { Tiktoken } from "js-tiktoken/lite"
import o200kBase from "js-tiktoken/ranks/o200k_base"
import type { RoundPartnerMissingReason } from "./round-units.js"

/**
 * D: the custom-v3 reader budget. Token counts are a labeled estimate
 * from an offline o200k_base encoder, not the answer provider's tokenizer;
 * each run calibrates them against the provider-reported input tokens.
 */

export const READER_BUDGET_TOKENIZER = "js-tiktoken@1.0.21/o200k_base"
/** Frozen 2026-10-22: estimated tokens of the serialized user content. */
export const READER_BUDGET_ESTIMATED_TOKENS = 16_000

const encoder = new Tiktoken(o200kBase)

export function estimateTokens(text: string): number {
	return encoder.encode(text).length
}

/** One admissible passage: a round or a single turn, admitted whole. */
export type ReaderUnit = {
	/** Canonical unit id (the round key); the final tie-break. */
	id: string
	/** Role-labeled turns, one per line, in session order. */
	passage: string
	/** Best 1-based stage-1 rank among the results that formed the unit. */
	rank: number
	sessionId: string
	/** The session's dates, sorted; empty when unknown. */
	sessionDates: string[]
	/** Index of the unit's first turn in its session; null when unknown. */
	turnOrder: number | null
	/** Why a single-turn unit has no round partner, when known. */
	roundPartnerMissing?: RoundPartnerMissingReason
}

export type ReaderContext = {
	userContent: string
	/** Estimated tokens of the whole serialized user content. */
	estimatedContextTokens: number
	budgetEstimatedTokens: number
	/** The first unit alone exceeded the budget and was admitted anyway. */
	budgetExceededByFirstUnit: boolean
	/** Admitted units in presentation order. */
	admitted: ReaderUnit[]
	/** Character offset of each admitted unit in `userContent`. */
	admittedOffsets: number[]
	counts: {
		candidates: number
		admitted: number
		deduplicated: number
		skipped: number
	}
	/** Stage-1 ranks of the units skipped for the budget, in admission order. */
	skippedRanks: number[]
}

/** custom-v1 to custom-v3's return line; reader admission always counts it. */
export const ANSWER_RETURN_LINE = 'Return only {"answer":"..."}.'

type SessionGroup = { sessionId: string; dates: string[]; units: ReaderUnit[] }

function byRankThenId(a: ReaderUnit, b: ReaderUnit): number {
	return (
		a.rank - b.rank ||
		compareText(a.id, b.id) ||
		compareText(sha256(a.passage), sha256(b.passage))
	)
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Same unit id or same text SHA-256: the better-ranked copy stays. */
function dropDuplicates(sorted: readonly ReaderUnit[]): ReaderUnit[] {
	const ids = new Set<string>()
	const texts = new Set<string>()
	return sorted.filter((unit) => {
		const text = sha256(unit.passage)
		if (ids.has(unit.id) || texts.has(text)) return false
		ids.add(unit.id)
		texts.add(text)
		return true
	})
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function byTurnOrder(a: ReaderUnit, b: ReaderUnit): number {
	if (a.turnOrder !== b.turnOrder) {
		if (a.turnOrder === null) return 1
		if (b.turnOrder === null) return -1
		return a.turnOrder - b.turnOrder
	}
	return compareText(a.id, b.id)
}

/**
 * Sessions with no date come first, by their best unit's rank; dated
 * sessions follow by first date ascending, ties by session id. Units inside
 * a session follow turn order.
 */
function presentationOrder(units: readonly ReaderUnit[]): SessionGroup[] {
	const groups = new Map<string, SessionGroup>()
	for (const unit of [...units].sort(byRankThenId)) {
		const group = groups.get(unit.sessionId) ?? {
			sessionId: unit.sessionId,
			dates: unit.sessionDates,
			units: [],
		}
		group.units.push(unit)
		groups.set(unit.sessionId, group)
	}
	const all = [...groups.values()]
	const undated = all.filter((group) => group.dates.length === 0)
	const dated = all
		.filter((group) => group.dates.length > 0)
		.sort(
			(a, b) =>
				compareText(a.dates[0] as string, b.dates[0] as string) ||
				compareText(a.sessionId, b.sessionId),
		)
	return [...undated, ...dated].map((group) => ({
		...group,
		units: group.units.sort(byTurnOrder),
	}))
}

/** The user content and each unit's character offset in it, in order. */
function render(
	sessions: readonly SessionGroup[],
	question: string,
	questionDate: string | undefined,
	returnLine: string,
): { text: string; offsets: number[] } {
	let text = "History Chats:"
	const offsets: number[] = []
	sessions.forEach((session, index) => {
		text += `\n\n### Session ${index + 1}:\n`
		if (session.dates.length > 0) {
			text += `Session Date: ${session.dates.join("; ")}\n`
		}
		text += "Session Content:"
		for (const unit of session.units) {
			text += "\n"
			offsets.push(text.length)
			text += unit.passage
		}
	})
	const tail = [
		...(questionDate ? [`Current Date: ${questionDate}`] : []),
		`Question: ${question}`,
		returnLine,
	].join("\n")
	return { text: `${text}\n\n${tail}`, offsets }
}

export function buildReaderContext(params: {
	units: readonly ReaderUnit[]
	question: string
	questionDate?: string
	budget: number
	/** The return line the user content ends with; custom-v1 to custom-v3's when absent. */
	returnLine?: string
}): ReaderContext {
	const serialize = (units: readonly ReaderUnit[]) => {
		const sessions = presentationOrder(units)
		const { text, offsets } = render(
			sessions,
			params.question,
			params.questionDate,
			params.returnLine ?? ANSWER_RETURN_LINE,
		)
		return {
			sessions,
			userContent: text,
			offsets,
			tokens: estimateTokens(text),
		}
	}
	const unique = dropDuplicates([...params.units].sort(byRankThenId))
	// Breadth: each session's best unit, sessions by that unit's rank.
	// Depth: every other unit in rank order.
	const seenSessions = new Set<string>()
	const breadth: ReaderUnit[] = []
	const depth: ReaderUnit[] = []
	for (const unit of unique) {
		if (seenSessions.has(unit.sessionId)) {
			depth.push(unit)
		} else {
			seenSessions.add(unit.sessionId)
			breadth.push(unit)
		}
	}
	const candidates = [...breadth, ...depth]
	const admitted: ReaderUnit[] = []
	const skippedRanks: number[] = []
	let current = serialize(admitted)
	let budgetExceededByFirstUnit = false
	for (const unit of candidates) {
		const trial = serialize([...admitted, unit])
		if (admitted.length === 0 && trial.tokens > params.budget) {
			budgetExceededByFirstUnit = true
		} else if (trial.tokens > params.budget) {
			skippedRanks.push(unit.rank)
			continue
		}
		admitted.push(unit)
		current = trial
	}
	return {
		userContent: current.userContent,
		estimatedContextTokens: current.tokens,
		budgetEstimatedTokens: params.budget,
		budgetExceededByFirstUnit,
		admitted: current.sessions.flatMap((session) => session.units),
		admittedOffsets: current.offsets,
		counts: {
			candidates: params.units.length,
			admitted: admitted.length,
			deduplicated: params.units.length - candidates.length,
			skipped: skippedRanks.length,
		},
		skippedRanks,
	}
}
