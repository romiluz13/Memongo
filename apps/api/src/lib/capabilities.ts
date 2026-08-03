import type { MemongoBridgeCapabilities } from "@memongo/memory-bridge"

/**
 * P1.9 boot-time search-lane visibility. When Atlas Search/vector indexes
 * cannot be created, the engine warns and silently degrades every query to
 * the `$text` last resort. These helpers make the degradation visible at
 * boot: a capability table is logged once, and MEMONGO_REQUIRE_VECTOR=1
 * refuses to boot when the vector lane is unavailable.
 *
 * Lane model (derived from the engine's DetectedCapabilities via the bridge):
 *   - vector:  $vectorSearch serving index exists and is queryable
 *   - keyword: Atlas Search $search serving index exists and is queryable
 *   - hybrid:  vector + keyword (the engine falls back to js-merge fusion
 *              when server-side score/rank fusion stages are absent, so the
 *              lane needs both retrieval legs, not the fusion stages)
 *   - text:    standard MongoDB $text index last resort — always available
 *
 * All functions are pure (or take an injected probe/logger) so the unit
 * suite can drive them without booting a server or a live Mongo.
 */
export type SearchLanes = {
	hybrid: boolean
	vector: boolean
	keyword: boolean
	text: boolean
}

export function deriveSearchLanes(
	caps: MemongoBridgeCapabilities | null | undefined,
): SearchLanes {
	const vector = caps?.vectorSearch === true
	const keyword = caps?.textSearch === true
	return {
		hybrid: vector && keyword,
		vector,
		keyword,
		// Standard $text indexes are a core MongoDB feature, not Atlas Search —
		// the last-resort lane exists on every deployment.
		text: true,
	}
}

export function formatCapabilityTable(
	lanes: SearchLanes,
	probeError?: string,
): string {
	const status = (ok: boolean): string => (ok ? "available" : "unavailable")
	const lines = [
		"memongo-api search capability lanes:",
		`  hybrid:  ${status(lanes.hybrid)}`,
		`  vector:  ${status(lanes.vector)}`,
		`  keyword: ${status(lanes.keyword)}`,
		`  text:    ${status(lanes.text)} (standard $text fallback)`,
	]
	if (lanes.hybrid && lanes.vector && lanes.keyword && lanes.text) {
		lines.push("  all retrieval lanes available")
	} else {
		lines.push(
			"  DEGRADED: queries on unavailable lanes silently fall back to $text",
		)
	}
	if (probeError) {
		lines.push(`  capability probe failed: ${probeError}`)
	}
	return lines.join("\n")
}

export function logCapabilityTable(
	lanes: SearchLanes,
	probeError?: string,
	log: (message: string) => void = (message) => console.log(message),
): void {
	log(formatCapabilityTable(lanes, probeError))
}

export function isRequireVectorEnabled(raw: string | undefined): boolean {
	const value = raw?.trim().toLowerCase()
	return value === "1" || value === "true"
}

export const REQUIRE_VECTOR_FAILURE_MESSAGE =
	"MEMONGO_REQUIRE_VECTOR is set but vector search is not available on this MongoDB deployment (serving vector index missing or not queryable). Refusing to boot."

export function enforceRequiredVector(
	lanes: SearchLanes,
	probeError?: string,
): void {
	if (lanes.vector) {
		return
	}
	throw new Error(
		probeError
			? `${REQUIRE_VECTOR_FAILURE_MESSAGE} Capability probe failed: ${probeError}`
			: REQUIRE_VECTOR_FAILURE_MESSAGE,
	)
}

export type BootCapabilityReport = {
	lanes: SearchLanes
	probeError?: string
}

/**
 * Best-effort capability probe for boot. A probe failure (e.g. Mongo
 * unreachable during boot) must not crash an unstrict deployment — the lanes
 * degrade to "unavailable" and the error is surfaced in the table; strict
 * mode (MEMONGO_REQUIRE_VECTOR) turns the same report into a boot refusal.
 */
export async function probeBootCapabilities(
	probe: () => Promise<MemongoBridgeCapabilities | null>,
): Promise<BootCapabilityReport> {
	try {
		return { lanes: deriveSearchLanes(await probe()) }
	} catch (err) {
		return {
			lanes: deriveSearchLanes(null),
			probeError: err instanceof Error ? err.message : String(err),
		}
	}
}
