import { parseExplicitTimestamp } from "../../packages/memory-engine/src/conversation-timestamp.js"
import type {
	MemoryBenchmarkConversation,
	MemoryBenchmarkDatasetKind,
} from "../../packages/memory-engine/src/types.js"

export const BENCHMARK_TIMESTAMP_POLICY_VERSION =
	"benchmark-timestamp-utc-fields-literal12h-v1"

export type BenchmarkTimestampRejectionReason =
	| "not-string" // includes explicit null: an explicit value that is not a timestamp
	| "empty"
	| "unrecognized-grammar"
	| "invalid-calendar"
	| "invalid-shape"

/** Value-free coordinate; sessionIndex is the 0-based session/conversation position. */
export type BenchmarkTimestampRejection = {
	field:
		| "turn.timestamp"
		| "haystack_dates"
		| "session_date_time"
		| "question_date"
	conversationIndex: number
	sessionIndex: number | null
	turnIndex: number | null
	reason: BenchmarkTimestampRejectionReason
}

export class BenchmarkTimestampRejectedError extends Error {
	readonly rejections: BenchmarkTimestampRejection[]
	constructor(rejections: BenchmarkTimestampRejection[]) {
		const counts = new Map<string, number>()
		for (const r of rejections)
			counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1)
		super(
			`benchmark dataset has ${rejections.length} invalid explicit timestamp(s) (${Array.from(counts, ([k, v]) => `${k}=${v}`).join(", ")}); nothing was written`,
		)
		this.name = "BenchmarkTimestampRejectedError"
		this.rejections = rejections
	}
}

const LONGMEMEVAL =
	/^(\d{4})\/(\d{2})\/(\d{2}) \((Mon|Tue|Wed|Thu|Fri|Sat|Sun)\) (\d{2}):(\d{2})$/
const LOCOMO =
	/^(\d{1,2}):(\d{2}) (am|pm) on (\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December), (\d{4})$/
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
]
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function utcFields(
	y: number,
	mo: number,
	d: number,
	h: number,
	mi: number,
): Date | null {
	if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59) return null
	const date = new Date(0)
	date.setUTCFullYear(y, mo - 1, d)
	date.setUTCHours(h, mi, 0, 0)
	return date.getUTCDate() === d ? date : null
}

/**
 * Caller decides presence: call only when the property/index exists. Explicit
 * null is invalid, never treated as absent.
 */
export function parseBenchmarkTimestamp(
	datasetKind: MemoryBenchmarkDatasetKind | undefined,
	raw: unknown,
):
	| {
			ok: true
			instant: Date
			weekdayMismatch: boolean
			literalMidnightLabel?: boolean
	  }
	| { ok: false; reason: BenchmarkTimestampRejectionReason } {
	if (typeof raw !== "string") return { ok: false, reason: "not-string" }
	const text = raw.trim()
	if (!text) return { ok: false, reason: "empty" }
	const iso = parseExplicitTimestamp(text)
	if (iso) return { ok: true, instant: iso, weekdayMismatch: false }
	if (datasetKind === "longmemeval") {
		const m = LONGMEMEVAL.exec(text)
		if (!m) return { ok: false, reason: "unrecognized-grammar" }
		const instant = utcFields(+m[1], +m[2], +m[3], +m[5], +m[6])
		if (!instant) return { ok: false, reason: "invalid-calendar" }
		return {
			ok: true,
			instant,
			weekdayMismatch: WEEKDAYS[instant.getUTCDay()] !== m[4],
		}
	}
	if (datasetKind === "locomo") {
		const match = LOCOMO.exec(text)
		if (!match) return { ok: false, reason: "unrecognized-grammar" }
		const hour = Number(match[1])
		if (hour < 1 || hour > 12) return { ok: false, reason: "invalid-calendar" }
		const instant = utcFields(
			Number(match[6]),
			MONTHS.indexOf(match[5]) + 1,
			Number(match[4]),
			(hour % 12) + (match[3] === "pm" ? 12 : 0),
			Number(match[2]),
		)
		if (!instant) return { ok: false, reason: "invalid-calendar" }
		// Preserve the released label. The pinned generator's noon-label bug
		// does not establish that any particular historical record means noon.
		return {
			ok: true,
			instant,
			weekdayMismatch: false,
			literalMidnightLabel: hour === 12 && match[3] === "am",
		}
	}
	return { ok: false, reason: "unrecognized-grammar" }
}

/** UTC-calendar end of day, the cutoff partner of the UTC-fields policy. */
export function endOfBenchmarkUtcDay(instant: Date): Date {
	const end = new Date(instant.getTime())
	end.setUTCHours(23, 59, 59, 999)
	return end
}

export function requireBenchmarkTimestamp(
	datasetKind: MemoryBenchmarkDatasetKind | undefined,
	raw: unknown,
	at: Omit<BenchmarkTimestampRejection, "reason">,
): Date {
	const parsed = parseBenchmarkTimestamp(datasetKind, raw)
	if (!parsed.ok)
		throw new BenchmarkTimestampRejectedError([
			{ ...at, reason: parsed.reason },
		])
	return parsed.instant
}

/** Validate the whole selected replay before writes; keep source objects untouched. */
export function normalizeBenchmarkConversationTimestamps(
	conversations: MemoryBenchmarkConversation[],
	datasetKind?: MemoryBenchmarkDatasetKind,
): MemoryBenchmarkConversation[] {
	const rejections: BenchmarkTimestampRejection[] = []
	const normalized = conversations.map((conversation, conversationIndex) => ({
		...conversation,
		turns: conversation.turns.map((turn, turnIndex) => {
			if (turn.timestamp === undefined) return turn
			const parsed = parseBenchmarkTimestamp(datasetKind, turn.timestamp)
			if (!parsed.ok) {
				rejections.push({
					field: "turn.timestamp",
					conversationIndex,
					sessionIndex: conversationIndex,
					turnIndex,
					reason: parsed.reason,
				})
				return turn
			}
			return { ...turn, timestamp: parsed.instant.toISOString() }
		}),
	}))
	if (rejections.length) throw new BenchmarkTimestampRejectedError(rejections)
	return normalized
}
