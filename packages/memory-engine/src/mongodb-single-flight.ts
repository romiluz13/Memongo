/**
 * In-process single-flight coalescing (P2.4): N concurrent callers for the
 * same key share ONE execution of the wrapped work instead of stampeding the
 * underlying resource. Used by the search path so a burst of identical
 * queries pays a single retrieval instead of N.
 *
 * Lifecycle: flights are keyed per owner (a manager instance) so independent
 * managers never share work. The first caller becomes the leader and its
 * promise is registered synchronously, so same-tick callers always coalesce.
 * Waiters await the leader's promise — rejections propagate to every waiter
 * with the original error. The entry is removed as soon as the leader's
 * promise settles (success OR failure), so single-flight is NOT a cache:
 * sequential calls always re-execute, and a failed flight never poisons the
 * next attempt.
 */

export type SingleFlightOutcome<T> = {
	value: T
	/** True for the caller whose function actually ran; false for coalesced waiters. */
	leader: boolean
}

const inFlightByOwner = new WeakMap<object, Map<string, Promise<unknown>>>()

export async function runSingleFlight<T>(
	owner: object,
	key: string,
	execute: () => Promise<T>,
): Promise<SingleFlightOutcome<T>> {
	let byKey = inFlightByOwner.get(owner)
	if (!byKey) {
		byKey = new Map()
		inFlightByOwner.set(owner, byKey)
	}
	const existing = byKey.get(key)
	if (existing) {
		return { value: (await existing) as T, leader: false }
	}

	let promise: Promise<T>
	try {
		promise = Promise.resolve(execute())
	} catch (err) {
		// A synchronously-throwing executor still registers as a (rejected)
		// flight so same-tick waiters observe the same failure.
		promise = Promise.reject(err)
	}
	byKey.set(key, promise)
	try {
		return { value: await promise, leader: true }
	} finally {
		if (byKey.get(key) === promise) {
			byKey.delete(key)
			if (byKey.size === 0) {
				inFlightByOwner.delete(owner)
			}
		}
	}
}
