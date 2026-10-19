// M2 required-index manifest: every Search and Vector Search index the
// selected profile and the enabled query surfaces need, with the definition
// each must serve. Boot creates or updates these and refuses to start until
// each one is READY and serving its definition (mongodb-boot-contract.ts).
//
// To add a required index, add one row to REQUIRED_INDEX_ROWS. Later M2
// tickets add field mappings by editing the row's definition.
//
// WS-16 (C-029) text-analyzer strategy: natural-language fields carry the
// analyzer selected by MEMONGO_SEARCH_TEXT_ANALYZER; identifier-heavy fields
// (kb_chunks.path, structured_mem.key) get a dual keyword+folding mapping
// under the improved strategies. Fields used by compound `equals`/`in`
// filters stay `token`, because Search filter clauses require token fields.
import type { Document } from "mongodb"
import { isEvidenceMirrorEnabled } from "./mongodb-evidence-mirror.js"
import {
	autoEmbedVectorField,
	buildAutoEmbedVectorDefinition,
	isLongMemEvalSearchIndexProfile,
	isRawSessionSearchIndexProfile,
	withVectorStoredSource,
} from "./mongodb-schema-search-definitions.js"
import {
	isIdentifierDualMappingEnabled,
	resolveSearchTextAnalyzer,
	searchTextAnalyzerName,
} from "./mongodb-search-ranking.js"

export type RequiredSearchIndex = {
	collectionName: string
	name: string
	type: "search" | "vectorSearch"
	definition: Document
	label: string
}

export type RequiredIndexManifestOptions = {
	prefix: string
	quantization?: "none" | "scalar" | "binary"
	/** buildInfo versionArray; gates the storedSource include-lists. */
	serverVersionArray?: unknown
	/** Credential-free deployment identity for probe-scoped gates. */
	deployment?: string
	env?: NodeJS.ProcessEnv
}

type Surface =
	| "chunks"
	| "kb"
	| "structured"
	| "procedures"
	| "events"
	| "session"
	| "evidence"
	| "entities"
	| "episodes"

type DefinitionContext = {
	textAnalyzer: string
	identifierField: Document
	quantization: "none" | "scalar" | "binary"
	serverVersionArray?: unknown
	deployment?: string
}

type RequiredIndexRow = {
	surface: Surface
	collection: string
	/** Index name; a leading "{prefix}" is replaced with the collection prefix. */
	name: string
	type: "search" | "vectorSearch"
	label: string
	definition: (ctx: DefinitionContext) => Document
}

const filterFields = (paths: string[]): Document[] =>
	paths.map((path) => ({ type: "filter", path }))

const SESSION_CHUNKS_FILTER_PATHS = [
	"agentId",
	"scope",
	"scopeRef",
	"sessionId",
	// C-005: the Option B lane filters unexpired docs in its $vectorSearch filter.
	"expiresAt",
	// RET-02: the Option B lane composes the explicit-range occurrence-time guard.
	"timestamp",
]

