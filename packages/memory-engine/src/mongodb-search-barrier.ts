// Opt-in search visibility barrier on writes (#101, decision 17).
//
// MongoDB Search indexing is eventually consistent with no documented bound,
// so a search issued right after a write can miss it. A write that opts in
// stamps a fresh opaque `searchWriteToken` in the same update as its content,
// then probes every search index that write feeds until each one returns the
// document for that exact token, or a bound is reached. Index readiness,
// `queryable`, or the document's presence in the collection never count as
// visibility: only a probe that returns the document for this token does.
import { type Db, type Document, ObjectId } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import { INDEX_AUTOEMBED_MODEL } from "./mongodb-schema-search-definitions.js"
import {
	isSearchIndexQueryable,
	listSearchIndexes,
	type SearchIndexDescription,
} from "./mongodb-schema-search-readiness.js"

const log = createSubsystemLogger("memory:mongodb:search-barrier")

export const SEARCH_WRITE_TOKEN_FIELD = "searchWriteToken"
export const SEARCH_BARRIER_DEFAULT_TIMEOUT_MS = 10_000
export const SEARCH_BARRIER_MIN_TIMEOUT_MS = 1_000
export const SEARCH_BARRIER_INTERVAL_MS = 1_000
export const SEARCH_BARRIER_MAX_ATTEMPTS_PER_INDEX = 10
// autoEmbed takes query text, and every vector probe embeds it (one paid
// query embedding per attempt), so it stays a short constant.
const VECTOR_PROBE_QUERY_TEXT = "search barrier probe"

export type SearchBarrierRequest = {
	/** Lower the 10 s default; clamped to [1000, 10000] ms. */
	timeoutMs?: number
	/** Abort after commit returns a committed `cancelled` outcome. */
	signal?: AbortSignal
}

export type SearchBarrierWriteFamily = "event" | "structured" | "procedure"

export type SearchBarrierIndex =
	| "events_text"
	| "events_vector"
	| "chunks_text"
	| "chunks_vector"
	| "structured_mem_text"
	| "structured_mem_vector"
	| "procedures_text"
	| "procedures_vector"

export type SearchBarrierTarget = {
	index: SearchBarrierIndex
	collection: "events" | "chunks" | "structured_mem" | "procedures"
	kind: "text" | "vector"
	/** autoEmbed path the vector index embeds (vector targets only). */
	path?: string
}

export type SearchBarrierStatus =
	| "searchable"
	| "not-yet-searchable"
	| "cancelled"

export type SearchBarrierReason =
	| "timeout"
	| "projection-failed"
	| "probe-failed"
	| "cancelled"
	| "quarantined"

export type SearchBarrierTargetResult = {
	index: SearchBarrierIndex
	status: "confirmed" | "pending" | "failed"
	attempts: number
}

export type SearchBarrierResult = {
	committed: true
	status: SearchBarrierStatus
	reason?: SearchBarrierReason
	targets: SearchBarrierTargetResult[]
}

export type SearchBarrierUnsupportedReason =
	| "write-family-unsupported"
	| "target-missing"
	| "target-not-queryable"
	| "target-not-filter-capable"

/**
 * Typed pre-write rejection: nothing was written. Checked across package
 * boundaries by `name`, like the engine's other typed write errors.
 */
export class SearchBarrierUnsupportedError extends Error {
	readonly code = "BARRIER_UNSUPPORTED"
	readonly reason: SearchBarrierUnsupportedReason
	constructor(reason: SearchBarrierUnsupportedReason) {
		super(`search barrier unsupported: ${reason}`)
		this.name = "SearchBarrierUnsupportedError"
		this.reason = reason
	}
}

export function isSearchBarrierUnsupportedError(
	err: unknown,
): err is SearchBarrierUnsupportedError {
	return (
		err instanceof Error &&
		err.name === "SearchBarrierUnsupportedError" &&
		typeof (err as { reason?: unknown }).reason === "string"
	)
}

const SEARCH_BARRIER_TARGETS: Record<
	SearchBarrierWriteFamily,
	readonly SearchBarrierTarget[]
