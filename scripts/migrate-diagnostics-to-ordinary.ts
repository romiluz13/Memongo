import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { BSON, MongoClient, type ClientSession, type Db } from "mongodb"

/**
 * Offline migration for existing time-series `memory_telemetry` and
 * `access_events` collections into ordinary collections with preserved BSON
 * payload/multiplicity, fresh unique ObjectId `_id` values, preserved
 * retention, and ordinary-startup compatibility.
 *
 * Mechanism (documented MongoDB behavior, validated on 9.0 with FCV 9):
 *   1. validate namespaces/types/UUIDs and persist ownership state
 *   2. pin one snapshot session; digest the source with `{$project:{_id:0}}`
 *      raw cursor reads (SHA-256 per row, multiset counts)
 *   3. copy inside that SAME snapshot with `[{$unset:"_id"},{$out:candidate}]`
 *      (`$unset` is the documented exact alias of the digest's `_id`
 *      exclusion, so both sides cover identical application fields; `$out`
 *      atomically replaces its target on completion and carries no indexes
 *      over to it)
 *   4. verify the candidate outside the snapshot against the recorded digest
 *      multiset; capture its UUID; confirm fresh unique ObjectId `_id`s
 *   5. install via `renameCollection ... dropTarget:true`, then establish the
 *      ordinary TTL index (deferred until after install: `$out` does not
 *      carry indexes over, so an earlier TTL would be silently discarded)
 *
 * Time-series sources may legally hold duplicate or missing `_id` values
 * (time-series collections get no default `_id` index) and cannot be
 * converted in place, which is why the data moves through a fresh ordinary
 * candidate before the namespace swap.
 *
 * Retention: ordinary startup (`ensureOrdinaryDiagnosticCollection` in
 * packages/memory-engine/src/mongodb-schema-collections.ts) enforces exactly
 * one `{ts:1}` TTL index with the canonical retention (604800 s telemetry,
 * 2592000 s access events) and throws on any other policy. The converter
 * therefore installs only the canonical retention: a matching source TTL is
 * preserved, and a differing source TTL requires an explicit
 * `--accept-retention-change` (its effect is shown in the dry run) or the
 * run stops with the source unchanged.
 *
 * Usage (defaults to a read-only dry run):
 *
 *   MEMONGO_MONGODB_URI=... bun scripts/migrate-diagnostics-to-ordinary.ts
 *   MEMONGO_MONGODB_URI=... bun scripts/migrate-diagnostics-to-ordinary.ts --apply
 *   MEMONGO_MONGODB_URI=... bun scripts/migrate-diagnostics-to-ordinary.ts --abort
 *
 * Flags:
 *   --apply                     execute the conversion (default: dry run)
 *   --abort                     drop the owned candidate + state, only before
 *                               installation (refuses once installed)
 *   --accept-retention-change   adopt the canonical retention when the source
 *                               TTL differs (instead of stopping)
 *   --state <path>              state file (default migrate-diagnostics-state.json)
 *   --max-time-ms <n>           server time limit for copy aggregations
 *
 * Env (current configuration names, same as backend-config.ts):
 *   MEMONGO_MONGODB_URI                (required)
 *   MEMONGO_MONGODB_DATABASE           (default "memongo")
 *   MEMONGO_MONGODB_COLLECTION_PREFIX  (default "memongo_")
 *
 * Recovery contract: application writers and external DDL must be quiescent.
 * The source is never dropped, renamed, or written before installation. A
 * namespace whose UUID is not recorded in the state as ours is never erased.
 * Interrupted or uncertain `$out`/rename outcomes are recovered by UUID
 * inspection; retrying never amplifies data (`$out` replaces the candidate
 * wholesale). Snapshot history exhaustion fails without installing partial
 * data. Requires at least MongoDB 9 with FCV 9 (older documentation states
 * time-series collections cannot be renamed, so the tool rejects older
 * versions rather than inferring an upgrade procedure). The admission gate is
 * not certification of untested future majors: the receipt records the actual
 * server, while namespace, digest, UUID, and command checks remain the safety
 * barriers.
 */

export const STATE_VERSION = 1
export const CANDIDATE_SUFFIX = "__ordinary_candidate"

export type SurfaceId = "telemetry" | "access-events"

export type SurfaceSpec = {
	surface: SurfaceId
	suffix: string
	/** Canonical retention, mirrors ensureOrdinaryDiagnosticCollection wiring. */
	canonicalRetentionSeconds: number
}

export const SURFACES: readonly SurfaceSpec[] = [
	{
		surface: "telemetry",
		suffix: "memory_telemetry",
		canonicalRetentionSeconds: 604_800,
	},
	{
		surface: "access-events",
		suffix: "access_events",
		canonicalRetentionSeconds: 2_592_000,
	},
]

export type SurfacePhase =
	| "validated"
	| "copying"
	| "copied"
	| "verified"
	| "installed"
	| "complete"
	| "skipped"

export const SURFACE_PHASES: readonly SurfacePhase[] = [
	"validated",
	"copying",
	"copied",
	"verified",
	"installed",
	"complete",
	"skipped",
]

export type DigestMultiset = {
	entries: [string, number][]
	documentCount: number
}

export type NamespaceInfo = {
	name: string
	type: string
	uuid: string | null
	/** TS collection-option TTL; null when absent or "off". */
	retentionSeconds: number | null
}

export type SurfaceState = {
	surface: SurfaceId
	canonicalName: string
	candidateName: string
	phase: SurfacePhase
	skipReason: string | null
	source: { uuid: string; retentionSeconds: number | null } | null
	plan: { retentionSeconds: number; documentCount: number } | null
	digest: DigestMultiset | null
	candidate: { uuid: string; documentCount: number } | null
	installed: { uuid: string } | null
	updatedAt: string
}

export type StateFile = {
	version: number
	database: string
	prefix: string
	server: { version: string; fcv: string } | null
	surfaces: Partial<Record<SurfaceId, SurfaceState>>
}

export type CliArgs = {
	mode: "dry-run" | "apply" | "abort"
	acceptRetentionChange: boolean
	statePath: string
	maxTimeMs: number | undefined
}

