import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:best-effort")

const failureCounts = new Map<string, number>()

/**
 * Declared best-effort bookkeeping, audit and telemetry work. A failure is
 * logged and counted, never returned as a result, and callers never put this
 * on a retrieval or write-decision path: a value that decides something must
 * throw its failure instead of passing through here.
 */
export async function bestEffort(
	label: string,
	work: () => Promise<unknown>,
): Promise<void> {
	try {
		await work()
	} catch (err) {
		recordBestEffortFailure(label, err)
	}
}

export function recordBestEffortFailure(label: string, err: unknown): void {
	failureCounts.set(label, (failureCounts.get(label) ?? 0) + 1)
	log.warn(
		`best-effort ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
	)
}

/** In-process failure counts per best-effort label since process start. */
export function getBestEffortFailureCounts(): Record<string, number> {
	return Object.fromEntries(failureCounts)
}

export function resetBestEffortFailureCounts(): void {
	failureCounts.clear()
}
