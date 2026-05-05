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
