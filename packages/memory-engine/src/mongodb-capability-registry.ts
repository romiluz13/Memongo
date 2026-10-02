import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:capabilities")

// ---------------------------------------------------------------------------
// Capability re-enable registry (fix-plan-2026-08-03 P3.6)
//
// memongo has a pattern of adopting a MongoDB feature, hitting a version gate
// or a server bug, and leaving the feature half-wired and disabled
// (storedSource, quantization, and returnStoredSource all exhibited this).
// This registry is the single place where every gated feature declares:
//
//   - minServerVersion (or the external fix that unblocks it),
//   - the re-enable condition evaluated inside detectCapabilities,
//   - a tracked TODO reference.
//
// Features self-enable as servers advance: detectCapabilities evaluates every
// gate against buildInfo, and index creation consults the same gates when
// deciding what to ship. Probe-adopt features (no trustworthy static gate)
// start optimistic and record a server rejection via recordCapabilityProbe.
// ---------------------------------------------------------------------------

export type CapabilityGateContext = {
	/** buildInfo `versionArray` (e.g. [8, 3, 7, 0]); undefined when unavailable. */
	versionArray?: unknown
	/** Environment overrides; defaults to process.env at call sites. */
	env?: NodeJS.ProcessEnv
	/**
	 * Credential-free deployment identity (see mongodbDeploymentIdentity).
	 * Probe outcomes are keyed per deployment so one deployment's rejection
	 * never disables the feature for another deployment in the same process
	 * (B10). Callers that omit it share a single default bucket — the
	 * pre-B10 process-global behavior.
	 */
	deployment?: string
}

export type CapabilityGate = {
	id: string
	description: string
	/** Minimum server version that unblocks the feature, when version-gated. */
	minServerVersion?: readonly [number, number, number]
	/** External fix that unblocks the feature when no version gate exists. */
	blockedOn?: string
	/** Tracked TODO reference for the re-enable follow-up. */
	todo: string
	/** Re-enable condition evaluated inside detectCapabilities. */
	shouldEnable: (context: CapabilityGateContext) => boolean
	/**
	 * Context-specific truthful reason the gate is disabled (env kill-switch,
	 * missing opt-in). Return undefined when the static blocker line IS the
	 * actual reason; a recorded probe rejection takes precedence over both.
	 */
	explainDisabled?: (context: CapabilityGateContext) => string | undefined
}

/**
 * Compare a buildInfo versionArray against a minimum major.minor[.patch].
 * Returns false for missing or malformed arrays — an unknown version never
 * lights a gate up.
 */
export function serverVersionAtLeast(
	versionArray: unknown,
	minimumMajor: number,
	minimumMinor: number,
	minimumPatch = 0,
): boolean {
	if (!Array.isArray(versionArray) || versionArray.length < 2) {
		return false
	}
	const major = Number(versionArray[0])
	const minor = Number(versionArray[1])
	const patch = versionArray.length > 2 ? Number(versionArray[2]) : 0
	if (
		!Number.isFinite(major) ||
		!Number.isFinite(minor) ||
		!Number.isFinite(patch)
	) {
		return false
	}
	if (major !== minimumMajor) {
		return major > minimumMajor
	}
	if (minor !== minimumMinor) {
		return minor > minimumMinor
	}
	return patch >= minimumPatch
}

// Runtime probe records for probe-adopt features: a server rejection observed
// at index-creation time flips the capability off for THIS deployment (B10),
// so the next deployment against a fixed server self-enables again while
// other deployments in the same process keep their own verdicts. Keyed by
// deployment identity (see mongodbDeploymentIdentity) -> capability id ->
// verdict. Callers without a deployment context share the default bucket,
// which preserves the pre-B10 process-global behavior for legacy call sites.
const DEFAULT_DEPLOYMENT_KEY = "__default__"

const probeResults = new Map<string, Map<string, boolean>>()

function probeBucketKey(deployment: string | undefined): string {
	return deployment ?? DEFAULT_DEPLOYMENT_KEY
}

