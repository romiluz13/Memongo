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
import {
	API_ERROR_OPENAPI_SCHEMA,
	apiErrorOpenApiResponse,
	BEARER_SECURITY_SCHEME,
	BEARER_SECURITY_SCHEME_NAME,
	MEMONGO_API_ROUTES,
} from "@memongo/lib"
import { MEMONGO_API_VERSION } from "./version.js"

import { searchPaths } from "./openapi-paths-search.js"
import { contextPaths } from "./openapi-paths-context.js"
import { lifecyclePaths } from "./openapi-paths-lifecycle.js"
import { writePaths } from "./openapi-paths-write.js"
import { statusPaths } from "./openapi-paths-status.js"
import { adminPaths } from "./openapi-paths-admin.js"
import { maintenancePaths } from "./openapi-paths-maintenance.js"

const openApiSpecDocument = {
	openapi: "3.0.3",
	info: {
		title: "Memongo API",
		version: MEMONGO_API_VERSION,
		description:
			"HTTP API for the Memongo memory platform. Configure it with MEMONGO_MONGODB_URI and, optionally, ~/.memongo/memongo.json.",
	},
	servers: [{ url: "/", description: "Default" }],
	paths: {
		...searchPaths,
		...contextPaths,
		...lifecyclePaths,
		...writePaths,
		...statusPaths,
		...adminPaths,
		...maintenancePaths,
	},
	components: {
		schemas: {
			ApiError: API_ERROR_OPENAPI_SCHEMA,
		},
		securitySchemes: {
			[BEARER_SECURITY_SCHEME_NAME]: BEARER_SECURITY_SCHEME,
		},
	},
	security: [{ [BEARER_SECURITY_SCHEME_NAME]: [] }],
} as const

/**
 * P2.2 derivation pass: every contract route's documented error statuses get
 * the shared ApiError envelope ($ref), so no route can drift to its own error
 * body shape. Existing descriptions are preserved; missing statuses are
 * added. Path/method coverage itself is enforced by
 * apps/api/src/contract-conformance.test.ts against the live router.
 */
const ERROR_STATUS_DESCRIPTIONS: Record<number, string> = {
	400: "Validation error",
	404: "Not found",
	422: "Request rejected",
	500: "Internal server error",
}

function withContractConformance<T>(document: T): T {
	type MutableRecord = Record<string, unknown>
	const doc = document as MutableRecord
	const paths = doc.paths as MutableRecord
	for (const route of MEMONGO_API_ROUTES) {
		const pathItem = paths[route.path] as MutableRecord | undefined
		const operation = pathItem?.[route.method] as MutableRecord | undefined
		if (!operation) {
			// The conformance test fails on the missing operation; nothing to
			// derive onto here.
			continue
		}
		const existingResponses = (operation.responses ?? {}) as MutableRecord
		const responses: MutableRecord = { ...existingResponses }
		for (const status of route.errorStatuses) {
			const key = String(status)
			const existing = existingResponses[key] as MutableRecord | undefined
			const fragment = apiErrorOpenApiResponse(
				(typeof existing?.description === "string"
					? existing.description
					: undefined) ??
					ERROR_STATUS_DESCRIPTIONS[status] ??
					"Error",
			)
			responses[key] = existing
				? { ...existing, content: fragment.content }
				: fragment
		}
		operation.responses = responses
	}
	return document
}

export const openApiSpec = withContractConformance(openApiSpecDocument)
