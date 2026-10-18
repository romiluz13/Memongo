import {
	type MemongoBridgeCapabilities,
	shouldEnsureTextFallbackIndexes,
} from "@memongo/memory-bridge"
import { formatErrorMessage, redactSensitiveText } from "@memongo/lib"

/**
 * P1.9 boot-time search-lane visibility. When Atlas Search/vector indexes
 * cannot be created, searches that need those lanes report them per call as
 * not-applicable or lane-unavailable outcomes (#101). These helpers make the
 * deployment's lanes visible at boot: a capability table is logged once, and
 * MEMONGO_REQUIRE_VECTOR=1 refuses to boot when the vector lane is
 * unavailable.
 *
 * Lane model (derived from the engine's DetectedCapabilities via the bridge):
 *   - vector:  $vectorSearch serving index exists and is queryable
 *   - keyword: Atlas Search $search serving index exists and is queryable
 *   - hybrid:  vector + keyword (the engine falls back to js-merge fusion
 *              when server-side score/rank fusion stages are absent, so the
 *              lane needs both retrieval legs, not the fusion stages)
 *   - text:    classic MongoDB $text index (chunks and KB only), which the
 *              engine creates only where Atlas Search is absent
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
		// #101: the lane exists only where the engine creates its index, by the
		// same rule; an unknown probe reports it unavailable.
		text: caps != null && shouldEnsureTextFallbackIndexes(caps),
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
		`  text:    ${status(lanes.text)} (classic $text, chunks/KB only)`,
	]
	if (lanes.hybrid && lanes.vector && lanes.keyword) {
		lines.push("  all retrieval lanes available")
	} else {
		lines.push(
			"  DEGRADED: searches report unavailable lanes as typed outcomes; no lane falls back to $text",
		)
	}
	if (probeError) {
		// C-002: probeError can carry credentials (a failed connection echoes
		// the URI). probeBootCapabilities redacts at the origin, but the table
		// is the render boundary — redacting here keeps every direct caller
		// safe too, not just the boot chain.
		lines.push(`  capability probe failed: ${redactSensitiveText(probeError)}`)
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
	// C-002: probeError can carry credentials (a failed connection echoes the
	// URI). It is redacted at the origin in probeBootCapabilities; redacting
	// again here keeps the thrown boot-refusal message safe even when a
	// direct caller passes an unredacted probe report.
	throw new Error(
		probeError
			? `${REQUIRE_VECTOR_FAILURE_MESSAGE} Capability probe failed: ${redactSensitiveText(probeError)}`
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
		// C-002: the probe error can echo the connection URI (or other
		// credentials). The message flows into the boot capability table
		// (console.log — no formatErrorMessage boundary) and into the strict
		// boot-refusal throw, so it must be redacted at the origin.
		return {
			lanes: deriveSearchLanes(null),
			probeError: formatErrorMessage(err),
		}
	}
}
