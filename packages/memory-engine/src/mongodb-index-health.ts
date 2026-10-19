// M2 decision 8: per-request index health. Each top-level request or job takes
// a request-local status snapshot of the manifest indexes its planned
// operations use, reads it through the same metadata the startup contract
// reads, and reuses it only within that request and its nested passes. An
// index observed unhealthy at admission is a typed `index-stale` or
// `index-unavailable` failure; nothing steps down to a weaker operation, and a
// later request reads fresh metadata and recovers on a healthy check.
//
// The claim is "never runs against an index observed unhealthy at admission".
// It does not detect transitions after the check or read-after-write
// freshness; the M1 write-token barrier stays the visibility witness.
//
// The snapshot travels in AsyncLocalStorage, like the request ledger in
// mongodb-search-budget.ts: lanes and nested passes share one snapshot without
// threading a parameter through every helper. A caller outside any scope
// (a diagnostic or a unit test calling an engine function directly) is not
// gated, the same as it is not throttled by the ledger. Every manager request
// entry opens the scope.
import { AsyncLocalStorage } from "node:async_hooks"
import type { Db } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { assessRequiredIndex } from "./mongodb-index-assessment.js"
import type { RequiredSearchIndex } from "./mongodb-required-index-manifest.js"
import type { SearchIndexDescription } from "./mongodb-schema-search-readiness.js"
import type { DetectedCapabilities } from "./mongodb-schema-types.js"
import {
	SearchLaneError,
	type SearchFailureReason,
	type SearchLane,
} from "./search-outcomes.js"

const log = createSubsystemLogger("memory:mongodb:index-health")

export type IndexHealthReason = Extract<
	SearchFailureReason,
	"index-stale" | "index-unavailable"
>

/** Why an index is not healthy; bounded enum values, safe in logs and rows. */
export type IndexHealthCause =
	| "stale"
	| "definition-drift"
	| "definition-pending"
	| "absent"
	| "not-ready"
	| "failed"
	| "unqueryable"
	| "metadata-unknown"
	| "not-in-manifest"
	| "metadata-read-failed"

export type IndexHealthVerdict =
	| { healthy: true; index: string }
	| {
			healthy: false
			index: string
			collection: string
			reason: IndexHealthReason
			cause: IndexHealthCause
			/** The metadata read error, kept only as a `cause` for bounded server logs. */
			readError?: unknown
	  }

export type IndexHealthSource = {
	db: Db
	prefix: string
	/** The required-index manifest built at boot: intended definitions, not health. */
	manifest: readonly RequiredSearchIndex[]
	/** What the deployment guarantees for this boot; never index health. */
	facts: DeploymentFacts
}

export type IndexHealthStats = {
	/** `$listSearchIndexes` reads this request issued (one per collection). */
	metadataReads: number
	/** Reads that failed; each one is an `index-unavailable` verdict. */
	failedMetadataReads: number
	/** Index verdicts this request evaluated against its snapshot. */
	indexesChecked: number
}

/** The user-driven metadata read ceiling; the read is bounded, never waited on. */
export const INDEX_HEALTH_READ_MAX_TIME_MS = 5_000

type CollectionRead =
	| { ok: true; indexes: Map<string, SearchIndexDescription> }
	| { ok: false; error: unknown }

function driverCode(err: unknown): number | undefined {
	const code = (err as { code?: unknown } | null)?.code
	return typeof code === "number" ? code : undefined
}

/** One collection's `$listSearchIndexes`; a collection that does not exist has no indexes. */
async function readCollectionIndexes(
	db: Db,
	collectionName: string,
): Promise<Map<string, SearchIndexDescription>> {
	try {
		const rows = (await db
			.collection(collectionName)
			.aggregate([{ $listSearchIndexes: {} }], {
				maxTimeMS: INDEX_HEALTH_READ_MAX_TIME_MS,
			})
			.toArray()) as SearchIndexDescription[]
		const byName = new Map<string, SearchIndexDescription>()
		for (const row of rows) {
			if (typeof row.name === "string") byName.set(row.name, row)
		}
		return byName
	} catch (err) {
		if (driverCode(err) === 26) return new Map()
		throw err
	}
}

const PENDING_BUILD_STATUSES = new Set(["BUILDING", "PENDING", "DELETING"])

/**
 * Map the startup contract's assessment of one index to a request-time
 * verdict. STALE, a pending or drifted definition: the index still serves, but
 * out of date (`index-stale`). Absent, building, FAILED, unqueryable,
 * wrong-typed or unreadable metadata: it cannot serve (`index-unavailable`).
 */
