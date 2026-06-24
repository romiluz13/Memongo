/**
 * Exportable-memory guarantee.
 *
 * Users can export every memory scoped to an `agentId` as a signed JSON
 * bundle. The bundle is HMAC-SHA256 signed using `MEMONGO_EXPORT_SIGNING_KEY`
 * so consumers can verify integrity and authenticity off-line.
 *
 * The invariant (Provable Property 14): two exports of the same scopeRef with
 * no intervening writes produce byte-identical bundles. We achieve determinism
 * via deep-sorted canonical JSON serialization.
 *
 * MongoDB MCP note: bundle construction streams events / episodes / kb
 * documents under a stable sort key so the exported order is stable across
 * replays; canonicalization inside this module is the belt that matches the
 * suspenders.
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export type ExportEvent = {
	eventId: string
	body: string
	timestamp: string
	[key: string]: unknown
}

export type ExportEpisode = {
	episodeId: string
	[key: string]: unknown
}

export type ExportKBDoc = {
	docId?: string
	[key: string]: unknown
}

export type ExportBundle = {
	agentId: string
	scope: string
	scopeRef: string
	exportedAt: string
	events: ExportEvent[]
	episodes: ExportEpisode[]
	kb: ExportKBDoc[]
	[key: string]: unknown
}

/**
 * Deep-sort object keys alphabetically so two semantically equal bundles
 * produce byte-identical JSON. Arrays are preserved in input order (event
 * order is load-bearing — callers are responsible for stable sort at the
 * retrieval site).
 *
 * Non-JSON value handling: native `JSON.stringify` silently drops or
 * mangles several common non-plain-object types. We normalize them before
 * serialization so exports never lose data:
 *   - `Date`         → ISO-8601 string
 *   - `Buffer`       → `{ __type: "Buffer", base64: string }`
 *   - `Uint8Array`   → same tagged object as `Buffer`
 *   - `Map`          → `{ __type: "Map", entries: [[k, v], ...] }` (key-sorted)
 *   - `Set`          → `{ __type: "Set", values: [...] }` (JSON-sorted)
 * Tagged objects round-trip through canonicalization and sign deterministically.
 */
function canonicalize(value: unknown): unknown {
	if (value === null || value === undefined) {
		return value
	}
	if (typeof value !== "object") {
		return value
	}
	if (value instanceof Date) {
		return value.toISOString()
	}
	if (Buffer.isBuffer(value)) {
		return { __type: "Buffer", base64: value.toString("base64") }
	}
	if (value instanceof Uint8Array) {
		return {
			__type: "Buffer",
			base64: Buffer.from(value).toString("base64"),
		}
	}
	if (value instanceof Map) {
		const entries = Array.from(value.entries()).map(
			([k, v]) => [canonicalize(k), canonicalize(v)] as [unknown, unknown],
		)
		entries.sort((a, b) => {
			const ka = JSON.stringify(a[0])
			const kb = JSON.stringify(b[0])
			return ka < kb ? -1 : ka > kb ? 1 : 0
		})
		return { __type: "Map", entries }
	}
	if (value instanceof Set) {
		const values = Array.from(value.values()).map(canonicalize)
		values.sort((a, b) => {
			const sa = JSON.stringify(a)
			const sb = JSON.stringify(b)
			return sa < sb ? -1 : sa > sb ? 1 : 0
		})
		return { __type: "Set", values }
	}
	if (Array.isArray(value)) {
		return value.map(canonicalize)
	}
	const obj = value as Record<string, unknown>
	const sortedKeys = Object.keys(obj).sort()
	const result: Record<string, unknown> = {}
	for (const key of sortedKeys) {
		result[key] = canonicalize(obj[key])
	}
	return result
}

/**
 * Produce the canonical JSON string for an export bundle. Stable under key
 * insertion-order permutations; SHA256-identical for semantically equal inputs.
 */
export function canonicalizeExportBundle(bundle: ExportBundle): string {
	return JSON.stringify(canonicalize(bundle))
}

/**
 * HMAC-SHA256 sign the canonical bundle bytes using the provided key. Returns
 * lowercase hex string (64 chars). Throws if the key is empty — strict mode
 * refuses to produce an unsigned-masquerading-as-signed artifact.
 */
export function signExportBundle(
	bundle: ExportBundle,
	signingKey: string,
): string {
	if (!signingKey || signingKey.length === 0) {
		throw new Error(
			"signExportBundle: signing key (MEMONGO_EXPORT_SIGNING_KEY) must be set and non-empty",
		)
	}
	const canonical = canonicalizeExportBundle(bundle)
	return createHmac("sha256", signingKey).update(canonical).digest("hex")
}

/**
 * Constant-time verification of a signature against a bundle + key. Returns
 * `false` for any mismatch (tampered bundle, wrong key, wrong length). Never
 * throws on mismatch — throws only if the signature is malformed.
 */
export function verifyExportBundle(
	bundle: ExportBundle,
	signature: string,
	signingKey: string,
): boolean {
	if (!signingKey || !signature) {
		return false
	}
	if (!/^[0-9a-f]{64}$/i.test(signature)) {
		return false
	}
	const expected = signExportBundle(bundle, signingKey)
	const expectedBuf = Buffer.from(expected, "hex")
	const providedBuf = Buffer.from(signature, "hex")
	if (expectedBuf.length !== providedBuf.length) {
		return false
	}
	return timingSafeEqual(expectedBuf, providedBuf)
}
