/**
 * P1.9: environment gate for KB-lane e2e assertions.
 *
 * The production-readiness KB test used to wrap its real assertion in
 * `if (pathsExecuted.includes("kb"))` and fall through to a trivial
 * `expect(results).toBeDefined()` otherwise — a false green: when index
 * visibility (or planner routing) regressed and the KB lane never ran, the
 * test PASSED precisely because the thing it verifies was broken.
 *
 * The repaired shape distinguishes two situations:
 *  - the environment CANNOT run the KB lane (its search indexes do not
 *    exist, e.g. atlas-local without autoEmbed) → the test skips EXPLICITLY
 *    with a reason, which the run output reports as a skip, not a pass;
 *  - the environment CAN run the lane (at least one required search index
 *    exists) → the test asserts strictly: the lane must execute and return
 *    reference results, and any regression goes red.
 */
export function kbLaneEnvironmentAvailable(params: {
	/** Names of the search indexes present on the KB chunks collection. */
	availableSearchIndexes: readonly string[]
	/** Search index names the KB lane queries. */
	requiredIndexNames: readonly string[]
}): boolean {
	return params.requiredIndexNames.some((name) =>
		params.availableSearchIndexes.includes(name),
	)
}
