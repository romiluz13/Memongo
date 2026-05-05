import { lookup as dnsLookup } from "node:dns/promises"

export class SsrFBlockedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SsrFBlockedError"
	}
}

export type SsrFPolicy = {
	allowPrivateNetwork?: boolean
	dangerouslyAllowPrivateNetwork?: boolean
	allowRfc2544BenchmarkRange?: boolean
	allowedHostnames?: string[]
	hostnameAllowlist?: string[]
	isAllowed?: (url: string) => boolean
}

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"metadata.google.internal",
])

const PRIVATE_IPV4_RANGES = [
	{ prefix: "10.", mask: 8 },
	{ prefix: "127.", mask: 8 },
	{ prefix: "169.254.", mask: 16 },
	{
		prefix: "172.",
		mask: 12,
		check: (ip: string) => {
			const second = Number.parseInt(ip.split(".")[1], 10)
			return second >= 16 && second <= 31
		},
	},
	{ prefix: "192.168.", mask: 16 },
	{ prefix: "0.", mask: 8 },
]

function isPrivateIpv4(ip: string): boolean {
	for (const range of PRIVATE_IPV4_RANGES) {
		if (ip.startsWith(range.prefix)) {
			if (range.check) return range.check(ip)
			return true
		}
	}
	return false
}

function isPrivateIpv6(ip: string): boolean {
	const lower = ip.toLowerCase()
	if (lower === "::1" || lower === "::") return true
	if (lower.startsWith("fe80:")) return true
	if (lower.startsWith("fc") || lower.startsWith("fd")) return true
	if (lower.startsWith("::ffff:")) {
		const v4 = lower.slice(7)
		if (v4.includes(".")) return isPrivateIpv4(v4)
	}
	return false
}

export function isPrivateIpAddress(address: string): boolean {
	const trimmed = address.trim()
	if (trimmed.includes(":")) return isPrivateIpv6(trimmed)
	return isPrivateIpv4(trimmed)
}

export function isBlockedHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase().replace(/\.+$/, "")
	if (BLOCKED_HOSTNAMES.has(lower)) return true
	return (
		lower.endsWith(".localhost") ||
		lower.endsWith(".local") ||
		lower.endsWith(".internal")
	)
}

export function isPrivateNetworkAllowedByPolicy(policy?: SsrFPolicy): boolean {
	return (
		policy?.dangerouslyAllowPrivateNetwork === true ||
		policy?.allowPrivateNetwork === true
	)
}

function isHostnameInAllowlist(hostname: string, policy?: SsrFPolicy): boolean {
	const allowlist = policy?.allowedHostnames ?? policy?.hostnameAllowlist
	if (!allowlist?.length) return false
	const lower = hostname.toLowerCase().replace(/\.+$/, "")
	return allowlist.some((pattern) => {
		const p = pattern.toLowerCase()
		if (p.startsWith("*.")) {
			const suffix = p.slice(2)
			return lower.endsWith(`.${suffix}`) || lower === suffix
		}
		return lower === p
	})
}

export function assertAllowedHostOrIp(
	hostname: string,
	policy?: SsrFPolicy,
): void {
	if (isPrivateNetworkAllowedByPolicy(policy)) return
	if (isHostnameInAllowlist(hostname, policy)) return
	if (isBlockedHostname(hostname)) {
		throw new SsrFBlockedError(`Blocked hostname: ${hostname}`)
	}
	if (isPrivateIpAddress(hostname)) {
		throw new SsrFBlockedError(`Blocked private/internal IP: ${hostname}`)
	}
}

export async function assertPublicHostname(hostname: string): Promise<void> {
	assertAllowedHostOrIp(hostname)
	const results = await dnsLookup(hostname, { all: true })
	for (const entry of results) {
		if (isPrivateIpAddress(entry.address)) {
			throw new SsrFBlockedError(
				`Hostname resolves to private IP: ${entry.address}`,
			)
		}
	}
}

export const defaultSsrfPolicy: SsrFPolicy = {
	allowPrivateNetwork: true,
}