> = {
	event: [
		{ index: "events_text", collection: "events", kind: "text" },
		{
			index: "events_vector",
			collection: "events",
			kind: "vector",
			path: "body",
		},
		{ index: "chunks_text", collection: "chunks", kind: "text" },
		{
			index: "chunks_vector",
			collection: "chunks",
			kind: "vector",
			path: "text",
		},
	],
	structured: [
		{
			index: "structured_mem_text",
			collection: "structured_mem",
			kind: "text",
		},
		{
			index: "structured_mem_vector",
			collection: "structured_mem",
			kind: "vector",
			path: "value",
		},
	],
	procedure: [
		{ index: "procedures_text", collection: "procedures", kind: "text" },
		{
			index: "procedures_vector",
			collection: "procedures",
			kind: "vector",
			path: "searchText",
		},
	],
}

/** The fixed target row for a write family; any other family is rejected. */
export function searchBarrierTargets(
	family: string,
): readonly SearchBarrierTarget[] {
	const targets = Object.hasOwn(SEARCH_BARRIER_TARGETS, family)
		? SEARCH_BARRIER_TARGETS[family as SearchBarrierWriteFamily]
		: undefined
	if (!targets) {
		throw new SearchBarrierUnsupportedError("write-family-unsupported")
	}
	return targets
}

export function resolveSearchBarrierTimeoutMs(timeoutMs?: number): number {
	if (typeof timeoutMs !== "number" || Number.isNaN(timeoutMs)) {
		return SEARCH_BARRIER_DEFAULT_TIMEOUT_MS
	}
	return Math.min(
		SEARCH_BARRIER_DEFAULT_TIMEOUT_MS,
		Math.max(SEARCH_BARRIER_MIN_TIMEOUT_MS, Math.floor(timeoutMs)),
	)
}

// Errors after which the server may or may not have applied the write: the
// driver's unknown-commit label, a network failure once the command could
// have been sent, and an unsatisfied write concern on an applied write.
const UNCERTAIN_COMMIT_ERROR_NAMES = new Set([
	"MongoNetworkError",
	"MongoNetworkTimeoutError",
	"MongoWriteConcernError",
])

export function isUncertainCommitError(err: unknown): boolean {
	let current: unknown = err
	for (
		let depth = 0;
		depth < 8 && current && typeof current === "object";
		depth++
	) {
		const hasErrorLabel = (current as { hasErrorLabel?: unknown }).hasErrorLabel
		if (
			typeof hasErrorLabel === "function" &&
			hasErrorLabel.call(current, "UnknownTransactionCommitResult") === true
		) {
			return true
		}
		if (UNCERTAIN_COMMIT_ERROR_NAMES.has(String((current as Error).name))) {
			return true
		}
		current = (current as { cause?: unknown }).cause
	}
	return false
}

/**
 * A barrier write whose commit outcome is unknown rejects with its own error,
 * marked `commitState: "unknown"`; it claims neither committed nor searchable.
 */
export function annotateUncertainCommit<T>(err: T): T {
	if (err && typeof err === "object" && isUncertainCommitError(err)) {
		try {
			Object.defineProperty(err, "commitState", {
				value: "unknown",
				enumerable: true,
				configurable: true,
			})
		} catch {
			// A frozen error keeps its original shape.
		}
	}
	return err
}

/** A fresh opaque token per barrier write: the hex form of a new ObjectId. */
export function mintSearchWriteToken(): string {
	return new ObjectId().toHexString()
}

function mapsSearchWriteToken(
	index: SearchIndexDescription,
	kind: SearchBarrierTarget["kind"],
): boolean {
	const definition = index.latestDefinition ?? index.definition
	if (!definition) return false
	if (kind === "text") {
		const mapping = (definition.mappings as Document | undefined)?.fields?.[
			SEARCH_WRITE_TOKEN_FIELD
		] as Document | Document[] | undefined
		const mappings = Array.isArray(mapping) ? mapping : [mapping]
		return mappings.some((field) => field?.type === "token")
	}
	const fields = Array.isArray(definition.fields) ? definition.fields : []
	return fields.some(
		(field: Document) =>
			field?.type === "filter" && field.path === SEARCH_WRITE_TOKEN_FIELD,
	)
}

/**
 * Static pre-write check: every target index exists, is queryable, and maps
 * the token in its latest definition. Lists index metadata only; it runs no
 * search query and no paid call.
 */
