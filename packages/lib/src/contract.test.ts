import { describe, expect, it } from "vitest"
import {
	AGENT_ID_FIELD_DESCRIPTION,
	API_ERROR_OPENAPI_REF,
	API_ERROR_OPENAPI_SCHEMA,
	apiErrorOpenApiResponse,
	BEARER_SECURITY_SCHEME,
	BEARER_SECURITY_SCHEME_NAME,
	CHAIN_TRACE_COLLECTION_VALUES,
	CHAIN_TRACE_COLLECTION_VALUES_TUPLE,
	CONTEXT_BUNDLE_MODE_VALUES,
	CONTEXT_BUNDLE_MODE_VALUES_TUPLE,
	MEMONGO_API_ROUTES,
	MEMORY_SCOPE_VALUES,
	MEMORY_SCOPE_VALUES_TUPLE,
	isChainTraceCollectionValue,
	isContextBundleModeValue,
	isMemoryScopeValue,
	type ChainTraceCollectionValue,
	type ContextBundleModeValue,
	type MemoryScopeValue,
} from "./contract.js"
import { MEMONGO_MCP_TOOL_FIELDS } from "./contract-mcp.js"
import type { MemoryScope } from "./types.memory.js"

describe("contract: canonical scope enum", () => {
	it("defines exactly the six canonical scope values in order", () => {
		expect(MEMORY_SCOPE_VALUES).toEqual([
			"session",
			"user",
			"agent",
			"workspace",
			"tenant",
			"global",
		])
	})

	it("keeps the mutable tuple derived from the canonical array", () => {
		expect(MEMORY_SCOPE_VALUES_TUPLE).toEqual([...MEMORY_SCOPE_VALUES])
	})

	it("classifies scope strings", () => {
		for (const scope of MEMORY_SCOPE_VALUES) {
			expect(isMemoryScopeValue(scope)).toBe(true)
		}
		expect(isMemoryScopeValue("organization")).toBe(false)
		expect(isMemoryScopeValue("")).toBe(false)
	})

	it("keeps MemoryScope identical to the scope value union (type level)", () => {
		// Compile-time assertion: assignability in both directions.
		const value: MemoryScopeValue = "workspace"
		const scope: MemoryScope = value
		const roundTrip: MemoryScopeValue = scope
		expect(roundTrip).toBe("workspace")
	})
})

describe("contract: canonical context-bundle mode enum (C-013)", () => {
	it("defines exactly the two canonical mode values in order", () => {
		expect(CONTEXT_BUNDLE_MODE_VALUES).toEqual(["full", "wake-up"])
	})

	it("keeps the mutable tuple derived from the canonical array", () => {
		expect(CONTEXT_BUNDLE_MODE_VALUES_TUPLE).toEqual([
			...CONTEXT_BUNDLE_MODE_VALUES,
		])
	})

	it("classifies mode strings", () => {
		for (const mode of CONTEXT_BUNDLE_MODE_VALUES) {
			expect(isContextBundleModeValue(mode)).toBe(true)
		}
		// The typo class the API used to swallow into the default bundle.
		expect(isContextBundleModeValue("wakeup")).toBe(false)
		expect(isContextBundleModeValue("FULL")).toBe(false)
		expect(isContextBundleModeValue("")).toBe(false)
	})

	it("keeps ContextBundleModeValue usable as a concrete string union (type level)", () => {
		// Compile-time assertion: guard-narrowed strings flow into the union.
		const candidate = "wake-up" as string
		if (isContextBundleModeValue(candidate)) {
			const mode: ContextBundleModeValue = candidate
			expect(mode).toBe("wake-up")
		}
	})
})

