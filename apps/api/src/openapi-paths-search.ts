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
import { memoryScopeEnum } from "./openapi-schemas.js"

/**
 * WS-12 (C-019): degradation marker on search responses. Present exactly
 * when the answer is degraded rather than authoritative, so a throttled
 * search never reads as "no memories found".
 */
const searchDegradationSchema = {
	type: "object",
	required: ["kind", "scope", "retryAfterMs"],
	properties: {
		kind: {
			type: "string",
			enum: ["throttled"],
			description: "The answer is degraded by admission control.",
		},
		scope: {
			type: "string",
			enum: ["denied"],
			description:
				"Which surface was degraded: the whole query was denied before any lane ran, so the empty results are not a retrieval verdict.",
		},
		retryAfterMs: {
			type: "number",
			description: "Hint for when to retry (milliseconds).",
		},
	},
	description:
		"WS-12: set only when admission control degraded this answer; absent means the results are an authoritative retrieval verdict.",
}

/**
 * #101 / decision 16: the value-free outcome vocabulary of a search call
 * (enum values only; no query, body or provider text).
 */
export const searchOutcomeStatusSchema = {
	type: "string",
	enum: ["complete", "partial", "failed"],
	description:
		"complete: no lane failed or was budget-denied. partial: some lanes failed or were denied and the rest answered (200, even with zero results). failed: no required lane answered (served as a non-2xx).",
}

export const searchLaneOutcomeSchema = {
	type: "object",
	required: ["lane", "stage", "outcome"],
	properties: {
		lane: {
			type: "string",
			description:
				"Retrieval lane, tier owner or phase (e.g. structured, procedural, hybrid:chunks, kb, conversation-evidence, backstop:hybrid, search).",
		},
		stage: {
			type: "string",
			description:
				"Stage inside the lane (e.g. lane, index-health, vector, atlas-search, classic-text, score-fusion, reservation, explain). An index-health row is an admission-time metadata check, reported separately from retrieval work; its reason is index-stale or index-unavailable. Explain rows are diagnostics and never change the status.",
		},
		outcome: {
			type: "string",
			enum: ["ok", "ok-empty", "not-applicable", "failed", "budget-denied"],
		},
		reason: {
			type: "string",
			enum: [
				"zero-hits",
				"not-planned",
				"capability-absent",
				"query-shape",
				"no-candidates",
				"mode-disabled",
				"source-disabled",
				"empty-query",
				"lane-unavailable",
				"index-missing",
				"index-not-ready",
				"index-stale",
				"index-unavailable",
				"query-timeout",
				"dependency-unavailable",
				"query-error",
				"internal-error",
				"rerank-unsupported",
				"budget-aggregations",
				"budget-embeds",
				"budget-deadline",
				"budget-reservation",
			],
		},
		resultCount: { type: "integer" },
		pass: {
			type: "integer",
			description: "Retrieval pass index (search-detailed only).",
		},
	},
}

export const searchOutcomesSchema = {
	type: "object",
	required: ["status", "lanes"],
	properties: {
		status: searchOutcomeStatusSchema,
		lanes: { type: "array", items: searchLaneOutcomeSchema },
	},
	description:
		"#101: this call's outcome summary. A throttled search is a failed call (503 SEARCH_BUDGET_EXHAUSTED) whose body carries it with a budget-denied row.",
}

/**
 * #101 / resolution R3: the non-2xx search failures. The body is the ApiError
 * envelope plus `outcomes` (status "failed" and every row).
 */
const RERANKED_DESCRIPTION =
	"Always false: there is no reranker. The HTTP reranker was removed and native $rerank (Atlas only) is not implemented yet."

export const searchFailureResponses = {
	"409": {
		description:
			"ERASURE_IN_PROGRESS: an erasure is in progress for the agent, so the read is refused rather than answered with an empty result. For /v1/search-kb this also covers an erasure that began while the search ran: its chunks are never returned. Retry after the erasure finishes.",
	},
	"500": {
		description:
			"SEARCH_LANES_FAILED: every required lane failed and at least one failure is a defect (query-error or internal-error); this wins over the 503 codes. The body adds `outcomes` (status failed, every row). Other unexpected failures keep their route's internal error code.",
	},
	"503": {
		description:
			"SEARCH_LANES_UNAVAILABLE: every required lane failed with a retryable reason (lane-unavailable, index-missing, index-not-ready, index-stale, index-unavailable, query-timeout, dependency-unavailable); it wins over budget. SEARCH_BUDGET_EXHAUSTED: every failure is a search budget denial; an admission-bucket denial also sets the Retry-After header (whole seconds, from the denial's retry hint), and a per-request budget denial sets none. The body adds `outcomes` (status failed, every row). SERVICE_UNAVAILABLE: the database is unreachable.",
		headers: {
			"Retry-After": {
				description:
					"Seconds until the admission bucket refills. Set only on SEARCH_BUDGET_EXHAUSTED responses caused by an admission-bucket denial.",
				schema: { type: "integer", minimum: 1 },
			},
		},
	},
}