export async function assertSearchBarrierTargets(params: {
	db: Db
	prefix: string
	family: string
	listIndexes?: (collectionName: string) => Promise<SearchIndexDescription[]>
}): Promise<void> {
	const targets = searchBarrierTargets(params.family)
	const listIndexes =
		params.listIndexes ??
		((collectionName: string) =>
			listSearchIndexes(params.db.collection(collectionName)))
	const listed = new Map<string, SearchIndexDescription[]>()
	for (const target of targets) {
		const collectionName = `${params.prefix}${target.collection}`
		let indexes = listed.get(collectionName)
		if (!indexes) {
			try {
				indexes = await listIndexes(collectionName)
			} catch {
				throw new SearchBarrierUnsupportedError("target-missing")
			}
			listed.set(collectionName, indexes)
		}
		const indexName = `${params.prefix}${target.index}`
		const index = indexes.find((candidate) => candidate.name === indexName)
		if (!index) throw new SearchBarrierUnsupportedError("target-missing")
		if (!isSearchIndexQueryable(index)) {
			throw new SearchBarrierUnsupportedError("target-not-queryable")
		}
		if (!mapsSearchWriteToken(index, target.kind)) {
			throw new SearchBarrierUnsupportedError("target-not-filter-capable")
		}
	}
}

export type SearchBarrierClock = {
	now(): number
	/** Resolves after `ms`, or early (without error) when `signal` aborts. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/** Returns how many documents the target index returned for the token. */
export type SearchBarrierProbe = (
	target: SearchBarrierTarget,
	token: string,
) => Promise<number>

export const systemSearchBarrierClock: SearchBarrierClock = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise((resolve) => {
			if (signal?.aborted) {
				resolve()
				return
			}
			const done = () => {
				clearTimeout(timer)
				signal?.removeEventListener("abort", done)
				resolve()
			}
			const timer = setTimeout(done, ms)
			signal?.addEventListener("abort", done, { once: true })
		}),
}

export function searchBarrierProbePipeline(
	target: SearchBarrierTarget,
	prefix: string,
	token: string,
): Document[] {
	const index = `${prefix}${target.index}`
	if (target.kind === "text") {
		return [
			{
				$search: {
					index,
					equals: { path: SEARCH_WRITE_TOKEN_FIELD, value: token },
				},
			},
			{ $limit: 1 },
			{ $project: { _id: 1 } },
		]
	}
	return [
		{
			$vectorSearch: {
				index,
				path: target.path,
				query: { text: VECTOR_PROBE_QUERY_TEXT },
				model: INDEX_AUTOEMBED_MODEL,
				exact: true,
				limit: 1,
				filter: { [SEARCH_WRITE_TOKEN_FIELD]: token },
			},
		},
		{ $project: { _id: 1 } },
	]
}

export function createSearchBarrierProbe(
	db: Db,
	prefix: string,
): SearchBarrierProbe {
	return async (target, token) => {
		const rows = await db
			.collection(`${prefix}${target.collection}`)
			.aggregate(searchBarrierProbePipeline(target, prefix, token), {
				maxTimeMS: SEARCH_BARRIER_DEFAULT_TIMEOUT_MS,
			})
			.toArray()
		return rows.length
	}
}

/**
 * The post-commit half of a barrier write. A failed chunk projection is
 * committed `projection-failed`, and a quarantined entry (never stored in the
 * searchable collection) is committed `quarantined`, both without probing;
 * otherwise the bounded probe loop runs. Logs carry bounded reasons only: no token, query text, document
 * body or provider error text.
 */
export async function awaitSearchBarrier(params: {
	db: Db
	prefix: string
	family: SearchBarrierWriteFamily
	token: string
	request: SearchBarrierRequest
	projectionFailed?: boolean
	quarantined?: boolean
	probe?: SearchBarrierProbe
	clock?: SearchBarrierClock
}): Promise<SearchBarrierResult> {
	const targets = searchBarrierTargets(params.family)
	const unprobedReason = params.projectionFailed
		? "projection-failed"
		: params.quarantined
			? "quarantined"
			: undefined
	const result: SearchBarrierResult = unprobedReason
		? {
				committed: true,
				status: "not-yet-searchable",
				reason: unprobedReason,
				targets: targets.map((target) => ({
					index: target.index,
					status: "pending",
					attempts: 0,
				})),
			}
		: await runSearchBarrier({
				targets,
				token: params.token,
				probe:
					params.probe ?? createSearchBarrierProbe(params.db, params.prefix),
				clock: params.clock ?? systemSearchBarrierClock,
				timeoutMs: params.request.timeoutMs,
				signal: params.request.signal,
			})
	if (result.status !== "searchable") {
		log.warn(`search barrier ${result.status}: ${result.reason ?? "none"}`, {
			family: params.family,
			targets: result.targets.map(
				(target) => `${target.index}:${target.status}:${target.attempts}`,
			),
		})
	}
	return result
}