const REQUIRED_INDEX_ROWS: RequiredIndexRow[] = [
	{
		surface: "chunks",
		collection: "chunks",
		name: "{prefix}chunks_text",
		type: "search",
		label: "chunks text",
		definition: (ctx) => ({
			mappings: {
				dynamic: false,
				fields: {
					text: { type: "string", analyzer: ctx.textAnalyzer },
					source: { type: "token" },
					path: { type: "token" },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					sessionId: { type: "token" },
					status: { type: "token" },
					updatedAt: { type: "date" },
					searchWriteToken: { type: "token" },
				},
			},
		}),
	},
	{
		surface: "chunks",
		collection: "chunks",
		name: "{prefix}chunks_vector",
		type: "vectorSearch",
		label: "chunks vector",
		// C-005 expiresAt, C-026 validAt/invalidAt and RET-02 timestamp are
		// declared filter paths because the chunk lanes compose them into the
		// $vectorSearch filter.
		definition: (ctx) =>
			withVectorStoredSource(
				buildAutoEmbedVectorDefinition(
					"text",
					[
						"source",
						"path",
						"agentId",
						"scope",
						"scopeRef",
						"sessionId",
						"status",
						"expiresAt",
						"validAt",
						"invalidAt",
						"timestamp",
						"searchWriteToken",
					],
					ctx.quantization,
				),
				"chunks",
				ctx.serverVersionArray,
				ctx.deployment,
			),
	},
	{
		surface: "kb",
		collection: "kb_chunks",
		name: "{prefix}kb_chunks_text",
		type: "search",
		label: "kb_chunks text",
		definition: (ctx) => ({
			mappings: {
				dynamic: false,
				fields: {
					text: { type: "string", analyzer: ctx.textAnalyzer },
					path: ctx.identifierField,
					// docId stays token: the KB text lane pushes docId $in into
					// the compound filter.
					docId: { type: "token" },
					scopeRef: { type: "token" },
					updatedAt: { type: "date" },
				},
			},
		}),
	},
	{
		surface: "kb",
		collection: "kb_chunks",
		name: "{prefix}kb_chunks_vector",
		type: "vectorSearch",
		label: "kb_chunks vector",
		definition: (ctx) =>
			withVectorStoredSource(
				{
					fields: [
						autoEmbedVectorField("text", ctx.quantization),
						// scopeRef: tenant isolation pre-filter (issue #27);
						// agentId: the stats coverage probe filter (W13).
						...filterFields(["docId", "path", "scopeRef", "agentId"]),
					],
				},
				"kb_chunks",
				ctx.serverVersionArray,
				ctx.deployment,
			),
	},
	{
		surface: "structured",
		collection: "structured_mem",
		name: "{prefix}structured_mem_text",
		type: "search",
		label: "structured_mem text",
		definition: (ctx) => ({
			mappings: {
				dynamic: false,
				fields: {
					value: { type: "string", analyzer: ctx.textAnalyzer },
					context: { type: "string", analyzer: ctx.textAnalyzer },
					type: { type: "token" },
					key: ctx.identifierField,
					tags: { type: "token" },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					state: { type: "token" },
					salience: { type: "token" },
					temporalScope: { type: "token" },
					updatedAt: { type: "date" },
					searchWriteToken: { type: "token" },
				},
			},
		}),
	},
	{
		surface: "structured",
		collection: "structured_mem",
		name: "{prefix}structured_mem_vector",
		type: "vectorSearch",
		label: "structured_mem vector",
		definition: (ctx) =>
			withVectorStoredSource(
				{
					fields: [
						autoEmbedVectorField("value", ctx.quantization),
						...filterFields([
							"type",
							"tags",
							"agentId",
							"scope",
							"scopeRef",
							"state",
							"salience",
							"temporalScope",
							"validFrom",
							"validTo",
							"searchWriteToken",
						]),
					],
				},
				"structured_mem",
				ctx.serverVersionArray,
				ctx.deployment,
			),
	},
	{
		surface: "procedures",
		collection: "procedures",
		name: "{prefix}procedures_text",
		type: "search",
		label: "procedures text",
		definition: (ctx) => ({
			mappings: {
				dynamic: false,
				fields: {
					// T7: `name` is also a lowercase token so the exact-match lane
					// can run `equals`; `triggerQueries` has no other consumer.
					name: [
						{ type: "string", analyzer: ctx.textAnalyzer },
						{ type: "token", normalizer: "lowercase" },
					],
					triggerQueries: { type: "token", normalizer: "lowercase" },
					searchText: { type: "string", analyzer: ctx.textAnalyzer },
					intentTags: { type: "token" },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					state: { type: "token" },
					updatedAt: { type: "date" },
					searchWriteToken: { type: "token" },
				},
			},
		}),
	},
	{
		surface: "procedures",
		collection: "procedures",
		name: "{prefix}procedures_vector",
		type: "vectorSearch",
		label: "procedures vector",
		definition: (ctx) =>
			withVectorStoredSource(
				{
					fields: [
						autoEmbedVectorField("searchText", ctx.quantization),
						...filterFields([
							"intentTags",
							"agentId",
							"scope",
							"scopeRef",
							"state",
							"validFrom",
							"validTo",
							"searchWriteToken",
						]),
					],
				},
				"procedures",
				ctx.serverVersionArray,
				ctx.deployment,
			),
	},
	{
		surface: "events",
		collection: "events",
		name: "{prefix}events_text",
		type: "search",
		label: "events text",
		definition: (ctx) => ({
			mappings: {
				dynamic: false,
				fields: {
					body: { type: "string", analyzer: ctx.textAnalyzer },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					sessionId: { type: "token" },
					role: { type: "token" },
					channel: { type: "token" },
					timestamp: { type: "date" },
					searchWriteToken: { type: "token" },
				},
			},
		}),
	},
	{
		surface: "events",
		collection: "events",
		name: "{prefix}events_vector",
		type: "vectorSearch",
		label: "events vector",
		// No storedSource: recall matches validAt/invalidAt after $vectorSearch.
		definition: (ctx) => ({
			fields: [
				autoEmbedVectorField("body", ctx.quantization),
				...filterFields([
					"agentId",
					"scope",
					"scopeRef",
					"sessionId",
					"role",
					"channel",
					"timestamp",
					"validAt",
					"invalidAt",
					"searchWriteToken",
				]),
			],
		}),
	},
	{
		surface: "session",
		collection: "session_chunks",
		name: "{prefix}session_chunks_text",
		type: "search",
		label: "session_chunks text",
		definition: (ctx) => ({
			mappings: {
				dynamic: false,
				fields: {
					text: { type: "string", analyzer: ctx.textAnalyzer },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					sessionId: { type: "token" },
				},
			},
		}),
	},
	{
		surface: "session",
		collection: "session_chunks",
		name: "{prefix}session_chunks_vector",
		type: "vectorSearch",
		label: "session_chunks vector",
		definition: (ctx) =>
			withVectorStoredSource(
				{
					fields: [
						autoEmbedVectorField("text", ctx.quantization),
						...filterFields(SESSION_CHUNKS_FILTER_PATHS),
					],
				},
				"session_chunks",
				ctx.serverVersionArray,
				ctx.deployment,
			),
	},
	{
		surface: "evidence",
		collection: "memory_evidence",
		name: "{prefix}memory_evidence_text",
		type: "search",
		label: "memory_evidence text",
		definition: (ctx) => ({
			mappings: {
				dynamic: false,
				fields: {
					text: { type: "string", analyzer: ctx.textAnalyzer },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
					sessionId: { type: "token" },
					unit: { type: "token" },
					status: { type: "token" },
					timestamp: { type: "date" },
				},
			},
		}),
	},
	{
		surface: "evidence",
		collection: "memory_evidence",
		name: "{prefix}memory_evidence_vector",
		type: "vectorSearch",
		label: "memory_evidence vector",
		definition: (ctx) => ({
			fields: [
				autoEmbedVectorField("text", ctx.quantization),
				...filterFields([
					"agentId",
					"scope",
					"scopeRef",
					"sessionId",
					"unit",
					"status",
					"timestamp",
				]),
			],
		}),
	},
	{
		surface: "entities",
		collection: "entities",
		name: "entity_autocomplete",
		type: "search",
		label: "entity autocomplete",
		// T7: prefix lookup keeps the edgeGram `autocomplete` mapping; exact
		// names run `equals` on the lowercase `token` mapping beside it.
		definition: () => ({
			mappings: {
				dynamic: false,
				fields: {
					name: [
						{ type: "autocomplete" },
						{ type: "token", normalizer: "lowercase" },
					],
					aliases: [
						{ type: "autocomplete" },
						{ type: "token", normalizer: "lowercase" },
					],
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
				},
			},
		}),
	},
	{
		surface: "episodes",
		collection: "episodes",
		name: "episode_autocomplete",
		type: "search",
		label: "episode autocomplete",
		// T7: episode search runs `text`, so title and summary are analyzed
		// strings. Nothing queries them with `autocomplete` any more.
		definition: (ctx) => ({
			mappings: {
				dynamic: false,
				fields: {
					title: { type: "string", analyzer: ctx.textAnalyzer },
					summary: { type: "string", analyzer: ctx.textAnalyzer },
					agentId: { type: "token" },
					scope: { type: "token" },
					scopeRef: { type: "token" },
				},
			},
		}),
	},
]

