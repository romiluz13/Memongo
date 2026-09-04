/**
 * OpenAPI 3.0 document for the Memongo HTTP API.
 * Keep this aligned with the supported route contract in `routes/v1.ts`.
 *
 * P2.2: shared fragments derive from the single contract source in
 * @memongo/lib (canonical scope enum, ApiError envelope, bearer scheme,
 * route table). `withContractConformance` below fills every contract
 * route's error responses with the ApiError $ref so error bodies cannot
 * drift, and apps/api/src/contract-conformance.test.ts fails CI when the
 * hand-written paths and the live router disagree.
 */
import {
	AGENT_ID_FIELD_DESCRIPTION,
	SCOPE_FIELD_DESCRIPTION,
	SCOPE_REF_FIELD_DESCRIPTION,
} from "@memongo/lib"
import {
	memoryScopeEnum,
	IDEMPOTENCY_KEY_FIELD_DESCRIPTION,
	IDEMPOTENCY_KEY_HEADER_PARAMETER,
	EXPIRES_AT_FIELD_DESCRIPTION,
} from "./openapi-schemas.js"

export const writePaths = {
	"/v1/add": {
		post: {
			summary: "Append a user message to conversational memory",
			parameters: [IDEMPOTENCY_KEY_HEADER_PARAMETER],
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["content"],
							properties: {
								content: { type: "string" },
								agentId: { type: "string" },
								sessionId: {
									type: "string",
									description:
										"Optional session identifier for this memory write.",
								},
								containerTag: {
									type: "string",
									deprecated: true,
									description: "Deprecated compatibility alias for sessionId.",
								},
								scope: {
									type: "string",
									enum: memoryScopeEnum,
									description: SCOPE_FIELD_DESCRIPTION,
								},
								scopeRef: {
									type: "string",
									description: SCOPE_REF_FIELD_DESCRIPTION,
								},
								metadata: {
									type: "object",
									description:
										"Optional metadata stored verbatim with the event (query-operator keys are rejected).",
								},
								customId: {
									type: "string",
									description: IDEMPOTENCY_KEY_FIELD_DESCRIPTION,
								},
								expiresAt: {
									type: "string",
									format: "date-time",
									description: EXPIRES_AT_FIELD_DESCRIPTION,
								},
							},
						},
					},
				},
			},
			responses: { "200": { description: "Event id" } },
		},
	},
	"/v1/write-event": {
		post: {
			summary: "Write conversation event (any role)",
			parameters: [IDEMPOTENCY_KEY_HEADER_PARAMETER],
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["role", "body"],
							properties: {
								role: {
									type: "string",
									enum: ["user", "assistant", "system", "tool"],
								},
								body: { type: "string", minLength: 1 },
								agentId: { type: "string" },
								sessionId: { type: "string" },
								scope: {
									type: "string",
									enum: memoryScopeEnum,
								},
								scopeRef: { type: "string" },
								timestamp: { type: "string", format: "date-time" },
								validAt: {
									type: "string",
									format: "date-time",
									description:
										"When the event became valid; defaults to timestamp.",
								},
								invalidAt: {
									type: "string",
									format: "date-time",
									description:
										"When the event stopped being valid; omitted means still valid.",
								},
								metadata: { type: "object" },
								customId: {
									type: "string",
									description: IDEMPOTENCY_KEY_FIELD_DESCRIPTION,
								},
								expiresAt: {
									type: "string",
									format: "date-time",
									description: EXPIRES_AT_FIELD_DESCRIPTION,
								},
							},
						},
					},
				},
			},
			responses: { "200": { description: "Event id" } },
		},
	},
	"/v1/write-events": {
		post: {
			summary:
				"Write a batch of conversation events (P3.9) with per-item receipts",
			description:
				"Bulk variant of /v1/write-event: one request writes up to 500 events through an amortized insertMany/bulkWrite path. Per-item idempotency keys (customId) follow the same IETF/Stripe semantics as the single write — a replayed item returns its original receipt, a key reused with a different payload yields a per-item IDEMPOTENCY_CONFLICT entry, and a failed item never fails the batch.",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["events"],
							properties: {
								events: {
									type: "array",
									minItems: 1,
									maxItems: 500,
									items: {
										type: "object",
										required: ["role", "body"],
										properties: {
											role: {
												type: "string",
												enum: ["user", "assistant", "system", "tool"],
											},
											body: { type: "string", minLength: 1 },
											sessionId: { type: "string" },
											scope: {
												type: "string",
												enum: memoryScopeEnum,
											},
											scopeRef: { type: "string" },
											timestamp: { type: "string", format: "date-time" },
											validAt: { type: "string", format: "date-time" },
											invalidAt: { type: "string", format: "date-time" },
											metadata: { type: "object" },
											customId: {
												type: "string",
												description:
													"Per-item idempotency key (same semantics as the Idempotency-Key header on /v1/write-event).",
											},
											expiresAt: {
												type: "string",
												format: "date-time",
												description:
													"Per-item TTL instant; an invalid or past value fails only this item with a VALIDATION_ERROR receipt.",
											},
										},
									},
								},
								agentId: { type: "string" },
								sessionId: {
									type: "string",
									description: "Default sessionId for items that omit one.",
								},
								scope: {
									type: "string",
									enum: memoryScopeEnum,
									description: SCOPE_FIELD_DESCRIPTION,
								},
								scopeRef: {
									type: "string",
									description: SCOPE_REF_FIELD_DESCRIPTION,
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description:
						"Per-item receipts mirroring the single-write receipt shape",
				},
			},
		},
	},
	"/v1/extract": {
		post: {
			summary: "Schedule background extraction for one canonical event",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["eventId"],
							properties: {
								eventId: { type: "string", minLength: 1 },
								agentId: { type: "string" },
								scope: {
									type: "string",
									enum: memoryScopeEnum,
									description: SCOPE_FIELD_DESCRIPTION,
								},
								scopeRef: {
									type: "string",
									description: SCOPE_REF_FIELD_DESCRIPTION,
								},
							},
						},
					},
				},
			},
			responses: { "202": { description: "Extraction scheduled" } },
		},
	},
	"/v1/write-structured": {
		post: {
			summary: "Structured memory write",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["entry"],
							properties: {
								entry: {
									type: "object",
									description:
										"Structured memory entry to upsert (type, key, value, plus optional fields such as context, confidence, tags, salience, temporalScope).",
									properties: {
										expiresAt: {
											type: "string",
											format: "date-time",
											description: EXPIRES_AT_FIELD_DESCRIPTION,
										},
									},
								},
								agentId: {
									type: "string",
									description: AGENT_ID_FIELD_DESCRIPTION,
								},
								scope: {
									type: "string",
									enum: memoryScopeEnum,
									description: SCOPE_FIELD_DESCRIPTION,
								},
								scopeRef: {
									type: "string",
									description: SCOPE_REF_FIELD_DESCRIPTION,
								},
							},
						},
					},
				},
			},
			responses: {
				"200": { description: "Upsert result" },
				"202": {
					description:
						"Accepted but quarantined (C-008): injection-likely entry is held in memory_quarantine pending human review; body carries quarantined=true, id (quarantine id) and matchedPatterns",
				},
			},
		},
	},
	"/v1/write-procedure": {
		post: {
			summary: "Upsert procedure",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["entry"],
							properties: {
								entry: {
									type: "object",
									description: "Procedure memory entry to upsert.",
								},
								agentId: {
									type: "string",
									description: AGENT_ID_FIELD_DESCRIPTION,
								},
								scope: {
									type: "string",
									enum: memoryScopeEnum,
									description: SCOPE_FIELD_DESCRIPTION,
								},
								scopeRef: {
									type: "string",
									description: SCOPE_REF_FIELD_DESCRIPTION,
								},
							},
						},
					},
				},
			},
			responses: { "200": { description: "Upsert result" } },
		},
	},
} as const
