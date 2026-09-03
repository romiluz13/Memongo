const DEFAULT_REDACT_MIN_LENGTH = 18
const DEFAULT_REDACT_KEEP_START = 6
const DEFAULT_REDACT_KEEP_END = 4

// Credentials embedded in ANY scheme's URL userinfo (mongodb+srv,
// postgres, redis, amqp, https, ...). Only the password group is
// starred; an empty user (redis://:pass@) still matches.
const SCHEME_USERINFO_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^@\s/]+)@/gi

// Username-only userinfo (redis://dummy-user@host, https://user@host):
// the username itself is the credential in key-as-username schemes, so
// it is starred too. Runs after the password pattern, which has already
// consumed user:pass@ forms (its masked *** output is idempotent here).
const SCHEME_USER_PATTERN = /[a-z][a-z0-9+.-]*:\/\/([^:@/\s"]+)@/gi

const DEFAULT_REDACT_PATTERNS: RegExp[] = [
	// Assignment forms: KEY/TOKEN/SECRET/PASSWORD/PASSWD/AUTH/CREDENTIAL(S)
	// named identifiers (env vars, headers like X-Custom-Auth, config keys)
	// followed by : or = and a value. Quoted values may contain spaces
	// (password="two words"); a bare value ends at the next delimiter. The
	// optional backslash before each quote tolerates JSON-serialized meta,
	// where an assignment riding inside a string value has its quotes
	// escaped (password=\"two words\") — without it the pair survived raw.
	/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIALS?)\b\s*"?\s*[=:]\s*(?:\\?"([^"\\]*)\\?"?|\\?'([^'\\]*)\\?'?|([^\s"'\\,;}\]]+))/gi,
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
	// The two scheme-userinfo patterns above are referenced by identity
	// (indexOf on the const) so the callback dispatch cannot silently lose
	// them — source-string prefix probes broke when the literal's escaped
	// slashes did not match the probe text, dropping both branches into
	// the partial-reveal maskToken fallback.
	SCHEME_USERINFO_PATTERN,
	SCHEME_USER_PATTERN,
	// Webhook URLs: the secret is the path (Slack hooks, Discord webhooks).
	/(https?:\/\/(?:hooks\.[a-z0-9.-]+|discord(?:app)?\.com\/api\/webhooks))\S*/gi,
	// URLs whose path carries a credential word as a delimited token
	// (…/path-dummy-000001/callback, …/reset/token). The lookahead requires a
	// delimiter (or end) after the word, so "tokenization" and similar
	// non-credential paths pass through unmasked.
	/(https?:\/\/[^/?#\s]+)\/(?:[^\s?#/]*[/._-])*(?:secrets?|tokens?|credentials?|passwd|password)(?=[/._-]|$)[^\s?#]*/gi,
]

/**
 * Index of the password-bearing scheme-userinfo pattern in
 * DEFAULT_REDACT_PATTERNS. Its callback branch stars only the captured
 * password, preserving the scheme, user, and host for debugging.
 */
const SCHEME_USERINFO_PATTERN_INDEX = DEFAULT_REDACT_PATTERNS.indexOf(
	SCHEME_USERINFO_PATTERN,
)

/**
 * Index of the username-only scheme-userinfo pattern. Its callback branch
 * stars the captured username in full: in key-as-username schemes the
 * username IS the credential, so no partial reveal.
 */
const SCHEME_USER_PATTERN_INDEX =
	DEFAULT_REDACT_PATTERNS.indexOf(SCHEME_USER_PATTERN)

/**
 * Indexes of the webhook/credential-path URL patterns. Their callback branch
 * keeps the captured scheme://host prefix and truncates the credential-
 * bearing path to ***.
 */
const URL_TRUNCATING_PATTERN_INDEXES = [
	DEFAULT_REDACT_PATTERNS.findIndex((r) => r.source.includes("hooks\\.")),
	DEFAULT_REDACT_PATTERNS.findIndex((r) =>
		r.source.includes("(?:secrets?|tokens?|credentials?|passwd|password)"),
	),
].filter((index) => index !== -1)

function maskToken(token: string): string {
	// Already-masked tokens stay stable: patterns run in sequence over the
	// same text, so a second pattern hitting a first pattern's output must
	// not collapse the partial-reveal mask into a bare ***.
	if (token.includes("***")) return token
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
	for (const [patternIndex, pattern] of DEFAULT_REDACT_PATTERNS.entries()) {
		const regex = new RegExp(pattern.source, pattern.flags)
		result = result.replace(regex, (...args: unknown[]) => {
			const match = args[0] as string
			if (match.includes("PRIVATE KEY-----")) return redactPemBlock(match)
			// Replace-callback varargs are: capture groups..., offset (number),
			// input (string), [named-groups object]. Capture groups are only the
			// entries before the numeric offset — the trailing input string must
			// never be mistaken for a group (picking it made embedded secrets
			// survive redaction and over-masked whole-line inputs).
			const rest = args.slice(1)
			const offsetIndex = rest.findIndex((arg) => typeof arg === "number")
			const captures = offsetIndex === -1 ? rest : rest.slice(0, offsetIndex)
			if (patternIndex === SCHEME_USERINFO_PATTERN_INDEX) {
				// *************************** — star only the password.
				const passwordGroup = captures[0]
				if (typeof passwordGroup === "string" && passwordGroup.length > 0)
					return match.replace(passwordGroup, "***")
				return match
			}
			if (patternIndex === SCHEME_USER_PATTERN_INDEX) {
				// Username-only userinfo — star the username in full.
				const userGroup = captures[0]
				if (typeof userGroup === "string" && userGroup.length > 0)
					return match.replace(userGroup, "***")
				return match
			}
			if (URL_TRUNCATING_PATTERN_INDEXES.includes(patternIndex)) {
				// Webhook / credential-path URL — keep scheme://host, drop the path.
				const host = captures[0]
				if (typeof host === "string" && host.length > 0) return `${host}/***`
				return match
			}
			const token =
				captures
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
