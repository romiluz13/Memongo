import type { ClientSession, TransactionOptions } from "mongodb"

export const MAJORITY_TRANSACTION_OPTIONS: TransactionOptions = {
	// wtimeout prevents indefinite blocking when majority is unachievable
	// (e.g. a secondary is down). Docs examples use wtimeout: 1000.
	// See https://www.mongodb.com/docs/manual/reference/write-concern/
	writeConcern: { w: "majority", wtimeout: 1000 },
}

/** Extract a MongoDB server error code from an error-like object. */
function getMongoErrorCode(error: unknown): number | undefined {
	if (error instanceof Error && "code" in error) {
		const code = (error as Error & { code?: unknown }).code
		if (typeof code === "number") {
			return code
		}
	}
	return undefined
}

export function isTransactionUnsupported(error: unknown): boolean {
	if (getMongoErrorCode(error) === 20) {
		return true
	}
	const message = error instanceof Error ? error.message : String(error)
	return message.includes(
		"Transaction numbers are only allowed on a replica set member or mongos",
	)
}

/**
 * Detect a WiredTiger `TransactionTooLargeForCache` error (MongoDB 6.2+,
 * code 388). The driver's `withTransaction` does NOT auto-retry this — it
 * surfaces to the caller. Note: code 225 is `TransactionTooOld` (a different,
 * unrelated error). See https://www.mongodb.com/docs/manual/core/transactions/
 */
export function isTransactionTooLargeForCache(error: unknown): boolean {
	if (getMongoErrorCode(error) === 388) {
		return true
	}
	const message = error instanceof Error ? error.message : String(error)
	return message.includes("TransactionTooLargeForCache")
}

/**
 * Run `ops` inside a transaction via `session.withTransaction`. If the batch
 * throws `TransactionTooLargeForCache`, split it in half and retry each half in
 * its own transaction — until a batch fits or it shrinks below `minBatchSize`.
 * This is a retry, not a downgrade: every op still runs transactionally; we only
 * split the work so each transaction's cache footprint is smaller.
 */
export async function withTransactionBatched<T>(
	session: Pick<ClientSession, "withTransaction">,
	ops: T[],
	runBatch: (batch: T[]) => Promise<void>,
	options?: { minBatchSize?: number },
): Promise<void> {
	const minBatchSize = options?.minBatchSize ?? 1
	try {
		await session.withTransaction(
			async () => runBatch(ops),
			MAJORITY_TRANSACTION_OPTIONS,
		)
	} catch (error) {
		if (isTransactionTooLargeForCache(error) && ops.length > minBatchSize) {
			const mid = Math.ceil(ops.length / 2)
			await withTransactionBatched(
				session,
				ops.slice(0, mid),
				runBatch,
				options,
			)
			await withTransactionBatched(session, ops.slice(mid), runBatch, options)
			return
		}
		throw error
	}
}