const RETENTION_LIMIT = 2_147_483_647

function parsePositiveInteger(value: string, flag: string): number {
	if (!/^\d+$/.test(value)) {
		throw new Error(`${flag} must be a positive integer <= ${RETENTION_LIMIT}`)
	}
	const parsed = Number(value)
	if (
		!Number.isSafeInteger(parsed) ||
		parsed <= 0 ||
		parsed > RETENTION_LIMIT
	) {
		throw new Error(`${flag} must be a positive integer <= ${RETENTION_LIMIT}`)
	}
	return parsed
}

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		mode: "dry-run",
		acceptRetentionChange: false,
		statePath: "migrate-diagnostics-state.json",
		maxTimeMs: undefined,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string
		const next = argv[i + 1]
		switch (arg) {
			case "--apply":
				if (args.mode === "abort") {
					throw new Error("use either --apply or --abort, not both")
				}
				args.mode = "apply"
				break
			case "--abort":
				if (args.mode === "apply") {
					throw new Error("use either --apply or --abort, not both")
				}
				args.mode = "abort"
				break
			case "--accept-retention-change":
				args.acceptRetentionChange = true
				break
			case "--state":
				if (next === undefined || next === "")
					throw new Error("--state requires a path")
				args.statePath = next
				i++
				break
			case "--max-time-ms":
				if (next === undefined)
					throw new Error("--max-time-ms requires a value")
				args.maxTimeMs = parsePositiveInteger(next, "--max-time-ms")
				i++
				break
			default:
				throw new Error(`unknown argument: ${arg}`)
		}
	}
	if (args.mode === "abort" && args.acceptRetentionChange) {
		throw new Error("--accept-retention-change cannot be combined with --abort")
	}
	return args
}

export type ConverterConfig = { uri: string; database: string; prefix: string }

export function resolveConfig(env: NodeJS.ProcessEnv): ConverterConfig {
	const uri = env.MEMONGO_MONGODB_URI?.trim()
	if (!uri) {
		throw new Error("MEMONGO_MONGODB_URI is required")
	}
	return {
		uri,
		database: env.MEMONGO_MONGODB_DATABASE?.trim() || "memongo",
		prefix: env.MEMONGO_MONGODB_COLLECTION_PREFIX?.trim() || "memongo_",
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBoundedInteger(
	value: unknown,
	options: { minimum: number; maximum?: number },
): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= options.minimum &&
		value <= (options.maximum ?? Number.MAX_SAFE_INTEGER)
	)
}

/**
 * State is an ownership credential, not a source of namespace configuration.
 * Reject stale or malformed identifiers before any recovery inspection or DDL.
 */
export function validateStateForConfig(
	state: StateFile,
	config: Pick<ConverterConfig, "database" | "prefix">,
): void {
	if (state.database !== config.database || state.prefix !== config.prefix) {
		throw new Error(
			`state file was recorded for db=${String(state.database)} prefix=${String(state.prefix)}, refusing to run against db=${config.database} prefix=${config.prefix}`,
		)
	}
	if (state.version !== STATE_VERSION) {
		throw new Error(
			`state file has version ${String(state.version)}, expected ${STATE_VERSION}`,
		)
	}
	if (!isRecord(state.surfaces)) {
		throw new Error("state file surfaces must be an object")
	}
	const expected = new Map(
		SURFACES.map((spec) => [
			spec.surface,
			{
				spec,
				canonicalName: `${config.prefix}${spec.suffix}`,
				candidateName: `${config.prefix}${spec.suffix}${CANDIDATE_SUFFIX}`,
			},
		]),
	)
	for (const [surfaceKey, rawSurface] of Object.entries(state.surfaces)) {
		const expectedSurface = expected.get(surfaceKey as SurfaceId)
		if (!expectedSurface) {
			throw new Error(
				`state file contains unexpected surface identifier ${surfaceKey}`,
			)
		}
		if (!isRecord(rawSurface)) {
			throw new Error(`state surface ${surfaceKey} must be an object`)
		}
		if (rawSurface.surface !== surfaceKey) {
			throw new Error(
				`state surface ${surfaceKey} records mismatched identifier ${String(rawSurface.surface)}`,
			)
		}
		if (
			rawSurface.canonicalName !== expectedSurface.canonicalName ||
			rawSurface.candidateName !== expectedSurface.candidateName
		) {
			throw new Error(
				`state surface ${surfaceKey} namespace mismatch; expected canonical=${expectedSurface.canonicalName} candidate=${expectedSurface.candidateName}`,
			)
		}
		const phase = rawSurface.phase
		if (
			typeof phase !== "string" ||
			!(SURFACE_PHASES as readonly string[]).includes(phase)
		) {
			throw new Error(
				`state surface ${surfaceKey} has unknown phase ${String(phase)}`,
			)
		}
		const source = rawSurface.source
		if (
			source !== null &&
			(!isRecord(source) ||
				typeof source.uuid !== "string" ||
				source.uuid.length === 0 ||
				(source.retentionSeconds !== null &&
					!isBoundedInteger(source.retentionSeconds, {
						minimum: 0,
						maximum: RETENTION_LIMIT,
					})))
		) {
			throw new Error(
				`state surface ${surfaceKey} source identity or retention is malformed`,
			)
		}
		const plan = rawSurface.plan
		if (
			plan !== null &&
			(!isRecord(plan) ||
				plan.retentionSeconds !==
					expectedSurface.spec.canonicalRetentionSeconds ||
				!isBoundedInteger(plan.documentCount, { minimum: 0 }))
		) {
			throw new Error(
				`state surface ${surfaceKey} plan must use canonical integer retention ${expectedSurface.spec.canonicalRetentionSeconds} and a non-negative integer document count`,
			)
		}
		const digest = rawSurface.digest
		if (
			digest !== null &&
			(!isRecord(digest) ||
				!isBoundedInteger(digest.documentCount, { minimum: 0 }) ||
				!Array.isArray(digest.entries) ||
				digest.entries.some(
					(entry) =>
						!Array.isArray(entry) ||
						entry.length !== 2 ||
						typeof entry[0] !== "string" ||
						entry[0].length === 0 ||
						!isBoundedInteger(entry[1], { minimum: 1 }),
				))
		) {
			throw new Error(
				`state surface ${surfaceKey} digest counts must be safe integers`,
			)
		}
		for (const identityField of ["candidate", "installed"] as const) {
			const identity = rawSurface[identityField]
			if (
				identity !== null &&
				(!isRecord(identity) ||
					typeof identity.uuid !== "string" ||
					identity.uuid.length === 0)
			) {
				throw new Error(
					`state surface ${surfaceKey} ${identityField} identity is malformed`,
				)
			}
		}
		if (
			isRecord(rawSurface.candidate) &&
			!isBoundedInteger(rawSurface.candidate.documentCount, { minimum: 0 })
		) {
			throw new Error(
				`state surface ${surfaceKey} candidate document count must be a non-negative integer`,
			)
		}
		// Phase-specific persisted-state invariants: each phase implies which
		// digest and identity fields must be present or absent. The `copied`
		// phase additionally accepts the legacy checkpoint persisted before
		// candidate UUID pinning, which carries no candidate identity.
		if (phase === "validated") {
			if (
				digest !== null ||
				rawSurface.candidate !== null ||
				rawSurface.installed !== null
			) {
				throw new Error(
					`state surface ${surfaceKey} phase validated must not record digest, candidate, or installed identity`,
				)
			}
		} else if (phase === "copying") {
			if (
				digest === null ||
				source === null ||
				plan === null ||
				rawSurface.candidate !== null ||
				rawSurface.installed !== null
			) {
				throw new Error(
					`state surface ${surfaceKey} phase copying requires digest, source, and plan and must not record candidate or installed identity`,
				)
			}
		} else if (phase === "copied") {
			if (
				digest === null ||
				source === null ||
				plan === null ||
				rawSurface.installed !== null
			) {
				throw new Error(
					`state surface ${surfaceKey} phase copied requires digest, source, and plan and must not record installed identity`,
				)
			}
		} else if (phase === "verified") {
			if (
				digest === null ||
				source === null ||
				plan === null ||
				rawSurface.candidate === null ||
				rawSurface.installed !== null
			) {
				throw new Error(
					`state surface ${surfaceKey} phase verified requires digest, source, plan, and candidate identity and must not record installed identity`,
				)
			}
		} else if (phase === "installed" || phase === "complete") {
			if (
				digest === null ||
				source === null ||
				plan === null ||
				rawSurface.installed === null
			) {
				throw new Error(
					`state surface ${surfaceKey} phase ${phase} requires digest, source, plan, and installed identity`,
				)
			}
		} else if (phase === "skipped") {
			if (
				typeof rawSurface.skipReason !== "string" ||
				rawSurface.skipReason.length === 0 ||
				digest !== null ||
				rawSurface.candidate !== null ||
				rawSurface.installed !== null
			) {
				throw new Error(
					`state surface ${surfaceKey} phase skipped requires a non-empty skip reason and must not record digest, candidate, or installed identity`,
				)
			}
		}
	}
}

