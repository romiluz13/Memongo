export type StandardIndexOptions = {
	memoryTtlDays?: number
	/**
	 * Optional episodes retention, in days. Episodes are derived summaries
	 * (the events they compress remain retained and marked consolidatedAt),
	 * so expiring them bounds storage without losing source data. The TTL
	 * keys on updatedAt — staleness by last touch: an episode re-materialized
	 * from its source window keeps living while untouched windows age out.
	 * Undefined/0 (the default) disables the index: episodes are user-visible
	 * history, so deletion must be an explicit opt-in, never an upgrade
	 * surprise.
	 */
	episodesRetentionDays?: number
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
