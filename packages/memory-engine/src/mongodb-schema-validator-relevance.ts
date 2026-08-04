import type { Document } from "mongodb"

export const RELEVANCE_RUNS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["runId", "agentId", "ts", "sourceScope", "latencyMs", "status"],
		properties: {
			runId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			ts: { bsonType: "date" },
			queryHash: { bsonType: "string" },
			queryRedacted: { bsonType: "string" },
			sourceScope: { enum: ["all", "memory", "kb", "structured"] },
			profile: { bsonType: "string" },
			capabilities: { bsonType: "object" },
			latencyMs: { bsonType: "number" },
			topK: { bsonType: "number" },
			hitSources: { bsonType: "array", items: { bsonType: "string" } },
			fallbackPath: { bsonType: "string" },
			status: { enum: ["ok", "degraded", "insufficient-data"] },
			sampleRate: { bsonType: "number" },
			sampled: { bsonType: "bool" },
		},
	},
}

export const RELEVANCE_ARTIFACTS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: ["runId", "artifactType", "summary", "ts"],
		properties: {
			runId: { bsonType: "string" },
			artifactType: {
				enum: [
					"searchExplain",
					"vectorExplain",
					"fusionExplain",
					"scoreDetails",
					"trace",
				],
			},
			summary: { bsonType: "object" },
			rawExplain: {},
			rawSizeBytes: { bsonType: "number" },
			compression: { bsonType: "string" },
			ts: { bsonType: "date" },
		},
	},
}

export const RELEVANCE_REGRESSIONS_SCHEMA: Document = {
	$jsonSchema: {
		bsonType: "object",
		required: [
			"regressionId",
			"agentId",
			"ts",
			"metricName",
			"current",
			"severity",
		],
		properties: {
			regressionId: { bsonType: "string" },
			agentId: { bsonType: "string" },
			ts: { bsonType: "date" },
			datasetVersion: { bsonType: "string" },
			metricName: { bsonType: "string" },
			baseline: { bsonType: "number" },
			current: { bsonType: "number" },
			delta: { bsonType: "number" },
			severity: { enum: ["low", "medium", "high"] },
			failingCases: { bsonType: "array", items: { bsonType: "object" } },
		},
	},
}

// v2 schema constants
