import {
	type SsrFPolicy,
	assertPublicHostname,
	defaultSsrfPolicy,
	isBlockedHostname,
	isPrivateIpAddress,
	isPrivateNetworkAllowedByPolicy,
	SsrFBlockedError,
} from "@memongo/lib"

export function buildRemoteBaseUrlPolicy(
	baseUrl: string,
): SsrFPolicy | undefined {
	const trimmed = baseUrl.trim()
	if (!trimmed) {
		return undefined
	}
	try {
		const parsed = new URL(trimmed)
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return undefined
		}
		// If the operator explicitly configured a private/loopback endpoint (e.g. a
		// self-hosted Ollama at localhost), honor that intent so local deployments
		// keep working. Otherwise the DNS guard enforces that the pinned host
		// resolves to a public address (DNS-rebinding defense).
		const allowPrivateNetwork =
			isBlockedHostname(parsed.hostname) || isPrivateIpAddress(parsed.hostname)
		return {
			isAllowed: (url: string) => new URL(url).hostname === parsed.hostname,
			...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
		}
	} catch {
		return undefined
	}
}

// Error text reaches logs and benchmark output. Any part of a configured URL
// (userinfo, path, query, even the host) can carry a secret, so messages
// describe the failure and never echo the URL.
const GUARD_REFUSALS = {
	invalidUrl: "SSRF guard rejected invalid URL",
	nonHttp: "SSRF guard rejected a non-HTTP URL",
	credentials: "SSRF guard rejected a URL with embedded credentials",
	offEndpoint: "SSRF guard blocked a request outside the configured endpoint",
	redirect: "SSRF guard refused redirect from the configured endpoint",
} as const
const GUARD_REFUSAL_TEXTS: ReadonlySet<string> = new Set(
	Object.values(GUARD_REFUSALS),
)

/**
 * A fixed-text stand-in for a failure raised while sending a remote request or
 * reading its response. DNS and guard errors from @memongo/lib can name the
 * host, a runtime TypeError can quote a rejected header value, and a JSON
 * SyntaxError can quote the body, so only the class survives (retry and
 * fallback decisions depend on it). The guard's own refusals keep their text.
 */
export function withoutRemotePayload(error: unknown, operation: string): Error {
	if (error instanceof SsrFBlockedError)
		return new SsrFBlockedError(
			GUARD_REFUSAL_TEXTS.has(error.message)
				? error.message
				: "SSRF guard blocked a private or disallowed host",
		)
	if (error instanceof TypeError)
		return new TypeError(`${operation} could not be sent`)
	if (error instanceof SyntaxError)
		return new SyntaxError(`${operation} response was not valid JSON`)
	if (
		error instanceof DOMException &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	)
		return new DOMException(
			`${operation} was aborted`,
			error.name === "TimeoutError" ? "TimeoutError" : "AbortError",
		)
	return new Error(`${operation} failed before a response`)
}

export async function withRemoteHttpResponse<T>(params: {
	url: string
	init?: RequestInit
	ssrfPolicy?: SsrFPolicy
	auditContext?: string
	onResponse: (response: Response) => Promise<T>
	fetchFn?: typeof globalThis.fetch
	// Overridable DNS-resolving guard seam — production uses assertPublicHostname
	// (DNS-resolves the host and blocks private/metadata targets); tests inject a
	// deterministic fake so no real network lookup is required.
	verifyPublicHostname?: (hostname: string) => Promise<void>
}): Promise<T> {
	let parsedUrl: URL
	try {
		parsedUrl = new URL(params.url)
	} catch {
		throw new SsrFBlockedError(GUARD_REFUSALS.invalidUrl)
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new SsrFBlockedError(GUARD_REFUSALS.nonHttp)
	}
	// Node's Request throws on embedded credentials and echoes the whole URL
	// in its TypeError; refuse first so no runtime ever reflects them.
	if (parsedUrl.username || parsedUrl.password) {
		throw new SsrFBlockedError(GUARD_REFUSALS.credentials)
	}
	const policy = params.ssrfPolicy ?? defaultSsrfPolicy
	// Hostname pinning: when the caller configured an allow predicate (e.g. from
	// the operator's baseUrl), the request must target that exact host.
	if (policy.isAllowed && !policy.isAllowed(params.url)) {
		throw new SsrFBlockedError(GUARD_REFUSALS.offEndpoint)
	}
	// Fail closed by default: block private/loopback/metadata targets unless the
	// operator explicitly opted into a private network. This runs even when a
	// pinning predicate is present. Note it MITIGATES but does not fully close
	// DNS rebinding: fetch() resolves the host again independently (TOCTOU), so a
	// host that resolves public here but private at connect time is not caught.
	// Real risk is low because these URLs are operator-configured, not user input.
	if (!isPrivateNetworkAllowedByPolicy(policy)) {
		const verify = params.verifyPublicHostname ?? assertPublicHostname
		await verify(parsedUrl.hostname)
	}
	const fetchFn = params.fetchFn ?? fetch
	const response = await fetchFn(params.url, {
		...params.init,
		redirect: "manual",
	})
	if (response.status >= 300 && response.status < 400) {
		throw new SsrFBlockedError(GUARD_REFUSALS.redirect)
	}
	return await params.onResponse(response)
}
