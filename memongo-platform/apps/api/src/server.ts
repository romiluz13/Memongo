import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { openApiSpec } from "./openapi-spec.js";
import { createV1Router } from "./routes/v1.js";

const app = new Hono();

app.use("/*", cors());

const token = process.env.MEMONGO_API_KEY?.trim();
if (token) {
  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const expected = `Bearer ${token}`;
    if (auth !== expected) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "unauthorized" } }, 401);
    }
    await next();
  });
}

app.get("/health", (c) => c.json({ ok: true, service: "memongo-api" }));

/** Public OpenAPI document (no auth). */
app.get("/openapi.json", (c) => c.json(openApiSpec));

app.route("/v1", createV1Router());

const port = Number(process.env.MEMONGO_API_PORT ?? "3847");
const host = process.env.MEMONGO_API_HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.error(`memongo-api listening on http://${info.address}:${info.port}`);
});
