/**
 * C-002: pi-extension is published and cannot depend on the private
 * @memongo/lib redaction utilities, so diagnostic text passes through a
 * local, minimal classifier instead. It covers the credential shapes that
 * can ride into warns and tool responses via client-error messages, raw
 * response bodies, and chained upstream errors: connection-string
 * passwords and usernames (any scheme), credential-named assignments
 * (quoted values may contain spaces, including JSON-escaped quotes),
 * Bearer tokens, and webhook URLs.
 * Over-matching only adds stars to log detail; errMessage is the single
 * choke point every diagnostic site flows through.
 */
export function sanitizeDiagnostic(text: string): string {
	let out = text
	out = out.replace(
		/[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^@\s]+)@/gi,
		(match, password: string) => match.replace(password, "***"),
	)
	out = out.replace(
		/[a-z][a-z0-9+.-]*:\/\/([^:@/\s"]+)@/gi,
		(match, user: string) => match.replace(user, "***"),
	)
	out = out.replace(
		/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIALS?)\b\s*"?\s*[=:]\s*(?:\\?"([^"\\]*)\\?"?|\\?'([^'\\]*)\\?'?|([^\s"'\\,;}\]]+))/gi,
		(match, doubleQuoted: string, singleQuoted: string, bare: string) => {
			const value = [doubleQuoted, singleQuoted, bare].find(
				(candidate) => typeof candidate === "string" && candidate.length > 0,
			)
			return typeof value === "string" ? match.replace(value, "***") : match
		},
	)
	out = out.replace(
		/\bBearer\s+([A-Za-z0-9._\-+=]+)/gi,
		(match, token: string) => match.replace(token, "***"),
	)
	out = out.replace(
		/(https?:\/\/(?:hooks\.[a-z0-9.-]+|discord(?:app)?\.com\/api\/webhooks))\S*/gi,
		(_match, host: string) => `${host}/***`,
	)
	return out
}

export function errMessage(err: unknown): string {
	return sanitizeDiagnostic(err instanceof Error ? err.message : String(err))
}
