import { serve } from "@hono/node-server"
import { refuseToServeOpen } from "@memongo/lib"
import {
	memongoBridgeCapabilities,
	memongoBridgeShutdown,
} from "@memongo/memory-bridge"
import {
	createApp,
	registerGracefulShutdown,
	resolveCorsPolicy,
} from "./app.js"
import { validateBootEnv } from "./lib/boot-env.js"
import { bootOrRefuse } from "./lib/capabilities.js"

// P1.7: fail fast on missing MongoDB configuration — before binding the port —
// with the engine's own message, so a misconfigured container exits immediately
// instead of booting "healthy" and serving per-request 500s.
try {
	validateBootEnv()
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(1)
}

// P1.7: log the active CORS policy once at boot so operators can tell whether
// the web-console dev defaults or an explicit env allowlist are in effect.
const corsPolicy = resolveCorsPolicy(process.env.MEMONGO_CORS_ORIGINS)
console.log(
	`memongo-api CORS: ${corsPolicy.source === "dev-default" ? "dev-default" : "env-configured"} origins=[${corsPolicy.origins.join(", ")}]`,
)

// X-06: creating the engine manager runs the M2 startup contract (MongoDB
// 8.3+, Search index management, every required index READY and serving its
// definition). A boot failure refuses to serve: the typed reason is logged and
// the process exits 1 before the port is bound. Nothing degrades or warns and
// serves. This also warms the cached manager for the first request.
await bootOrRefuse(() => memongoBridgeCapabilities({}), {
	exit: (code) => process.exit(code),
})

const app = createApp()

const port = Number(process.env.MEMONGO_API_PORT ?? "3847")
const host = process.env.MEMONGO_API_HOST ?? "127.0.0.1"

// Guardrail 3: refuse to bind a routable address without authentication.
const hasApiKey = Boolean(process.env.MEMONGO_API_KEY?.trim())
const hasScopedKeys = Boolean(process.env.MEMONGO_API_SCOPED_KEYS?.trim())
refuseToServeOpen(host, hasApiKey || hasScopedKeys)

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
	console.error(`memongo-api listening on http://${info.address}:${info.port}`)
})

// Graceful shutdown: SIGTERM / SIGINT drain the server, flush the bridge, then
// exit. Timeout is set short enough for container runtimes but long enough to
// let Mongo in-flight writes finish.
registerGracefulShutdown({
	signals: ["SIGTERM", "SIGINT"],
	process,
	closeServer: () =>
		new Promise<void>((resolve) => {
			try {
				server.close(() => resolve())
			} catch {
				resolve()
			}
		}),
	closeBridge: () => memongoBridgeShutdown(),
	exit: (code) => process.exit(code),
	timeoutMs: 15_000,
})