function probeRejected(id: string, deployment: string | undefined): boolean {
	return probeResults.get(probeBucketKey(deployment))?.get(id) === false
}

export function recordCapabilityProbe(
	id: string,
	supported: boolean,
	deployment?: string,
): void {
	const key = probeBucketKey(deployment)
	let bucket = probeResults.get(key)
	if (!bucket) {
		bucket = new Map()
		probeResults.set(key, bucket)
	}
	bucket.set(id, supported)
}

/**
 * Test hook / shutdown hook: clear recorded probe results between runs.
 * Scoped to one deployment when an identity is passed (a closing manager
 * clears only its own deployment's state); clears every deployment when
 * called with no argument.
 */
export function resetCapabilityProbes(deployment?: string): void {
	if (deployment === undefined) {
		probeResults.clear()
		return
	}
	probeResults.delete(deployment)
}

/**
 * Derive a credential-free identity for a MongoDB deployment from its
 * connection URI and database. Probe outcomes are keyed by this identity so
 * two deployments can hold opposite capability verdicts in one process (B10).
 *
 * The key is built from non-secret parts only: host(s)+port, the database,
 * and the optional appName connection option. Userinfo (username/password)
 * is never included — the WHATWG URL parser separates it from the host, and
 * the manual fallback (multi-host standard URIs are not valid WHATWG URLs)
 * discards everything up to the last "@" in the authority. The key is never
 * logged by this module.
 */
