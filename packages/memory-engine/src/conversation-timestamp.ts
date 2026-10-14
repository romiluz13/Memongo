// Accepted explicit timestamps: an ISO 8601 date-time with Z or a numeric
// offset, or a date-only value. ECMA-262 reads date-only forms as UTC but
// date-times without an offset as local time, so those depend on the host
// zone and are refused.
const DATE_TIME =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

function isCalendarDate(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1) return false
	return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** A host-independent instant for a valid explicit timestamp, else null. */
export function parseExplicitTimestamp(value: unknown): Date | null {
	if (typeof value !== "string") return null
	const dateOnly = DATE_ONLY.exec(value)
	if (dateOnly) {
		const year = Number(dateOnly[1])
		const month = Number(dateOnly[2])
		const day = Number(dateOnly[3])
		return isCalendarDate(year, month, day)
			? new Date(Date.UTC(year, month - 1, day))
			: null
	}
	const match = DATE_TIME.exec(value)
	if (!match) return null
	if (
		!isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) ||
		Number(match[4]) > 23 ||
		Number(match[5]) > 59 ||
		Number(match[6] ?? 0) > 59 ||
		Number(match[9] ?? 0) > 23 ||
		Number(match[10] ?? 0) > 59
	)
		return null
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? null : parsed
}