export const searchPaths = {
	"/health": {
		get: {
			summary: "Health check",
			responses: { "200": { description: "OK" } },
		},
	},
	"/openapi.json": {
		get: {
			summary: "OpenAPI document",
			responses: { "200": { description: "OpenAPI JSON" } },
		},
	},
	"/v1/search": {
		post: {
			summary: "Search memory",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["query"],
							properties: {
								query: { type: "string" },
								limit: { type: "number" },
								agentId: { type: "string" },
								minScore: { type: "number" },
								sessionKey: {
									type: "string",
									description:
										"Optional session scope for conversational retrieval.",
								},
								scope: {
									type: "string",
									enum: memoryScopeEnum,
									description: "Optional memory isolation scope for retrieval.",
								},
								scopeRef: {
									type: "string",
									description:
										"Optional scope reference, for example a workspace path.",
								},
								containerTag: {
									type: "string",
									deprecated: true,
									description: "Deprecated compatibility alias for sessionKey.",
								},
								maxResults: {
									type: "number",
									deprecated: true,
									description: "Deprecated compatibility alias for limit.",
								},
								q: {
									type: "string",
									deprecated: true,
									description: "Deprecated compatibility alias for query.",
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description:
						"Search results (with degradation marker when throttled). A partial answer is a 200 with outcomes.status partial, even with zero results.",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									results: {
										type: "array",
										items: { type: "object" },
									},
									degradation: searchDegradationSchema,
									outcomes: searchOutcomesSchema,
								},
							},
						},
					},
				},
				...searchFailureResponses,
			},
		},
	},
	"/v1/search-detailed": {
		post: {
			summary:
				"Advanced search with CRAG corrective retrieval, MMR diversity, constraint relaxation, and multi-source fusion",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["query"],
							properties: {
								query: { type: "string" },
								scope: {
									type: "string",
									enum: memoryScopeEnum,
									description: "Optional memory isolation scope for retrieval.",
								},
								scopeRef: {
									type: "string",
									description:
										"Optional scope reference, for example a workspace path.",
								},
								limit: {
									type: "number",
									description: "Maximum results to return.",
								},
								searchMode: {
									type: "string",
									enum: ["auto", "direct", "agentic"],
									description:
										"Search mode. 'auto' lets the engine classify; 'direct' skips multi-pass; 'agentic' enables full CRAG pipeline.",
								},
								sourcePreference: {
									type: "array",
									items: { type: "string" },
									description:
										"Ordered list of preferred retrieval sources (e.g. conversation, structured, kb, procedural).",
								},
								timeRange: {
									type: "object",
									properties: {
										preset: { type: "string" },
										start: {
											type: "string",
											format: "date-time",
										},
										end: {
											type: "string",
											format: "date-time",
										},
									},
									description:
										"Time range filter (preset name or explicit start/end).",
								},
								needExactEvidence: {
									type: "boolean",
									description:
										"When true, CRAG enforces stricter evidence coverage thresholds.",
								},
								maxPasses: {
									type: "number",
									description:
										"Maximum number of retrieval passes for multi-pass orchestration.",
								},
								returnPlan: {
									type: "boolean",
									description:
										"When true, include the retrieval plan in the response metadata.",
								},
								conversationScope: {
									type: "object",
									properties: {
										sessionKey: { type: "string" },
									},
									description:
										"Scope conversation retrieval to a specific session.",
								},
								structuredScope: {
									type: "object",
									description: "Scope structured memory retrieval.",
								},
								referenceScope: {
									type: "object",
									description: "Scope reference/KB retrieval.",
								},
								proceduralScope: {
									type: "object",
									description: "Scope procedural memory retrieval.",
								},
								searchConfig: {
									type: "object",
									description:
										"Named search recipe plus optional execution overrides. Top-level request fields override recipe defaults.",
									properties: {
										recipe: {
											type: "string",
											enum: [
												"fast",
												"hybrid",
												"deep",
												"temporal",
												"chain-of-thought",
											],
										},
										recallProfile: {
											type: "string",
											enum: ["latency", "balanced", "proof"],
										},
										maxResults: { type: "number" },
										searchMode: {
											type: "string",
											enum: ["auto", "direct", "agentic"],
										},
										maxPasses: { type: "number" },
										sourcePreference: {
											type: "array",
											items: { type: "string" },
										},
										timeRange: {
											type: "object",
											properties: {
												preset: { type: "string" },
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
										needExactEvidence: { type: "boolean" },
										rerank: {
											type: "boolean",
											description:
												"A demand for a rerank stage. M2 has none: true is rejected with 400 RERANK_UNSUPPORTED (rerank-unsupported); false is accepted. Native $rerank (Atlas only) is not implemented yet.",
										},
										allowConstraintRelaxation: {
											type: "boolean",
											description:
												"Opt-in for the constraint-relaxation fallback: without it, explicit constraints (timeRange, needExactEvidence) stay hard and an empty constrained answer stays empty.",
										},
										numCandidates: { type: "number" },
										fusionMethod: {
											type: "string",
											enum: ["scoreFusion", "rankFusion"],
										},
										hybridMode: {
											type: "string",
											enum: ["hybrid", "vector-only"],
										},
										allowHybridBackstop: { type: "boolean" },
									},
								},
								maxResults: {
									type: "number",
									deprecated: true,
									description: "Deprecated compatibility alias for limit.",
								},
								minScore: {
									type: "number",
									description: "Minimum relevance score threshold.",
								},
								agentId: { type: "string" },
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Detailed search results with metadata",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									results: {
										type: "array",
										items: {
											type: "object",
											properties: {
												path: { type: "string" },
												startLine: { type: "integer" },
												endLine: { type: "integer" },
												filePath: { type: "string" },
												snippet: { type: "string" },
												score: { type: "number" },
												source: { type: "string" },
												canonicalId: { type: "string" },
												sessionId: { type: "string" },
												timestamp: {
													type: "string",
													format: "date-time",
												},
												scope: { type: "string" },
												scopeRef: { type: "string" },
												state: { type: "string" },
												provenance: { type: "object" },
												sourceEventIds: {
													type: "array",
													items: { type: "string" },
												},
												sourceReliability: { type: "number" },
												reinforcementCount: { type: "number" },
												validFrom: {
													type: "string",
													format: "date-time",
												},
												validTo: {
													type: "string",
													format: "date-time",
												},
												reviewAt: {
													type: "string",
													format: "date-time",
												},
												lastConfirmedAt: {
													type: "string",
													format: "date-time",
												},
												trust: {
													type: "object",
													properties: {
														score: { type: "number" },
														confidence: { type: "string" },
														exactness: { type: "string" },
														freshness: { type: "string" },
														contradiction: { type: "string" },
														scopeMatch: { type: "string" },
														provenance: { type: "string" },
														sourceDiversity: { type: "string" },
														factors: {
															type: "array",
															items: { type: "string" },
														},
													},
												},
											},
										},
									},
									metadata: {
										type: "object",
										properties: {
											mode: { type: "string" },
											classification: { type: "string" },
											sourceOrder: {
												type: "array",
												items: { type: "string" },
											},
											resolvedSearchConfig: {
												type: "object",
												properties: {
													recipe: { type: "string" },
													recallProfile: { type: "string" },
													maxResults: { type: "number" },
													searchMode: { type: "string" },
													maxPasses: { type: "number" },
													sourcePreference: {
														type: "array",
														items: { type: "string" },
													},
													timeRange: {
														type: "object",
														properties: {
															preset: { type: "string" },
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
													needExactEvidence: { type: "boolean" },
													allowConstraintRelaxation: {
														type: "boolean",
													},
													numCandidates: { type: "number" },
													fusionMethod: { type: "string" },
													hybridMode: { type: "string" },
													allowHybridBackstop: { type: "boolean" },
												},
											},
											passes: {
												type: "array",
												items: {
													type: "object",
													properties: {
														pass: { type: "integer" },
														query: { type: "string" },
														reason: { type: "string" },
														pathsExecuted: {
															type: "array",
															items: {
																type: "string",
															},
														},
														resultCount: {
															type: "integer",
														},
														queryRewritten: {
															type: "boolean",
														},
														reranked: {
															type: "boolean",
															description: RERANKED_DESCRIPTION,
														},
														correctionApplied: {
															type: "string",
														},
													},
												},
											},
											queriesTried: {
												type: "array",
												items: { type: "string" },
											},
											constraintsApplied: {
												type: "array",
												items: { type: "string" },
											},
											resultsRejected: {
												type: "array",
												items: {
													type: "object",
													required: ["reason"],
													properties: {
														canonicalId: { type: "string" },
														path: { type: "string" },
														source: { type: "string" },
														reason: { type: "string" },
													},
												},
											},
											evidenceCoverage: { type: "string" },
											pathsExecuted: {
												type: "array",
												items: { type: "string" },
											},
											resultsByPath: {
												type: "object",
												additionalProperties: { type: "number" },
											},
											queryRewritten: { type: "boolean" },
											reranked: {
												type: "boolean",
												description: RERANKED_DESCRIPTION,
											},
											noDirectEvidenceReason: { type: "string" },
											constraintRelaxations: {
												type: "array",
												items: {
													type: "object",
													properties: {
														constraint: { type: "string" },
														action: { type: "string" },
													},
												},
											},
											mmrApplied: { type: "boolean" },
											mmrLambda: { type: "number" },
											throttled: {
												type: "object",
												required: ["retryAfterMs"],
												properties: {
													retryAfterMs: { type: "number" },
												},
												description:
													"WS-11: set when admission control denied a pass — the empty results are throttling, not a retrieval verdict.",
											},
											laneOutcomes: {
												type: "array",
												items: searchLaneOutcomeSchema,
												description:
													"#101: value-free outcome rows across every pass.",
											},
											outcomeStatus: searchOutcomeStatusSchema,
											trustSummary: {
												type: "object",
												properties: {
													topScore: { type: "number" },
													topConfidence: { type: "string" },
													averageScore: { type: "number" },
													distribution: {
														type: "object",
														additionalProperties: { type: "number" },
													},
													contradictionCount: { type: "number" },
													staleCount: { type: "number" },
													exactCount: { type: "number" },
													sourceDiversity: { type: "string" },
												},
											},
											plan: { type: "object" },
										},
									},
								},
							},
						},
					},
				},
				"400": {
					description:
						"VALIDATION_ERROR: a malformed request. RERANK_UNSUPPORTED: searchConfig.rerank was true; there is no reranker, so the request fails instead of returning unreranked results.",
				},
				...searchFailureResponses,
			},
		},
	},
	"/v1/recall-conversation": {
		post: {
			summary:
				"Recall prior conversation events by content, session, role, and exact time range",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["scope", "scopeRef"],
							properties: {
								agentId: { type: "string" },
								scope: {
									type: "string",
									enum: memoryScopeEnum,
								},
								scopeRef: {
									type: "string",
									description:
										"Scope reference of the tenant whose conversation is recalled. Required: a recall without scope and scopeRef is refused rather than widened to the agent.",
								},
								query: {
									type: "string",
									description:
										"Recall query, run as one hybrid ($rankFusion) lane. Omit for a filter-only chronological listing.",
								},
								sessionId: {
									type: "string",
									description: "Restrict recall to one conversation session.",
								},
								roles: {
									type: "array",
									items: {
										type: "string",
										enum: ["user", "assistant", "system", "tool"],
									},
									description:
										"Filter to specific message roles. Overrides includeToolMessages when present.",
								},
								startTime: {
									type: "string",
									description:
										"Inclusive start boundary. Use ISO 8601 (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ssZ`).",
								},
								endTime: {
									type: "string",
									description:
										"Inclusive end boundary. Use ISO 8601 (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ssZ`).",
								},
								asOf: {
									type: "string",
									format: "date-time",
									description:
										"Evaluate event validity at this historical instant. Defaults to now.",
								},
								timezone: {
									type: "string",
									description:
										"IANA timezone used only when startTime/endTime are date-only strings.",
								},
								includeToolMessages: {
									type: "boolean",
									description: "Include `tool` role messages. Default false.",
								},
								limit: {
									type: "integer",
									minimum: 1,
									maximum: 200,
									description: "Maximum results to return.",
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Conversation recall results with canonical citations",
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["results", "metadata"],
								properties: {
									results: {
										type: "array",
										items: {
											type: "object",
											required: ["citation", "matchType"],
											properties: {
												citation: {
													type: "object",
													required: ["eventId", "role", "timestamp", "preview"],
													properties: {
														eventId: { type: "string" },
														sessionId: { type: "string" },
														role: {
															type: "string",
															enum: ["user", "assistant", "system", "tool"],
														},
														timestamp: {
															type: "string",
															format: "date-time",
														},
														sourceRef: { type: "string" },
														preview: { type: "string" },
													},
												},
												score: { type: "number" },
												matchType: {
													type: "string",
													enum: ["filter", "hybrid"],
												},
											},
										},
									},
									metadata: {
										type: "object",
										required: [
											"totalMatched",
											"filtersApplied",
											"searchMethod",
											"durationMs",
										],
										properties: {
											totalMatched: { type: "integer" },
											queryUsed: { type: "string" },
											filtersApplied: {
												type: "array",
												items: { type: "string" },
											},
											searchMethod: {
												type: "string",
												enum: ["standard", "hybrid"],
											},
											durationMs: { type: "number" },
										},
									},
								},
							},
						},
					},
				},
				"400": {
					description:
						"VALIDATION_ERROR: invalid input, including an invalid timezone (never replaced by UTC).",
				},
				...searchFailureResponses,
			},
		},
	},
	"/v1/import/conversations": {
		post: {
			summary:
				"Import conversation history through the canonical writeConversationEvent() pipeline",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["datasetPath"],
							properties: {
								agentId: { type: "string" },
								datasetPath: { type: "string", minLength: 1 },
								scope: {
									type: "string",
									enum: memoryScopeEnum,
								},
								scopeRef: {
									type: "string",
									description:
										"Optional scope reference applied to every imported turn.",
								},
								limitConversations: { type: "integer", minimum: 1 },
								limitTurnsPerConversation: {
									type: "integer",
									minimum: 1,
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description: "Conversation import summary",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									datasetPath: { type: "string" },
									datasetName: { type: "string" },
									datasetKind: {
										type: "string",
										enum: ["generic"],
									},
									conversationsImported: { type: "integer" },
									turnsImported: { type: "integer" },
									skippedConversations: { type: "integer" },
									failedLines: { type: "integer" },
									failedTurns: { type: "integer" },
									rejectedTurns: { type: "integer" },
									rejectedConversations: { type: "integer" },
									rejections: {
										type: "array",
										items: {
											type: "object",
											required: [
												"line",
												"conversationIndex",
												"turnIndex",
												"reason",
											],
											properties: {
												line: { type: "integer", nullable: true },
												conversationIndex: { type: "integer" },
												turnIndex: { type: "integer", nullable: true },
												reason: {
													type: "string",
													enum: [
														"conversation-not-object",
														"turns-not-array",
														"no-valid-turns",
														"turn-not-object",
														"invalid-role",
														"empty-body",
														"invalid-timestamp",
													],
												},
											},
										},
									},
									startedAt: {
										type: "string",
										format: "date-time",
									},
									completedAt: {
										type: "string",
										format: "date-time",
									},
								},
							},
						},
					},
				},
			},
		},
	},
	"/v1/search-kb": {
		post: {
			summary: "Search imported knowledge base documents",
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["query"],
							properties: {
								query: { type: "string" },
								agentId: {
									type: "string",
									description: AGENT_ID_FIELD_DESCRIPTION,
								},
								scopeRef: {
									type: "string",
									description:
										"Restrict results to this KB scope reference (for example a workspace path). Defaults to the agent KB scope.",
								},
								limit: { type: "number" },
								minScore: { type: "number" },
								filter: {
									type: "object",
									description:
										"Optional KB metadata filter (typed fields only; query-operator keys are rejected).",
									properties: {
										tags: {
											type: "array",
											items: { type: "string" },
										},
										category: { type: "string" },
										source: { type: "string" },
									},
								},
								fusionMethod: {
									type: "string",
									enum: ["scoreFusion", "rankFusion"],
									description: "Server-side fusion preference for the KB lane.",
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description:
						"KB results. A partial answer is a 200 with outcomes.status partial, even with zero results.",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									results: {
										type: "array",
										items: { type: "object" },
									},
									outcomes: searchOutcomesSchema,
								},
							},
						},
					},
				},
				...searchFailureResponses,
			},
		},
	},
} as const
