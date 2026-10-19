import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:commit-report")

/**
 * M2 review D3: what a failed operation had already committed when it threw.
 * The report rides on the error the operation throws, so the typed failure,
 * its class and its status stay exactly as they were.
 *
 * - `none`: the operation knows that none of its own writes committed.
 * - `committed`: known committed effects; the detail lists the work that is
 *   known, and the operation as a whole did not complete.
 * - `unknown`: at least one write's commit outcome is uncertain (an unknown
 *   transaction commit result, a network failure once the write could have
 *   been sent). The detail lists only the work known to be committed, which
 *   may be less than the truth. An uncertain outcome is never reported as zero
 *   and never as a rollback.
 */
export type CommitState = "none" | "committed" | "unknown"

/** A failed `sync` whose file-sync phase ran to the end before the KB refresh failed. */
export type SyncCommitDetail = {
	operation: "sync"
	fileSync: { filesFailed: number; enumerationComplete: boolean }
	/** Present only when the import's counts are known (a rejected import has none). */
	kbImport?: {
		documentsProcessed: number
		chunksCreated: number
		skipped: number
	}
}

/** A failed consolidation run: its identity and the work known to be committed. */
export type ConsolidateCommitDetail = {
	operation: "consolidate"
	runId: string
	eventsProcessed: number
	factsPromoted: number
	factsInferred: number
	factsMerged: number
	factsPruned: number
}

export type CommitDetail = SyncCommitDetail | ConsolidateCommitDetail

export type CommitReport = {
	commitState: CommitState
	commit: CommitDetail
}

/**
 * Attach the report to the thrown error and return it. An error that already
 * carries a `commitState` (an uncertain barrier write) keeps it: a deeper
 * layer's statement about its own write is never overwritten. A frozen or
 * non-object error cannot carry the report; that is logged, not hidden.
 */
export function attachCommitReport<T>(err: T, report: CommitReport): T {
	if (err === null || typeof err !== "object") {
		log.warn("commit report not attached: the thrown value is not an object")
		return err
	}
	if (Object.getOwnPropertyDescriptor(err, "commitState") !== undefined) {
		return err
	}
	try {
		Object.defineProperty(err, "commitState", {
			value: report.commitState,
			enumerable: true,
			configurable: true,
		})
		Object.defineProperty(err, "commit", {
			value: report.commit,
			enumerable: true,
			configurable: true,
		})
	} catch {
		log.warn("commit report not attached: the thrown error is not extensible")
	}
	return err
}