export function classifyIndexHealth(
	entry: RequiredSearchIndex,
	description: SearchIndexDescription | undefined,
): IndexHealthVerdict {
	const at = { index: entry.name, collection: entry.collectionName }
	const assessment = assessRequiredIndex(entry, description)
	switch (assessment.state) {
		case "serving":
			return { healthy: true, index: entry.name }
		case "absent":
			return {
				healthy: false,
				...at,
				reason: "index-unavailable",
				cause: "absent",
			}
		case "drift":
			return {
				healthy: false,
				...at,
				reason: "index-stale",
				cause: "definition-drift",
			}
		case "pending":
			// A READY index whose updated definition is still building keeps
			// serving the old one; every other pending status cannot serve.
			return assessment.status === "READY"
				? {
						healthy: false,
						...at,
						reason: "index-stale",
						cause: "definition-pending",
					}
				: {
						healthy: false,
						...at,
						reason: "index-unavailable",
						cause: PENDING_BUILD_STATUSES.has(assessment.status)
							? "not-ready"
							: "absent",
					}
		case "terminal":
			switch (assessment.failure.code) {
				case "index-stale":
					return {
						healthy: false,
						...at,
						reason: "index-stale",
						cause: "stale",
					}
				case "index-failed":
					return {
						healthy: false,
						...at,
						reason: "index-unavailable",
						cause: "failed",
					}
				case "index-metadata-unknown":
					return {
						healthy: false,
						...at,
						reason: "index-unavailable",
						cause:
							description?.queryable === false
								? "unqueryable"
								: "metadata-unknown",
					}
				default:
					return {
						healthy: false,
						...at,
						reason: "index-unavailable",
						cause: "metadata-unknown",
					}
			}
	}
}

/** Unavailable outranks stale: an index that cannot serve is the worse finding. */
function worst(
	verdicts: readonly IndexHealthVerdict[],
): Extract<IndexHealthVerdict, { healthy: false }> | undefined {
	const unhealthy = verdicts.filter(
		(verdict): verdict is Extract<IndexHealthVerdict, { healthy: false }> =>
			!verdict.healthy,
	)
	return (
		unhealthy.find((verdict) => verdict.reason === "index-unavailable") ??
		unhealthy[0]
	)
}

/**
 * One request's index-health snapshot. Each collection's metadata is read at
 * most once per request, lazily, when the first operation that uses one of its
 * indexes asks. A failed read is remembered for the request, so one request
 * never sees two answers; the next request reads again.
 */
export class RequestIndexHealth {
	private readonly reads = new Map<string, Promise<CollectionRead>>()
	private metadataReads = 0
	private failedMetadataReads = 0
	private indexesChecked = 0

	constructor(private readonly source: IndexHealthSource) {}

	get facts(): DeploymentFacts {
		return this.source.facts
	}

	stats(): IndexHealthStats {
		return {
			metadataReads: this.metadataReads,
			failedMetadataReads: this.failedMetadataReads,
			indexesChecked: this.indexesChecked,
		}
	}

	/** Every manifest entry, for a status surface that reports the whole contract. */
	entries(): readonly RequiredSearchIndex[] {
		return this.source.manifest
	}

	/** The manifest entries of these collections (unprefixed names), optionally one index type. */
	select(
		collections: readonly string[],
		types?: readonly RequiredSearchIndex["type"][],
	): RequiredSearchIndex[] {
		const wanted = new Set(
			collections.map((collection) => `${this.source.prefix}${collection}`),
		)
		return this.source.manifest.filter(
			(entry) =>
				wanted.has(entry.collectionName) &&
				(types === undefined || types.includes(entry.type)),
		)
	}

	private readCollection(collectionName: string): Promise<CollectionRead> {
		let read = this.reads.get(collectionName)
		if (!read) {
			this.metadataReads += 1
			read = readCollectionIndexes(this.source.db, collectionName).then(
				(indexes): CollectionRead => ({ ok: true, indexes }),
				(error: unknown): CollectionRead => {
					this.failedMetadataReads += 1
					return { ok: false, error }
				},
			)
			this.reads.set(collectionName, read)
		}
		return read
	}

	/** The verdict of every entry, reading each collection's metadata once. */
	async check(
		entries: readonly RequiredSearchIndex[],
	): Promise<IndexHealthVerdict[]> {
		const collections = [...new Set(entries.map((e) => e.collectionName))]
		const reads = new Map(
			await Promise.all(
				collections.map(
					async (name) => [name, await this.readCollection(name)] as const,
				),
			),
		)
		return entries.map((entry): IndexHealthVerdict => {
			this.indexesChecked += 1
			const read = reads.get(entry.collectionName)
			if (!read || !read.ok) {
				return {
					healthy: false,
					index: entry.name,
					collection: entry.collectionName,
					reason: "index-unavailable",
					cause: "metadata-read-failed",
					...(read && !read.ok ? { readError: read.error } : {}),
				}
			}
			return classifyIndexHealth(entry, read.indexes.get(entry.name))
		})
	}

