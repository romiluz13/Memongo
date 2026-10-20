const MIN_SECRET_LENGTH = 6
const MAX_DEPTH = 12
const SECRET_LABEL = "[REDACTED:secret]"
const FIELD_LABEL = "[REDACTED:field]"

const SECRET_ENV_NAME =
	/(?:^|_)(?:API_?KEY|KEY|KEYS|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|URI)$/i
const PERCENT_TRIPLET = /%[0-9A-F]{2}/g
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi
const QUERY_SECRET =
	/([?&;](?:api[-_]?key|apikey|key|token|access[-_]?token|auth|password|passwd|pwd|secret|signature|sig|credential)=)[^&\s#"'<>]*/gi
const JSON_FIELD =
	/("(?:authorization|proxy-authorization|x-api-key|api-?key|apikey|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|cookie|set-cookie)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi
const HEADER_LINE =
	/\b((?:proxy-)?authorization|x-api-key|api-key|cookie|set-cookie)(\s*[:=]\s*)[^\r\n]*/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g
const BASIC = /\bBasic\s+[A-Za-z0-9+/=]{12,}/g
const SHAPE_SK = /\bsk-[A-Za-z0-9_-]{16,}/g
const SHAPE_AIZA = /\bAIza[0-9A-Za-z_-]{20,}/g
const SHAPE_PA = /\bpa-[A-Za-z0-9_-]{20,}/g
const SHAPE_AL = /\bal-[A-Za-z0-9_-]{20,}/g

const CREDENTIAL_FIELDS = new Set([
	"authorization",
	"proxyauthorization",
	"xapikey",
	"apikey",
	"password",
	"passwd",
	"secret",
	"clientsecret",
	"token",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"cookie",
	"setcookie",
	"credentials",
	"connectionstring",
	"mongodburi",
	"mongouri",
	"uri",
])

export type Sanitizer = {
	text(input: string): string
	value(input: unknown): unknown
	register(secret: string): void
	redactionCount(): number
}

function isCredentialField(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
	return (
		CREDENTIAL_FIELDS.has(normalized) ||
		normalized.endsWith("apikey") ||
		normalized.endsWith("secret") ||
		normalized.endsWith("password")
	)
}

function base64Cores(secret: string): string[] {
	const cores: string[] = []
	const leadingDrop = [0, 2, 3]
	for (let pad = 0; pad < 3; pad += 1) {
		const encoded = Buffer.from(`${"\u0000".repeat(pad)}${secret}`).toString(
			"base64",
		)
		const core = encoded.slice(leadingDrop[pad] ?? 0, -4)
		if (core.length >= 10) cores.push(core)
	}
	return cores
}

function variantsOf(secret: string): string[] {
	const percent = encodeURIComponent(secret)
	const variants = new Set<string>([
		secret,
		percent,
		percent.replace(PERCENT_TRIPLET, (m) => m.toLowerCase()),
		encodeURI(secret),
		JSON.stringify(secret).slice(1, -1),
		Buffer.from(secret).toString("base64url"),
		...base64Cores(secret),
	])
	return [...variants].filter((v) => v.length >= MIN_SECRET_LENGTH)
}

function uriParts(value: string): string[] {
	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		return []
	}
	const parts: string[] = []
	for (const raw of [parsed.username, parsed.password]) {
		if (!raw) continue
		parts.push(raw)
		try {
			parts.push(decodeURIComponent(raw))
		} catch {
			// malformed escape: the raw form above is still registered
		}
	}
	if (parsed.hostname) parts.push(parsed.hostname)
	return parts
}

export function collectSecretValues(
	env: Record<string, string | undefined>,
): string[] {
	const found = new Set<string>()
	for (const [name, raw] of Object.entries(env)) {
		const value = raw?.trim()
		if (!value || value.length < MIN_SECRET_LENGTH) continue
		if (!SECRET_ENV_NAME.test(name)) continue
		found.add(value)
		for (const part of uriParts(value)) {
			if (part.length >= MIN_SECRET_LENGTH) found.add(part)
		}
	}
	return [...found]
}

function needlesFor(secrets: readonly string[]): string[] {
	return [...new Set(secrets.flatMap((secret) => variantsOf(secret)))].sort(
		(a, b) => b.length - a.length,
	)
}

export function createSanitizer(options: {
	secretValues: readonly string[]
}): Sanitizer {
	const secrets = [...options.secretValues]
	let needles = needlesFor(secrets)
	let redactions = 0

	function replaceKnown(input: string): string {
		let out = input
		for (const needle of needles) {
			const pieces = out.split(needle)
			if (pieces.length > 1) {
				redactions += pieces.length - 1
				out = pieces.join(SECRET_LABEL)
			}
		}
		return out
	}

	function replaceGeneric(
		input: string,
		pattern: RegExp,
		build: (groups: string[]) => string,
	): string {
		return input.replace(pattern, (...args) => {
			redactions += 1
			const groups = args
				.slice(1, -2)
				.filter((group): group is string => typeof group === "string")
			return build(groups)
		})
	}

	function text(input: string): string {
		let out = replaceKnown(input)
		out = replaceGeneric(
			out,
			USERINFO,
			([scheme]) => `${scheme}[REDACTED:userinfo]@`,
		)
		out = replaceGeneric(
			out,
			QUERY_SECRET,
			([head]) => `${head}[REDACTED:query]`,
		)
		out = replaceGeneric(out, JSON_FIELD, ([head]) => `${head}"${FIELD_LABEL}"`)
		out = replaceGeneric(
			out,
			HEADER_LINE,
			([name, sep]) => `${name}${sep}[REDACTED:header]`,
		)
		out = replaceGeneric(out, BEARER, () => "Bearer [REDACTED:token]")
		out = replaceGeneric(out, BASIC, () => "Basic [REDACTED:token]")
		for (const shape of [SHAPE_SK, SHAPE_AIZA, SHAPE_PA, SHAPE_AL]) {
			out = replaceGeneric(out, shape, () => "[REDACTED:key-shape]")
		}
		return out
	}

	function walkError(error: Error, depth: number, seen: WeakSet<object>) {
		const out: Record<string, unknown> = {
			name: text(error.name),
			message: text(error.message),
		}
		const extra = error as Error & { code?: unknown; status?: unknown }
		if (typeof extra.code === "string" || typeof extra.code === "number") {
			out.code = typeof extra.code === "string" ? text(extra.code) : extra.code
		}
		if (typeof extra.status === "number") out.status = extra.status
		if (error.cause !== undefined) {
			out.cause = walk(error.cause, depth + 1, seen)
		}
		return out
	}

	function walkEntries(
		entries: Iterable<[unknown, unknown]>,
		depth: number,
		seen: WeakSet<object>,
	): Record<string, unknown> {
		const out: Record<string, unknown> = {}
		for (const [rawKey, rawValue] of entries) {
			const key = text(String(rawKey))
			out[key] = isCredentialField(String(rawKey))
				? FIELD_LABEL
				: walk(rawValue, depth + 1, seen)
		}
		return out
	}

	function walk(input: unknown, depth: number, seen: WeakSet<object>): unknown {
		if (typeof input === "string") return text(input)
		if (input === null || input === undefined) return input
		if (typeof input === "number" || typeof input === "boolean") return input
		if (typeof input === "bigint") return input.toString()
		if (typeof input === "function" || typeof input === "symbol") {
			return "[unserializable]"
		}
		if (depth > MAX_DEPTH) return "[depth-limit]"
		const object = input as object
		if (seen.has(object)) return "[circular]"
		seen.add(object)
		try {
			if (input instanceof Uint8Array) {
				return `[binary ${input.byteLength} bytes]`
			}
			if (input instanceof Error) return walkError(input, depth, seen)
			if (input instanceof Headers) {
				return walkEntries(input.entries(), depth, seen)
			}
			if (input instanceof Map) return walkEntries(input.entries(), depth, seen)
			if (input instanceof Set) {
				return [...input].map((item) => walk(item, depth + 1, seen))
			}
			if (Array.isArray(input)) {
				if (
					input.length === 2 &&
					typeof input[0] === "string" &&
					isCredentialField(input[0])
				) {
					return [text(input[0]), FIELD_LABEL]
				}
				return input.map((item) => walk(item, depth + 1, seen))
			}
			if (input instanceof Date) return input.toISOString()
			const entries: Array<[unknown, unknown]> = []
			for (const key of Object.keys(object)) {
				try {
					entries.push([key, (object as Record<string, unknown>)[key]])
				} catch (error) {
					entries.push([key, error])
				}
			}
			return walkEntries(entries, depth, seen)
		} finally {
			seen.delete(object)
		}
	}

	return {
		text,
		value: (input) => walk(input, 0, new WeakSet()),
		register: (secret) => {
			secrets.push(secret)
			needles = needlesFor(secrets)
		},
		redactionCount: () => redactions,
	}
}
