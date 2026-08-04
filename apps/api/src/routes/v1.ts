import { Hono } from "hono"
import { jsonError } from "../lib/errors.js"
import { InvalidJsonError } from "../lib/validation.js"

import { parseJsonRequestBody, type V1RouterEnv } from "./v1-helpers.js"

import { registerSearchRoutes } from "./v1-search-routes.js"
import { registerLifecycleRoutes } from "./v1-lifecycle-routes.js"
import { registerContextRoutes } from "./v1-context-routes.js"
import { registerWriteRoutes } from "./v1-write-routes.js"
import { registerStatusRoutes } from "./v1-status-routes.js"
import { registerAdminRoutes } from "./v1-admin-routes.js"
import { registerMaintenanceRoutes } from "./v1-maintenance-routes.js"

export function createV1Router(): Hono<V1RouterEnv> {
	const v1 = new Hono<V1RouterEnv>()

	// P2.8: pre-parse the JSON body ONCE for every non-GET route. A non-empty
	// unparseable body is a deliberate 400 INVALID_JSON returned here — Hono's
	// compose sends errors thrown in handlers straight to the app's onError,
	// bypassing wrapping middleware, so the mapping cannot live downstream.
	// The parsed body is stashed for readJsonBody; a genuinely empty body
	// stays `{}` as before.
	v1.use("*", async (c, next) => {
		if (c.req.method === "GET" || c.req.method === "HEAD") {
			await next()
			return
		}
		let body: Record<string, unknown>
		try {
			body = await parseJsonRequestBody(c)
		} catch (error) {
			if (error instanceof InvalidJsonError) {
				return jsonError(c, 400, "INVALID_JSON", error.message)
			}
			throw error
		}
		c.set("jsonBody", body)
		await next()
	})

	registerSearchRoutes(v1)
	registerLifecycleRoutes(v1)
	registerContextRoutes(v1)
	registerWriteRoutes(v1)
	registerStatusRoutes(v1)
	registerAdminRoutes(v1)
	registerMaintenanceRoutes(v1)

	return v1
}