export function sha256Hex(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex")
}

export function digestMultiset(rows: Buffer[]): DigestMultiset {
	const counts = new Map<string, number>()
	for (const row of rows) {
		const hash = sha256Hex(row)
		counts.set(hash, (counts.get(hash) ?? 0) + 1)
	}
	return {
		entries: [...counts.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([hash, count]) => [hash, count] as [string, number]),
		documentCount: rows.length,
	}
}

export function digestsEqual(a: DigestMultiset, b: DigestMultiset): boolean {
	return (
		a.documentCount === b.documentCount &&
		a.entries.length === b.entries.length &&
		a.entries.every(
			([hash, count], index) =>
				b.entries[index]?.[0] === hash && b.entries[index]?.[1] === count,
		)
	)
}

function describeRetention(seconds: number | null): string {
	return seconds === null ? "off/absent" : `${seconds}s`
}

export type RetentionDecision =
	| { action: "install"; retentionSeconds: number; note: string }
	| { action: "abort"; reason: string }

/**
 * Retention policy: the canonical value keeps ordinary startup compatible
 * (ensureOrdinaryDiagnosticCollection enforces an exact match and throws
 * otherwise). A differing source setting is never silently dropped: it is
 * either adopted explicitly (--accept-retention-change) or aborts the
 * surface with the source unchanged.
 */
export function decideRetention(input: {
	discovered: number | null
	canonical: number
	acceptChange: boolean
}): RetentionDecision {
	if (input.discovered === input.canonical) {
		return {
			action: "install",
			retentionSeconds: input.canonical,
			note: `source retention ${input.canonical}s preserved`,
		}
	}
	if (input.acceptChange) {
		return {
			action: "install",
			retentionSeconds: input.canonical,
			note: `source retention ${describeRetention(input.discovered)} replaced by canonical ${input.canonical}s (--accept-retention-change)`,
		}
	}
	return {
		action: "abort",
		reason: `source retention ${describeRetention(input.discovered)} differs from the canonical ${input.canonical}s, the only value ordinary startup accepts (it enforces an exact TTL match); pass --accept-retention-change to adopt the canonical value, or stop and leave the source unchanged`,
	}
}

export async function getServerInfo(
	db: Db,
): Promise<{ version: string; fcv: string }> {
	const build = await db.admin().command({ buildInfo: 1 })
	const parameters = await db.admin().command({
		getParameter: 1,
		featureCompatibilityVersion: 1,
	})
	const fcv = parameters.featureCompatibilityVersion as
		| { version?: unknown }
		| undefined
	return {
		version: String(build.version),
		fcv: String(fcv?.version ?? ""),
	}
}

export function serverSupported(server: {
	version: string
	fcv: string
}): boolean {
	const major = Number.parseInt(server.version.split(".")[0] ?? "", 10)
	const fcvMajor = Number.parseInt(server.fcv.split(".")[0] ?? "", 10)
	return major >= 9 && fcvMajor >= 9
}

type RawCollectionInfo = {
	name?: unknown
	type?: unknown
	options?: { expireAfterSeconds?: unknown }
	info?: { uuid?: unknown }
}

