const DEFAULT_MAX_EVENTS = 100

export function resolveConsolidationMaxEvents(
	maxEvents: number | undefined,
): number {
	const value = maxEvents ?? DEFAULT_MAX_EVENTS
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error("maxEvents must be a positive integer")
	}
	return value
}
