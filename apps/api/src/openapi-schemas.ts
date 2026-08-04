import { MEMORY_SCOPE_VALUES } from "@memongo/lib"

/** Canonical scope enum, derived from the single contract source (P2.2). */
export const memoryScopeEnum: readonly string[] = MEMORY_SCOPE_VALUES

/**
 * Shared idempotency wording (B2a). The header is the transport-preferred
 * channel; the `customId` body field is the SDK-friendly fallback — the
 * header wins when both are present (routes/v1.ts readIdempotencyKey).
 */
export const IDEMPOTENCY_KEY_FIELD_DESCRIPTION =
	"Idempotency key for this write (IETF/Stripe semantics): a replay returns the original receipt, a key reused with a different payload yields 422 IDEMPOTENCY_CONFLICT. The Idempotency-Key header takes precedence when both are sent."

export const IDEMPOTENCY_KEY_HEADER_PARAMETER = {
	name: "Idempotency-Key",
	in: "header",
	required: false,
	schema: { type: "string" },
	description: IDEMPOTENCY_KEY_FIELD_DESCRIPTION,
} as const

/**
 * Shared TTL wording (B1). expiresAt is an absolute retention instant —
 * after it the document is invisible to reads and a MongoDB TTL index
 * removes it (sweep lag ~60s). It is about retention, not event validity;
 * historical fact windows belong in validAt/invalidAt.
 */
export const EXPIRES_AT_FIELD_DESCRIPTION =
	"ISO 8601 instant after which this document expires (P4.4.1 TTL). Must be in the future; an invalid or past value is rejected with 400 VALIDATION_ERROR."

export const lifecycleSourceAgentSchema = {
	type: "object",
	required: ["id", "name"],
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		runId: { type: "string" },
	},
} as const

export const actorRoleSchema = {
	type: "string",
	enum: ["user", "assistant", "system"],
} as const

export const lifecycleStructuredHandleSchema = {
	type: "object",
	required: [
		"family",
		"id",
		"agentId",
		"scope",
		"scopeRef",
		"revision",
		"state",
		"structured",
	],
	properties: {
		family: { type: "string", enum: ["structured"] },
		id: { type: "string" },
		agentId: { type: "string" },
		scope: {
			type: "string",
			enum: memoryScopeEnum,
		},
		scopeRef: { type: "string" },
		revision: { type: "integer", minimum: 1 },
		state: { type: "string", enum: ["active", "invalidated", "conflicted"] },
		validFrom: { type: "string", format: "date-time" },
		validTo: { type: "string", format: "date-time" },
		updatedAt: { type: "string", format: "date-time" },
		structured: {
			type: "object",
			required: ["type", "key"],
			properties: {
				type: { type: "string" },
				key: { type: "string" },
			},
		},
	},
} as const

export const lifecycleProcedureHandleSchema = {
	type: "object",
	required: [
		"family",
		"id",
		"agentId",
		"scope",
		"scopeRef",
		"revision",
		"state",
		"procedure",
	],
	properties: {
		family: { type: "string", enum: ["procedure"] },
		id: { type: "string" },
		agentId: { type: "string" },
		scope: {
			type: "string",
			enum: memoryScopeEnum,
		},
		scopeRef: { type: "string" },
		revision: { type: "integer", minimum: 1 },
		state: { type: "string", enum: ["active", "invalidated", "conflicted"] },
		validFrom: { type: "string", format: "date-time" },
		validTo: { type: "string", format: "date-time" },
		updatedAt: { type: "string", format: "date-time" },
		procedure: {
			type: "object",
			required: ["procedureId"],
			properties: {
				procedureId: { type: "string" },
			},
		},
	},
} as const

export const lifecycleHandleSchema = {
	oneOf: [lifecycleStructuredHandleSchema, lifecycleProcedureHandleSchema],
} as const

