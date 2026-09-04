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

export const maintenancePaths = {
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
								resolveContradictions: {
									type: "boolean",
									description:
										"Whether consolidation resolves contradictory facts. Defaults to true.",
								},
								llmDedup: {
									type: "boolean",
									description:
										"Whether consolidation uses LLM-assisted deduplication. Defaults to false.",
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
	"/v1/self-edit": {
		post: {
			summary: "Directly edit a core memory block (user/persona/instructions)",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["block", "content"],
							properties: {
								block: {
									type: "string",
									enum: ["user", "persona", "instructions"],
									description: "Core memory block to edit.",
								},
								action: {
									type: "string",
									enum: ["append", "replace", "prepend"],
									description: "Edit action; defaults to replace when omitted.",
								},
								content: { type: "string", minLength: 1 },
								agentId: {
									type: "string",
									description: AGENT_ID_FIELD_DESCRIPTION,
								},
							},
						},
					},
				},
			},
			responses: {
				"200": { description: "Self-edit result" },
				"202": {
					description:
						"Accepted but quarantined (C-008): a user-block edit whose merged content tripped the injection classifier is held in memory_quarantine pending review; body carries quarantined=true, id (quarantine id) and matchedPatterns",
				},
				"422": {
					description:
						"Self-edit rejected by the injection screen (SELF_EDIT_REJECTED)",
				},
			},
		},
	},
} as const