export async function inspectNamespace(
	db: Db,
	name: string,
): Promise<NamespaceInfo | null> {
	const [raw] = await db.listCollections({ name }).toArray()
	if (!raw) {
		return null
	}
	const info = raw as RawCollectionInfo
	const expire = info.options?.expireAfterSeconds
	return {
		name,
		type: String(info.type ?? "collection"),
		uuid: info.info?.uuid === undefined ? null : String(info.info.uuid),
		retentionSeconds: typeof expire === "number" ? expire : null,
	}
}

export function ownsNamespace(
	recordedUuid: string | null | undefined,
	observed: NamespaceInfo | null,
): boolean {
	return (
		observed !== null &&
		observed.uuid !== null &&
		recordedUuid !== null &&
		recordedUuid !== undefined &&
		observed.uuid === recordedUuid
	)
}

export async function digestCollection(
	db: Db,
	name: string,
	options: { session?: ClientSession; maxTimeMs?: number } = {},
): Promise<DigestMultiset> {
	// {$unset:"_id"} is the documented exact alias of this exclusion
	// projection, so the copy result and the digested source multiset cover
	// the same application fields.
	const rows = (await db
		.collection(name)
		.aggregate([{ $project: { _id: 0 } }], {
			raw: true,
			// A snapshot session injects readConcern "snapshot" on its first
			// read and reuses that snapshot time. Do not override it with an
			// operation-level majority concern.
			...(options.session === undefined
				? { readConcern: { level: "majority" } }
				: {}),
			...(options.session !== undefined ? { session: options.session } : {}),
			...(options.maxTimeMs !== undefined
				? { maxTimeMS: options.maxTimeMs }
				: {}),
		})
		.toArray()) as unknown as Buffer[]
	return digestMultiset(rows)
}

/**
 * Copy phase: one snapshot session pins the conversion boundary. The digest
 * aggregate is the first operation (pins the snapshot), then the
 * `$unset`+`$out` copy reads the SAME snapshot, so concurrent source expiry
 * or deletion cannot make the copy diverge from the recorded digest
 * (read concern "snapshot" documentation: reads are
 * bounded by minSnapshotHistoryWindowInSeconds and may terminate, which
 * aborts here without installing anything).
 */
export async function runCopyPhase(
	db: Db,
	state: SurfaceState,
	maxTimeMs: number | undefined,
	persistCopyIntent: () => Promise<void>,
): Promise<void> {
	if (!state.source || !state.plan) {
		throw new Error(
			"copy requires a recorded source identity and retention plan",
		)
	}
	const existingCandidate = await inspectNamespace(db, state.candidateName)
	if (existingCandidate !== null) {
		throw new Error(
			"the candidate namespace existed before copy intent was recorded; refusing to overwrite an unowned collection",
		)
	}
	const session = db.client.startSession({ snapshot: true })
	try {
		const digest = await digestCollection(db, state.canonicalName, {
			session,
			maxTimeMs,
		})
		state.digest = digest
		state.plan.documentCount = digest.documentCount
		state.candidate = null
		state.phase = "copying"
		state.updatedAt = new Date().toISOString()
		// Persist the pinned source boundary before the server-side output
		// transition. If the response is lost, retry can identify the result
		// by its exact digest before adopting its UUID.
		await persistCopyIntent()
		await db
			.collection(state.canonicalName)
			.aggregate([{ $unset: "_id" }, { $out: state.candidateName }], {
				session,
				writeConcern: { w: "majority" },
				...(maxTimeMs !== undefined ? { maxTimeMS: maxTimeMs } : {}),
			})
			.toArray()
		const candidate = await inspectNamespace(db, state.candidateName)
		if (!candidate || candidate.type !== "collection" || !candidate.uuid) {
			throw new Error(
				"copy completed without an identifiable ordinary candidate; retry --apply to reconcile the persisted copy intent",
			)
		}
		state.candidate = {
			uuid: candidate.uuid,
			documentCount: digest.documentCount,
		}
		state.phase = "copied"
		state.updatedAt = new Date().toISOString()
	} finally {
		await session.endSession()
	}
}

/**
 * Reconcile a persisted pre-$out checkpoint after an interrupted or uncertain
 * response. An unrecorded namespace is adopted only when its ordinary type,
 * UUID, and complete payload digest match the pinned source boundary.
 */
export async function recoverCopyingPhase(
	db: Db,
	state: SurfaceState,
	candidateObserved: NamespaceInfo | null,
	maxTimeMs?: number,
): Promise<"adopted" | "restart"> {
	if (
		(state.phase !== "copying" &&
			!(state.phase === "copied" && state.candidate === null)) ||
		!state.digest ||
		!state.source ||
		!state.plan
	) {
		throw new Error(
			"copy recovery requires a complete persisted copying checkpoint or an older copied checkpoint without candidate identity",
		)
	}
	if (candidateObserved === null) {
		state.phase = "validated"
		state.digest = null
		state.candidate = null
		state.updatedAt = new Date().toISOString()
		return "restart"
	}
	if (
		candidateObserved.type !== "collection" ||
		!candidateObserved.uuid ||
		(state.candidate !== null &&
			!ownsNamespace(state.candidate.uuid, candidateObserved))
	) {
		throw new Error(INSTALL_ACTION_ERRORS["abort-foreign-candidate"])
	}
	const digest = await digestCollection(db, state.candidateName, { maxTimeMs })
	if (!digestsEqual(digest, state.digest)) {
		throw new Error(INSTALL_ACTION_ERRORS["abort-foreign-candidate"])
	}
	state.candidate = {
		uuid: candidateObserved.uuid,
		documentCount: digest.documentCount,
	}
	state.phase = "copied"
	state.updatedAt = new Date().toISOString()
	return "adopted"
}

