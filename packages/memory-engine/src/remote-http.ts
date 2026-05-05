import { type SsrFPolicy, defaultSsrfPolicy } from "@memongo/lib"

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
		return {
			isAllowed: (url: string) => new URL(url).hostname === parsed.hostname,
		}
	} catch {
		return undefined
	}
}

export async function withRemoteHttpResponse<T>(params: {
	url: string
	init?: RequestInit
	ssrfPolicy?: SsrFPolicy
	auditContext?: string
	onResponse: (response: Response) => Promise<T>
}): Promise<T> {
	const policy = params.ssrfPolicy ?? defaultSsrfPolicy
	const isAllowed = policy.isAllowed ?? (() => true)
	if (!isAllowed(params.url)) {
		throw new Error(`SSRF guard blocked request to ${params.url}`)
	}
	const response = await fetch(params.url, params.init)
	return await params.onResponse(response)
}
