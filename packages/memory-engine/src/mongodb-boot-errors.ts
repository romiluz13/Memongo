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
		super(redactSensitiveText(message))
		this.name = "MemongoBootError"
		this.code = detail.code
		this.requirement = detail.requirement
		this.index = detail.index
		this.collection = detail.collection
		this.status = detail.status
		this.setting = detail.setting
		this.failures = failures ?? [detail]
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

const DRIVER_MESSAGE_MAX_LENGTH = 200

/**
 * A driver error rendered for a boot diagnostic: its code name and a redacted,
 * length-capped message. Driver messages can echo hosts or URIs, so nothing
 * from them reaches a boot message unredacted.
 */
export function describeDriverError(err: unknown): string {
	const codeName =
		typeof (err as { codeName?: unknown })?.codeName === "string"
			? (err as { codeName: string }).codeName
			: undefined
	const raw = err instanceof Error ? err.message : String(err)
	const message = redactSensitiveText(raw).slice(0, DRIVER_MESSAGE_MAX_LENGTH)
	return codeName ? `${codeName}: ${message}` : message
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