/** Bounded fields only: a probe error's message can carry provider or query text. */
function logProbeFailure(index: SearchBarrierIndex, err: unknown): void {
	const code = (err as { code?: unknown } | null)?.code
	log.warn("search barrier probe failed", {
		index,
		errorClass:
			err instanceof Error ? err.constructor.name || err.name : typeof err,
		...(typeof code === "number" ? { code } : {}),
	})
}

type TargetState = {
	target: SearchBarrierTarget
	status: SearchBarrierTargetResult["status"]
	attempts: number
}

/**
 * Bounded probe loop. Each round probes every unconfirmed target in
 * parallel; a confirmed target latches. Stops at the first of: every target
 * confirmed, a probe error, abort, the timeout, or 10 attempts per index.
 * The attempt ledger is per write and separate from the search request
 * ledger.
 */
export async function runSearchBarrier(params: {
	targets: readonly SearchBarrierTarget[]
	token: string
	probe: SearchBarrierProbe
	clock: SearchBarrierClock
	timeoutMs?: number
	signal?: AbortSignal
}): Promise<SearchBarrierResult> {
	const { clock, signal } = params
	const deadline = clock.now() + resolveSearchBarrierTimeoutMs(params.timeoutMs)
	const states: TargetState[] = params.targets.map((target) => ({
		target,
		status: "pending",
		attempts: 0,
	}))
	// A probe that settles after the barrier returned must not rewrite the
	// reported outcome.
	let settled = false
	const finish = (
		status: SearchBarrierStatus,
		reason?: SearchBarrierReason,
	): SearchBarrierResult => {
		settled = true
		return {
			committed: true,
			status,
			...(reason ? { reason } : {}),
			targets: states.map((state) => ({
				index: state.target.index,
				status: state.status,
				attempts: state.attempts,
			})),
		}
	}

	while (true) {
		if (signal?.aborted) return finish("cancelled", "cancelled")
		const round = states.filter(
			(state) =>
				state.status === "pending" &&
				state.attempts < SEARCH_BARRIER_MAX_ATTEMPTS_PER_INDEX,
		)
		const remaining = deadline - clock.now()
		if (round.length === 0 || remaining <= 0) break
		for (const state of round) state.attempts += 1
		const probes = Promise.all(
			round.map(async (state) => {
				try {
					const returned = await params.probe(state.target, params.token)
					if (!settled && returned === 1) state.status = "confirmed"
				} catch (err) {
					logProbeFailure(state.target.index, err)
					if (!settled) state.status = "failed"
				}
			}),
		)
		const roundTimer = new AbortController()
		const abortRound = () => roundTimer.abort()
		signal?.addEventListener("abort", abortRound, { once: true })
		let outcome: "probed" | "interrupted"
		try {
			outcome = await Promise.race([
				probes.then(() => "probed" as const),
				clock
					.sleep(remaining, roundTimer.signal)
					.then(() => "interrupted" as const),
			])
		} finally {
			roundTimer.abort()
			signal?.removeEventListener("abort", abortRound)
		}
		if (outcome === "interrupted") {
			if (signal?.aborted) return finish("cancelled", "cancelled")
			break
		}
		if (states.some((state) => state.status === "failed")) {
			return finish("not-yet-searchable", "probe-failed")
		}
		if (states.every((state) => state.status === "confirmed")) {
			return finish("searchable")
		}
		if (clock.now() + SEARCH_BARRIER_INTERVAL_MS >= deadline) break
		await clock.sleep(SEARCH_BARRIER_INTERVAL_MS, signal)
	}
	return finish("not-yet-searchable", "timeout")
}
