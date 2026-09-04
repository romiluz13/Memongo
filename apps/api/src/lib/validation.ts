import {
	CHAIN_TRACE_COLLECTION_VALUES_TUPLE,
	CONTEXT_BUNDLE_MODE_VALUES_TUPLE,
} from "@memongo/lib"
import { z } from "zod"

/**
 * P2.8 boundary input validation. Route bodies used to be cast, not
 * validated — a missing `entry.key` landed `undefined` in the MongoDB
 * identity filter, malformed JSON silently became `{}`, and free-form
 * metadata accepted operator-shaped keys (`$where`, dotted paths) straight
 * into stored documents. These schemas validate the route families whose
 * casts were unsafe; the route layer maps a rejection to a deliberate
 * 400 VALIDATION_ERROR naming the offending field (first zod issue), and a
 * non-empty unparseable body to 400 INVALID_JSON via InvalidJsonError.
 */

/**
 * Thrown when a non-empty request body fails JSON.parse. The v1 router maps
 * this ONCE to 400 INVALID_JSON; a genuinely empty body is not an error and
 * stays `{}` (bodiless POSTs rely on that).
 */
export class InvalidJsonError extends Error {
	override readonly name = "InvalidJsonError"
	constructor() {
		super("request body is not valid JSON")
	}
}

export function isInvalidJsonError(error: unknown): error is InvalidJsonError {
	return error instanceof InvalidJsonError
}

export type SchemaValidation<T> =
	| { ok: true; value: T }
	| { ok: false; message: string }

/**
 * Validate `raw` against `schema`, reporting the FIRST zod issue as
 * `<fieldPrefix>.<path>: <message>` so the 400 names the offending field
 * without leaking schema internals.
 */
export function validateWithSchema<S extends z.ZodTypeAny>(
	schema: S,
	raw: unknown,
	fieldPrefix: string,
): SchemaValidation<z.infer<S>> {
	const parsed = schema.safeParse(raw)
	if (parsed.success) {
		return { ok: true, value: parsed.data as z.infer<S> }
	}
	const issue = parsed.error.issues[0]
	if (!issue) {
		return { ok: false, message: `${fieldPrefix}: invalid value` }
	}
	const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : ""
	return {
		ok: false,
		message: `${fieldPrefix}${path}: ${issue.message}`,
	}
}

/* ------------------------------------------------------------------------ */
/*  write family — structured/procedure entries                             */
/* ------------------------------------------------------------------------ */

/**
 * Structured memory entry (StructuredMemoryEntry in the engine). `type`,
 * `key`, and `value` are required — a missing key used to land `undefined`
 * in the DB identity filter. Known optional fields are type-checked; unknown
 * fields pass through so newer engine fields stay forward-compatible.
 */
export const structuredEntrySchema = z
	.object({
		type: z.string().trim().min(1),
		key: z.string().trim().min(1),
		value: z.string(),
		context: z.string().optional(),
		confidence: z.number().finite().optional(),
		source: z.enum(["agent", "user", "session", "ingestion"]).optional(),
		sessionId: z.string().optional(),
		tags: z.array(z.string()).optional(),
		salience: z.enum(["critical", "high", "normal", "low"]).optional(),
		temporalScope: z
			.enum(["ongoing", "bounded", "permanent", "transient"])
			.optional(),
		provenance: z.record(z.unknown()).optional(),
		sourceEventIds: z.array(z.string()).optional(),
		// B1: optional absolute expiry instant (P4.4.1 engine TTL). Validated
		// as an ISO datetime string here; the route converts it to a Date —
		// without this the passthrough string silently failed the engine's
		// `instanceof Date` check and the write never expired.
		expiresAt: z.string().datetime({ offset: true }).optional(),
	})
	.passthrough()

/**
 * Procedure entry (ProcedureEntry in the engine). `procedureId` feeds the DB
 * identity filter the same way `key` does for structured memory, so it is
 * required alongside `name` and `steps`.
 */
export const procedureEntrySchema = z
	.object({
		procedureId: z.string().trim().min(1),
		name: z.string().trim().min(1),
		steps: z.array(z.string()),
		intentTags: z.array(z.string()).optional(),
		triggerQueries: z.array(z.string()).optional(),
		successSignals: z.array(z.string()).optional(),
		confidence: z.number().finite().optional(),
		provenance: z.record(z.unknown()).optional(),
		sourceEventIds: z.array(z.string()).optional(),
	})
	.passthrough()

/* ------------------------------------------------------------------------ */
/*  search family — KB filter                                               */
/* ------------------------------------------------------------------------ */

/**
 * KB search filter. Strict: unknown keys (including operator-shaped ones
 * like `$where`) are rejected instead of being cast through into the
 * MongoDB filter the engine builds from this object.
 */
export const kbFilterSchema = z
	.object({
		tags: z.array(z.string()).optional(),
		category: z.string().optional(),
		source: z.string().optional(),
	})
	.strict()

/* ------------------------------------------------------------------------ */
/*  search family — /search-detailed nested objects (WS-08 / C-012)        */
/* ------------------------------------------------------------------------ */

/**
 * Temporal window filter shared by /search-detailed, /context-bundle, and
 * /discovery-projection. Every nested object of these routes used to be
 * type-cast straight through, so a typo'd preset (e.g. "last-7-days")
 * skipped the planner's exhaustive preset switch and silently degraded to
 * NO time constraint, and a non-date `start`/`end` became an Invalid Date
 * inside the engine's comparisons. Strict: unknown keys are rejected and
 * the preset must be one of the eight the planner actually resolves.
 */
