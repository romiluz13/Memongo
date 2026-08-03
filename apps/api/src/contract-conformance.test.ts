/**
 * Contract conformance (P2.2): the OpenAPI document must describe the API
 * the server actually exposes. This test walks the REAL /v1 router (no
 * bridge mock — handlers are never invoked) and the route table from the
 * single contract source (@memongo/lib contract) and fails on any drift:
 * undocumented routes, missing required request fields, undocumented error
 * statuses, error bodies that do not use the shared ApiError envelope,
 * missing bearer security scheme, or divergent scope enums.
 */
import {
	API_ERROR_OPENAPI_REF,
	BEARER_SECURITY_SCHEME_NAME,
	MEMONGO_API_ROUTES,
	MEMORY_SCOPE_VALUES,
} from "@memongo/lib"
import { describe, expect, it } from "vitest"
import { openApiSpec } from "./openapi-spec.js"
import { createV1Router } from "./routes/v1.js"

type OpenApiOperation = {
	summary?: string
	parameters?: Array<{ name?: string; in?: string; required?: boolean }>
	requestBody?: {
		content?: {
			"application/json"?: {
				schema?: {
					required?: string[]
					properties?: Record<string, unknown>
					oneOf?: Array<{
						required?: string[]
						properties?: Record<string, unknown>
					}>
				}
			}
		}
	}
	responses?: Record<
		string,
		{
			description?: string
			content?: {
				"application/json"?: { schema?: { $ref?: string } }
			}
		}
	>
}

type OpenApiDocument = {
	openapi: string
	security?: Array<Record<string, unknown>>
	paths: Record<string, Record<string, OpenApiOperation>>
	components?: {
		schemas?: Record<string, unknown>
		securitySchemes?: Record<string, { type?: string; scheme?: string }>
	}
}

const spec = openApiSpec as unknown as OpenApiDocument

/** Registered /v1 routes, converted from Hono syntax to OpenAPI syntax. */
function registeredV1Routes(): Array<{ method: string; path: string }> {
	const router = createV1Router()
	const seen = new Map<string, { method: string; path: string }>()
	for (const route of router.routes) {
		const method = route.method.toLowerCase()
		if (method !== "get" && method !== "post") {
			continue
		}
		const path = `/v1${route.path}`.replace(/:([A-Za-z0-9_]+)/g, "{$1}")
		seen.set(`${method} ${path}`, { method, path })
	}
	return [...seen.values()]
}

function operationFor(
	path: string,
	method: string,
): OpenApiOperation | undefined {
	return spec.paths[path]?.[method]
}

describe("contract conformance: routes vs OpenAPI document", () => {
	it("documents every registered /v1 route (path + method)", () => {
		const registered = registeredV1Routes()
		expect(registered.length).toBeGreaterThan(0)
		const missing = registered.filter(
			({ method, path }) => operationFor(path, method) === undefined,
		)
		expect(missing.map((r) => `${r.method.toUpperCase()} ${r.path}`)).toEqual(
			[],
		)
	})

	it("contract route table covers exactly the registered routes", () => {
		const registered = new Set(
			registeredV1Routes().map((r) => `${r.method} ${r.path}`),
		)
		const table = new Set(
			MEMONGO_API_ROUTES.map((r) => `${r.method} ${r.path}`),
		)
		expect([...table].filter((key) => !registered.has(key))).toEqual([])
		expect([...registered].filter((key) => !table.has(key))).toEqual([])
	})

	it("documents the contract's required request fields", () => {
		const failures: string[] = []
		for (const route of MEMONGO_API_ROUTES) {
			const operation = operationFor(route.path, route.method)
			if (!operation) {
				failures.push(`${route.method} ${route.path}: operation missing`)
				continue
			}
			if (route.requiredFields.length === 0) {
				continue
			}
			if (route.method === "post") {
				const schema =
					operation.requestBody?.content?.["application/json"]?.schema
				// A route-required field must be required by EVERY accepted body
				// variant (oneOf), or by the single object schema.
				const variants = schema?.oneOf ?? (schema ? [schema] : [])
				for (const field of route.requiredFields) {
					const documented =
						variants.length > 0 &&
						variants.every(
							(variant) =>
								(variant.required ?? []).includes(field) &&
								field in (variant.properties ?? {}),
						)
					if (!documented) {
						failures.push(
							`${route.method} ${route.path}: required body field "${field}" not documented`,
						)
					}
				}
			} else {
				const parameters = operation.parameters ?? []
				for (const field of route.requiredFields) {
					const parameter = parameters.find(
						(p) => p.name === field && p.in === "query",
					)
					if (!parameter || parameter.required !== true) {
						failures.push(
							`${route.method} ${route.path}: required query field "${field}" not documented`,
						)
					}
				}
			}
		}
		expect(failures).toEqual([])
	})

	it("documents every contract error status with the ApiError envelope", () => {
		const failures: string[] = []
		for (const route of MEMONGO_API_ROUTES) {
			const operation = operationFor(route.path, route.method)
			if (!operation) {
				failures.push(`${route.method} ${route.path}: operation missing`)
				continue
			}
			const responses = operation.responses ?? {}
			for (const status of route.errorStatuses) {
				const response = responses[String(status)]
				if (!response) {
					failures.push(
						`${route.method} ${route.path}: error status ${status} not documented`,
					)
					continue
				}
				const ref = response.content?.["application/json"]?.schema?.$ref
				if (ref !== API_ERROR_OPENAPI_REF) {
					failures.push(
						`${route.method} ${route.path}: error status ${status} does not $ref ${API_ERROR_OPENAPI_REF}`,
					)
				}
			}
		}
		expect(failures).toEqual([])
	})

	it("declares the bearer security scheme and applies it globally", () => {
		const scheme =
			spec.components?.securitySchemes?.[BEARER_SECURITY_SCHEME_NAME]
		expect(scheme).toEqual({ type: "http", scheme: "bearer" })
		expect(spec.security).toContainEqual({ [BEARER_SECURITY_SCHEME_NAME]: [] })
	})

	it("keeps every scope enum in the spec equal to the canonical values", () => {
		const canonical = [...MEMORY_SCOPE_VALUES]
		const divergent: string[] = []
		const walk = (node: unknown, trail: string): void => {
			if (!node || typeof node !== "object") {
				return
			}
			if (Array.isArray(node)) {
				for (const [index, item] of node.entries()) {
					walk(item, `${trail}[${index}]`)
				}
				return
			}
			const record = node as Record<string, unknown>
			if (Array.isArray(record.enum)) {
				const values = record.enum as unknown[]
				// A scope enum is identified by containing canonical-only values.
				if (
					values.length > 0 &&
					values.every(
						(value) =>
							typeof value === "string" &&
							(canonical as readonly string[]).includes(value),
					) &&
					values.includes("workspace")
				) {
					if (JSON.stringify(values) !== JSON.stringify(canonical)) {
						divergent.push(`${trail}: ${JSON.stringify(values)}`)
					}
				}
			}
			for (const [key, value] of Object.entries(record)) {
				walk(value, trail ? `${trail}.${key}` : key)
			}
		}
		walk(spec.paths, "paths")
		expect(divergent).toEqual([])
	})

	it("defines the ApiError schema in components", () => {
		const schema = spec.components?.schemas?.ApiError as
			| { required?: string[] }
			| undefined
		expect(schema?.required).toEqual(["error"])
	})
})