export async function runVerifyPhase(
	db: Db,
	state: SurfaceState,
): Promise<void> {
	if (!state.digest) {
		throw new Error("verify requires the recorded source digest")
	}
	const digest = await digestCollection(db, state.candidateName)
	if (!digestsEqual(digest, state.digest)) {
		throw new Error(
			`candidate digest does not match the pinned source digest multiset (candidate ${digest.documentCount} vs source ${state.digest.documentCount} documents); retry --apply to re-copy — the source is untouched`,
		)
	}
	const ids = await db
		.collection(state.candidateName)
		.find({}, { projection: { _id: 1 } })
		.toArray()
	const freshUniqueObjectIds =
		ids.every(
			(doc) => (doc as { _id?: unknown })._id instanceof BSON.ObjectId,
		) &&
		new Set(ids.map((doc) => String((doc as { _id: unknown })._id))).size ===
			ids.length
	if (!freshUniqueObjectIds) {
		throw new Error(
			"candidate documents do not all carry fresh unique ObjectId _id values; retry --apply to re-copy",
		)
	}
	const candidate = await inspectNamespace(db, state.candidateName)
	if (!candidate || candidate.type !== "collection" || !candidate.uuid) {
		throw new Error(
			"owned candidate is missing or not an ordinary collection; retry --apply",
		)
	}
	state.candidate = {
		uuid: candidate.uuid,
		documentCount: digest.documentCount,
	}
	state.phase = "verified"
	state.updatedAt = new Date().toISOString()
}

export type InstallAction =
	| "rename"
	| "already-installed"
	| "restart-from-copy"
	| "abort-foreign-canonical"
	| "abort-foreign-candidate"
	| "abort-missing"

/**
 * Install/recovery decision from observed namespaces vs recorded state.
 * "already-installed" also recovers an uncertain renameCollection response:
 * if the canonical carries the verified candidate UUID, the rename happened.
 */
export function planInstallAction(input: {
	canonicalObserved: NamespaceInfo | null
	candidateObserved: NamespaceInfo | null
	sourceUuid: string | null
	candidateUuid: string | null
	installedUuid: string | null
}): InstallAction {
	const canonical = input.canonicalObserved
	const candidate = input.candidateObserved
	if (canonical !== null) {
		if (
			ownsNamespace(input.installedUuid, canonical) ||
			ownsNamespace(input.candidateUuid, canonical)
		) {
			return "already-installed"
		}
		if (canonical.type === "timeseries") {
			if (!ownsNamespace(input.sourceUuid, canonical)) {
				return "abort-foreign-canonical"
			}
			if (candidate === null) {
				return "restart-from-copy"
			}
			return ownsNamespace(input.candidateUuid, candidate)
				? "rename"
				: "abort-foreign-candidate"
		}
		return "abort-foreign-canonical"
	}
	if (candidate === null) {
		return "abort-missing"
	}
	return ownsNamespace(input.candidateUuid, candidate)
		? "rename"
		: "abort-foreign-candidate"
}

const INSTALL_ACTION_ERRORS: Record<
	Exclude<InstallAction, "rename" | "already-installed">,
	string
> = {
	"abort-foreign-canonical":
		"the canonical namespace carries an identity this tool did not record; refusing to overwrite a foreign or replaced namespace",
	"abort-foreign-candidate":
		"the candidate namespace carries an identity this tool did not record; refusing to erase an unowned collection",
	"abort-missing":
		"neither the canonical nor the owned candidate namespace exists; nothing verified remains to install (state digest is preserved for inspection)",
	"restart-from-copy":
		"the verified candidate is gone but the source time-series collection is intact; re-running the copy phase",
}

export async function runInstallPhase(
	db: Db,
	database: string,
	state: SurfaceState,
): Promise<"renamed" | "already-installed" | "restarted"> {
	const action = planInstallAction({
		canonicalObserved: await inspectNamespace(db, state.canonicalName),
		candidateObserved: await inspectNamespace(db, state.candidateName),
		sourceUuid: state.source?.uuid ?? null,
		candidateUuid: state.candidate?.uuid ?? null,
		installedUuid: state.installed?.uuid ?? null,
	})
	if (action === "restart-from-copy") {
		state.phase = "validated"
		state.digest = null
		state.candidate = null
		state.updatedAt = new Date().toISOString()
		return "restarted"
	}
	if (action === "already-installed") {
		state.installed =
			state.installed ??
			(state.candidate ? { uuid: state.candidate.uuid } : null)
		state.phase = "installed"
		state.updatedAt = new Date().toISOString()
		return "already-installed"
	}
	if (action !== "rename") {
		throw new Error(INSTALL_ACTION_ERRORS[action])
	}
	await db.admin().command({
		renameCollection: `${database}.${state.candidateName}`,
		to: `${database}.${state.canonicalName}`,
		dropTarget: true,
		writeConcern: { w: "majority" },
	})
	const canonical = await inspectNamespace(db, state.canonicalName)
	if (!ownsNamespace(state.candidate?.uuid ?? null, canonical)) {
		throw new Error(
			`rename outcome uncertain: ${state.canonicalName} does not carry the verified candidate UUID; re-run --apply to reconcile by UUID inspection`,
		)
	}
	state.installed = { uuid: canonical?.uuid as string }
	state.phase = "installed"
	state.updatedAt = new Date().toISOString()
	return "renamed"
}

/**
 * TTL phase: on a fresh install the count check runs BEFORE the TTL index
 * exists so the TTL monitor cannot delete anything between verification and
 * this check. The index is established only after installation because `$out`
 * does not carry indexes over to the replaced output collection.
 *
 * Retry reconciliation: if the exact canonical TTL policy already exists, a
 * prior attempt created the index but crashed before persisting the
 * `complete` phase, and TTL expiry may have legitimately changed the count
 * since. The established policy is authoritative evidence the phase already
 * ran, so the count guard is skipped and the phase is marked complete.
 */
