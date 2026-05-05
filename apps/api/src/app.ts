import { Hono } from "hono"
import { cors } from "hono/cors"
import { openApiSpec } from "./openapi-spec.js"
import { createV1Router } from "./routes/v1.js"

export function createApp(): Hono {
	const app = new Hono()

	app.use("/*", cors())

	const token = process.env.MEMONGO_API_KEY?.trim()
	if (token) {
		app.use("/v1/*", async (c, next) => {
			const auth = c.req.header("Authorization") ?? ""
			const expected = `Bearer ${token}`
			if (auth !== expected) {
				return c.json(
					{ error: { code: "UNAUTHORIZED", message: "unauthorized" } },
					401,
				)
			}
			await next()
		})
	}

	app.get("/health", (c) => c.json({ ok: true, service: "memongo-api" }))
	app.get("/openapi.json", (c) => c.json(openApiSpec))
	app.route("/v1", createV1Router())

	return app
}
