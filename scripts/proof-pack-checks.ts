export type CheckVerdict = { ok: boolean; details: string }

export type ProofSearchHit = {
	path?: string
	snippet?: string
	source?: string
	scope?: string
	scopeRef?: string
}

function carriesMarker(hit: ProofSearchHit, marker: string): boolean {
	return `${hit.path ?? ""}\n${hit.snippet ?? ""}`.includes(marker)
}

/**
 * Decision 15: `search` reads the agent partition the structured and
 * procedure writes went to. Any result is not proof: the planted marker must
 * come back, and from that partition.
 */
export function evaluateSearch(
	results: ProofSearchHit[],
	expected: { marker: string; scopeRef: string },
): CheckVerdict {
	if (results.length === 0) {
		return { ok: false, details: "search returned no results" }
	}
	const markerHits = results.filter((hit) =>
		carriesMarker(hit, expected.marker),
	)
	if (markerHits.length === 0) {
		return {
			ok: false,
			details: `planted marker not returned (results=${results.length})`,
		}
	}
	const inPartition = markerHits.find(
		(hit) => hit.scopeRef === expected.scopeRef,
	)
	if (!inPartition) {
		return {
			ok: false,
			details: `planted marker returned only outside ${expected.scopeRef} (scopeRefs=${markerHits.map((hit) => hit.scopeRef ?? "none").join(",")})`,
		}
	}
	return {
		ok: true,
		details: `results=${results.length}, marker=${inPartition.path ?? "unknown"}`,
	}
}

export type ProofSearchBarrier = {
	committed?: boolean
	status?: string
	reason?: string
	targets?: Array<{ index?: string; status?: string; attempts?: number }>
}

const MAX_BARRIER_FIELD_CHARS = 64
const MAX_BARRIER_TARGETS = 12

function bounded(value: unknown): string {
	return String(value ?? "none").slice(0, MAX_BARRIER_FIELD_CHARS)
}

/**
 * Decision 17: each proof-pack write opts into the search barrier, and its
 * check passes only when the write itself passed and every target index
 * confirmed the written version.
 */
export function evaluateBarrierWrite(
	write: CheckVerdict,
	barrier: ProofSearchBarrier | undefined,
): CheckVerdict {
	if (!write.ok) {
		return write
	}
	if (!barrier) {
		return {
			ok: false,
			details: `${write.details}, searchBarrier missing from the write response`,
		}
	}
	const targets = barrier.targets ?? []
	if (barrier.status === "searchable") {
		return {
			ok: true,
			details: `${write.details}, searchBarrier=searchable (${targets.length} targets)`,
		}
	}
	const shown = targets
		.slice(0, MAX_BARRIER_TARGETS)
		.map(
			(target) =>
				`${bounded(target.index)}:${bounded(target.status)}/${bounded(target.attempts)}`,
		)
	if (targets.length > MAX_BARRIER_TARGETS) {
		shown.push(`+${targets.length - MAX_BARRIER_TARGETS} more`)
	}
	return {
		ok: false,
		details: `${write.details}, searchBarrier status=${bounded(barrier.status)} reason=${bounded(barrier.reason)} targets=${shown.join(",") || "none"}`,
	}
}

export type ProofDetailedHit = ProofSearchHit & {
	canonicalId?: string
	role?: string
	derivation?: string
}

function isPlantedEvent(hit: ProofDetailedHit, eventIds: string[]): boolean {
	return eventIds.some(
		(id) => hit.canonicalId === `event:${id}` || hit.path === `events/${id}`,
	)
}

/**
 * Decision 15: `searchDetailed` keeps `needExactEvidence` and asks it of the
 * planted session conversation. The marker hit must be one of the planted
 * turns, verbatim user-authored, never a derived structured or procedure entry.
 */
export function evaluateSearchDetailed(
	response: {
		results: ProofDetailedHit[]
		metadata: { pathsExecuted?: unknown; noDirectEvidenceReason?: string }
	},
	expected: { marker: string; plantedEventIds: string[] },
): CheckVerdict {
	const { results, metadata } = response
	if (results.length === 0) {
		const reason = metadata.noDirectEvidenceReason
		return {
			ok: false,
			details: `advanced search returned no evidence${reason ? ` (noDirectEvidenceReason=${reason.slice(0, 200)})` : ""}`,
		}
	}
	if (!Array.isArray(metadata.pathsExecuted)) {
		return { ok: false, details: "metadata.pathsExecuted is not an array" }
	}
	const exactHit = results.find(
		(hit) =>
			carriesMarker(hit, expected.marker) &&
			hit.source === "conversation" &&
			hit.derivation === "user" &&
			isPlantedEvent(hit, expected.plantedEventIds),
	)
	if (!exactHit) {
		const markerHits = results
			.filter((hit) => carriesMarker(hit, expected.marker))
			.map((hit) => `${hit.source ?? "unknown"}/${hit.derivation ?? "unknown"}`)
		return {
			ok: false,
			details: `no planted exact-capable conversation evidence carries the marker (results=${results.length}, marker hits=${markerHits.join(",") || "none"})`,
		}
	}
	return {
		ok: true,
		details: `paths=${metadata.pathsExecuted.join(",") || "none"}, marker=${exactHit.canonicalId ?? exactHit.path}`,
	}
}
