export type ProofCheck = {
	name: string
	ok: boolean
	details: string
}

export type ProofSkip = {
	name: string
	reason: string
}

/** A proof passes only when required checks ran and every one passed; skips never count. */
export function requiredChecksPassed(checks: ProofCheck[]): boolean {
	return checks.length > 0 && checks.every((check) => check.ok)
}

/**
 * Readiness is the producer's hasData flag (B05); count may legitimately stay 0.
 * Producers only write lanes they touch, so a missing required lane is cold.
 */
export function coldLanes(
	lanes: Record<string, { hasData: boolean; count: number }>,
	requiredLanes: string[],
): string[] {
	return requiredLanes.filter((lane) => lanes[lane]?.hasData !== true)
}

export function exitCodeForVerdict(ok: boolean): 0 | 1 {
	return ok ? 0 : 1
}
