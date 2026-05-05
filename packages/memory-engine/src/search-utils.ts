/**
 * Shared utilities for search-related modules.
 */

/**
 * Recursively sort all object keys in a value for deterministic JSON serialization.
 * Used by both search request signatures and search index definition signatures.
 */
export function sortObject(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortObject)
	}
	if (!value || typeof value !== "object") {
		return value
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, sortObject(entry)]),
	)
}
