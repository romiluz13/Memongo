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
function maskCapturedValue(text: string, pattern: RegExp): string {
	const parts: string[] = []
	let copiedUntil = 0
	const regex = new RegExp(pattern.source, `${pattern.flags}d`)
	for (const match of text.matchAll(regex)) {
		let redacted = match[0]
		for (let group = 1; group < match.length; group++) {
			if (!match[group]) continue
			const [start, end] = (match.indices as RegExpIndicesArray)[group]
			redacted =
				match[0].slice(0, start - match.index) +
				"***" +
				match[0].slice(end - match.index)
			break
		}
		parts.push(text.slice(copiedUntil, match.index), redacted)
		copiedUntil = match.index + match[0].length
	}
	parts.push(text.slice(copiedUntil))
	return parts.join("")
}

export function sanitizeDiagnostic(text: string): string {
	let out = text
	out = maskCapturedValue(
		out,
		/(?<![a-z0-9+.-])[0-9+.-]*[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^@\s]+)@/gi,
	)
	out = maskCapturedValue(
		out,
		/(?<![a-z0-9+.-])[0-9+.-]*[a-z][a-z0-9+.-]*:\/\/([^:@/\s"]+)@/gi,
	)
	out = maskCapturedValue(
		out,
		/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIALS?)\b\s*"?\s*[=:]\s*(?:\\?"([^"\\]*)\\?"?|\\?'([^'\\]*)\\?'?|([^\s"'\\,;}\]]+))/gi,
	)
	out = maskCapturedValue(out, /\bBearer\s+([A-Za-z0-9._\-+=]+)/gi)
	out = out.replace(
		/(https?:\/\/(?:hooks\.[a-z0-9.-]+|discord(?:app)?\.com\/api\/webhooks))\S*/gi,
		(_match, host: string) => `${host}/***`,
	)
	return out
}

export function errMessage(err: unknown): string {
	return sanitizeDiagnostic(err instanceof Error ? err.message : String(err))
}
