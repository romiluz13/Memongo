import type { Collection, Db } from "mongodb"
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

// ---------------------------------------------------------------------------
// TTL convergence (review finding F1)
// ---------------------------------------------------------------------------

/**
 * The retention-configured TTL indexes (idx_files_ttl, idx_episodes_ttl_updated,
 * idx_relruns_ttl, idx_relart_ttl). createIndex() cannot change
 * expireAfterSeconds on an existing index — TTL page, Restrictions: "You cannot
 * use createIndex() to change the value of expireAfterSeconds of an existing
 * index. Instead, use the collMod database command." Rerunning setup with a
 * changed retention therefore silently kept the old deletion horizon.
 * Inspect the named index first: create when absent, no-op when key+expiry
 * match, collMod only when the existing index has the expected key and is
 * already TTL with a different expiry, and fail loudly on an incompatible
 * same-name index instead of mutating something the schema layer does not own.
 */
export type TtlIndexSpec = {
	name: string
	key: Record<string, 1 | -1>
	expireAfterSeconds: number
	/**
	 * Same-key plain counterpart retired by the helper once the target proves
	 * compatible (F18: a live same-key counterpart makes creation fail with
	 * IndexKeySpecsConflict). Never dropped before the target is inspected:
	 * an incompatible target throws first and the counterpart stays (F2).
	 */
	counterpartName?: string
}

export type TtlIndexOutcome = "created" | "unchanged" | "converged"

/** Docs (TTL page, Create; collMod reference): value must be within 0 and 2147483647 inclusive. */
const MAX_TTL_SECONDS = 2147483647

/**
 * Pinned explicitly at creation (F1): without it, a collection whose default
 * collation is non-simple would make the new index inherit that default, and
 * the next run's compatibility check would reject the index this helper just
 * created. Simple is the documented binary-comparison default semantics, and
 * these TTL keys are dates — collation is irrelevant to them either way.
 */
const SIMPLE_COLLATION = { locale: "simple" } as const

type ExistingIndexShape = {
	name?: string
	key?: unknown
	expireAfterSeconds?: unknown
	unique?: unknown
	sparse?: unknown
	hidden?: unknown
	partialFilterExpression?: unknown
	collation?: unknown
}

/** Order-sensitive comparison; key order matters for compound indexes. */
function sameKeyPattern(
	actual: unknown,
	expected: Record<string, 1 | -1>,
): boolean {
	if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
		return false
	}
	const actualEntries = Object.entries(actual as Record<string, unknown>)
	const expectedEntries = Object.entries(expected)
	return (
		actualEntries.length === expectedEntries.length &&
		expectedEntries.every(
			([field, direction], i) =>
				actualEntries[i]?.[0] === field &&
				Number(actualEntries[i]?.[1]) === Number(direction),
		)
	)
}

/**
 * True only for the server-default collation document: `{ locale: "simple" }`
 * with no other fields. The collation reference defines simple as binary
 * comparison — the semantics an index has when no collation is specified at
 * all — and MongoDB 9.0 records that default explicitly in the index spec
 * (verified on 9.0.0-rc0: a plain createIndex without any collation option
 * reports `collation: { locale: "simple" }` in listIndexes; memongo itself
 * never sets a collation anywhere). A collation document carrying anything
 * beyond the bare simple locale is an operator-applied semantic (ICU
 * parameters, a non-simple locale) that collMod cannot remove.
 */
function isServerDefaultCollation(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const entries = Object.entries(value as Record<string, unknown>)
	return (
		entries.length === 1 &&
		entries[0]?.[0] === "locale" &&
		entries[0]?.[1] === "simple"
	)
}

/** Options collMod cannot remove from an existing index. */
function foreignOptionsOf(existing: ExistingIndexShape): string[] {
	const found: string[] = []
	if (existing.unique === true) found.push("unique")
	if (existing.sparse === true) found.push("sparse")
	if (existing.hidden === true) found.push("hidden")
	if (existing.partialFilterExpression !== undefined)
		found.push("partialFilterExpression")
	if (
		existing.collation !== undefined &&
		!isServerDefaultCollation(existing.collation)
	)
		found.push("collation")
	return found
}