export async function runTtlPhase(db: Db, state: SurfaceState): Promise<void> {
	if (!state.plan) {
		throw new Error("TTL phase requires a recorded plan")
	}
	const plan = state.plan
	const collection = db.collection(state.canonicalName)
	const exactPolicyExists = async (): Promise<boolean> => {
		const indexes = (await collection.listIndexes().toArray()) as Array<{
			key: unknown
			expireAfterSeconds?: number
			partialFilterExpression?: unknown
		}>
		const policy = indexes.filter(
			(index) => index.expireAfterSeconds !== undefined,
		)
		return (
			policy.length === 1 &&
			JSON.stringify(policy[0]?.key) === JSON.stringify({ ts: 1 }) &&
			policy[0]?.expireAfterSeconds === plan.retentionSeconds &&
			policy[0]?.partialFilterExpression === undefined
		)
	}
	if (await exactPolicyExists()) {
		state.phase = "complete"
		state.updatedAt = new Date().toISOString()
		return
	}
	const count = await collection.countDocuments({})
	if (count !== plan.documentCount) {
		throw new Error(
			`installed document count ${count} does not match the verified ${plan.documentCount}; refusing to establish TTL`,
		)
	}
	await collection.createIndex(
		{ ts: 1 },
		{ expireAfterSeconds: plan.retentionSeconds },
	)
	if (!(await exactPolicyExists())) {
		throw new Error(
			`TTL policy on ${state.canonicalName} is not the single exact {ts:1} expireAfterSeconds=${plan.retentionSeconds} index that ordinary startup requires; resolve manually`,
		)
	}
	state.phase = "complete"
	state.updatedAt = new Date().toISOString()
}

export async function loadState(path: string): Promise<StateFile | null> {
	let raw: string
	try {
		raw = await readFile(path, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null
		}
		throw error
	}
	const parsed: unknown = JSON.parse(raw)
	if (!isRecord(parsed) || parsed.version !== STATE_VERSION) {
		throw new Error(
			`state file ${path} has version ${String(isRecord(parsed) ? parsed.version : undefined)}, expected ${STATE_VERSION}`,
		)
	}
	return parsed as StateFile
}

type RenameFile = (oldPath: string, newPath: string) => Promise<void>

/**
 * Replace the journal without truncating its previous complete version.
 *
 * The same-directory rename is one namespace operation on supported POSIX
 * filesystems. A process interruption during the temporary write may leave an
 * incomplete temporary sibling, and one between the write and the rename may
 * leave a complete but unreferenced one; the destination journal itself is
 * only ever replaced by the rename of a fully written temporary file, never
 * truncated in place. This does not claim disk/power-loss durability because
 * neither file nor directory is fsynced.
 */
export async function saveState(
	statePath: string,
	state: StateFile,
	renameFile: RenameFile = rename,
): Promise<void> {
	const directory = path.dirname(statePath)
	await mkdir(directory, { recursive: true })
	const temporaryPath = path.join(
		directory,
		`.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`,
	)
	await writeFile(temporaryPath, `${JSON.stringify(state, null, "\t")}\n`, {
		encoding: "utf8",
		flag: "wx",
	})
	try {
		await renameFile(temporaryPath, statePath)
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => {})
		throw error
	}
}

export type SurfaceOutcome = {
	surface: SurfaceId
	canonicalName: string
	candidateName: string
	phase: SurfacePhase
	skipReason: string | null
	sourceUuid: string | null
	installedUuid: string | null
	documentCount: number | null
	digestEntries: number | null
	retentionSeconds: number | null
	note: string | null
}

function outcomeOf(state: SurfaceState): SurfaceOutcome {
	return {
		surface: state.surface,
		canonicalName: state.canonicalName,
		candidateName: state.candidateName,
		phase: state.phase,
		skipReason: state.skipReason,
		sourceUuid: state.source?.uuid ?? null,
		installedUuid: state.installed?.uuid ?? null,
		documentCount: state.plan?.documentCount ?? null,
		digestEntries: state.digest?.entries.length ?? null,
		retentionSeconds: state.plan?.retentionSeconds ?? null,
		note: state.plan ? (state.skipReason ?? null) : state.skipReason,
	}
}

/**
 * Per-surface orchestration: reconcile recorded state against observed
 * namespaces, then run the remaining phases. Trust observed UUIDs over
 * recorded phases; never touch a namespace whose identity was not recorded.
 */
