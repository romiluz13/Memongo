/**
 * OpenAPI 3.0 document for the Memongo HTTP API (Supermemory-shaped surface).
 * Extend as routes grow; keep in sync with `routes/v1.ts`.
 */
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Memongo API",
    version: "1.0.0",
    description:
      "HTTP API for Memongo memory (MongoDB). Requires @romiluz/memongo memongo-bridge and gateway config.",
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
        summary: "Semantic / hybrid memory search",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["query"],
                properties: {
                  query: { type: "string" },
                  agentId: { type: "string" },
                  maxResults: { type: "number" },
                  minScore: { type: "number" },
                  sessionKey: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Search results" } },
      },
    },
    "/v1/search-kb": {
      post: {
        summary: "Knowledge base search",
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
        summary: "Append user message (shortcut)",
        responses: { "200": { description: "Event id" } },
      },
    },
    "/v1/write-event": {
      post: {
        summary: "Write conversation event (any role)",
        responses: { "200": { description: "Event id" } },
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
        summary: "Synthesize profile",
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
        responses: { "200": { description: "Benchmark metrics" } },
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
} as const;