	/**
	 * Throws a typed `SearchLaneError` (stage `index-health`) when any of these
	 * indexes is observed unhealthy. Nothing runs against it and nothing
	 * substitutes for it.
	 */
	async assertHealthy(
		entries: readonly RequiredSearchIndex[],
		lane?: SearchLane,
	): Promise<void> {
		const finding = worst(await this.check(entries))
		if (!finding) return
		log.warn("index observed unhealthy at admission", {
			lane,
			index: finding.index,
			reason: finding.reason,
			cause: finding.cause,
		})
		throw new SearchLaneError({
			lane,
			stage: "index-health",
			reason: finding.reason,
			cause: finding.readError,
		})
	}
}

// ---------------------------------------------------------------------------
// Request scope
// ---------------------------------------------------------------------------

const healthStorage = new AsyncLocalStorage<RequestIndexHealth>()

/** The active request's snapshot, or undefined outside a request scope. */
export function activeIndexHealth(): RequestIndexHealth | undefined {
	return healthStorage.getStore()
}

/**
 * Run `fn` as one request. A nested pass shares its parent's snapshot instead
 * of taking a new one.
 */
export function runWithIndexHealth<T>(
	source: IndexHealthSource,
	fn: () => Promise<T>,
): Promise<T> {
	if (healthStorage.getStore()) return fn()
	return healthStorage.run(new RequestIndexHealth(source), fn)
}

// ---------------------------------------------------------------------------
// Lane admission
// ---------------------------------------------------------------------------

// The collections whose manifest indexes each lane's native operation uses.
// The `chunks` entries on the structured, procedure, session, evidence and
// events lanes are the capability flags' own reads: those lanes
// decide whether they run from the chunk flags, so a lane is admitted only
// when the chunk indexes are healthy too. A lane whose flags no longer read
// the chunk indexes drops its `chunks` entry.
const LANE_COLLECTIONS: Partial<Record<SearchLane, readonly string[]>> = {
	"active-critical": ["structured_mem", "chunks"],
	structured: ["structured_mem", "chunks"],
	procedural: ["procedures", "chunks"],
	"backstop:procedural-exact": ["procedures", "chunks"],
	"backstop:procedural": ["procedures", "chunks"],
	graph: ["entities"],
	episodic: ["episodes"],
	kb: ["kb_chunks"],
	"raw-window": ["events"],
	"hybrid:chunks": ["chunks"],
	"hybrid:session_chunks": ["session_chunks", "chunks"],
	"hybrid:memory_evidence": ["memory_evidence", "chunks"],
	"backstop:hybrid": ["chunks"],
	"conversation-evidence": ["events", "chunks"],
	"temporal-coverage": ["events", "chunks"],
	"turn-precision": ["events", "chunks"],
}

/**
 * Admit one lane: throws a typed index-health failure when an index its
 * planned operation uses is observed unhealthy. No-op outside a request scope
 * and for a lane that uses no Search index.
 */
export async function assertLaneIndexesHealthy(
	lane: SearchLane,
	options: { vectorOnly?: boolean } = {},
): Promise<void> {
	const health = activeIndexHealth()
	const collections = LANE_COLLECTIONS[lane]
	if (!health || !collections) return
	await health.assertHealthy(
		health.select(
			collections,
			options.vectorOnly ? ["vectorSearch"] : undefined,
		),
		lane,
	)
}

/**
 * True when this request's manifest declares no index for the lane's
 * collections: a deployment profile that builds none (the LongMemEval
 * search-index profile builds no entity or episode index). The lane has
 * nothing to query, so it is declared not-applicable before it runs instead
 * of querying an index that does not exist. False outside a request scope,
 * for a lane that uses no Search index, and for an empty manifest, which
 * declares nothing and so gates nothing.
 */
export function laneHasNoManifestIndex(lane: SearchLane): boolean {
	const health = activeIndexHealth()
	const collections = LANE_COLLECTIONS[lane]
	return (
		health !== undefined &&
		collections !== undefined &&
		health.entries().length > 0 &&
		health.select(collections).length === 0
	)
}

/**
 * Admit an operation that is not a search lane (recall, novelty, the
 * consolidator, discovery): the named collections' indexes must be healthy.
 * `types` narrows the check to the index types the operation queries, so a
 * text-only read is not refused for an unrelated vector index.
 */
export async function assertCollectionIndexesHealthy(
	collections: readonly string[],
	lane?: SearchLane,
	types?: readonly RequiredSearchIndex["type"][],
): Promise<void> {
	const health = activeIndexHealth()
	if (!health) return
	await health.assertHealthy(health.select(collections, types), lane)
}

