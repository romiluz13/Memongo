import { serve } from "@hono/node-server"
import { createApp } from "./app.js"

const app = createApp()

const port = Number(process.env.MEMONGO_API_PORT ?? "3847")
const host = process.env.MEMONGO_API_HOST ?? "127.0.0.1"

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
	console.error(`memongo-api listening on http://${info.address}:${info.port}`)
})
