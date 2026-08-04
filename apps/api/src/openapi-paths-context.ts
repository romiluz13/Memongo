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
			responses: { "200": { description: "File read result" } },
		},
	},
} as const
