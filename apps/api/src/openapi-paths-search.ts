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
 * search never reads as "no memories found" and a skipped KB vector lane
 * never reads as authoritative ranking.
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
			enum: ["denied", "legacy-fallback-skipped", "vector-lane-skipped"],
			description:
				"Which surface was degraded: the whole query was denied before any lane ran, the optional legacy re-run of an empty v2 verdict was denied, or the KB vector lane was skipped (text-lane results stand with degraded ranking).",
		},
		retryAfterMs: {
			type: "number",
			description: "Hint for when to retry (milliseconds).",
		},
	},
	description:
		"WS-12: set only when admission control degraded this answer; absent means the results are an authoritative retrieval verdict.",
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
						"Search results (with degradation marker when throttled)",
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
								},
							},
						},
					},
				},
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
										numCandidates: { type: "number" },
										fusionMethod: {
											type: "string",
											enum: ["scoreFusion", "rankFusion", "js-merge"],
										},
										hybridMode: {
											type: "string",
											enum: ["hybrid", "vector-only"],
										},
										allowHybridBackstop: { type: "boolean" },
										lexicalPrefilter: {
											type: "string",
											enum: ["disabled", "experimental"],
										},
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
													numCandidates: { type: "number" },
													fusionMethod: { type: "string" },
													hybridMode: { type: "string" },
													allowHybridBackstop: { type: "boolean" },
													lexicalPrefilter: { type: "string" },
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
											reranked: { type: "boolean" },
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
							properties: {
								agentId: { type: "string" },
								scope: {
									type: "string",
									enum: memoryScopeEnum,
								},
								scopeRef: {
									type: "string",
									description:
										"Optional scope reference used for tenant isolation.",
								},
								query: {
									type: "string",
									description:
										"Semantic recall query. Omit for filter-only conversation recall.",
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
													enum: ["filter", "semantic", "hybrid"],
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
												enum: ["standard", "semantic", "hybrid"],
											},
											durationMs: { type: "number" },
											throttled: {
												type: "object",
												required: ["retryAfterMs"],
												properties: {
													retryAfterMs: { type: "number" },
												},
												description:
													"WS-11: set when admission control denied the semantic recall pass — the empty results are throttling, not a retrieval verdict.",
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
									enum: ["scoreFusion", "rankFusion", "js-merge"],
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
						"KB results (with degradation marker when the vector lane was skipped)",
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
								},
							},
						},
					},
				},
			},
		},
	},
} as const