export async function convertSurface(options: {
	db: Db
	database: string
	spec: SurfaceSpec
	canonicalName: string
	candidateName: string
	state: StateFile
	args: CliArgs
	dryRun: boolean
	log: (message: string) => void
}): Promise<SurfaceOutcome> {
	const {
		db,
		database,
		spec,
		canonicalName,
		candidateName,
		state,
		args,
		dryRun,
		log,
	} = options
	const prior = state.surfaces[spec.surface]
	const surfaceState = (): SurfaceState =>
		prior ?? {
			surface: spec.surface,
			canonicalName,
			candidateName,
			phase: "validated",
			skipReason: null,
			source: null,
			plan: null,
			digest: null,
			candidate: null,
			installed: null,
			updatedAt: new Date().toISOString(),
		}
	const priorPhase = prior?.phase
	const current = surfaceState()
	const canonical = await inspectNamespace(db, canonicalName)
	const candidate = await inspectNamespace(db, candidateName)
	const label = `[${spec.surface}] ${canonicalName}`
	const persist = () => saveState(args.statePath, state)
	const needsCandidateRecovery =
		current.phase === "copying" ||
		(current.phase === "copied" && current.candidate === null)

	if (
		needsCandidateRecovery &&
		canonical !== null &&
		!ownsNamespace(current.source?.uuid ?? null, canonical)
	) {
		throw new Error(
			`${label}: ${INSTALL_ACTION_ERRORS["abort-foreign-canonical"]}`,
		)
	}
	if (needsCandidateRecovery) {
		const recovery = await recoverCopyingPhase(
			db,
			current,
			candidate,
			args.maxTimeMs,
		)
		state.surfaces[spec.surface] = current
		if (!dryRun) {
			await persist()
		}
		log(
			recovery === "adopted"
				? `${label}: adopted candidate uuid=${current.candidate?.uuid} after an uncertain $out response`
				: `${label}: no candidate followed the interrupted copy; restarting from the owned source`,
		)
	}

	if (canonical === null) {
		const lostWork =
			prior &&
			(priorPhase === "copying" ||
				current.phase === "copied" ||
				current.phase === "verified" ||
				current.phase === "installed" ||
				current.phase === "complete")
		if (lostWork && ownsNamespace(current.candidate?.uuid ?? null, candidate)) {
			if (current.phase === "installed" || current.phase === "complete") {
				const stalePhase = current.phase
				current.installed = null
				current.phase = "verified"
				current.updatedAt = new Date().toISOString()
				log(
					`${label}: recorded phase ${stalePhase} is stale (canonical absent, owned candidate intact); reconciling to verified to run the install`,
				)
			} else {
				log(
					`${label}: source absent but the verified candidate still holds the data; installing it`,
				)
			}
		} else if (lostWork) {
			const action = planInstallAction({
				canonicalObserved: canonical,
				candidateObserved: candidate,
				sourceUuid: current.source?.uuid ?? null,
				candidateUuid: current.candidate?.uuid ?? null,
				installedUuid: current.installed?.uuid ?? null,
			})
			if (action === "abort-missing" || action === "abort-foreign-candidate") {
				throw new Error(`${label}: ${INSTALL_ACTION_ERRORS[action]}`)
			}
		}
		if (!lostWork) {
			const skipped: SurfaceState = {
				...surfaceState(),
				phase: "skipped",
				skipReason:
					"source collection absent; the fresh initializer will create the ordinary collection",
			}
			state.surfaces[spec.surface] = skipped
			log(`${label}: skipped (${skipped.skipReason})`)
			return outcomeOf(skipped)
		}
	}

	if (canonical !== null && canonical.type !== "timeseries") {
		if (
			prior &&
			ownsNamespace(
				current.installed?.uuid ?? current.candidate?.uuid ?? null,
				canonical,
			)
		) {
			current.phase = current.phase === "complete" ? "complete" : "installed"
			if (current.installed === null && canonical.uuid !== null) {
				current.installed = { uuid: canonical.uuid }
				current.updatedAt = new Date().toISOString()
			}
			state.surfaces[spec.surface] = current
			log(`${label}: already installed (ordinary, recorded UUID matches)`)
		} else if (
			prior &&
			(priorPhase === "copying" ||
				current.phase === "copied" ||
				current.phase === "verified" ||
				current.phase === "installed" ||
				current.phase === "complete")
		) {
			throw new Error(
				`${label}: ${INSTALL_ACTION_ERRORS["abort-foreign-canonical"]}`,
			)
		} else {
			const skipped: SurfaceState = {
				...surfaceState(),
				phase: "skipped",
				skipReason: `canonical is already ${canonical.type}; this tool only converts time-series sources and never touches it`,
			}
			state.surfaces[spec.surface] = skipped
			log(`${label}: skipped (${skipped.skipReason})`)
			return outcomeOf(skipped)
		}
	}

	if (canonical !== null && canonical.type === "timeseries") {
		if (prior && !ownsNamespace(current.source?.uuid ?? null, canonical)) {
			throw new Error(
				`${label}: ${INSTALL_ACTION_ERRORS["abort-foreign-canonical"]}`,
			)
		}
		if (
			candidate !== null &&
			!ownsNamespace(current.candidate?.uuid ?? null, candidate)
		) {
			throw new Error(
				`${label}: ${INSTALL_ACTION_ERRORS["abort-foreign-candidate"]}`,
			)
		}
		if (current.phase === "installed" || current.phase === "complete") {
			throw new Error(
				`${label}: recorded phase ${current.phase} is stale: the canonical namespace is still the recorded time-series source, so the installation never happened; refusing (state file preserved; reset the surface state to re-convert)`,
			)
		}
	}

	if (current.phase === "validated") {
		if (!canonical || canonical.type !== "timeseries" || !canonical.uuid) {
			throw new Error(`${label}: source is not an owned time-series collection`)
		}
		current.source = {
			uuid: canonical.uuid,
			retentionSeconds: canonical.retentionSeconds,
		}
		const decision = decideRetention({
			discovered: canonical.retentionSeconds,
			canonical: spec.canonicalRetentionSeconds,
			acceptChange: args.acceptRetentionChange,
		})
		if (decision.action === "abort") {
			throw new Error(`${label}: ${decision.reason}`)
		}
		const documentCount = await db.collection(canonicalName).countDocuments({})
		current.plan = {
			retentionSeconds: decision.retentionSeconds,
			documentCount,
		}
		current.skipReason = decision.note
		current.phase = "validated"
		current.updatedAt = new Date().toISOString()
		log(
			`${label}: ${canonical.type} source uuid=${canonical.uuid} docs=${documentCount} retention ${describeRetention(canonical.retentionSeconds)} -> ${decision.retentionSeconds}s (${decision.note})`,
		)
		if (dryRun) {
			state.surfaces[spec.surface] = current
			return outcomeOf(current)
		}
	}
	state.surfaces[spec.surface] = current

	if (dryRun) {
		return outcomeOf(current)
	}

	if (current.phase === "validated") {
		await runCopyPhase(db, current, args.maxTimeMs, persist)
		await persist()
		log(
			`${label}: copied ${current.digest?.documentCount} docs into ${candidateName} (pinned snapshot digest entries=${current.digest?.entries.length})`,
		)
	}
	if (current.phase === "copied") {
		await runVerifyPhase(db, current)
		await persist()
		log(
			`${label}: verified candidate uuid=${current.candidate?.uuid} against the pinned digest`,
		)
	}
	if (current.phase === "verified") {
		const result = await runInstallPhase(db, database, current)
		await persist()
		if (result === "restarted") {
			await persist()
			throw new Error(`${label}: ${INSTALL_ACTION_ERRORS["restart-from-copy"]}`)
		}
		log(
			`${label}: installed via renameCollection dropTarget:true (uuid=${current.installed?.uuid})`,
		)
	}
	if (current.phase === "installed") {
		await runTtlPhase(db, current)
		await persist()
		log(
			`${label}: complete — ordinary collection with TTL {ts:1} expireAfterSeconds=${current.plan?.retentionSeconds}`,
		)
	}
	state.surfaces[spec.surface] = current
	return outcomeOf(current)
}

type Receipt = {
	mode: "apply" | "abort" | "dry-run"
	database: string
	prefix: string
	server: { version: string; fcv: string }
	surfaces: SurfaceOutcome[]
	finishedAt: string
}

