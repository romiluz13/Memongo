import type { Document } from "mongodb"

type TemporalWindowOptions = {
	asOf?: Date
	validFromField?: string
	validToField?: string
}

type LiveStateOptions = {
	stateField?: string
	liveStates: string[]
	includeMissingAsLive?: boolean
}

export function resolveTemporalAsOf(asOf?: Date): Date {
	if (asOf instanceof Date && !Number.isNaN(asOf.getTime())) {
		return asOf
	}
	return new Date()
}

export function buildCurrentValidityClause(
	options: TemporalWindowOptions = {},
): Document {
	const asOf = resolveTemporalAsOf(options.asOf)
	const validFromField = options.validFromField ?? "validFrom"
	const validToField = options.validToField ?? "validTo"

	return mergeQueryClauses(
		{
			$or: [
				{ [validFromField]: { $exists: false } },
				{ [validFromField]: { $lte: asOf } },
			],
		},
		{
			$or: [
				{ [validToField]: { $exists: false } },
				{ [validToField]: { $gt: asOf } },
			],
		},
	)
}

export function buildLiveStateClause(options: LiveStateOptions): Document {
	const stateField = options.stateField ?? "state"
	if (options.includeMissingAsLive) {
		return {
			$or: [
				{ [stateField]: { $exists: false } },
				{ [stateField]: { $in: options.liveStates } },
			],
		}
	}
	return options.liveStates.length === 1
		? { [stateField]: options.liveStates[0] }
		: { [stateField]: { $in: options.liveStates } }
}

export function mergeQueryClauses(
	...clauses: Array<Document | undefined>
): Document {
	const effective = clauses.filter((clause): clause is Document => {
		if (!clause) {
			return false
		}
		return Object.keys(clause).length > 0
	})
	if (effective.length === 0) {
		return {}
	}
	if (effective.length === 1) {
		return effective[0]
	}
	return {
		$and: effective.flatMap((clause) =>
			Array.isArray(clause.$and) ? (clause.$and as Document[]) : [clause],
		),
	}
}

// ---------------------------------------------------------------------------
// P4.4.1: TTL expiration (fix-plan-2026-08-03 P4.4.1)
// ---------------------------------------------------------------------------

/**
 * Resolved session-scope TTL settings (memory.mongodb.ttl). Off by default;
 * when enabled, writes carrying a sessionId get an absolute `expiresAt` of
 * recordedAt + sessionDays unless the caller passes an explicit expiresAt.
 */
export type MemoryTtlSettings = {
	enabled: boolean
	sessionDays: number
}

/**
 * Read-side guard for the optional TTL indexes on `events` and
 * `structured_mem`: MongoDB's TTL sweep only runs about every 60s, so an
 * expired document can still be returned until the sweep deletes it. Every
 * read path composes this clause to hide expired docs immediately. The
 * `$exists: false` branch keeps the clause semantics-neutral for documents
 * written without an expiresAt (TTL disabled), so it is applied
 * unconditionally rather than gated on config.
 */
export function buildUnexpiredClause(
	options: { asOf?: Date; field?: string } = {},
): Document {
	const asOf = resolveTemporalAsOf(options.asOf)
	const field = options.field ?? "expiresAt"
	return {
		$or: [{ [field]: { $exists: false } }, { [field]: { $gt: asOf } }],
	}
}

/**
 * Resolve the expiresAt for one write. An explicit per-write value always
 * wins; otherwise the session-scope default applies only when the config is
 * enabled AND the write carries a sessionId. Returns undefined when no TTL
 * applies, so callers can omit the field entirely (byte-identical writes
 * when TTL is off).
 */
export function resolveWriteExpiresAt(params: {
	explicit?: Date
	sessionId?: string
	ttl?: MemoryTtlSettings
	now?: Date
}): Date | undefined {
	if (params.explicit instanceof Date) {
		return params.explicit
	}
	const ttl = params.ttl
	if (!ttl?.enabled || !params.sessionId) {
		return undefined
	}
	const now = params.now ?? new Date()
	return new Date(now.getTime() + ttl.sessionDays * 86_400_000)
}
