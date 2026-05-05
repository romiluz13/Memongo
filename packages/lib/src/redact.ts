const DEFAULT_REDACT_MIN_LENGTH = 18
const DEFAULT_REDACT_KEEP_START = 6
const DEFAULT_REDACT_KEEP_END = 4

const DEFAULT_REDACT_PATTERNS: RegExp[] = [
	/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/gi,
	/"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"/gi,
	/--(?:api[-_]?key|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1/gi,
	/Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)/gi,
	/\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b(sk-[A-Za-z0-9_-]{8,})\b/g,
	/\b(ghp_[A-Za-z0-9]{20,})\b/g,
	/\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
	/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
	/\b(xapp-[A-Za-z0-9-]{10,})\b/g,
	/\b(gsk_[A-Za-z0-9_-]{10,})\b/g,
	/\b(AIza[0-9A-Za-z\-_]{20,})\b/g,
	/\b(pplx-[A-Za-z0-9_-]{10,})\b/g,
	/\b(npm_[A-Za-z0-9]{10,})\b/g,
	/\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
	/\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
	/mongodb(?:\+srv)?:\/\/[^:]+:([^@]+)@/gi,
]

function maskToken(token: string): string {
	if (token.length < DEFAULT_REDACT_MIN_LENGTH) return "***"
	const start = token.slice(0, DEFAULT_REDACT_KEEP_START)
	const end = token.slice(-DEFAULT_REDACT_KEEP_END)
	return `${start}***${end}`
}

function redactPemBlock(block: string): string {
	const lines = block.split(/\r?\n/).filter(Boolean)
	if (lines.length < 2) return "***"
	return `${lines[0]}\n***redacted***\n${lines[lines.length - 1]}`
}

export function redactSensitiveText(text: string): string {
	if (!text) return text
	let result = text
	for (const pattern of DEFAULT_REDACT_PATTERNS) {
		const regex = new RegExp(pattern.source, pattern.flags)
		result = result.replace(regex, (match, ...groups) => {
			if (match.includes("PRIVATE KEY-----")) return redactPemBlock(match)
			if (match.startsWith("mongodb")) {
				const passwordGroup = groups[0]
				if (typeof passwordGroup === "string")
					return match.replace(passwordGroup, "***")
				return match
			}
			const token =
				groups
					.filter((g): g is string => typeof g === "string" && g.length > 0)
					.at(-1) ?? match
			const masked = maskToken(token)
			return token === match ? masked : match.replace(token, masked)
		})
	}
	return result
}

/** Alias used by engine code */
export function redactSecrets(text: string): string {
	return redactSensitiveText(text)
}

export function getDefaultRedactPatterns(): string[] {
	return DEFAULT_REDACT_PATTERNS.map((r) => r.source)
}
