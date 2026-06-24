/**
 * OpenAPI 3.0 document for the Memongo HTTP API.
 * Keep this aligned with the supported route contract in `routes/v1.ts`.
 */
const benchmarkOfficialRetrievalMetricsSchema = {
	type: "object",
	required: [
		"recallAnyAt1",
		"recallAllAt1",
		"ndcgAnyAt1",
		"recallAnyAt3",
		"recallAllAt3",
		"ndcgAnyAt3",
		"recallAnyAt5",
		"recallAllAt5",
		"ndcgAnyAt5",
		"recallAnyAt10",
		"recallAllAt10",
		"ndcgAnyAt10",
		"recallAnyAt30",
		"recallAllAt30",
		"ndcgAnyAt30",
		"recallAnyAt50",
		"recallAllAt50",
		"ndcgAnyAt50",
	],
	properties: {
		recallAnyAt1: { type: "number" },
		recallAllAt1: { type: "number" },
		ndcgAnyAt1: { type: "number" },
		recallAnyAt3: { type: "number" },
		recallAllAt3: { type: "number" },
		ndcgAnyAt3: { type: "number" },
		recallAnyAt5: { type: "number" },
		recallAllAt5: { type: "number" },
		ndcgAnyAt5: { type: "number" },
		recallAnyAt10: { type: "number" },
		recallAllAt10: { type: "number" },
		ndcgAnyAt10: { type: "number" },
		recallAnyAt30: { type: "number" },
		recallAllAt30: { type: "number" },
		ndcgAnyAt30: { type: "number" },
		recallAnyAt50: { type: "number" },
		recallAllAt50: { type: "number" },
		ndcgAnyAt50: { type: "number" },
	},
} as const

const benchmarkOfficialMetricsSchema = {
	type: "object",
	properties: {
		longMemEval: {
			type: "object",
			required: ["retrievalCases", "abstentionCases", "session"],
			properties: {
				retrievalCases: { type: "integer" },
				abstentionCases: { type: "integer" },
				session: benchmarkOfficialRetrievalMetricsSchema,
				turn: benchmarkOfficialRetrievalMetricsSchema,
			},
		},
		loCoMo: {
			type: "object",
			required: [
				"qaCases",
				"abstentionCases",
				"sessionEvidenceRecallAt5",
				"sessionEvidenceRecallAt10",
			],
			properties: {
				qaCases: { type: "integer" },
				abstentionCases: { type: "integer" },
				sessionEvidenceRecallAt5: { type: "number" },
				sessionEvidenceRecallAt10: { type: "number" },
				dialogEvidenceRecallAt5: { type: "number" },
				dialogEvidenceRecallAt10: { type: "number" },
			},
		},
	},
} as const

const benchmarkRunReportSchema = {
	type: "object",
	required: [
		"generatedAt",
		"build",
		"corpus",
		"metrics",
		"releaseGates",
		"warnings",
		"degradations",
	],
	properties: {
		generatedAt: { type: "string", format: "date-time" },
		build: {
			type: "object",
			required: ["source"],
			properties: {
				source: { type: "string", enum: ["env", "unknown"] },
				commitSha: { type: "string" },
				buildId: { type: "string" },
				buildLabel: { type: "string" },
			},
		},
		corpus: {
			type: "object",
			required: ["datasetVersion", "cases"],
			properties: {
				datasetVersion: { type: "string" },
				datasetName: { type: "string" },
				datasetKind: {
					type: "string",
					enum: ["generic", "longmemeval", "locomo", "legacy-query"],
				},
				scenarios: { type: "integer" },
				cases: { type: "integer" },
				scoredCases: { type: "integer" },
				skippedCases: { type: "integer" },
			},
		},
		metrics: {
			type: "object",
			required: ["internal"],
			properties: {
				internal: {
					type: "object",
					required: ["hitRate", "emptyRate", "avgTopScore", "p95LatencyMs"],
					properties: {
						hitRate: { type: "number" },
						emptyRate: { type: "number" },
						avgTopScore: { type: "number" },
						p95LatencyMs: { type: "number" },
						rAt5: { type: "number" },
						rAt10: { type: "number" },
						ndcgAt10: { type: "number" },
					},
				},
				official: benchmarkOfficialMetricsSchema,
			},
		},
		releaseGates: {
			type: "array",
			items: {
				type: "object",
				required: ["gate", "status", "evidence"],
				properties: {
					gate: {
						type: "string",
						enum: [
							"official-retrieval",
							"internal-retrieval",
							"conversation-recall-regression",
							"query-governance",
						],
					},
					status: {
						type: "string",
						enum: ["passed", "warning", "not-run", "advisory-only"],
					},
					evidence: { type: "string" },
				},
			},
		},
		warnings: { type: "array", items: { type: "string" } },
		degradations: { type: "array", items: { type: "string" } },
	},
} as const