export const structuredLifecyclePatchSchema = {
	type: "object",
	properties: {
		value: { type: "string" },
		context: { type: "string" },
		confidence: { type: "number" },
		source: { type: "string" },
		sessionId: { type: "string" },
		tags: { type: "array", items: { type: "string" } },
		salience: { type: "string" },
		temporalScope: { type: "string" },
		provenance: { type: "object" },
		sourceEventIds: { type: "array", items: { type: "string" } },
		validTo: { type: "string", format: "date-time" },
		reviewAt: { type: "string", format: "date-time" },
		lastConfirmedAt: { type: "string", format: "date-time" },
		sourceReliability: { type: "number" },
		sourceAgent: lifecycleSourceAgentSchema,
		artifact: { type: "object" },
	},
} as const

export const procedureLifecyclePatchSchema = {
	type: "object",
	properties: {
		name: { type: "string" },
		intentTags: { type: "array", items: { type: "string" } },
		triggerQueries: { type: "array", items: { type: "string" } },
		steps: { type: "array", items: { type: "string" } },
		successSignals: { type: "array", items: { type: "string" } },
		confidence: { type: "number" },
		provenance: { type: "object" },
		sourceEventIds: { type: "array", items: { type: "string" } },
		sourceAgent: lifecycleSourceAgentSchema,
	},
} as const

export const lifecycleStructuredItemSchema = {
	type: "object",
	required: ["family", "handle", "data"],
	properties: {
		family: { type: "string", enum: ["structured"] },
		handle: lifecycleStructuredHandleSchema,
		data: {
			type: "object",
			required: ["type", "key", "value"],
			properties: {
				type: { type: "string" },
				key: { type: "string" },
				value: { type: "string" },
				context: { type: "string" },
				confidence: { type: "number" },
				source: { type: "string" },
				sessionId: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				salience: { type: "string" },
				temporalScope: { type: "string" },
				provenance: { type: "object" },
				sourceEventIds: { type: "array", items: { type: "string" } },
				sourceReliability: { type: "number" },
				reinforcementCount: { type: "number" },
				reviewAt: { type: "string", format: "date-time" },
				lastConfirmedAt: { type: "string", format: "date-time" },
				sourceAgent: lifecycleSourceAgentSchema,
				artifact: { type: "object" },
			},
		},
		createdAt: { type: "string", format: "date-time" },
		updatedAt: { type: "string", format: "date-time" },
	},
} as const

export const lifecycleProcedureItemSchema = {
	type: "object",
	required: ["family", "handle", "data"],
	properties: {
		family: { type: "string", enum: ["procedure"] },
		handle: lifecycleProcedureHandleSchema,
		data: {
			type: "object",
			required: ["procedureId", "name", "steps"],
			properties: {
				procedureId: { type: "string" },
				name: { type: "string" },
				intentTags: { type: "array", items: { type: "string" } },
				triggerQueries: { type: "array", items: { type: "string" } },
				steps: { type: "array", items: { type: "string" } },
				successSignals: { type: "array", items: { type: "string" } },
				confidence: { type: "number" },
				provenance: { type: "object" },
				sourceEventIds: { type: "array", items: { type: "string" } },
				successCount: { type: "number" },
				failCount: { type: "number" },
				lastSuccessAt: { type: "string", format: "date-time" },
				lastFailureAt: { type: "string", format: "date-time" },
				sourceAgent: lifecycleSourceAgentSchema,
			},
		},
		createdAt: { type: "string", format: "date-time" },
		updatedAt: { type: "string", format: "date-time" },
	},
} as const

export const lifecycleItemSchema = {
	oneOf: [lifecycleStructuredItemSchema, lifecycleProcedureItemSchema],
} as const

export const lifecycleHistoryEntrySchema = {
	oneOf: [
		{
			allOf: [
				lifecycleStructuredItemSchema,
				{
					type: "object",
					required: ["historyKind"],
					properties: {
						historyKind: { type: "string", enum: ["revision", "current"] },
						supersededAt: { type: "string", format: "date-time" },
					},
				},
			],
		},
		{
			allOf: [
				lifecycleProcedureItemSchema,
				{
					type: "object",
					required: ["historyKind"],
					properties: {
						historyKind: { type: "string", enum: ["revision", "current"] },
						supersededAt: { type: "string", format: "date-time" },
					},
				},
			],
		},
	],
} as const