// ---------------------------------------------------------------------------
// Capabilities from the snapshot
// ---------------------------------------------------------------------------

/**
 * What the server and the serving definitions guarantee for the life of this
 * boot: fusion stage availability follows the server version, and storedSource
 * follows the definitions the startup contract verified. None of it is health.
 */
export type DeploymentFacts = Pick<
	DetectedCapabilities,
	| "scoreFusion"
	| "rankFusion"
	| "storedSource"
	| "vectorIndexMethod"
	| "capabilityGates"
>

export function deploymentFactsOf(
	capabilities: DetectedCapabilities,
): DeploymentFacts {
	return {
		scoreFusion: capabilities.scoreFusion,
		rankFusion: capabilities.rankFusion,
		storedSource: capabilities.storedSource,
		vectorIndexMethod: capabilities.vectorIndexMethod,
		...(capabilities.capabilityGates
			? { capabilityGates: capabilities.capabilityGates }
			: {}),
	}
}

const TEXT_TIER_COLLECTIONS = ["structured_mem", "procedures"] as const

/**
 * The capability view of this request: the deployment facts plus whether the
 * chunk text and vector indexes, and each text-tier index, are healthy now.
 * Read from the request snapshot; there is no boot-time health. A failed
 * metadata read makes the flags false, and the lane gate throws the typed
 * `index-unavailable` before any lane that depends on them runs.
 */
export async function capabilitiesFromHealth(
	health: RequestIndexHealth,
): Promise<DetectedCapabilities> {
	const chunkEntries = health.select(["chunks"])
	const [chunks, textTiers] = await Promise.all([
		health.check(chunkEntries),
		health.check(health.select(TEXT_TIER_COLLECTIONS, ["search"])),
	])
	const typeHealthy = (type: RequiredSearchIndex["type"]): boolean => {
		const wanted = chunkEntries.filter((entry) => entry.type === type)
		return (
			wanted.length > 0 &&
			wanted.every(
				(entry) =>
					chunks.find((verdict) => verdict.index === entry.name)?.healthy ===
					true,
			)
		)
	}
	return {
		...health.facts,
		vectorSearch: typeHealthy("vectorSearch"),
		textSearch: typeHealthy("search"),
		queryableSearchIndexes: textTiers
			.filter((verdict) => verdict.healthy)
			.map((verdict) => verdict.index),
	}
}

/**
 * The capability view for a caller that did not pass one: the active
 * request's snapshot. No snapshot, no answer: there is no default to assume.
 */
export async function capabilitiesFromActiveHealth(): Promise<DetectedCapabilities> {
	return capabilitiesFromHealth(requireIndexHealth())
}

/** The active request's snapshot; a caller that needs one outside a scope is a defect. */
export function requireIndexHealth(): RequestIndexHealth {
	const health = activeIndexHealth()
	if (!health) {
		throw new SearchLaneError({
			stage: "request",
			reason: "internal-error",
			cause: new Error(
				"index health needs an active request scope (runWithIndexHealth) or caller-supplied capabilities",
			),
		})
	}
	return health
}

/**
 * Whether every one of these indexes is serving now, for a boolean probe. A
 * failed metadata read is not "not serving": it throws the typed
 * `index-unavailable`, so a probe that cannot answer says so.
 */
export async function indexesServing(
	health: RequestIndexHealth,
	entries: readonly RequiredSearchIndex[],
): Promise<boolean> {
	const verdicts = await health.check(entries)
	for (const verdict of verdicts) {
		if (!verdict.healthy && verdict.cause === "metadata-read-failed") {
			throw new SearchLaneError({
				stage: "index-health",
				reason: "index-unavailable",
				cause: verdict.readError,
			})
		}
	}
	return verdicts.length > 0 && verdicts.every((verdict) => verdict.healthy)
}

export type IndexHealthReport = {
	index: string
	collection: string
	healthy: boolean
	reason?: IndexHealthReason
	cause?: IndexHealthCause
}

/** Per-index verdicts for a status surface; a failed read is reported, never hidden. */
export async function reportIndexHealth(
	health: RequestIndexHealth,
	entries: readonly RequiredSearchIndex[],
): Promise<IndexHealthReport[]> {
	const verdicts = await health.check(entries)
	return verdicts.map((verdict, position) =>
		verdict.healthy
			? {
					index: verdict.index,
					collection: entries[position].collectionName,
					healthy: true,
				}
			: {
					index: verdict.index,
					collection: verdict.collection,
					healthy: false,
					reason: verdict.reason,
					cause: verdict.cause,
				},
	)
}
