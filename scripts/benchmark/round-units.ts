import type {
	MemoryRoundPartner,
	MemoryRoundPartnerMissingReason,
	MemorySearchResult,
} from "../../packages/memory-engine/src/types.js"
import { roleLabeledText } from "./dated-answer-context.js"

/**
 * C-2 round units, built from results searched with `includeRoundPartner`.
 * Not wired into any QA protocol yet; `custom-v3` will use it.
 */
export type RoundUnit = {
	/** `round:` or `single:` plus the turn ids in session order. */
	key: string
	turns: MemoryRoundPartner[]
	/** Each turn on its own line, in session order, role-labeled once. */
	passage: string
	/** Set when the engine recorded why this turn has no partner. */
	roundPartnerMissing?: MemoryRoundPartnerMissingReason
}

/**
 * One unit per round, in the order of each round's first result. A result
 * without a partner stays a single-turn unit; no partner is invented.
 */
export function buildRoundUnits(
	results: readonly MemorySearchResult[],
): RoundUnit[] {
	const units = new Map<string, RoundUnit>()
	for (const result of results) {
		const self: MemoryRoundPartner = {
			canonicalId: result.canonicalId ?? result.path,
			...(result.role ? { role: result.role } : {}),
			text: result.text ?? result.snippet,
			...(result.timestamp ? { timestamp: result.timestamp } : {}),
		}
		const partner = result.roundPartner
		// A user turn's partner is the next turn; an assistant's, the previous.
		const turns = !partner
			? [self]
			: result.role === "assistant"
				? [partner, self]
				: [self, partner]
		const kind = partner ? "round" : "single"
		const key = `${kind}:${turns.map((t) => t.canonicalId).join("|")}`
		if (units.has(key)) continue
		units.set(key, {
			key,
			turns,
			passage: turns.map((t) => roleLabeledText(t.text, t.role)).join("\n"),
			...(result.roundPartnerMissing
				? { roundPartnerMissing: result.roundPartnerMissing }
				: {}),
		})
	}
	return [...units.values()]
}