/**
 * Drop the same-key plain counterpart when the listing shows it. IndexNotFound
 * (code 27) after a positive listing is torn state equivalent to "already
 * gone"; anything else is a real failure and propagates.
 */
async function dropCounterpartIfPresent(
	collection: Collection,
	listed: ExistingIndexShape[],
	name: string,
): Promise<void> {
	if (!listed.some((idx) => idx.name === name)) return
	try {
		await collection.dropIndex(name)
	} catch (err) {
		if ((err as { code?: unknown } | null)?.code === 27) return
		throw err
	}
}

export async function ensureTtlIndex(
	db: Db,
	collection: Collection,
	spec: TtlIndexSpec,
): Promise<TtlIndexOutcome> {
	const { name, key, expireAfterSeconds, counterpartName } = spec
	if (
		!Number.isInteger(expireAfterSeconds) ||
		expireAfterSeconds < 0 ||
		expireAfterSeconds > MAX_TTL_SECONDS
	) {
		throw new Error(
			`TTL index ${name}: expireAfterSeconds ${expireAfterSeconds} is invalid (must be an integer within 0..${MAX_TTL_SECONDS})`,
		)
	}
	const listed = (await collection.listIndexes().toArray()) as
		| ExistingIndexShape[]
		| never[]
	const existing = listed.find((idx) => idx.name === name)
	if (existing) {
		// Classify before ANY mutation (F2): an incompatible target must leave
		// the collection exactly as found, counterpart included.
		const keyMatches = sameKeyPattern(existing.key, key)
		const isTtl = existing.expireAfterSeconds !== undefined
		const foreign = foreignOptionsOf(existing)
		if (!keyMatches || !isTtl || foreign.length > 0) {
			const reason = !keyMatches
				? `key pattern ${JSON.stringify(existing.key)} does not match expected ${JSON.stringify(key)}`
				: !isTtl
					? "is not a TTL index (no expireAfterSeconds)"
					: `carries options collMod cannot remove: ${foreign.join(", ")}`
			throw new Error(
				`TTL index ${name} on ${collection.collectionName} is incompatible: ${reason}. ` +
					"Refusing to mutate or drop an index the schema layer does not own — drop or rename it manually, then rerun setup. " +
					`Existing spec: ${JSON.stringify(existing)}`,
			)
		}
	}
	if (!existing) {
		// Target is known absent, so retiring the same-key counterpart first
		// cannot strand anything — and creation requires it gone (F18).
		if (counterpartName) {
			await dropCounterpartIfPresent(collection, listed, counterpartName)
		}
		await collection.createIndex(key, {
			name,
			expireAfterSeconds,
			collation: { ...SIMPLE_COLLATION },
		})
		return "created"
	}
	let outcome: TtlIndexOutcome
	const currentSeconds = Number(existing.expireAfterSeconds)
	if (currentSeconds === expireAfterSeconds) {
		outcome = "unchanged"
	} else {
		// collMod reference (Options → Change Index Properties): identify the
		// index by name, set only expireAfterSeconds; no index rebuild. Verify
		// against the catalog afterwards so "converged" is a read-back fact,
		// not a receipt. Requires the collMod privilege action on the database
		// (collMod reference, Access Control) — without it this throws and the
		// old TTL stays: fail closed.
		await db.command({
			collMod: collection.collectionName,
			index: { name, expireAfterSeconds },
		})
		const after = (await collection.listIndexes().toArray()).find(
			(idx) => (idx as ExistingIndexShape).name === name,
		) as ExistingIndexShape | undefined
		if (!after || Number(after.expireAfterSeconds) !== expireAfterSeconds) {
			throw new Error(
				`TTL index ${name} on ${collection.collectionName}: collMod returned success but expireAfterSeconds is ${String(after?.expireAfterSeconds)}, expected ${expireAfterSeconds}`,
			)
		}
		log.warn(
			`converged TTL index ${name} on ${collection.collectionName}: expireAfterSeconds ${currentSeconds} -> ${expireAfterSeconds} — deletion horizon moved`,
		)
		outcome = "converged"
	}
	// The target is verified converged/unchanged — a stale same-key
	// counterpart is now safe to retire.
	if (counterpartName) {
		await dropCounterpartIfPresent(collection, listed, counterpartName)
	}
	return outcome
}
