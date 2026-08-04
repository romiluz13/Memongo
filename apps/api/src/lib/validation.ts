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
