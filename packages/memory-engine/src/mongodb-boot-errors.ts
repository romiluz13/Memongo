// M2 startup contract: the typed boot failures. Every reason the engine
// refuses to start is one of these codes, so the bridge, the API boot path
// and /ready can carry the reason instead of a bare Error.
import { redactSensitiveText } from "@memongo/lib"

export type MemongoBootFailureCode =
	| "server-unreachable"
	| "server-version-unsupported"
	| "server-version-unreadable"
	| "search-management-unavailable"
	| "search-privileges-denied"
	| "autoembed-unavailable"
	| "index-failed"
	| "index-stale"
	| "index-not-ready"
	| "index-absent"
	| "index-type-mismatch"
	| "index-metadata-unknown"
	| "index-definition-rejected"
	| "boot-deadline-exceeded"
	| "collection-absent"
	| "config-invalid"
	| "config-removed"
	| "rerank-unsupported"

export type MemongoBootFailureDetail = {
	code: MemongoBootFailureCode
	/** What the contract required, in operator words. */
	requirement: string
	index?: string
	collection?: string
	status?: string
	setting?: string
}

const URI_TOKEN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`\\]*/gi
const HOST_TOKENS: RegExp[] = [
	/\[[0-9a-f:]{2,}\](?::\d{2,5})?/gi,
	/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g,
	/\b(?:[a-z0-9-]+\.)+[a-z0-9-]+:\d{2,5}\b/gi,
	/\blocalhost:\d{2,5}\b/gi,
	/\b(ENOTFOUND|EAI_AGAIN)\s+\S+/g,
]

/**
 * Boot-specific safe text: whole URI tokens (any scheme, credentialed or not,
 * so mongodb:// and mongodb+srv:// included) and host or address tokens are
 * replaced, then known secret shapes are redacted. Everything a boot
 * diagnostic prints goes through it; it is a floor, not a license to echo
 * driver, config or provider text.
 */
export function safeBootText(text: string): string {
	let safe = text.replace(URI_TOKEN, "<uri>")
	for (const pattern of HOST_TOKENS) {
		safe = safe.replace(pattern, (_match, resolver: unknown) =>
			typeof resolver === "string" ? `${resolver} <host>` : "<host>",
		)
	}
	return redactSensitiveText(safe)
}

/**
 * A provider-reported scalar (an index status, type or queryable flag)
 * rendered for a diagnostic: kept only when it is a boolean, a number or a
 * short plain token, and never echoed raw.
 */
export function safeScalar(value: unknown): string {
	if (value === undefined || value === null) return "absent"
	if (typeof value === "boolean" || typeof value === "number") {
		return String(value)
	}
	return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(value)
		? value
		: "<unreadable>"
}

export function sanitizeBootDetail(
	detail: MemongoBootFailureDetail,
): MemongoBootFailureDetail {
	const safe: MemongoBootFailureDetail = {
		code: detail.code,
		requirement: safeBootText(detail.requirement),
	}
	if (detail.index !== undefined) safe.index = safeBootText(detail.index)
	if (detail.collection !== undefined)
		safe.collection = safeBootText(detail.collection)
	if (detail.status !== undefined) safe.status = safeBootText(detail.status)
	if (detail.setting !== undefined) safe.setting = safeBootText(detail.setting)
	return safe
}

export class MemongoBootError extends Error {
	readonly code: MemongoBootFailureCode
	readonly requirement: string
	readonly index?: string
	readonly collection?: string
	readonly status?: string
	readonly setting?: string
	/** Every unmet requirement when one boot pass found several. */
	readonly failures: MemongoBootFailureDetail[]

	constructor(
		detail: MemongoBootFailureDetail,
		message: string,
		failures?: MemongoBootFailureDetail[],
	) {
		super(safeBootText(message))
		const safe = sanitizeBootDetail(detail)
		this.name = "MemongoBootError"
		this.code = safe.code
		this.requirement = safe.requirement
		this.index = safe.index
		this.collection = safe.collection
		this.status = safe.status
		this.setting = safe.setting
		this.failures = (failures ?? [detail]).map(sanitizeBootDetail)
	}
}

export function isMemongoBootError(err: unknown): err is MemongoBootError {
	return (
		err instanceof MemongoBootError ||
		(typeof err === "object" &&
			err !== null &&
			(err as { name?: unknown }).name === "MemongoBootError" &&
			typeof (err as { code?: unknown }).code === "string")
	)
}

const DOTTED_HOST = /\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi
const EXCERPT_MAX_LENGTH = 200

/**
 * The server's own wording about a definition it refused, made safe to print:
 * URI, host and address tokens are replaced (including dotted host names),
 * the database name is dropped, known secret shapes are redacted and the
 * length is capped.
 */
function definitionExcerpt(message: string, database?: string): string {
	let excerpt = safeBootText(message).replace(DOTTED_HOST, "<host>")
	if (database && database.length >= 3) {
		excerpt = excerpt.split(database).join("<database>")
	}
	return excerpt.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX_LENGTH)
}

/**
 * A driver error rendered for a boot diagnostic: its server code name (or
 * error class) and numeric code. The driver's message text is not forwarded,
 * because it echoes connection strings, hosts, database names and whole
 * commands; the typed code, collection and index name the failure. The one
 * exception is `excerpt`, which a caller sets only for a definition the
 * server refused: the server's wording is then the operator's remedy
 * ("Omit quantization to use the default"), and it is printed scrubbed.
 */
export function describeDriverError(
	err: unknown,
	options?: { excerpt?: boolean; database?: string },
): string {
	const identifier = (value: unknown): string | undefined =>
		typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
			? value
			: undefined
	const named = err as { codeName?: unknown; name?: unknown; code?: unknown }
	const label =
		identifier(named?.codeName) ?? identifier(named?.name) ?? "unreadable error"
	const code =
		typeof named?.code === "number"
			? ` (code ${named.code})`
			: identifier(named?.code)
				? ` (${named.code})`
				: ""
	const raw = err instanceof Error ? err.message : ""
	const excerpt =
		options?.excerpt && raw ? definitionExcerpt(raw, options.database) : ""
	return `${label}${code}${excerpt ? `: ${excerpt}` : ""}`
}

export function driverErrorCode(err: unknown): number | undefined {
	const code = (err as { code?: unknown })?.code
	return typeof code === "number" ? code : undefined
}

/** MongoDB `Unauthorized` (13) or an explicit "not authorized" denial. */
export function isPrivilegeDenial(err: unknown): boolean {
	if (driverErrorCode(err) === 13) {
		return true
	}
	const codeName = (err as { codeName?: unknown })?.codeName
	if (codeName === "Unauthorized") {
		return true
	}
	const message = err instanceof Error ? err.message : String(err)
	return /not authorized|unauthorized/i.test(message)
}

export function bootConfigError(
	setting: string,
	message: string,
	code:
		| "config-invalid"
		| "config-removed"
		| "rerank-unsupported" = "config-invalid",
): MemongoBootError {
	return new MemongoBootError(
		{ code, setting, requirement: `valid ${setting}` },
		message,
	)
}
