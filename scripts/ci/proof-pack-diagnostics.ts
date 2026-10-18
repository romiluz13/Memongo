// Failure-only proof-pack diagnostics (#93). Everything here feeds a CI
// artifact for a human reading a failed run. Index status is never a
// visibility signal: the search barrier probe is the only one.

const MAX_LINE_CHARS = 2_000
const MAX_INDEX_FIELDS = 64
const MAX_NAME_CHARS = 128

const TEXT_FIELDS =
	/("(?:text|body|content|value|query|queryString|snippet|input|searchText|summary|title|steps|documents|doc)"\s*:\s*)("(?:[^"\\]|\\.)*"|\[[^\]]*\])/g
const URI = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+/g
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const ASSIGNED_SECRET =
	/((?:api[_ -]?key|token|secret|password|passwd|credentials?)"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,}"']+)/gi
const MODEL_KEY = /\b(?:al|pa)-[A-Za-z0-9_-]{16,}/g
const HEX_TOKEN = /\b[0-9a-fA-F]{32,}\b/g

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Removes URIs, keys and document or query text from service log text and
 * caps every line. Known secret values are removed verbatim first, so a key
 * of any shape is covered when the caller knows it.
 */
export function scrubLogText(text: string, secrets: string[]): string {
	let scrubbed = text
	for (const secret of secrets) {
		if (secret.trim().length >= 4) {
			scrubbed = scrubbed.replace(
				new RegExp(escapeRegExp(secret.trim()), "g"),
				"<redacted>",
			)
		}
	}
	scrubbed = scrubbed
		.replace(URI, "<uri>")
		.replace(AUTH_SCHEME, "$1 <redacted>")
		.replace(ASSIGNED_SECRET, '$1"<redacted>"')
		.replace(MODEL_KEY, "<redacted-key>")
		.replace(HEX_TOKEN, "<redacted-token>")
		.replace(TEXT_FIELDS, '$1"<redacted-text>"')
	return scrubbed
		.split("\n")
		.map((line) =>
			line.length > MAX_LINE_CHARS
				? `${line.slice(0, MAX_LINE_CHARS)} [line truncated]`
				: line,
		)
		.join("\n")
}

/** Keeps the newest whole lines that fit in `maxBytes`, marking the cut. */
export function boundTail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) {
		return text
	}
	const header = `[truncated: newest ${maxBytes} bytes]\n`
	let budget = maxBytes - Buffer.byteLength(header)
	const kept: string[] = []
	const lines = text.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		const cost = Buffer.byteLength(lines[i]) + (kept.length > 0 ? 1 : 0)
		if (cost > budget) {
			break
		}
		kept.unshift(lines[i])
		budget -= cost
	}
	return header + kept.join("\n")
}

export type SearchIndexStatus = {
	collection: string
	name: string
	type: string
	status: string
	queryable: boolean | null
	fields: string[]
}

type IndexDefinition = {
	fields?: unknown
	mappings?: { fields?: unknown }
}

function mappingFieldNames(fields: unknown, prefix: string): string[] {
	if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
		return []
	}
	const names: string[] = []
	for (const [key, mapping] of Object.entries(fields)) {
		const name = `${prefix}${key}`
		names.push(name)
		const variants = Array.isArray(mapping) ? mapping : [mapping]
		for (const variant of variants) {
			if (variant && typeof variant === "object" && "fields" in variant) {
				names.push(...mappingFieldNames(variant.fields, `${name}.`))
			}
		}
	}
	return names
}

function definitionFieldNames(
	definition: IndexDefinition | undefined,
): string[] {
	if (!definition) {
		return []
	}
	if (Array.isArray(definition.fields)) {
		return definition.fields
			.map((field) =>
				field && typeof field === "object" && "path" in field
					? field.path
					: undefined,
			)
			.filter((path): path is string => typeof path === "string")
	}
	return mappingFieldNames(definition.mappings?.fields, "")
}

function boundedName(value: unknown): string {
	return String(value ?? "unknown").slice(0, MAX_NAME_CHARS)
}

/**
 * Reduces `$listSearchIndexes` documents to name, type, status, queryable and
 * the latest definition's field names. Definition values (models, analyzers,
 * similarity) and any document content are dropped.
 */
export function summarizeSearchIndexes(
	collection: string,
	indexes: Array<Record<string, unknown>>,
): SearchIndexStatus[] {
	return indexes.map((index) => ({
		collection: boundedName(collection),
		name: boundedName(index.name),
		type: boundedName(index.type),
		status: boundedName(index.status),
		queryable: typeof index.queryable === "boolean" ? index.queryable : null,
		fields: definitionFieldNames(
			index.latestDefinition as IndexDefinition | undefined,
		)
			.slice(0, MAX_INDEX_FIELDS)
			.map(boundedName),
	}))
}
