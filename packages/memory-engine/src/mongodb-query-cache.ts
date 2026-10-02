/**
 * Compatibility seam for legacy query-cache invalidation.
 *
 * Search no longer reads or writes persisted result-cache rows. Invalidation,
 * TTL cleanup, and tenant erasure remain active while old rows age out.
 */
export { invalidateQueryCache } from "./mongodb-query-cache-invalidation.js"
