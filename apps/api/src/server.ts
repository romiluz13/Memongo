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
import {
	enforceRequiredVector,
	isRequireVectorEnabled,
	logCapabilityTable,
	probeBootCapabilities,
} from "./lib/capabilities.js"

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

// P1.9: log the search capability table once at boot so operators can see
// which retrieval lanes (hybrid/vector/keyword/text) this deployment can
// actually serve. Capabilities come from the engine manager's detected
// capabilities (serving-index existence + queryability), exposed through the
// bridge's memongoBridgeCapabilities — the same signal family the /ready
// vector lane uses. This warms the cached manager at boot, which also makes
// the first real request fast. A probe failure degrades the table to
// "unavailable" lanes instead of crashing an unstrict deployment.
const bootCapabilities = await probeBootCapabilities(() =>
	memongoBridgeCapabilities({}),
)
logCapabilityTable(bootCapabilities.lanes, bootCapabilities.probeError)

// P1.9 strict mode: production deployments that cannot tolerate silent
// $text-only degradation set MEMONGO_REQUIRE_VECTOR=1; boot refuses to
// continue (exit 1) when the vector lane is unavailable or the capability
// probe failed.
if (isRequireVectorEnabled(process.env.MEMONGO_REQUIRE_VECTOR)) {
	try {
		enforceRequiredVector(bootCapabilities.lanes, bootCapabilities.probeError)
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
}

const app = createApp()

const port = Number(process.env.MEMONGO_API_PORT ?? "3847")
const host = process.env.MEMONGO_API_HOST ?? "127.0.0.1"

// Guardrail 3: refuse to bind a routable address without authentication.
const hasApiKey = Boolean(process.env.MEMONGO_API_KEY)
const hasScopedKeys = Boolean(process.env.MEMONGO_API_SCOPED_KEYS)
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
