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
		throw new SsrFBlockedError("SSRF guard rejected invalid URL")
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new SsrFBlockedError("SSRF guard rejected a non-HTTP URL")
	}
	// Node's Request throws on embedded credentials and echoes the whole URL
	// in its TypeError; refuse first so no runtime ever reflects them.
	if (parsedUrl.username || parsedUrl.password) {
		throw new SsrFBlockedError(
			"SSRF guard rejected a URL with embedded credentials",
		)
	}
	const policy = params.ssrfPolicy ?? defaultSsrfPolicy
	// Hostname pinning: when the caller configured an allow predicate (e.g. from
	// the operator's baseUrl), the request must target that exact host.
	if (policy.isAllowed && !policy.isAllowed(params.url)) {
		throw new SsrFBlockedError(
			"SSRF guard blocked a request outside the configured endpoint",
		)
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
		throw new SsrFBlockedError(
			"SSRF guard refused redirect from the configured endpoint",
		)
	}
	return await params.onResponse(response)
}
