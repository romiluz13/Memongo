import {
	type BootPreflightReport,
	isMemongoBootError,
	type MemongoBridgeCapabilities,
	safeBootText,
} from "@memongo/memory-bridge"
import { formatErrorMessage } from "@memongo/lib"

/**
 * API boot (X-06). Creating the engine manager runs the M2 startup contract:
 * MongoDB 8.3+, Search index management, and every required index READY and
 * serving its definition. Any boot failure refuses to serve: the API logs the
 * typed reason and exits before binding the port. On success it logs the
 * search lanes once.
 *
 * Lane model (derived from the engine's DetectedCapabilities via the bridge):
 *   - vector:  $vectorSearch serving index exists and is queryable
 *   - keyword: Atlas Search $search serving index exists and is queryable
 *   - hybrid:  vector + keyword
 */
export type SearchLanes = {
	hybrid: boolean
	vector: boolean
	keyword: boolean
}

export function deriveSearchLanes(
	caps: MemongoBridgeCapabilities | null | undefined,
): SearchLanes {
	const vector = caps?.vectorSearch === true
	const keyword = caps?.textSearch === true
	return { hybrid: vector && keyword, vector, keyword }
}

export function formatCapabilityTable(lanes: SearchLanes): string {
	const status = (ok: boolean): string => (ok ? "available" : "unavailable")
	return [
		"memongo-api search capability lanes:",
		`  hybrid:  ${status(lanes.hybrid)}`,
		`  vector:  ${status(lanes.vector)}`,
		`  keyword: ${status(lanes.keyword)}`,
		"  rerank:  unsupported (native $rerank is not implemented; a rerank request fails with rerank-unsupported)",
	].join("\n")
}

export function logCapabilityTable(
	lanes: SearchLanes,
	log: (message: string) => void = (message) => console.log(message),
): void {
	log(formatCapabilityTable(lanes))
}

/**
 * The boot refusal line. A typed boot failure names its code and the index or
 * setting; every message goes through the boot safe renderer, so no URI, host
 * or secret is printed, whether the failure is typed or not.
 */
export function formatBootFailure(err: unknown): string {
	if (isMemongoBootError(err)) {
		return `memongo-api refused to start: boot failure ${err.code}: ${safeBootText(err.message)}`
	}
	return `memongo-api refused to start: ${safeBootText(formatErrorMessage(err))}`
}

function safeBootValue(value: unknown): unknown {
	if (typeof value === "string") return safeBootText(value)
	if (Array.isArray(value)) return value.map(safeBootValue)
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, safeBootValue(entry)]),
		)
	}
	return value
}

/** The preflight JSON: every string field goes through the boot safe renderer. */
export function formatPreflightReport(report: BootPreflightReport): string {
	return JSON.stringify(safeBootValue(report), null, 2)
}

/**
 * Boot the engine through `probe` (which creates the manager) and log the
 * lanes, or refuse to serve: log the failure and exit 1. Never degrades.
 */
export async function bootOrRefuse(
	probe: () => Promise<MemongoBridgeCapabilities | null>,
	deps: {
		log?: (message: string) => void
		error?: (message: string) => void
		exit: (code: number) => never
	},
): Promise<SearchLanes> {
	let caps: MemongoBridgeCapabilities | null
	try {
		caps = await probe()
	} catch (err) {
		;(deps.error ?? ((message) => console.error(message)))(
			formatBootFailure(err),
		)
		return deps.exit(1)
	}
	const lanes = deriveSearchLanes(caps)
	logCapabilityTable(lanes, deps.log)
	return lanes
}