function enabledSurfaces(env: NodeJS.ProcessEnv): Set<Surface> {
	const evidence: Surface[] = isEvidenceMirrorEnabled(env) ? ["evidence"] : []
	if (isLongMemEvalSearchIndexProfile(env)) {
		return new Set<Surface>([
			"chunks",
			"structured",
			"procedures",
			"events",
			...evidence,
		])
	}
	return new Set<Surface>([
		"chunks",
		"kb",
		"structured",
		"procedures",
		"events",
		"session",
		...evidence,
		"entities",
		"episodes",
	])
}

export function buildRequiredIndexManifest(
	options: RequiredIndexManifestOptions,
): RequiredSearchIndex[] {
	const env = options.env ?? process.env
	const textAnalyzerStrategy = resolveSearchTextAnalyzer(
		env.MEMONGO_SEARCH_TEXT_ANALYZER,
	)
	const ctx: DefinitionContext = {
		textAnalyzer: searchTextAnalyzerName(textAnalyzerStrategy),
		identifierField: isIdentifierDualMappingEnabled(textAnalyzerStrategy)
			? {
					type: "string",
					analyzer: "lucene.keyword",
					fields: { folded: { type: "string", analyzer: "lucene.folding" } },
				}
			: { type: "token" },
		quantization: options.quantization ?? "none",
		serverVersionArray: options.serverVersionArray,
		deployment: options.deployment,
	}
	const rows = isRawSessionSearchIndexProfile(env)
		? REQUIRED_INDEX_ROWS.filter(
				(row) => row.name === "{prefix}session_chunks_vector",
			)
		: REQUIRED_INDEX_ROWS.filter((row) => enabledSurfaces(env).has(row.surface))
	return rows.map((row) => ({
		collectionName: `${options.prefix}${row.collection}`,
		name: row.name.replace("{prefix}", options.prefix),
		type: row.type,
		definition: row.definition(ctx),
		label: row.label,
	}))
}
