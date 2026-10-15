// Accepted explicit timestamps: an ISO 8601 date-time with Z or a numeric
// offset, or a date-only value. ECMA-262 reads date-only forms as UTC but
// date-times without an offset as local time, so those depend on the host
// zone and are refused. The instant is computed here rather than by
// Date.parse, so it never depends on the host zone or on engine leniency.
const DATE_TIME =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

// Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear does not.
function utcInstant(
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
	second = 0,
	millisecond = 0,
): Date {
	const date = new Date(0)
	date.setUTCFullYear(year, month - 1, day)
	date.setUTCHours(hour, minute, second, millisecond)
	return date
}

function isCalendarDate(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1) return false
	return utcInstant(year, month, day).getUTCDate() === day
}

/** A host-independent instant for a valid explicit timestamp, else null. */
export function parseExplicitTimestamp(value: unknown): Date | null {
	if (typeof value !== "string") return null
	const text = value.trim()
	const dateOnly = DATE_ONLY.exec(text)
	if (dateOnly) {
		const year = Number(dateOnly[1])
		const month = Number(dateOnly[2])
		const day = Number(dateOnly[3])
		return isCalendarDate(year, month, day)
			? utcInstant(year, month, day)
			: null
	}
	const match = DATE_TIME.exec(text)
	if (!match) return null
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	const hour = Number(match[4])
	const minute = Number(match[5])
	const second = Number(match[6] ?? 0)
	const offsetHour = Number(match[10] ?? 0)
	const offsetMinute = Number(match[11] ?? 0)
	if (
		!isCalendarDate(year, month, day) ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59
	)
		return null
	// Sub-millisecond digits are truncated, as Date.parse does.
	const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3))
	const sign = match[9] === "-" ? -1 : 1
	const instant = utcInstant(
		year,
		month,
		day,
		hour,
		minute,
		second,
		millisecond,
	)
	return new Date(
		instant.getTime() - sign * (offsetHour * 60 + offsetMinute) * 60_000,
	)
}
