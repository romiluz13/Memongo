import { nonSearchFailureResponses } from "./openapi-paths-search.js"
import {
	CLIENT_VERSION_HEADER_PARAMETER,
	memoryScopeEnum,
} from "./openapi-schemas.js"

const rerankStatusSchema = {
	type: "object",
	description:
		"There is no reranker. The engine does not implement native $rerank (Atlas only) yet, and the server is not probed.",
	properties: {
		nativeRerank: {
			type: "object",
			properties: {
				engineSupport: { type: "boolean", enum: [false] },
				serverSupport: { type: "string", enum: ["unknown"] },
			},
		},
		lane: {
			type: "object",
			properties: {
				outcome: { type: "string", enum: ["not-applicable"] },
				reason: { type: "string", enum: ["capability-absent"] },
			},
		},
	},
}

export const statusPaths = {
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
									enum: memoryScopeEnum,
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
			parameters: [CLIENT_VERSION_HEADER_PARAMETER],
			responses: {
				"200": {
					description:
						"Status. Includes `version`, the Memongo release version of this server, and `custom.rerank`: native rerank is unsupported by the engine and unknown on the server, and the rerank lane is not-applicable (capability-absent).",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									custom: {
										type: "object",
										properties: { rerank: rerankStatusSchema },
									},
								},
							},
						},
					},
				},
			},
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
			requestBody: {
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {
								agentId: { type: "string" },
								reason: { type: "string" },
								force: { type: "boolean" },
							},
						},
					},
				},
			},
			responses: {
				"200": { description: "Ok" },
				"500": {
					description:
						'KB_REFRESH_FAILED: the file sync committed, but the KB auto-refresh did not complete (a rejected import, an import that reported errors, a configured KB source that could not be scanned or read, or a marker write that failed after a clean import). The body carries error.commitState = "committed" and error.commit = { operation: "sync", fileSync, kbImport? }: fileSync says what the file-sync phase left undone, and kbImport holds the import\'s acknowledged counts only when the import produced them (absent means not known, never zero). The message names the reason; the refresh marker is not advanced, so the next sync retries. Other unexpected failures return SYNC_FAILED, which also carries error.commitState and error.commit when the failure came after the file sync committed.',
				},
			},
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
			responses: {
				"200": { description: "{ ok: boolean }" },
				...nonSearchFailureResponses("PROBE_VECTOR_FAILED"),
			},
		},
	},
} as const
