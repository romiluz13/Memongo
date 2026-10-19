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
import { AGENT_ID_FIELD_DESCRIPTION } from "@memongo/lib"
import {
	searchFailureResponses,
	searchLaneOutcomeSchema,
	searchOutcomeStatusSchema,
} from "./openapi-paths-search.js"
import { memoryScopeEnum } from "./openapi-schemas.js"

/**
 * M2 T8 (#117): one typed row per failed section of a slate, brief or
 * bundle. Enum values only; no query text, document text or driver message.
 * A section that failed is a row here, never an empty section.
 */
const sectionFailuresSchema = {
	type: "array",
	description:
		"Typed rows for the sections that failed or were budget-denied while the rest answered. Empty when every planned section answered. If every planned section fails the call is a non-2xx instead.",
	items: {
		type: "object",
		required: ["section", "stage", "outcome", "reason"],
		properties: {
			section: {
				type: "string",
				description:
					"Section name; nested rows are named parent:child (for example active-slate:procedures).",
			},
			stage: searchLaneOutcomeSchema.properties.stage,
			outcome: { type: "string", enum: ["failed", "budget-denied"] },
			reason: searchLaneOutcomeSchema.properties.reason,
		},
	},
} as const

export const contextPaths = {
	"/v1/hydrate-active-slate": {
		post: {
			summary:
				"Hydrate a tiny active-memory slate for recall-heavy turns and debugging surfaces",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {
								agentId: { type: "string" },
								scope: {
									type: "string",
									enum: memoryScopeEnum,
								},
								scopeRef: { type: "string" },
								maxItems: {
									type: "number",
									description: "Requested slate size. Clamped to 6 items.",
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Tiny active-memory slate",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									agentId: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									items: {
										type: "array",
										items: {
											type: "object",
											properties: {
												kind: { type: "string" },
												source: { type: "string" },
												title: { type: "string" },
												summary: { type: "string" },
												path: { type: "string" },
												canonicalId: { type: "string" },
												timestamp: { type: "string", format: "date-time" },
												scope: { type: "string" },
												scopeRef: { type: "string" },
											},
										},
									},
									metadata: {
										type: "object",
										properties: {
											maxItems: { type: "number" },
											truncated: { type: "boolean" },
											partial: { type: "boolean" },
											failures: sectionFailuresSchema,
											countsByKind: {
												type: "object",
												additionalProperties: { type: "number" },
											},
											sourceCounts: {
												type: "object",
												additionalProperties: { type: "number" },
											},
										},
									},
									hydratedAt: { type: "string", format: "date-time" },
								},
							},
						},
					},
				},
				...searchFailureResponses,
			},
		},
	},
	"/v1/discovery-projection": {
		post: {
			summary:
				"Build a rebuildable discovery projection such as an entity brief, topic brief, what-changed brief, or contradiction report",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["kind"],
							properties: {
								agentId: { type: "string" },
								kind: {
									type: "string",
									enum: [
										"entity-brief",
										"topic-brief",
										"what-changed",
										"contradiction-report",
									],
								},
								query: { type: "string" },
								scope: {
									type: "string",
									enum: memoryScopeEnum,
								},
								scopeRef: { type: "string" },
								maxItems: { type: "number" },
								timeRange: {
									type: "object",
									properties: {
										preset: { type: "string" },
										start: { type: "string", format: "date-time" },
										end: { type: "string", format: "date-time" },
									},
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Discovery projection with provenance-backed sections",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									kind: { type: "string" },
									query: { type: "string" },
									title: { type: "string" },
									summary: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									sections: {
										type: "array",
										items: {
											type: "object",
											properties: {
												title: { type: "string" },
												summary: { type: "string" },
												evidence: {
													type: "array",
													items: {
														type: "object",
														properties: {
															title: { type: "string" },
															summary: { type: "string" },
															path: { type: "string" },
															source: { type: "string" },
															canonicalId: { type: "string" },
															timestamp: {
																type: "string",
																format: "date-time",
															},
														},
													},
												},
											},
										},
									},
									metadata: {
										type: "object",
										properties: {
											partial: { type: "boolean" },
											failures: sectionFailuresSchema,
											evidenceCount: { type: "number" },
											sourceCounts: {
												type: "object",
												additionalProperties: { type: "number" },
											},
											timeRange: {
												type: "object",
												properties: {
													label: { type: "string" },
													start: {
														type: "string",
														format: "date-time",
													},
													end: {
														type: "string",
														format: "date-time",
													},
												},
											},
										},
									},
									builtAt: { type: "string", format: "date-time" },
								},
							},
						},
					},
				},
				...searchFailureResponses,
			},
		},
	},
	"/v1/context-bundle": {
		post: {
			summary:
				"Build a prompt-ready context bundle from active memory, durable evidence, summaries, and recent events",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {
								agentId: { type: "string" },
								query: { type: "string" },
								scope: {
									type: "string",
									enum: memoryScopeEnum,
								},
								scopeRef: { type: "string" },
								sessionId: { type: "string" },
								tokenBudget: { type: "number" },
								maxActiveItems: { type: "number" },
								maxEvidenceItems: { type: "number" },
								maxRecentEvents: { type: "number" },
								includeDiscoveryProjection: { type: "boolean" },
								discoveryKind: {
									type: "string",
									enum: [
										"entity-brief",
										"topic-brief",
										"what-changed",
										"contradiction-report",
									],
								},
								includeProfile: { type: "boolean" },
								timeRange: {
									type: "object",
									properties: {
										preset: { type: "string" },
										start: { type: "string", format: "date-time" },
										end: { type: "string", format: "date-time" },
									},
								},
								mode: {
									type: "string",
									enum: ["full", "wake-up"],
									description:
										"wake-up returns a compact session-start projection and skips query evidence",
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Prompt-ready context bundle with structured sections",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									agentId: { type: "string" },
									query: { type: "string" },
									scope: { type: "string" },
									scopeRef: { type: "string" },
									sessionId: { type: "string" },
									rendered: { type: "string" },
									sections: {
										type: "array",
										items: {
											type: "object",
											properties: {
												kind: { type: "string" },
												title: { type: "string" },
												summary: { type: "string" },
												items: {
													type: "array",
													items: {
														type: "object",
														properties: {
															title: { type: "string" },
															summary: { type: "string" },
															path: { type: "string" },
															source: { type: "string" },
															canonicalId: { type: "string" },
															timestamp: {
																type: "string",
																format: "date-time",
															},
															scope: { type: "string" },
															scopeRef: { type: "string" },
															sourceEventIds: {
																type: "array",
																items: { type: "string" },
															},
														},
													},
												},
												estimatedTokens: { type: "number" },
												truncated: { type: "boolean" },
												partial: { type: "boolean" },
											},
										},
									},
									metadata: {
										type: "object",
										properties: {
											tokenBudget: { type: "number" },
											estimatedTokensUsed: { type: "number" },
											partial: { type: "boolean" },
											failures: sectionFailuresSchema,
											laneOutcomes: {
												type: "array",
												description:
													"X-09: the query-evidence search lane outcomes, kept through the bundle.",
												items: searchLaneOutcomeSchema,
											},
											outcomeStatus: searchOutcomeStatusSchema,
											throttled: {
												type: "object",
												properties: { retryAfterMs: { type: "number" } },
												description:
													"Present when admission control denied the query-evidence search; also reported as a budget-denied failure row.",
											},
											truncated: { type: "boolean" },
											pathsExecuted: {
												type: "array",
												items: { type: "string" },
											},
											sectionsIncluded: {
												type: "array",
												items: { type: "string" },
											},
										},
									},
									builtAt: { type: "string", format: "date-time" },
								},
							},
						},
					},
				},
				...searchFailureResponses,
			},
		},
	},
	"/v1/state": {
		get: {
			summary: "Get the unified state family (profile, blocks, bundle)",
			parameters: [
				{
					name: "agentId",
					in: "query",
					schema: { type: "string" },
				},
				{
					name: "scope",
					in: "query",
					schema: {
						type: "string",
						enum: memoryScopeEnum,
					},
				},
				{
					name: "scopeRef",
					in: "query",
					schema: { type: "string" },
				},
			],
			responses: {
				"503": {
					description:
						"All unified state reads failed with supported dependency-unavailable errors",
				},
				"200": {
					description: "Unified state family for the requested scope",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									profile: {
										type: "object",
										description:
											"Profile synthesis payload from /v1/profile. Absent when its read failed.",
									},
									blocks: {
										type: "object",
										description: "Absent when the active slate read failed.",
										properties: {
											blocks: {
												type: "array",
												items: {
													type: "object",
													properties: {
														label: { type: "string" },
														title: { type: "string" },
														content: { type: "string" },
														tokenBudget: { type: "number" },
														actualTokens: { type: "number" },
														sourcePaths: {
															type: "array",
															items: { type: "string" },
														},
													},
												},
											},
											totalTokenBudget: { type: "number" },
											totalActualTokens: { type: "number" },
										},
									},
									bundle: {
										type: "object",
										description:
											"Context bundle payload from /v1/context-bundle",
									},
									partial: {
										type: "boolean",
										description:
											"True when at least one section could not be read. The unreadable sections are absent and named in failures.",
									},
									failures: {
										type: "array",
										description:
											"One row per unreadable section (profile, blocks or bundle) with a typed reason. Present only with partial.",
										items: {
											type: "object",
											properties: {
												section: {
													type: "string",
													enum: ["profile", "blocks", "bundle"],
												},
												reason: {
													type: "string",
													enum: [
														"lane-unavailable",
														"index-missing",
														"index-not-ready",
														"index-stale",
														"index-unavailable",
														"query-timeout",
														"dependency-unavailable",
														"query-error",
														"internal-error",
														"erasure-in-progress",
													],
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	},
	"/v1/read-file": {
		post: {
			summary: "Read memory file or structured path",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["relPath"],
							properties: {
								relPath: { type: "string", minLength: 1 },
								agentId: {
									type: "string",
									description: AGENT_ID_FIELD_DESCRIPTION,
								},
								from: { type: "number" },
								lines: { type: "number" },
							},
						},
					},
				},
			},
			responses: {
				"200": { description: "File read result" },
				"409": {
					description:
						"ERASURE_IN_PROGRESS: an erasure is in progress for the agent, so the read is refused rather than answered with an empty miss. Retry after the erasure finishes.",
				},
			},
		},
	},
} as const
