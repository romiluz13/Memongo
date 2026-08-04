import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:schema")

/**
 * E11000 while building a unique index means the collection already contains
 * duplicates for the exact keys the index exists to enforce — including the
 * tenant/scope uniqueness floors (uq_kb_scope_hash, uq_structured_*,
 * uq_entities_*). MongoDB builds no partial index in that case, so continuing
 * would leave the constraint permanently unenforced behind a log line: fail
 * bootstrap and make the operator deduplicate. "already exists"
 * (IndexOptionsConflict) stays non-fatal — an index with this name is present,
 * just created by an older version.
 */
export function handleUniqueIndexCreationError(
	err: unknown,
	indexName: string,
): void {
	const code = (err as { code?: unknown } | null)?.code
	const msg = err instanceof Error ? err.message : String(err)
	if (
		code === 11000 ||
		code === "11000" ||
		msg.includes("E11000") ||
		msg.includes("duplicate key")
	) {
		throw new Error(
			`unique index ${indexName} cannot be enforced: existing documents violate it (${msg}). Deduplicate the collection, then restart.`,
			{ cause: err },
		)
	}
	if (msg.includes("already exists")) {
		log.warn(`unique index ${indexName}: already exists; skipping`)
		return
	}
	throw err
}