const lifecycleSourceAgentSchema = {
	type: "object",
	required: ["id", "name"],
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		runId: { type: "string" },
	},
} as const

const actorRoleSchema = {
	type: "string",
	enum: ["user", "assistant", "system"],
} as const

const lifecycleStructuredHandleSchema = {
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
			enum: ["session", "user", "agent", "workspace", "tenant", "global"],
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

const lifecycleProcedureHandleSchema = {
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
			enum: ["session", "user", "agent", "workspace", "tenant", "global"],
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

const lifecycleHandleSchema = {
	oneOf: [lifecycleStructuredHandleSchema, lifecycleProcedureHandleSchema],
} as const

const structuredLifecyclePatchSchema = {
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

const procedureLifecyclePatchSchema = {
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

const lifecycleStructuredItemSchema = {
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

const lifecycleProcedureItemSchema = {
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

const lifecycleItemSchema = {
	oneOf: [lifecycleStructuredItemSchema, lifecycleProcedureItemSchema],
} as const

const lifecycleHistoryEntrySchema = {
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

export const openApiSpec = {
	openapi: "3.0.3",
	info: {
		title: "Memongo API",
		version: "1.0.0",
		description:
			"HTTP API for the Memongo memory platform. Configure it with MEMONGO_MONGODB_URI and, optionally, ~/.memongo/memongo.json.",
	},
	servers: [{ url: "/", description: "Default" }],
	paths: {
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
										enum: [
											"session",
											"user",
											"agent",
											"workspace",
											"tenant",
											"global",
										],
										description:
											"Optional memory isolation scope for retrieval.",
									},
									scopeRef: {
										type: "string",
										description:
											"Optional scope reference, for example a workspace path.",
									},
									containerTag: {
										type: "string",
										deprecated: true,
										description:
											"Deprecated compatibility alias for sessionKey.",
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
				responses: { "200": { description: "Search results" } },
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
										enum: [
											"session",
											"user",
											"agent",
											"workspace",
											"tenant",
											"global",
										],
										description:
											"Optional memory isolation scope for retrieval.",
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
										enum: [
											"session",
											"user",
											"agent",
											"workspace",
											"tenant",
											"global",
										],
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
										enum: [
											"session",
											"user",
											"agent",
											"workspace",
											"tenant",
											"global",
										],
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
										enum: [
											"session",
											"user",
											"agent",
											"workspace",
											"tenant",
											"global",
										],
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
							enum: [
								"session",
								"user",
								"agent",
								"workspace",
								"tenant",
								"global",
							],
						},
					},
					{
						name: "scopeRef",
						in: "query",
						schema: { type: "string" },
					},
				],
				responses: {
					"200": {
						description: "Unified state family for the requested scope",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										profile: {
											type: "object",
											description: "Profile synthesis payload from /v1/profile",
										},
										blocks: {
											type: "object",
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
										partial: { type: "boolean" },
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
														required: [
															"eventId",
															"role",
															"timestamp",
															"preview",
														],
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
										enum: [
											"session",
											"user",
											"agent",
											"workspace",
											"tenant",
											"global",
										],
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
											enum: ["generic", "longmemeval", "locomo"],
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
		"/v1/lifecycle/get": {
			post: {
				summary: "Fetch the current lifecycle item for a stable handle",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["handle"],
								properties: {
									handle: lifecycleHandleSchema,
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Lifecycle item",
						content: {
							"application/json": {
								schema: lifecycleItemSchema,
							},
						},
					},
					"400": { description: "Validation error" },
					"404": { description: "Not found" },
					"500": { description: "Lifecycle read failed" },
				},
			},
		},
		"/v1/lifecycle/update": {
			post: {
				summary: "Update a lifecycle item using a family-aware patch",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["handle", "patch"],
								properties: {
									handle: lifecycleHandleSchema,
									patch: {
										oneOf: [
											structuredLifecyclePatchSchema,
											procedureLifecyclePatchSchema,
										],
										description:
											"Patch shape must match the stable handle family.",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Updated lifecycle item",
						content: {
							"application/json": {
								schema: lifecycleItemSchema,
							},
						},
					},
					"400": { description: "Validation error" },
					"404": { description: "Not found" },
					"500": { description: "Lifecycle update failed" },
				},
			},
		},
		"/v1/lifecycle/delete": {
			post: {
				summary:
					"Delete a lifecycle item using invalidate-with-history semantics",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["handle"],
								properties: {
									handle: lifecycleHandleSchema,
									invalidatedBy: {
										type: "object",
										description:
											"Optional provenance describing why the item was invalidated.",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Invalidated lifecycle item",
						content: {
							"application/json": {
								schema: lifecycleItemSchema,
							},
						},
					},
					"400": { description: "Validation error" },
					"404": { description: "Not found" },
					"500": { description: "Lifecycle invalidation failed" },
				},
			},
		},
		"/v1/lifecycle/history": {
			post: {
				summary: "List lifecycle revision history for a stable handle",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["handle"],
								properties: {
									handle: lifecycleHandleSchema,
									limit: {
										type: "integer",
										minimum: 1,
										maximum: 200,
									},
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Ordered lifecycle history",
						content: {
							"application/json": {
								schema: {
									type: "array",
									items: lifecycleHistoryEntrySchema,
								},
							},
						},
					},
					"400": { description: "Validation error" },
					"404": { description: "Not found" },
					"500": { description: "Lifecycle history failed" },
				},
			},
		},
		"/v1/procedures/outcome": {
			post: {
				summary:
					"Record a success or failure outcome on a procedure using its stable handle",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["handle", "success"],
								properties: {
									handle: lifecycleProcedureHandleSchema,
									success: { type: "boolean" },
									note: { type: "string" },
									actorRole: actorRoleSchema,
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Updated procedure lifecycle item",
						content: {
							"application/json": {
								schema: lifecycleProcedureItemSchema,
							},
						},
					},
					"400": { description: "Validation error" },
					"404": { description: "Not found" },
					"500": { description: "Procedure outcome reporting failed" },
				},
			},
		},
		"/v1/memory/feedback": {
			post: {
				summary:
					"Apply structured memory feedback using stable handles without bypassing revision history",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								oneOf: [
									{
										type: "object",
										required: ["handle", "signal"],
										properties: {
											handle: lifecycleStructuredHandleSchema,
											signal: { type: "string", enum: ["confirm"] },
											note: { type: "string" },
											actorRole: actorRoleSchema,
										},
									},
									{
										type: "object",
										required: ["handle", "signal", "patch"],
										properties: {
											handle: lifecycleStructuredHandleSchema,
											signal: { type: "string", enum: ["correct"] },
											patch: structuredLifecyclePatchSchema,
											note: { type: "string" },
											actorRole: actorRoleSchema,
										},
									},
									{
										type: "object",
										required: ["handle", "signal"],
										properties: {
											handle: lifecycleStructuredHandleSchema,
											signal: { type: "string", enum: ["irrelevant"] },
											invalidatedBy: {
												type: "object",
												description:
													"Optional provenance describing why the memory was marked irrelevant.",
											},
											note: { type: "string" },
											actorRole: actorRoleSchema,
										},
									},
								],
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Updated structured lifecycle item",
						content: {
							"application/json": {
								schema: lifecycleStructuredItemSchema,
							},
						},
					},
					"400": { description: "Validation error" },
					"404": { description: "Not found" },
					"500": { description: "Memory feedback failed" },
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
									limit: { type: "number" },
									minScore: { type: "number" },
								},
							},
						},
					},
				},
				responses: { "200": { description: "KB results" } },
			},
		},
		"/v1/read-file": {
			post: {
				summary: "Read memory file or structured path",
				responses: { "200": { description: "File read result" } },
			},
		},
		"/v1/add": {
			post: {
				summary: "Append a user message to conversational memory",
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
										description:
											"Deprecated compatibility alias for sessionId.",
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
				responses: { "200": { description: "Event id" } },
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
				responses: { "200": { description: "Upsert result" } },
			},
		},
		"/v1/write-procedure": {
			post: {
				summary: "Upsert procedure",
				responses: { "200": { description: "Upsert result" } },
			},
		},
		"/v1/profile": {
			post: {
				summary: "Synthesize a profile for a scope",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									scope: {
										type: "string",
										enum: [
											"session",
											"user",
											"agent",
											"workspace",
											"tenant",
											"global",
										],
										description:
											"Optional scope for profile synthesis. Defaults to agent.",
									},
									scopeRef: {
										type: "string",
										description:
											"Optional scope reference for profile synthesis.",
									},
									containerTag: {
										type: "string",
										deprecated: true,
										description: "Deprecated compatibility alias for scopeRef.",
									},
									agentId: { type: "string" },
									maxEntities: { type: "number" },
									maxEpisodes: { type: "number" },
									maxPerType: { type: "number" },
									activityWindowMs: { type: "number" },
								},
							},
						},
					},
				},
				responses: { "200": { description: "Profile" } },
			},
		},
		"/v1/status": {
			get: {
				summary: "Memory provider status",
				responses: { "200": { description: "Status" } },
			},
		},
		"/v1/status/detailed": {
			get: {
				summary: "Detailed v2 status",
				responses: { "200": { description: "V2 status" } },
			},
		},
		"/v1/stats": {
			get: {
				summary: "Collection stats",
				responses: { "200": { description: "Stats" } },
			},
		},
		"/v1/sync": {
			post: {
				summary: "Sync workspace files to MongoDB",
				responses: { "200": { description: "Ok" } },
			},
		},
		"/v1/probes/embedding": {
			get: {
				summary: "Probe embedding availability",
				responses: { "200": { description: "Probe result" } },
			},
		},
		"/v1/probes/vector": {
			get: {
				summary: "Probe vector search availability",
				responses: { "200": { description: "{ ok: boolean }" } },
			},
		},
		"/v1/admin/relevance/explain": {
			post: {
				summary: "Relevance explain (diagnostic)",
				responses: { "200": { description: "Explain payload" } },
			},
		},
		"/v1/admin/relevance/benchmark": {
			post: {
				summary: "Relevance benchmark",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									agentId: { type: "string" },
									datasetPath: { type: "string", minLength: 1 },
									maxResults: { type: "integer", minimum: 1 },
									minScore: { type: "number", minimum: 0 },
								},
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Benchmark metrics",
						content: {
							"application/json": {
								schema: {
									type: "object",
									required: [
										"datasetVersion",
										"cases",
										"hitRate",
										"emptyRate",
										"avgTopScore",
										"p95LatencyMs",
										"regressions",
									],
									properties: {
										datasetVersion: { type: "string" },
										datasetName: { type: "string" },
										datasetKind: {
											type: "string",
											enum: [
												"generic",
												"longmemeval",
												"locomo",
												"legacy-query",
											],
										},
										scenarios: { type: "integer" },
										cases: { type: "integer" },
										scoredCases: { type: "integer" },
										skippedCases: { type: "integer" },
										hitRate: { type: "number" },
										emptyRate: { type: "number" },
										avgTopScore: { type: "number" },
										p95LatencyMs: { type: "number" },
										rAt5: { type: "number" },
										rAt10: { type: "number" },
										ndcgAt10: { type: "number" },
										questionTypeBreakdown: {
											type: "array",
											items: {
												type: "object",
												required: [
													"questionType",
													"cases",
													"scoredCases",
													"hitRate",
													"rAt5",
													"rAt10",
													"ndcgAt10",
												],
												properties: {
													questionType: { type: "string" },
													cases: { type: "integer" },
													scoredCases: { type: "integer" },
													hitRate: { type: "number" },
													rAt5: { type: "number" },
													rAt10: { type: "number" },
													ndcgAt10: { type: "number" },
												},
											},
										},
										officialMetrics: benchmarkOfficialMetricsSchema,
										ingest: {
											type: "object",
											properties: {
												conversationsIngested: { type: "integer" },
												turnsIngested: { type: "integer" },
												skippedConversations: { type: "integer" },
												failedLines: { type: "integer" },
												failedTurns: { type: "integer" },
											},
										},
										regressions: {
											type: "array",
											items: {
												type: "object",
												required: [
													"metricName",
													"baseline",
													"current",
													"delta",
													"severity",
												],
												properties: {
													metricName: { type: "string" },
													baseline: { type: "number" },
													current: { type: "number" },
													delta: { type: "number" },
													severity: {
														type: "string",
														enum: ["low", "medium", "high"],
													},
												},
											},
										},
										queryGovernance: {
											type: "object",
											properties: {
												status: {
													type: "string",
													enum: ["advisory-only"],
												},
												generatedAt: {
													type: "string",
													format: "date-time",
												},
												candidates: {
													type: "array",
													items: {
														type: "object",
														required: [
															"candidateId",
															"source",
															"queryShapeFamily",
															"scope",
															"reason",
															"evidence",
															"recommendedAction",
															"rollbackNote",
														],
														properties: {
															candidateId: { type: "string" },
															source: {
																type: "string",
																enum: ["benchmark", "operator-trace"],
															},
															queryShapeFamily: {
																type: "string",
																enum: ["search-detailed"],
															},
															recipe: { type: "string" },
															scope: {
																type: "string",
																enum: ["cluster"],
															},
															reason: { type: "string" },
															evidence: {
																type: "object",
																required: ["cases", "hitRate", "p95LatencyMs"],
																properties: {
																	datasetName: { type: "string" },
																	datasetKind: { type: "string" },
																	cases: { type: "integer" },
																	hitRate: { type: "number" },
																	p95LatencyMs: { type: "number" },
																	rAt5: { type: "number" },
																	ndcgAt10: { type: "number" },
																},
															},
															recommendedAction: {
																type: "string",
																enum: [
																	"inspect-query-stats",
																	"consider-setQuerySettings",
																],
															},
															rollbackNote: { type: "string" },
														},
													},
												},
												notes: {
													type: "array",
													items: { type: "string" },
												},
											},
										},
										benchmarkReport: benchmarkRunReportSchema,
									},
								},
							},
						},
					},
				},
			},
		},
		"/v1/admin/benchmarks/ingest": {
			post: {
				summary:
					"Replay a benchmark conversation dataset through writeConversationEvent()",
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
										enum: [
											"session",
											"user",
											"agent",
											"workspace",
											"tenant",
											"global",
										],
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
						description: "Benchmark ingest summary",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										datasetPath: { type: "string" },
										datasetName: { type: "string" },
										conversationsIngested: { type: "integer" },
										turnsIngested: { type: "integer" },
										skippedConversations: { type: "integer" },
										failedLines: { type: "integer" },
										failedTurns: { type: "integer" },
										startedAt: { type: "string", format: "date-time" },
										completedAt: { type: "string", format: "date-time" },
									},
								},
							},
						},
					},
				},
			},
		},
		"/v1/admin/relevance/report": {
			get: {
				summary: "Relevance report",
				responses: { "200": { description: "Report" } },
			},
		},
		"/v1/admin/relevance/sample-rate": {
			get: {
				summary: "Relevance sampling state",
				responses: { "200": { description: "Sample rate" } },
			},
		},
		"/v1/admin/access-trends": {
			get: {
				summary:
					"Rolling 7-day access trends from the access_events time series collection",
				parameters: [
					{ name: "agentId", in: "query", schema: { type: "string" } },
					{
						name: "collection",
						in: "query",
						schema: {
							type: "string",
							enum: [
								"events",
								"structured_mem",
								"procedures",
								"episodes",
								"entities",
								"relations",
							],
						},
					},
					{
						name: "memoryIds",
						in: "query",
						schema: {
							type: "string",
							description: "Comma-separated canonical memory ids",
						},
					},
					{
						name: "windowDays",
						in: "query",
						schema: { type: "integer", minimum: 1 },
					},
					{
						name: "limit",
						in: "query",
						schema: { type: "integer", minimum: 1, maximum: 100 },
					},
				],
				responses: { "200": { description: "Access trend points" } },
			},
		},
		"/v1/admin/traces": {
			get: {
				summary: "List recent recall traces",
				parameters: [
					{ name: "agentId", in: "query", schema: { type: "string" } },
					{
						name: "limit",
						in: "query",
						schema: { type: "integer", minimum: 1, maximum: 100 },
					},
				],
				responses: { "200": { description: "Recall trace list" } },
			},
		},
		"/v1/admin/traces/{traceId}": {
			get: {
				summary: "Get one recall trace by traceId",
				parameters: [
					{
						name: "traceId",
						in: "path",
						required: true,
						schema: { type: "string", minLength: 1 },
					},
					{ name: "agentId", in: "query", schema: { type: "string" } },
				],
				responses: {
					"200": { description: "Recall trace" },
					"404": { description: "Trace not found" },
				},
			},
		},
		"/v1/admin/access-summaries": {
			get: {
				summary:
					"Aggregate access counts and last-access timestamps from the access_events time series collection",
				parameters: [
					{ name: "agentId", in: "query", schema: { type: "string" } },
					{
						name: "collection",
						in: "query",
						required: true,
						schema: {
							type: "string",
							enum: [
								"events",
								"structured_mem",
								"procedures",
								"episodes",
								"entities",
								"relations",
							],
						},
					},
					{
						name: "memoryIds",
						in: "query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "windowDays",
						in: "query",
						schema: { type: "integer", minimum: 1 },
					},
				],
				responses: {
					"200": {
						description: "Access summaries",
						content: {
							"application/json": {
								schema: {
									type: "array",
									items: {
										type: "object",
										properties: {
											collection: { type: "string" },
											memoryId: { type: "string" },
											accessCount: { type: "integer" },
											lastAccessedAt: {
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
		},
		"/v1/jobs": {
			get: {
				summary: "List background memory jobs",
				parameters: [
					{ name: "agentId", in: "query", schema: { type: "string" } },
					{
						name: "status",
						in: "query",
						schema: {
							type: "string",
							enum: ["pending", "running", "completed", "failed", "cancelled"],
						},
					},
					{
						name: "jobType",
						in: "query",
						schema: {
							type: "string",
							enum: [
								"consolidation",
								"extraction",
								"import",
								"materialization",
								"enrichment",
							],
						},
					},
					{
						name: "limit",
						in: "query",
						schema: { type: "integer", minimum: 1, maximum: 100 },
					},
				],
				responses: { "200": { description: "Memory job list" } },
			},
		},
		"/v1/jobs/{jobId}": {
			get: {
				summary: "Get one background memory job by jobId",
				parameters: [
					{
						name: "jobId",
						in: "path",
						required: true,
						schema: { type: "string", minLength: 1 },
					},
					{ name: "agentId", in: "query", schema: { type: "string" } },
				],
				responses: {
					"200": { description: "Memory job" },
					"404": { description: "Job not found" },
				},
			},
		},
		"/v1/chain-trace": {
			post: {
				summary: "Trace reasoning chain for a fact",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["factId", "collection"],
								properties: {
									factId: {
										type: "string",
										description: "ID of the fact to trace.",
									},
									collection: {
										type: "string",
										description: "Collection containing the fact.",
									},
									agentId: { type: "string" },
									maxDepth: {
										type: "number",
										description: "Max graph traversal depth.",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "Chain trace result" },
					"400": { description: "Validation error" },
					"500": { description: "Chain trace failed" },
				},
			},
		},
		"/v1/novelty-scan": {
			post: {
				summary: "Scan for novel/surprising observations",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									agentId: { type: "string" },
									limit: {
										type: "number",
										description: "Max items to scan.",
									},
									scope: {
										type: "string",
										description: "Scope filter.",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "Novelty report" },
					"500": { description: "Novelty scan failed" },
				},
			},
		},
		"/v1/consolidate": {
			post: {
				summary: "Run Dreamer consolidation — extract facts from events",
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									agentId: { type: "string" },
									maxEvents: {
										type: "number",
										description: "Max events to process.",
									},
									minCombinedScore: {
										type: "number",
										description: "Minimum combined score threshold.",
									},
									scope: {
										type: "string",
										description: "Scope filter.",
									},
								},
							},
						},
					},
				},
				responses: {
					"200": { description: "Consolidation result" },
					"500": { description: "Consolidation failed" },
				},
			},
		},
	},
	components: {
		schemas: {
			ApiError: {
				type: "object",
				required: ["error"],
				properties: {
					error: {
						type: "object",
						required: ["code", "message"],
						properties: {
							code: { type: "string" },
							message: { type: "string" },
						},
					},
				},
			},
		},
	},
} as const
