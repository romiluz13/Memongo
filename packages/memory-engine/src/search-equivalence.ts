// ---------------------------------------------------------------------------
// #101 decision 18: when two retrievals in one request are equivalent.
//
// A completed retrieval is reused only when everything that shapes it is the
// same: lane, query, identity, source, time and hard constraints, limits and
// search modes. The key serializes those inputs by value (Dates by instant,
// RegExps by source and flags, object keys sorted), so a same-named lane with
// any different input gets a different key and runs.
//
// One exception is deliberate: caller-built filters carry wall-clock "now"
// arms (retention and validity checks) that differ by milliseconds between
// passes of one request. Instants inside those filters are keyed as "now";
// the request's real time inputs (explicit range, preset, question date) are
// keyed separately and by value.
// ---------------------------------------------------------------------------

function serialize(value: unknown, instantsAsNow: boolean): unknown {
	if (value instanceof Date) {
		return instantsAsNow ? { $now: true } : { $date: value.getTime() }
	}
	if (value instanceof RegExp) {
		return { $regex: value.source, $flags: value.flags }
	}
	if (Array.isArray(value)) {
		return value.map((entry) => serialize(entry, instantsAsNow))
	}
	if (value instanceof Set) {
		return {
			$set: [...value]
				.map((entry) => JSON.stringify(serialize(entry, instantsAsNow)))
				.sort(),
		}
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.flatMap((key) => {
					const entry = (value as Record<string, unknown>)[key]
					return entry === undefined
						? []
						: [[key, serialize(entry, instantsAsNow)]]
				}),
		)
	}
	if (typeof value === "bigint") {
		return { $bigint: value.toString() }
	}
	return value
}

/** The equivalence key of one retrieval. */
export function searchRetrievalKey(inputs: {
	/** Inputs keyed by value, Dates included. */
	exact: Record<string, unknown>
	/** Caller-built filters whose instants are the request's "now". */
	clockRelative?: Record<string, unknown>
}): string {
	return JSON.stringify({
		exact: serialize(inputs.exact, false),
		clockRelative: serialize(inputs.clockRelative ?? {}, true),
	})
}
