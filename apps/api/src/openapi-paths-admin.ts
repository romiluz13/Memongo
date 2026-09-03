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

export const adminPaths = {
	"/v1/admin/relevance/explain": {
		post: {
			summary: "Relevance explain (diagnostic)",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["query"],
							properties: {
								query: { type: "string", minLength: 1 },
								agentId: {
									type: "string",
									description: AGENT_ID_FIELD_DESCRIPTION,
								},
								sourceScope: {
									type: "string",
									enum: ["all", "memory", "kb", "structured"],
								},
								sessionKey: { type: "string" },
								maxResults: { type: "integer", minimum: 1 },
								minScore: { type: "number", minimum: 0 },
								deep: { type: "boolean" },
							},
						},
					},
				},
			},
			responses: { "200": { description: "Explain payload" } },
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
	"/v1/admin/erase": {
		post: {
			summary:
				"Irreversibly erase every collection entry for one agent (tenant erasure)",
			description:
				"Deletes all tenant data across every collection that stores agent data and returns a per-collection receipt. Requires the literal confirmation string and the global admin token; scoped API keys are rejected.",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["confirm"],
							properties: {
								confirm: {
									type: "string",
									enum: ["erase"],
									description: "Typed confirmation; anything else is a 400",
								},
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
				"200": { description: "Per-collection tenant erasure receipt" },
			},
		},
	},
	"/v1/admin/quarantine": {
		get: {
			summary: "List quarantined memories awaiting review (oldest first)",
			description:
				"Returns the injection-classified memories held for review, oldest first, with the matched patterns and decision metadata. Admin-only: scoped and agent-scoped API keys are rejected, because quarantined payloads must not flow back to agent credentials.",
			parameters: [
				{ name: "agentId", in: "query", schema: { type: "string" } },
				{
					name: "status",
					in: "query",
					description:
						"Filter by review state; omit to list every entry including the decided history",
					schema: {
						type: "string",
						enum: ["pending-review", "promoted", "rejected"],
					},
				},
				{
					name: "limit",
					in: "query",
					schema: { type: "integer", minimum: 1, maximum: 100 },
				},
			],
			responses: { "200": { description: "Quarantine review queue" } },
		},
	},
	"/v1/admin/quarantine/promote": {
		post: {
			summary:
				"Overrule the injection classifier and write a quarantined memory as structured memory",
			description:
				"Runs the standard pattern-match extraction on the quarantined content and writes the resulting structured memories with provenance back to the quarantine row. The decision (reviewer, notes, timestamp) is recorded on the row and in the mutation audit log. Admin-only: scoped and agent-scoped API keys are rejected.",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["quarantineId"],
							properties: {
								quarantineId: {
									type: "string",
									minLength: 1,
									description: "The quarantine entry to approve",
								},
								agentId: {
									type: "string",
									description: AGENT_ID_FIELD_DESCRIPTION,
								},
								reviewerId: {
									type: "string",
									description: "Who reviewed the entry",
								},
								reviewNotes: {
									type: "string",
									description: "Why the decision was made",
								},
							},
						},
					},
				},
			},
			responses: {
				"200": {
					description:
						"Review receipt with the written memory and mutation ids",
				},
			},
		},
	},
	"/v1/admin/quarantine/reject": {
		post: {
			summary:
				"Discard a quarantined memory (kept as audit trail; only unreviewed entries expire)",
			description:
				"Flips the entry to rejected and records the decision (reviewer, notes, timestamp) on the row and in the mutation audit log. The row itself is kept as durable audit trail; the retention TTL only removes entries still pending review. Admin-only: scoped and agent-scoped API keys are rejected.",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["quarantineId"],
							properties: {
								quarantineId: {
									type: "string",
									minLength: 1,
									description: "The quarantine entry to reject",
								},
								agentId: {
									type: "string",
									description: AGENT_ID_FIELD_DESCRIPTION,
								},
								reviewerId: {
									type: "string",
									description: "Who reviewed the entry",
								},
								reviewNotes: {
									type: "string",
									description: "Why the decision was made",
								},
							},
						},
					},
				},
			},
			responses: {
				"200": { description: "Review receipt with the mutation audit id" },
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
} as const