export function mongodbDeploymentIdentity(
	uri: string,
	database?: string,
): string {
	try {
		const parsed = new URL(uri)
		const dbFromUri = parsed.pathname.replace(/^\//, "") || undefined
		return joinDeploymentIdentity(
			parsed.host || "unknown",
			database ?? dbFromUri,
			parsed.searchParams.get("appName") ?? undefined,
		)
	} catch {
		// Multi-host standard URIs ("mongodb://h1:27017,h2:27018/db") fail
		// WHATWG URL parsing; split manually, still dropping any userinfo.
		const withoutScheme = uri.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
		const [authorityAndPath, query] = splitOnce(withoutScheme, "?")
		const [authority, path] = splitOnce(authorityAndPath, "/")
		// userinfo ends at the last "@" inside the authority; discard it.
		const hosts = authority.slice(authority.lastIndexOf("@") + 1)
		const appName = query ? queryParamValue(query, "appName") : undefined
		return joinDeploymentIdentity(
			hosts || "unknown",
			database ?? (path || undefined),
			appName,
		)
	}
}

function splitOnce(value: string, separator: string): [string, string?] {
	const index = value.indexOf(separator)
	if (index === -1) {
		return [value, undefined]
	}
	return [value.slice(0, index), value.slice(index + separator.length)]
}

function queryParamValue(query: string, name: string): string | undefined {
	for (const pair of query.split("&")) {
		const [key, rawValue] = splitOnce(pair, "=")
		if (key === name && rawValue !== undefined) {
			try {
				return decodeURIComponent(rawValue)
			} catch {
				return rawValue
			}
		}
	}
	return undefined
}

function joinDeploymentIdentity(
	hosts: string,
	database: string | undefined,
	appName: string | undefined,
): string {
	const parts = [hosts.toLowerCase()]
	if (database) {
		parts.push(database)
	}
	if (appName) {
		parts.push(`app=${appName}`)
	}
	return parts.join("/")
}

export const CAPABILITY_GATES: readonly CapabilityGate[] = [
	{
		id: "vector-stored-source",
		description:
			"$vectorSearch returns stored source fields directly (returnStoredSource), eliminating the collection re-fetch after vector search",
		// The {include: [...]} object form is accepted from MongoDB 8.3.7; the
		// boolean form is rejected outright on every version (live-verified
		// against 8.3.4, re-probed on Atlas 8.3.7 2026-07-30).
		minServerVersion: [8, 3, 7],
		todo: "fix-plan-2026-08-03 P3.3 — remove the gate once supported floors are all >= 8.3.7",
		shouldEnable: ({ versionArray, env }) => {
			// MEMONGO_VECTOR_STORED_SOURCE stays as an override: "0" kills the
			// feature even when the version gate passes, "1" forces it on.
			const raw = env?.MEMONGO_VECTOR_STORED_SOURCE?.trim()
			if (raw === "0") {
				return false
			}
			if (raw === "1") {
				return true
			}
			return serverVersionAtLeast(versionArray, 8, 3, 7)
		},
		explainDisabled: ({ env }) => {
			if (env?.MEMONGO_VECTOR_STORED_SOURCE?.trim() === "0") {
				return "disabled by MEMONGO_VECTOR_STORED_SOURCE=0"
			}
			return undefined
		},
	},
	{
		id: "autoembed-quantization",
		description:
			"quantization (scalar/binary) on autoEmbed vector index definitions (~75% memory reduction for scalar)",
		// The server rejects quantization on autoEmbed definitions ("Omit
		// quantization to use the default (float)"); there is no version that
		// announces support, so adoption is by probe: ensureSearchIndexes
		// passes the configured quantization through and records a rejection.
		blockedOn:
			"Atlas accepting quantization on autoEmbed vector index definitions",
		todo: "fix-plan-2026-08-03 P3.4 — re-probe when Atlas documents autoEmbed quantization support",
		// Optimistic until the probe records a rejection; the recorded probe
		// result (see isCapabilityEnabled) is the real gate.
		shouldEnable: () => true,
	},
	{
		id: "rerank-stage",
		description: "$rerank aggregation stage for server-side reranking",
		blockedOn: "Atlas Search Preview; Atlas-managed deployments only",
		todo: "fix-plan-2026-08-03 P3.6 — adopt when $rerank reaches GA",
		// Not wired into memongo at all: the operator-facing truth is "not
		// implemented", not the external Preview dependency it sits behind.
		shouldEnable: () => false,
		explainDisabled: () => "not implemented in this memongo release",
	},
	{
		id: "lexical-prefilters",
		description: "prefilters on lexical ($search) indexes",
		blockedOn: "Atlas Search Preview",
		todo: "fix-plan-2026-08-03 P3.6 — adopt when lexical prefilters reach GA",
		// Same as rerank-stage: nothing is wired, so "not implemented" is the
		// truthful operator line; the Preview dependency stays in blockedOn.
		shouldEnable: () => false,
		explainDisabled: () => "not implemented in this memongo release",
	},
	{
		id: "flat-indexes",
		description:
			'indexingMethod: "flat" (exact) on autoEmbed vector fields, behind the MEMONGO_VECTOR_INDEXING_METHOD opt-in',
		// Accepted on Atlas 8.3.7 (re-probed live 2026-07-30); still a
		// Preview-to-GA watch item, so the env opt-in remains required.
		minServerVersion: [8, 3, 7],
		blockedOn: "Preview-to-GA watch on autoEmbed indexingMethod",
		todo: "fix-plan-2026-08-03 P3.6 — drop the env opt-in when flat indexingMethod is GA",
		shouldEnable: ({ versionArray, env }) => {
			// Mirror vectorIndexingMethodFromEnv(): trim + lowercase so the
			// gate verdict always matches what index creation actually ships.
			const method = env?.MEMONGO_VECTOR_INDEXING_METHOD?.trim().toLowerCase()
			return method === "flat" && serverVersionAtLeast(versionArray, 8, 3, 7)
		},
		explainDisabled: ({ versionArray, env }) => {
			// [8, 3, 7] mirrors minServerVersion above.
			const method = env?.MEMONGO_VECTOR_INDEXING_METHOD?.trim().toLowerCase()
			if (method !== "flat") {
				if (serverVersionAtLeast(versionArray, 8, 3, 7)) {
					return "requires the MEMONGO_VECTOR_INDEXING_METHOD=flat opt-in"
				}
				const label = serverVersionLabel(versionArray)
				const version =
					label === undefined
						? "server version unknown or unavailable"
						: `server is ${label}`
				return (
					"requires the MEMONGO_VECTOR_INDEXING_METHOD=flat opt-in and " +
					`MongoDB >= 8.3.7 (${version})`
				)
			}
			return undefined
		},
	},
]

export function getCapabilityGate(id: string): CapabilityGate | undefined {
	return CAPABILITY_GATES.find((gate) => gate.id === id)
}

/**
 * Evaluate one gate: its static condition, overridden by a recorded probe
 * rejection for the context's deployment. Unknown ids are never enabled.
 */
export function isCapabilityEnabled(
	id: string,
	context: CapabilityGateContext,
): boolean {
	const gate = getCapabilityGate(id)
	if (!gate) {
		return false
	}
	if (probeRejected(id, context.deployment)) {
		return false
	}
	return gate.shouldEnable(context)
}

/** Evaluate every registered gate; consumed by detectCapabilities. */
export function evaluateCapabilityGates(
	context: CapabilityGateContext,
): Record<string, boolean> {
	const evaluation: Record<string, boolean> = {}
	for (const gate of CAPABILITY_GATES) {
		evaluation[gate.id] = isCapabilityEnabled(gate.id, context)
	}
	return evaluation
}

/**
 * Fold a recorded probe rejection into an already-evaluated gate set.
 * detectCapabilities runs before ensureSearchIndexes, so a rejection observed
 * during index creation is surfaced onto the manager's capabilities object
 * through this instead of re-running detection. With no recorded rejection
 * for this deployment the evaluation is returned unchanged.
 */
export function applyCapabilityProbeResult(
	evaluation: Record<string, boolean>,
	id: string,
	deployment?: string,
): Record<string, boolean> {
	if (probeRejected(id, deployment)) {
		return { ...evaluation, [id]: false }
	}
	return evaluation
}

/**
 * Human label for a buildInfo versionArray ("8.0.13"), or undefined when the
 * array is missing or malformed. An unknown version must be reported as
 * unknown — never confused with a known below-minimum server (D2).
 */
function serverVersionLabel(versionArray: unknown): string | undefined {
	if (!Array.isArray(versionArray) || versionArray.length < 2) {
		return undefined
	}
	const parts = [Number(versionArray[0]), Number(versionArray[1])]
	if (versionArray.length > 2) {
		parts.push(Number(versionArray[2]))
	}
	if (parts.some((part) => !Number.isFinite(part))) {
		return undefined
	}
	return parts.join(".")
}

/**
 * Version-gate disabled reason that distinguishes a known below-minimum
 * server from a missing or malformed version.
 */
function versionRequirementReason(
	minServerVersion: readonly [number, number, number],
	versionArray: unknown,
): string {
	const minimum = `MongoDB >= ${minServerVersion.join(".")}`
	const label = serverVersionLabel(versionArray)
	if (label === undefined) {
		return `requires ${minimum} (server version unknown or unavailable)`
	}
	return `requires ${minimum} (server is ${label})`
}

/**
 * One info line per disabled gate with what ACTUALLY blocks it in this
 * context — the visible counterpart of the half-wired features this
 * registry replaced. The reason is truthful for the specific evaluation:
 * a recorded probe rejection, an env kill-switch, or a missing opt-in is
 * reported as itself, never papered over with the static version
 * requirement; an unknown server version is never confused with a known
 * below-minimum one; gates with nothing wired report "not implemented".
 * Registry-internal tracking (fix-plan/GA TODO references) stays out of
 * operator lines.
 */
export function logDisabledCapabilityGates(
	context: CapabilityGateContext,
): void {
	for (const gate of CAPABILITY_GATES) {
		if (isCapabilityEnabled(gate.id, context)) {
			continue
		}
		const reason =
			(probeRejected(gate.id, context.deployment)
				? "server rejected it at index creation (recorded probe)"
				: gate.explainDisabled?.(context)) ??
			(gate.minServerVersion !== undefined
				? versionRequirementReason(gate.minServerVersion, context.versionArray)
				: `blocked on ${gate.blockedOn}`)
		log.info(`capability ${gate.id} disabled: ${reason}`)
	}
}
