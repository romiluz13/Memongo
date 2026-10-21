/**
 * C-2 round expansion, opt-in through the `includeRoundPartner` search
 * option. The official LongMemEval reader expands every retrieved turn into
 * its round; this attaches the round's other turn to each conversation turn
 * result.
 */

import type { Db, Document } from "mongodb"
import { parseResultRole } from "./memory-derivation.js"
import { eventsCollection } from "./mongodb-schema.js"
import {
	MAX_RESULT_TEXT_CHARS,
	runSearchAggregateWithRetry,
} from "./mongodb-search.js"
import {
	type SessionNamespace,
	sessionScopedEventFilters,
} from "./mongodb-session-scoped-selector.js"
import { buildEventLifecycleClause } from "./mongodb-temporal.js"
import {
	type SearchTierOutcomeSink,
	toTypedSearchError,
} from "./search-outcomes.js"
import type {
	MemoryRoundPartnerMissingReason,
	MemorySearchResult,
} from "./types.js"

const EVENT_CANONICAL_PREFIX = "event:"

export async function attachRoundPartners(params: {
	db: Db
	prefix: string
	namespace: SessionNamespace
	questionDate: Date | undefined
	results: MemorySearchResult[]
	onTierOutcome?: SearchTierOutcomeSink
}): Promise<MemorySearchResult[]> {
	const turns = params.results.filter(isConversationTurn)
	if (turns.length === 0) {
		params.onTierOutcome?.({
			stage: "plan",
			outcome: "not-applicable",
			reason: "no-candidates",
		})
		return params.results
	}
	const sessionIds = [
		...new Set(turns.map((result) => result.sessionId?.trim() ?? "")),
	].filter(Boolean)
	const { canonicalFilter } = sessionScopedEventFilters({
		namespace: params.namespace,
		sessionIds,
	})
	const turnIds = turns.map(eventIdOf)
	const idsWithRole = (role: "user" | "assistant") =>
		turns.filter((result) => result.role === role).map(eventIdOf)
	const pipeline: Document[] = [
		{ $match: canonicalFilter },
		{
			$setWindowFields: {
				partitionBy: "$sessionId",
				sortBy: { timestamp: 1, _id: 1 },
				output: {
					previousEventId: {
						$shift: { output: "$eventId", by: -1, default: null },
					},
					nextEventId: {
						$shift: { output: "$eventId", by: 1, default: null },
					},
				},
			},
		},
		{
			$match: {
				$or: [
					{ eventId: { $in: turnIds } },
					{ previousEventId: { $in: idsWithRole("user") } },
					{ nextEventId: { $in: idsWithRole("assistant") } },
				],
			},
		},
		...(params.questionDate
			? [{ $match: { timestamp: { $lte: params.questionDate } } }]
			: []),
		{ $match: buildEventLifecycleClause({ asOf: params.questionDate }) },
		{
			$project: {
				_id: 0,
				eventId: 1,
				role: 1,
				body: 1,
				timestamp: 1,
				previousEventId: 1,
				nextEventId: 1,
			},
		},
	]
	let docs: Document[]
	try {
		docs = await runSearchAggregateWithRetry(
			eventsCollection(params.db, params.prefix),
			pipeline,
		)
	} catch (err) {
		throw toTypedSearchError(err, "lane")
	}
	const byEventId = new Map(docs.map((doc) => [String(doc.eventId), doc]))
	return params.results.map((result) => {
		if (!isConversationTurn(result)) return result
		if (result.role !== "user" && result.role !== "assistant") {
			return missing(result, "no-round-role")
		}
		const self = byEventId.get(eventIdOf(result))
		if (!self) return missing(result, "turn-not-found")
		const partnerId =
			result.role === "user" ? self.nextEventId : self.previousEventId
		if (partnerId === null) return missing(result, "session-end")
		const partner = byEventId.get(String(partnerId))
		if (!partner) return missing(result, "partner-excluded")
		return { ...result, roundPartner: toPartner(partner) }
	})
}

/** Every conversation turn gets null with `lookup-failed`; others are kept. */
export function markRoundPartnerLookupFailed(
	results: MemorySearchResult[],
): MemorySearchResult[] {
	return results.map((result) =>
		isConversationTurn(result) ? missing(result, "lookup-failed") : result,
	)
}

function missing(
	result: MemorySearchResult,
	reason: MemoryRoundPartnerMissingReason,
): MemorySearchResult {
	return { ...result, roundPartner: null, roundPartnerMissing: reason }
}

function isConversationTurn(result: MemorySearchResult): boolean {
	return result.canonicalId?.startsWith(EVENT_CANONICAL_PREFIX) === true
}

function eventIdOf(result: MemorySearchResult): string {
	return (result.canonicalId as string).slice(EVENT_CANONICAL_PREFIX.length)
}

function toPartner(doc: Document): MemorySearchResult["roundPartner"] {
	const role = parseResultRole(doc.role)
	return {
		canonicalId: `${EVENT_CANONICAL_PREFIX}${doc.eventId}`,
		...(role ? { role } : {}),
		text:
			typeof doc.body === "string"
				? doc.body.slice(0, MAX_RESULT_TEXT_CHARS)
				: "",
		...(doc.timestamp instanceof Date ? { timestamp: doc.timestamp } : {}),
	}
}
