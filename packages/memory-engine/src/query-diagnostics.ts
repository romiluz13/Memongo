import { createHash } from "node:crypto"
import { formatErrorMessage, redactSensitiveText } from "@memongo/lib"

/**
 * C-002: failure diagnostics for query-carrying paths. Raw query text is
 * user content, not an error detail — it never enters logs. A length plus a
 * SHA-256 digest let an operator correlate failures across log lines (and
 * against a known query) without exposing the query itself; the error detail
 * is redacted through formatErrorMessage.
 *
 * Downstream errors (driver messages, command failures) can echo the query
 * that caused them, which would smuggle the raw text back in through the
 * error detail. redactQueryEcho therefore replaces every echo of the query
 * — verbatim, the credential-redacted variant formatErrorMessage would
 * leave behind, case/whitespace/split/truncated variants of either, and
 * mid-word fragments of long query words — with the correlatable
 * [query:<digest>] alias.
 */
export type QueryFailureMeta = {
	queryLength: number
	queryDigest: string
	error: string
}

/**
 * Echoes shorter than this are left intact: replacing 1-3 character
 * fragments would mangle log detail without protecting any meaningful
 * user content.
 */
const ECHO_REDACT_MIN_LENGTH = 4

/**
 * Minimum contiguous query text (joined with single spaces) for a
 * multi-word echo window to be replaced. Below this, two ordinary words
 * colliding with an error message are treated as coincidence, not echo.
 */
const ECHO_WINDOW_MIN_LENGTH = 8

/**
 * Minimum length for a single-word query to be replaced wherever it
 * appears. Single common words ("reset", "error") must not be scrubbed from
 * unrelated diagnostic text.
 */
const ECHO_SINGLE_WORD_MIN_LENGTH = 6

/**
 * Maximum separator junk allowed between consecutive query words inside an
 * echo. Whitespace-mangled, quote-split, and lightly interleaved echoes
 * match; wholesale reordering or heavy interleaving does not (bounded so
 * unrelated diagnostic text is never swallowed by a runaway match).
 */
const ECHO_MAX_GAP = 32

/**
 * Minimum contiguous overlap between a long query word and a diagnostic
 * token for the whole token to be replaced. Echoes are often truncated or
 * re-segmented mid-word ("dummyprojectname000" echoing the query word
 * "dummyprojectname0000000"); complete-word matching alone lets those
 * fragments through. Ten contiguous characters of query-word content
 * inside a longer token is echo content, not coincidence.
 */
const ECHO_FRAGMENT_MIN_LENGTH = 10

/**
 * Words longer than this skip the fragment pass: such words are almost
 * always URIs or secret-shaped payloads whose full form is already handled
 * by the exact and window passes, and slicing them into windows would
 * generate hundreds of low-value regexes.
 */
const ECHO_FRAGMENT_MAX_WORD_LENGTH = 128

function replaceAll(text: string, needle: string, replacement: string): string {
	return text.split(needle).join(replacement)
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * A query word as a regex fragment. Word-boundary guards are applied only
 * on word-character edges so the word never matches inside a longer token
 * ("how" must not match "however").
 */
function wordPattern(token: string): string {
	const escaped = escapeRegExp(token)
	const startsWord = /\w/.test(token[0] ?? "")
	const endsWord = /\w/.test(token[token.length - 1] ?? "")
	return `${startsWord ? "\\b" : ""}${escaped}${endsWord ? "\\b" : ""}`
}

/**
 * Builds an alternation of every eligible window of consecutive query
 * words, longest first. Each window tolerates up to ECHO_MAX_GAP chars of
 * separator junk between words and matches case-insensitively, so
 * case-folded, whitespace-mangled, split, truncated, and middle-fragment
 * echoes all hit. Longest-first ordering makes the alternation consume the
 * maximal span, so nested shorter windows never double-replace.
 */
function echoWindowRegex(words: string[]): RegExp | null {
	const windows: { source: string; text: string }[] = []
	for (let start = 0; start < words.length; start++) {
		for (let end = words.length; end > start; end--) {
			const run = words.slice(start, end)
			const text = run.join(" ")
			const eligible =
				run.length >= 2
					? text.length >= ECHO_WINDOW_MIN_LENGTH
					: text.length >= ECHO_SINGLE_WORD_MIN_LENGTH
			if (!eligible) continue
			windows.push({
				source: run.map(wordPattern).join(`[\\s\\S]{0,${ECHO_MAX_GAP}}?`),
				text,
			})
		}
	}
	if (windows.length === 0) return null
	const sources = [...new Set(windows)]
		.sort((a, b) => b.text.length - a.text.length)
		.map((window) => window.source)
	return new RegExp(sources.join("|"), "gi")
}

/**
 * Fragment pass: a diagnostic token that CONTAINS a long slice of a query
 * word without equaling it (truncated or re-segmented echoes) is replaced
 * whole. Sliding ECHO_FRAGMENT_MIN_LENGTH windows over each eligible query
 * word produce the needles; each needle matches with token context so the
 * full surrounding token is consumed, not just the overlap.
 */
function redactQueryFragments(
	text: string,
	words: string[],
	alias: string,
): string {
	let out = text
	for (const word of new Set(words)) {
		if (word.length < ECHO_FRAGMENT_MIN_LENGTH) continue
		if (word.length > ECHO_FRAGMENT_MAX_WORD_LENGTH) continue
		for (let i = 0; i + ECHO_FRAGMENT_MIN_LENGTH <= word.length; i++) {
			const fragment = word.slice(i, i + ECHO_FRAGMENT_MIN_LENGTH)
			const tokenRegex = new RegExp(
				`[\\w-]*${escapeRegExp(fragment)}[\\w-]*`,
				"gi",
			)
			out = out.replace(tokenRegex, (match) =>
				match.includes("***") ? match : alias,
			)
		}
	}
	return out
}

function redactQueryEcho(text: string, query: string, alias: string): string {
	let out = text
	const fragmentWords: string[] = []
	// The redacted variant matters when the query itself carries a
	// credential: formatErrorMessage has already replaced the credential
	// inside the echoed text, so only the redacted form of the query can
	// still match.
	for (const variant of new Set([query, redactSensitiveText(query)])) {
		const trimmed = variant.trim()
		if (trimmed.length < ECHO_REDACT_MIN_LENGTH) continue
		if (out.includes(variant)) out = replaceAll(out, variant, alias)
		// Variant-tolerant pass: downstream errors rarely echo the query
		// byte-for-byte. Case-folded, whitespace-mangled, split, and
		// truncated echoes are still the user's query text and must not
		// survive into logs.
		const words = trimmed.split(/\s+/).filter(Boolean)
		fragmentWords.push(...words)
		const windowRegex = echoWindowRegex(words)
		if (windowRegex) out = out.replace(windowRegex, alias)
	}
	// Fragment pass: truncated or re-segmented mid-word echoes.
	return redactQueryFragments(out, fragmentWords, alias)
}

export function queryFailureMeta(
	query: string,
	err: unknown,
): QueryFailureMeta {
	const digest = createHash("sha256").update(query).digest("hex").slice(0, 12)
	return {
		queryLength: query.length,
		queryDigest: digest,
		error: redactQueryEcho(formatErrorMessage(err), query, `[query:${digest}]`),
	}
}