describe("contract: canonical chain-trace collection enum (C-015)", () => {
	it("defines exactly the engine-traversable collections in order", () => {
		expect(CHAIN_TRACE_COLLECTION_VALUES).toEqual([
			"structured_mem",
			"entities",
			"relations",
			"procedures",
			"entity_links",
		])
	})

	it("keeps the mutable tuple derived from the canonical array", () => {
		expect(CHAIN_TRACE_COLLECTION_VALUES_TUPLE).toEqual([
			...CHAIN_TRACE_COLLECTION_VALUES,
		])
	})

	it("classifies collection strings", () => {
		for (const collection of CHAIN_TRACE_COLLECTION_VALUES) {
			expect(isChainTraceCollectionValue(collection)).toBe(true)
		}
		// The plausible-but-wrong name the engine used to answer with a
		// fabricated chainComplete:true empty chain.
		expect(isChainTraceCollectionValue("structured_memories")).toBe(false)
		expect(isChainTraceCollectionValue("events")).toBe(false)
		expect(isChainTraceCollectionValue("")).toBe(false)
	})

	it("keeps ChainTraceCollectionValue usable as a concrete string union (type level)", () => {
		// Compile-time assertion: guard-narrowed strings flow into the union.
		const candidate = "entities" as string
		if (isChainTraceCollectionValue(candidate)) {
			const collection: ChainTraceCollectionValue = candidate
			expect(collection).toBe("entities")
		}
	})
})

describe("contract: ApiError envelope", () => {
	it("declares the shared OpenAPI schema and $ref target", () => {
		expect(API_ERROR_OPENAPI_SCHEMA.required).toEqual(["error"])
		expect(API_ERROR_OPENAPI_SCHEMA.properties.error.required).toEqual([
			"code",
			"message",
		])
		expect(API_ERROR_OPENAPI_REF).toBe("#/components/schemas/ApiError")
	})

	it("builds error response fragments that reference the shared schema", () => {
		const fragment = apiErrorOpenApiResponse("Validation failed")
		expect(fragment.description).toBe("Validation failed")
		expect(fragment.content["application/json"].schema.$ref).toBe(
			API_ERROR_OPENAPI_REF,
		)
	})

	it("declares the bearer security scheme", () => {
		expect(BEARER_SECURITY_SCHEME_NAME).toBe("bearerAuth")
		expect(BEARER_SECURITY_SCHEME).toEqual({
			type: "http",
			scheme: "bearer",
		})
	})

	it("exposes shared field descriptions", () => {
		expect(AGENT_ID_FIELD_DESCRIPTION.length).toBeGreaterThan(0)
	})
})

describe("contract: /v1 route table", () => {
	it("has unique path+method entries", () => {
		const keys = MEMONGO_API_ROUTES.map((r) => `${r.method} ${r.path}`)
		expect(new Set(keys).size).toBe(keys.length)
	})

	it("covers every route under /v1", () => {
		for (const route of MEMONGO_API_ROUTES) {
			expect(route.path.startsWith("/v1/")).toBe(true)
			expect(["get", "post"]).toContain(route.method)
			expect(route.operationId).toMatch(/^[a-z][A-Za-z0-9]*$/)
		}
		const operationIds = MEMONGO_API_ROUTES.map((r) => r.operationId)
		expect(new Set(operationIds).size).toBe(operationIds.length)
	})

	it("documents only real error statuses", () => {
		for (const route of MEMONGO_API_ROUTES) {
			expect(route.errorStatuses.length).toBeGreaterThan(0)
			for (const status of route.errorStatuses) {
				expect(status).toBeGreaterThanOrEqual(400)
				expect(status).toBeLessThan(600)
			}
		}
	})

	it("pins the self-edit route (was missing from the OpenAPI document)", () => {
		const selfEdit = MEMONGO_API_ROUTES.find((r) => r.path === "/v1/self-edit")
		expect(selfEdit).toBeDefined()
		expect(selfEdit?.method).toBe("post")
		expect(selfEdit?.requiredFields).toEqual(["block", "content"])
		expect(selfEdit?.errorStatuses).toContain(422)
	})
})

describe("contract: MCP alias tenant coordinates", () => {
	it("keeps alias field sets aligned with their canonical tools", () => {
		expect(MEMONGO_MCP_TOOL_FIELDS.memongo_recall_messages).toEqual(
			MEMONGO_MCP_TOOL_FIELDS.memongo_recall_conversation,
		)
		expect(MEMONGO_MCP_TOOL_FIELDS.memongo_import_conversation_history).toEqual(
			MEMONGO_MCP_TOOL_FIELDS.memongo_import_conversations,
		)
	})
})