export const timeRangeSchema = z
	.object({
		preset: z
			.enum([
				"today",
				"yesterday",
				"last-24h",
				"last-7d",
				"this-week",
				"last-30d",
				"this-month",
			])
			.optional(),
		start: z.string().datetime({ offset: true }).optional(),
		end: z.string().datetime({ offset: true }).optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.preset !== undefined ||
			value.start !== undefined ||
			value.end !== undefined,
		{ message: "timeRange must set at least one of preset, start, end" },
	)

/** Conversation lane filter (sessionKey narrows the events lane). Strict. */
export const conversationScopeSchema = z
	.object({
		sessionKey: z.string().min(1).optional(),
	})
	.strict()

/**
 * Structured memory lane filter. `state` accepts a single value or a list
 * (the planner reads both shapes); `type`/`salience` stay open strings
 * because the engine treats them as open-ended. Strict: unknown keys are
 * rejected.
 */
export const structuredScopeSchema = z
	.object({
		type: z.string().min(1).optional(),
		state: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
		salience: z.array(z.string().min(1)).optional(),
	})
	.strict()

/** Reference (KB) lane filter. Strict. */
export const referenceScopeSchema = z
	.object({
		source: z.string().min(1).optional(),
		category: z.string().min(1).optional(),
		tags: z.array(z.string().min(1)).optional(),
	})
	.strict()

/** Procedural lane filter. Strict. */
export const proceduralScopeSchema = z
	.object({
		state: z.string().min(1).optional(),
		intentTags: z.array(z.string().min(1)).optional(),
	})
	.strict()

/**
 * Top-level search controls of /search-detailed that were silently
 * defaulted on invalid values (searchMode) or cast through unchecked
 * (sourcePreference).
 */
export const SEARCH_MODE_VALUES = ["auto", "direct", "agentic"] as const
export const searchModeSchema = z.enum(SEARCH_MODE_VALUES)
export const SOURCE_PREFERENCE_VALUES = [
	"reference",
	"conversation",
	"structured",
	"procedural",
	"episodic",
	"graph",
] as const
export const sourcePreferenceSchema = z.array(z.enum(SOURCE_PREFERENCE_VALUES))

/**
 * Search recipe configuration. Mirrors SearchConfig in
 * packages/memory-engine/src/types.ts field-for-field; strict so unknown
 * keys (or operator-shaped ones) are rejected instead of flowing into the
 * engine's config merge.
 */
export const searchConfigSchema = z
	.object({
		recipe: z
			.enum(["fast", "hybrid", "deep", "temporal", "chain-of-thought"])
			.optional(),
		recallProfile: z.enum(["latency", "balanced", "proof"]).optional(),
		maxResults: z.number().int().positive().optional(),
		searchMode: searchModeSchema.optional(),
		maxPasses: z.number().int().positive().optional(),
		sourcePreference: sourcePreferenceSchema.optional(),
		timeRange: timeRangeSchema.optional(),
		needExactEvidence: z.boolean().optional(),
		numCandidates: z.number().int().positive().optional(),
		fusionMethod: z.enum(["scoreFusion", "rankFusion", "js-merge"]).optional(),
		hybridMode: z.enum(["hybrid", "vector-only"]).optional(),
		allowHybridBackstop: z.boolean().optional(),
		lexicalPrefilter: z.enum(["disabled", "experimental"]).optional(),
	})
	.strict()

/* ------------------------------------------------------------------------ */
/*  context family — bundle mode (WS-08 / C-013)                            */
/* ------------------------------------------------------------------------ */

/**
 * Context-bundle mode, validated against the canonical contract enum
 * (CONTEXT_BUNDLE_MODE_VALUES in @memongo/lib). The route used to swallow
 * every value outside "wake-up" into the default "full" bundle with a 200
 * — callers could request "wakeup" or "FULL" and never learn the mode was
 * dropped. Invalid values now return 400 naming the allowed set.
 */
export const contextBundleModeSchema = z.enum(CONTEXT_BUNDLE_MODE_VALUES_TUPLE)

/* ------------------------------------------------------------------------ */
/*  maintenance family — chain-trace collection (WS-08 / C-015)            */
/* ------------------------------------------------------------------------ */

/**
 * Reasoning-chain collection, validated against the canonical contract
 * enum (CHAIN_TRACE_COLLECTION_VALUES in @memongo/lib, the same allowlist
 * that keys COLLECTION_ID_FIELDS in the engine). The engine used to answer
 * a plausible-but-wrong collection name with a fabricated empty
 * `chainComplete: true` chain — indistinguishable from "no premises
 * exist". Invalid values now return 400 naming the traversable set.
 */
export const chainTraceCollectionSchema = z.enum(
	CHAIN_TRACE_COLLECTION_VALUES_TUPLE,
)

/* ------------------------------------------------------------------------ */
/*  free-form metadata — operator key rejection                             */
/* ------------------------------------------------------------------------ */

const INVALID_METADATA_KEY_MESSAGE =
	'metadata keys must not start with "$" or contain "."'

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Free-form metadata is stored verbatim in MongoDB documents, so keys that
 * double as query operators (`$`-prefixed) or nested paths (dotted) are
 * rejected at the boundary — an operator-shaped key would otherwise persist
 * and could be evaluated inside a later Mongo filter.
 */
export const metadataSchema = z
	.record(z.unknown())
	.superRefine((value, ctx) => {
		for (const key of Object.keys(value)) {
			if (key.startsWith("$") || key.includes(".")) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: INVALID_METADATA_KEY_MESSAGE,
					path: [key],
				})
			}
		}
	})

export function validateMetadata(
	raw: unknown,
): SchemaValidation<Record<string, unknown> | undefined> {
	if (raw === undefined) {
		return { ok: true, value: undefined }
	}
	if (!isPlainObject(raw)) {
		return { ok: false, message: "metadata: must be an object" }
	}
	return validateWithSchema(metadataSchema, raw, "metadata")
}
