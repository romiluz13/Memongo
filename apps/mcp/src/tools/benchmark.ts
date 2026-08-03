import { MEMORY_SCOPE_VALUES } from "@memongo/lib"
import type { McpToolDefinition } from "../tool-registry.js"

const benchmarkCommonThresholdProperties = {
	contractId: { type: "string", minLength: 1 },
	version: { type: "string", minLength: 1 },
	minHitRate: { type: "number", minimum: 0, maximum: 1 },
	maxEmptyRate: { type: "number", minimum: 0, maximum: 1 },
	minRAt5: { type: "number", minimum: 0, maximum: 1 },
	minNdcgAt10: { type: "number", minimum: 0, maximum: 1 },
	maxP95LatencyMs: { type: "number", exclusiveMinimum: 0 },
} as const

const benchmarkCommonThresholdRequired = [
	"contractId",
	"version",
	"datasetKind",
	"minHitRate",
	"maxEmptyRate",
	"minRAt5",
	"minNdcgAt10",
	"maxP95LatencyMs",
] as const

const benchmarkQualityThresholdsSchema = {
	oneOf: [
		{
			type: "object",
			additionalProperties: false,
			properties: {
				...benchmarkCommonThresholdProperties,
				datasetKind: { type: "string", enum: ["longmemeval"] },
				minSessionRecallAnyAt10: {
					type: "number",
					minimum: 0,
					maximum: 1,
				},
				minSessionNdcgAnyAt10: {
					type: "number",
					minimum: 0,
					maximum: 1,
				},
			},
			required: [
				...benchmarkCommonThresholdRequired,
				"minSessionRecallAnyAt10",
				"minSessionNdcgAnyAt10",
			],
		},
		{
			type: "object",
			additionalProperties: false,
			properties: {
				...benchmarkCommonThresholdProperties,
				datasetKind: { type: "string", enum: ["locomo"] },
				minSessionEvidenceRecallAt10: {
					type: "number",
					minimum: 0,
					maximum: 1,
				},
				minDialogEvidenceRecallAt10: {
					type: "number",
					minimum: 0,
					maximum: 1,
				},
				minAnswerAccuracy: { type: "number", minimum: 0, maximum: 1 },
				maxJudgeFalsePositiveRate: {
					type: "number",
					minimum: 0,
					maximum: 1,
				},
				minAnswerCoverage: { type: "number", minimum: 0, maximum: 1 },
			},
			required: [
				...benchmarkCommonThresholdRequired,
				"minSessionEvidenceRecallAt10",
				"minAnswerAccuracy",
				"maxJudgeFalsePositiveRate",
				"minAnswerCoverage",
			],
		},
	],
} as const

// Benchmark/relevance harness tools (P1.2): dataset ingestion and relevance
// quality suites. Admin category — registered only when MEMONGO_MCP_ADMIN=1.
export const benchmarkTools: readonly McpToolDefinition[] = [
	{
		name: "memongo_benchmark_ingest",
		description:
			"Replay a benchmark conversation dataset through the canonical writeConversationEvent() pipeline",
		inputSchema: {
			type: "object",
			properties: {
				datasetPath: { type: "string", minLength: 1 },
				agentId: { type: "string" },
				scope: {
					type: "string",
					// Canonical scope enum from the single contract source (P2.2).
					enum: [...MEMORY_SCOPE_VALUES],
				},
				limitConversations: { type: "integer", minimum: 1 },
				limitTurnsPerConversation: { type: "integer", minimum: 1 },
			},
			required: ["datasetPath"],
		},
		category: "admin",
	},
	{
		name: "memongo_relevance_explain",
		description:
			"Detailed relevance diagnostics for a query: artifacts, health, scores",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				agentId: { type: "string" },
				sourceScope: {
					type: "string",
					enum: ["all", "memory", "kb", "structured"],
				},
				maxResults: { type: "number" },
				minScore: { type: "number" },
				deep: { type: "boolean" },
			},
			required: ["query"],
		},
		category: "admin",
	},
	{
		name: "memongo_relevance_benchmark",
		description: "Run relevance benchmark suite",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				datasetPath: { type: "string" },
				maxResults: { type: "number" },
				minScore: { type: "number" },
				retrievalLane: {
					type: "string",
					enum: ["native", "raw-session"],
				},
				datasetSha256: { type: "string" },
				embeddingConfig: { type: "object" },
				rerankerConfig: { type: "object" },
				qualityThresholds: benchmarkQualityThresholdsSchema,
			},
		},
		category: "admin",
	},
	{
		name: "memongo_relevance_report",
		description: "Relevance health report: hit rate, empty rate, fallback rate",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				windowMs: { type: "number" },
			},
		},
		category: "admin",
	},
	{
		name: "memongo_relevance_sample_rate",
		description: "Current relevance sampling rate and degraded signal count",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string" } },
		},
		category: "admin",
	},
]