async function runAbort(options: {
	db: Db
	state: StateFile
	args: CliArgs
	log: (message: string) => void
}): Promise<Receipt> {
	const { db, state, args, log } = options
	const dropped: string[] = []
	for (const spec of SURFACES) {
		const surfaceState = state.surfaces[spec.surface]
		if (!surfaceState) {
			continue
		}
		if (
			surfaceState.phase === "installed" ||
			surfaceState.phase === "complete"
		) {
			throw new Error(
				`[${spec.surface}] ${surfaceState.canonicalName} is already installed; abort cannot undo an installation (the time-series source was removed by the rename). Refusing.`,
			)
		}
		if (
			surfaceState.phase === "skipped" ||
			surfaceState.phase === "validated"
		) {
			continue
		}
		const source = await inspectNamespace(db, surfaceState.canonicalName)
		let candidate = await inspectNamespace(db, surfaceState.candidateName)
		if (
			ownsNamespace(surfaceState.candidate?.uuid ?? null, source) ||
			ownsNamespace(surfaceState.installed?.uuid ?? null, source)
		) {
			throw new Error(
				`[${spec.surface}] the canonical namespace ${surfaceState.canonicalName} carries the recorded candidate or installed UUID: the rename appears to have completed, and abort cannot undo an installation. Refusing (state file preserved for --apply to reconcile).`,
			)
		}
		if (candidate === null) {
			if (
				source?.type !== "timeseries" ||
				!ownsNamespace(surfaceState.source?.uuid ?? null, source)
			) {
				throw new Error(
					`[${spec.surface}] the recorded time-series source is missing or replaced and no owned candidate remains; refusing to erase the recovery journal. Refusing (state file preserved).`,
				)
			}
			continue
		}
		if (
			source?.type !== "timeseries" ||
			!ownsNamespace(surfaceState.source?.uuid ?? null, source)
		) {
			throw new Error(
				`[${spec.surface}] the recorded time-series source is missing or replaced; refusing to drop the only remaining candidate copy`,
			)
		}
		if (
			surfaceState.phase === "copying" ||
			(surfaceState.phase === "copied" && surfaceState.candidate === null)
		) {
			await recoverCopyingPhase(db, surfaceState, candidate, args.maxTimeMs)
			candidate = await inspectNamespace(db, surfaceState.candidateName)
		}
		if (!ownsNamespace(surfaceState.candidate?.uuid ?? null, candidate)) {
			throw new Error(
				`[${spec.surface}] candidate ${surfaceState.candidateName} does not carry the recorded UUID; refusing to drop an unowned collection`,
			)
		}
		await db.dropCollection(surfaceState.candidateName)
		dropped.push(surfaceState.candidateName)
		log(
			`[${spec.surface}] dropped owned candidate ${surfaceState.candidateName}`,
		)
	}
	await rm(args.statePath, { force: true })
	log(`removed state file ${args.statePath}`)
	return {
		mode: "abort",
		database: state.database,
		prefix: state.prefix,
		server: state.server ?? { version: "", fcv: "" },
		surfaces: [],
		finishedAt: new Date().toISOString(),
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2))
	const config = resolveConfig(process.env)
	const log = (message: string) =>
		console.log(`migrate-diagnostics: ${message}`)
	const client = new MongoClient(config.uri, {
		appName: "memongo-migrate-diagnostics-ordinary",
		serverSelectionTimeoutMS: 10_000,
		socketTimeoutMS: 300_000,
	})
	await client.connect()
	try {
		const db = client.db(config.database)
		const server = await getServerInfo(db)
		if (!serverSupported(server)) {
			throw new Error(
				`server ${server.version} (FCV ${server.fcv || "unknown"}) is not supported: the conversion requires MongoDB 9 or newer with FCV 9 or newer; this is a minimum prerequisite, while namespace, digest, UUID, and command checks remain authoritative`,
			)
		}
		log(
			`mode=${args.mode} db=${config.database} prefix=${config.prefix} server=${server.version} fcv=${server.fcv}`,
		)

		if (args.mode === "abort") {
			const state = await loadState(args.statePath)
			if (!state) {
				throw new Error(`no state file at ${args.statePath}; nothing to abort`)
			}
			validateStateForConfig(state, config)
			const receipt = await runAbort({ db, state, args, log })
			await writeFile(
				`${args.statePath}.receipt.json`,
				`${JSON.stringify(receipt, null, "\t")}\n`,
				"utf8",
			)
			console.log(JSON.stringify(receipt, null, "\t"))
			return
		}

		const state: StateFile =
			args.mode === "apply"
				? ((await loadState(args.statePath)) ?? {
						version: STATE_VERSION,
						database: config.database,
						prefix: config.prefix,
						server,
						surfaces: {},
					})
				: {
						version: STATE_VERSION,
						database: config.database,
						prefix: config.prefix,
						server,
						surfaces: {},
					}
		validateStateForConfig(state, config)
		state.server = server

		const outcomes: SurfaceOutcome[] = []
		for (const spec of SURFACES) {
			const canonicalName = `${config.prefix}${spec.suffix}`
			const candidateName = `${canonicalName}${CANDIDATE_SUFFIX}`
			const outcome = await convertSurface({
				db,
				database: config.database,
				spec,
				canonicalName,
				candidateName,
				state,
				args,
				dryRun: args.mode === "dry-run",
				log,
			})
			outcomes.push(outcome)
		}

		const receipt: Receipt = {
			mode: args.mode,
			database: config.database,
			prefix: config.prefix,
			server,
			surfaces: outcomes,
			finishedAt: new Date().toISOString(),
		}
		if (args.mode === "apply") {
			await saveState(args.statePath, state)
			await writeFile(
				`${args.statePath}.receipt.json`,
				`${JSON.stringify(receipt, null, "\t")}\n`,
				"utf8",
			)
			log(`state=${args.statePath} receipt=${args.statePath}.receipt.json`)
		} else {
			log(
				"dry-run only — no state file written, nothing mutated; re-run with --apply to convert",
			)
		}
		console.log(JSON.stringify(receipt, null, "\t"))
	} finally {
		await client.close()
	}
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(`migrate-diagnostics: ${(error as Error).message}`)
		process.exitCode = 1
	})
}
