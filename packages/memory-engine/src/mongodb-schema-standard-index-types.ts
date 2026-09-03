export type StandardIndexOptions = {
	memoryTtlDays?: number
	relevanceRetentionDays?: number
	revisionRetentionDays?: number
	/**
	 * C-004: retention cap on UNREVIEWED quarantine entries, in days.
	 * Undefined defaults to 30 (claim mandates a cap); 0 disables the TTL.
	 * Reviewed rows (promoted/rejected) never expire — they are the audit
	 * trail.
	 */
	quarantineRetentionDays?: number
	textFallbackIndexes?: boolean
}
