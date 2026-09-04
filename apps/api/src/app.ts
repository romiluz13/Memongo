import { createHash } from "node:crypto"
import { Hono, type Context, type MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { bodyLimit } from "hono/body-limit"
import { secureHeaders } from "hono/secure-headers"
import { cors } from "hono/cors"
import { requestId } from "hono/request-id"
import { formatErrorMessage, timingSafeBearerEquals } from "@memongo/lib"
import { openApiSpec } from "./openapi-spec.js"
import { internalError } from "./lib/errors.js"
import { checkReadiness } from "./lib/readiness.js"
import { createV1Router } from "./routes/v1.js"
import {
	isValidScope,
	resolveScopeField,
	resolveScopeInput,
} from "./scope-identity.js"
import { MEMONGO_API_VERSION } from "./version.js"

// Baseline network hardening (#28). Defaults are generous so normal use is
// unaffected; operators tighten via env. Body size is capped BEFORE JSON
// parsing so an oversized payload is rejected without being buffered/parsed.
const DEFAULT_MAX_BODY_BYTES = 1_000_000
const DEFAULT_RATE_LIMIT = 600
const DEFAULT_RATE_WINDOW_MS = 60_000

function parsePositiveIntEnv(
	raw: string | undefined,
	fallback: number,
): number {
	if (raw === undefined || raw.trim() === "") {
		return fallback
	}
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed < 0) {
		return fallback
	}
	return Math.floor(parsed)
}

function parseStrictlyPositiveIntEnv(
	raw: string | undefined,
	fallback: number,
): number {
	const parsed = parsePositiveIntEnv(raw, fallback)
	return parsed > 0 ? parsed : fallback
}

function parseBoolEnv(raw: string | undefined): boolean {
	const v = raw?.trim().toLowerCase()
	return v === "1" || v === "true" || v === "yes"
}

function parseCorsOrigins(raw: string | undefined): string[] {
	if (!raw?.trim()) {
		return []
	}
	const origins = raw
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean)
	if (origins.includes("*")) {
		throw new Error(
			"MEMONGO_CORS_ORIGINS must list explicit origins; wildcard CORS is not allowed",
		)
	}
	return [...new Set(origins)]
}

/**
 * P1.7: when MEMONGO_CORS_ORIGINS is unset, fall back to dev defaults for the
 * web console (apps/web dev/start port 3040) so the console works on a fresh
 * clone. An explicit env list keeps the existing strict behavior — explicit
 * origins only, wildcard still rejected by parseCorsOrigins.
 */
export const DEV_DEFAULT_CORS_ORIGINS: readonly string[] = [
	"http://127.0.0.1:3040",
	"http://localhost:3040",
]

export type CorsPolicy = {
	origins: string[]
	source: "env" | "dev-default"
}

export function resolveCorsPolicy(raw: string | undefined): CorsPolicy {
	const fromEnv = parseCorsOrigins(raw)
	if (fromEnv.length > 0) {
		return { origins: fromEnv, source: "env" }
	}
	return { origins: [...DEV_DEFAULT_CORS_ORIGINS], source: "dev-default" }
}

// Hard ceiling on distinct rate-limit buckets. Beyond this the limiter fails
// closed for NEW identities rather than growing without bound — otherwise an
// attacker rotating keys (e.g. spoofed X-Forwarded-For) could exhaust memory.
const RATE_LIMIT_MAX_BUCKETS = 100_000

/**
 * A bearer participates in rate-limit identity only after it matches a configured
 * credential. Invalid and missing bearers share the trusted-proxy IP bucket, or
 * one anonymous bucket when no proxy is trusted, so attacker-chosen tokens cannot
 * evade the limiter or exhaust its bucket map.
 */
function rateLimitKey(
	c: Context,
	trustProxy: boolean,
	validCredentials: string[],
): string {
	const auth = c.req.header("Authorization") ?? ""
	const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
	const credential = validCredentials.find((candidate) =>
		timingSafeBearerEquals(bearer, candidate),
	)
	if (credential) {
		return `credential:${createHash("sha256").update(credential, "utf8").digest("hex")}`
	}
	if (trustProxy) {
		const forwarded = (c.req.header("X-Forwarded-For") ?? "")
			.split(",")[0]
			?.trim()
		if (forwarded) {
			return `ip:${forwarded}`
		}
	}
	return "anonymous"
}

type RateBucket = { count: number; resetAt: number }

/**
 * Fixed-window in-memory rate limiter. State is per-app-instance (created in
 * createApp) so it never leaks across tests or app instances. Single-process
 * only; a shared store is out of scope (tracked with the durability work).
 */
function createRateLimiter(
	limit: number,
	windowMs: number,
	trustProxy: boolean,
	validCredentials: string[],
): MiddlewareHandler {
	const buckets = new Map<string, RateBucket>()
	// Sweep expired buckets at most once per window (amortized O(1)/request)
	// rather than scanning on every request once the map is large.
	let nextSweepAt = 0
	const tooManyResponse = (c: Context, retryAfterMs: number): Response => {
		c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
		return c.json(
			{ error: { code: "RATE_LIMITED", message: "rate limit exceeded" } },
			429,
		)
	}
	return async (c, next) => {
		const now = Date.now()
		if (now >= nextSweepAt) {
			for (const [key, bucket] of buckets) {
				if (now >= bucket.resetAt) {
					buckets.delete(key)
				}
			}
			nextSweepAt = now + windowMs
		}
		const key = rateLimitKey(c, trustProxy, validCredentials)
		let bucket = buckets.get(key)
		if (!bucket || now >= bucket.resetAt) {
			// Fail closed for new identities once saturated, so the limiter can
			// never be turned into a memory-exhaustion vector.
			if (!bucket && buckets.size >= RATE_LIMIT_MAX_BUCKETS) {
				return tooManyResponse(c, windowMs)
			}
			bucket = { count: 0, resetAt: now + windowMs }
			buckets.set(key, bucket)
		}
		bucket.count++
		if (bucket.count > limit) {
			return tooManyResponse(c, bucket.resetAt - now)
		}
		await next()
	}
}

// WS-01: the constant-time comparison now lives in @memongo/lib so the MCP
// HTTP transport shares it; re-exported here for existing importers.
export { timingSafeBearerEquals }

type ScopedApiKeyPolicy = {
	token: string
	agentIds?: string[]
	scopes?: string[]
	scopeRefs?: string[]
}

const WILDCARD = "*"
let unauthenticatedApiWarningEmitted = false

export function resetUnauthenticatedApiWarningForTests(): void {
	unauthenticatedApiWarningEmitted = false
}

// WS-08 / C-014: the TypeScript client (packages/client) sends
// `x-memongo-client-version` on every request; the server used to ignore the
// header entirely, so a stale client calling a newer API was invisible to
// operators. The middleware below reads it and warns once per (client,
// server) version pair on mismatch. Telemetry only — requests are never
// rejected for skew. Bounded so spoofed headers cannot spam the log: the
// dedup set is capped and absurdly long values are ignored.
const CLIENT_VERSION_HEADER = "x-memongo-client-version"
const MAX_SKEW_WARNED_PAIRS = 256
const MAX_CLIENT_VERSION_LENGTH = 64

export function createClientVersionSkewLogger(
	serverVersion: string,
): MiddlewareHandler {
	const warnedPairs = new Set<string>()
	return async (c, next) => {
		const clientVersion = c.req.header(CLIENT_VERSION_HEADER)?.trim()
		if (
			clientVersion &&
			clientVersion !== serverVersion &&
			clientVersion.length <= MAX_CLIENT_VERSION_LENGTH
		) {
			const pair = `${clientVersion} -> ${serverVersion}`
			if (!warnedPairs.has(pair) && warnedPairs.size < MAX_SKEW_WARNED_PAIRS) {
				warnedPairs.add(pair)
				console.warn(
					`memongo: client version skew — client ${clientVersion} calling server ${serverVersion} (header ${CLIENT_VERSION_HEADER})`,
				)
			}
		}
		await next()
	}
}

function asStringList(
	value: unknown,
	label: "agentIds" | "scopes" | "scopeRefs",
	token: string,
): string[] | undefined {
	if (value === undefined) {
		return undefined
	}
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((item) => typeof item !== "string" || item.trim() === "")
	) {
		throw new Error(
			`MEMONGO_API_SCOPED_KEYS policy for token ${token} must define ${label} as a non-empty array of non-empty strings`,
		)
	}
	return value.map((item) => (item as string).trim())
}

function normalizePolicy(raw: unknown): ScopedApiKeyPolicy | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return null
	}
	const item = raw as Record<string, unknown>
	const token = typeof item.token === "string" ? item.token.trim() : ""
	if (!token) {
		return null
	}
	return {
		token,
		agentIds: asStringList(item.agentIds, "agentIds", token),
		scopes: asStringList(item.scopes, "scopes", token),
		scopeRefs: asStringList(item.scopeRefs, "scopeRefs", token),
	}
}

function hasConcreteConstraint(values?: string[]): boolean {
	return values?.some((value) => value !== WILDCARD) ?? false
}

function requireValidScopedPolicies(
	policies: ScopedApiKeyPolicy[],
): ScopedApiKeyPolicy[] {
	if (policies.length === 0) {
		throw new Error(
			"MEMONGO_API_SCOPED_KEYS must define at least one scoped API key policy",
		)
	}
	const unconstrained = policies.find(
		(policy) =>
			!hasConcreteConstraint(policy.agentIds) &&
			!hasConcreteConstraint(policy.scopes) &&
			!hasConcreteConstraint(policy.scopeRefs),
	)
	if (unconstrained) {
		throw new Error(
			`MEMONGO_API_SCOPED_KEYS policy for token ${unconstrained.token} must constrain agentIds, scopes, or scopeRefs with at least one concrete value`,
		)
	}
	// Fail closed on a non-canonical scope value. Auth matches scope by raw
	// string, but request resolution (pickScope) only keeps canonical scopes, so
	// a policy scope outside the canonical set would authorize a request whose
	// scope execution silently drops — disabling write-forcing and letting a
	// nested entry.scope smuggle survive (issue #57 auth-vs-execution divergence).
	for (const policy of policies) {
		for (const [label, values] of [
			["agentIds", policy.agentIds],
			["scopes", policy.scopes],
			["scopeRefs", policy.scopeRefs],
		] as const) {
			if (values?.includes(WILDCARD) && values.length !== 1) {
				throw new Error(
					`MEMONGO_API_SCOPED_KEYS policy for token ${policy.token} must use "*" as the only ${label} value`,
				)
			}
		}
		const invalidScope = policy.scopes?.find(
			(scope) => scope !== WILDCARD && !isValidScope(scope),
		)
		if (invalidScope !== undefined) {
			throw new Error(
				`MEMONGO_API_SCOPED_KEYS policy for token ${policy.token} has an invalid scope "${invalidScope}"; valid scopes: session, user, agent, workspace, tenant, global`,
			)
		}
	}
	return policies
}

function routePolicyError(
	path: string,
	policy: ScopedApiKeyPolicy,
): string | null {
	if (path === "/v1/search-kb" && !hasConcreteConstraint(policy.scopeRefs)) {
		return "search-kb requires a concrete scopeRefs constraint for scoped API keys"
	}
	return null
}

export function parseScopedApiKeyPolicies(
	raw = process.env.MEMONGO_API_SCOPED_KEYS,
): ScopedApiKeyPolicy[] {
	const trimmed = raw?.trim()
	if (!trimmed) {
		return []
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed) as unknown
	} catch {
		throw new Error("MEMONGO_API_SCOPED_KEYS must be valid JSON")
	}
	if (Array.isArray(parsed)) {
		const policies = parsed
			.map((item) => normalizePolicy(item))
			.filter((item): item is ScopedApiKeyPolicy => item !== null)
		return requireValidScopedPolicies(policies)
	}
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const policies = Object.entries(parsed as Record<string, unknown>)
			.map(([token, policy]) =>
				normalizePolicy(
					policy && typeof policy === "object" && !Array.isArray(policy)
						? { token, ...(policy as Record<string, unknown>) }
						: { token },
				),
			)
			.filter((item): item is ScopedApiKeyPolicy => item !== null)
		return requireValidScopedPolicies(policies)
	}
	throw new Error("MEMONGO_API_SCOPED_KEYS must be a JSON array or object")
}

// Issue #57: identity resolution is shared with the route layer so auth and
// manager/partition selection can never disagree. See ./scope-identity.ts.
const readRequestScopeInput = resolveScopeInput
const firstStringField = resolveScopeField

function allowedByPolicy(
	label: string,
	actual: string | undefined,
	allowed: string[] | undefined,
): string | null {
	if (!allowed || allowed.includes(WILDCARD)) {
		return null
	}
	if (!actual) {
		return `${label} is required for this API key`
	}
	if (!allowed.includes(actual)) {
		return `${label} is not allowed for this API key`
	}
	return null
}

async function authorizeScopedApiKey(
	c: Context,
	policy: ScopedApiKeyPolicy,
): Promise<string | null> {
	const input = await readRequestScopeInput(c)
	const agentId = firstStringField(input, "agentId")
	const scope = firstStringField(input, "scope")
	const scopeRef =
		firstStringField(input, "scopeRef") ??
		firstStringField(input, "containerTag")
	return (
		allowedByPolicy("agentId", agentId, policy.agentIds) ??
		allowedByPolicy("scope", scope, policy.scopes) ??
		allowedByPolicy("scopeRef", scopeRef, policy.scopeRefs)
	)
}

/**
 * Agent-global /v1 routes: operations that read or mutate data across an
 * agent's whole memory (all scopes) — admin analytics, operational status,
 * background jobs, and agent-identity self-edits. They have no tenant scope to
 * filter by, so a scope-restricted key must NOT reach them (Class-G): it would
 * observe or act beyond its authorized scope/scopeRef.
 */
const AGENT_GLOBAL_V1_PATHS = new Set([
	"/v1/status",
	"/v1/status/detailed",
	"/v1/stats",
	"/v1/sync",
	"/v1/probes/embedding",
	"/v1/probes/vector",
	"/v1/read-file",
	"/v1/chain-trace",
	"/v1/self-edit",
])

const ADMIN_ONLY_V1_PATHS = new Set([
	"/v1/read-file",
	"/v1/import/conversations",
	// C-003: tenant erasure is irreversible; no scoped key (even an
	// agent-scoped one) may trigger it, only the global admin token.
	"/v1/admin/erase",
	// C-004: quarantine review. Listing exposes injection-classified payloads,
	// and promote/reject overrule the classifier — no agent credential (even
	// an agent-scoped key) may do either, or the quarantine it enforces is
	// self-defeating. Human reviewers use the global admin token via the
	// web console or MCP.
	"/v1/admin/quarantine",
	"/v1/admin/quarantine/promote",
	"/v1/admin/quarantine/reject",
])

function isAgentGlobalV1Path(path: string): boolean {
	if (AGENT_GLOBAL_V1_PATHS.has(path)) {
		return true
	}
	if (path.startsWith("/v1/admin/")) {
		return true
	}
	return path === "/v1/jobs" || path.startsWith("/v1/jobs/")
}

/**
 * A key is scope-constrained when its policy restricts scopes or scopeRefs to a
 * concrete allow-list (a wildcard is not a constraint). agentId-only keys are
 * not scope-constrained — agentId scoping is orthogonal to the tenant boundary.
 */
function policyIsScopeConstrained(policy: ScopedApiKeyPolicy): boolean {
	const constrains = (list?: string[]): boolean =>
		!!list && list.length > 0 && !list.includes(WILDCARD)
	return constrains(policy.scopes) || constrains(policy.scopeRefs)
}

/**
 * Graceful shutdown: Process-level graceful shutdown orchestrator.
 *
 * Registers listeners for SIGTERM / SIGINT that:
 *  1. Stop accepting new HTTP connections (`closeServer`).
 *  2. Close the memory bridge (flush access tracker, close Mongo clients via
 *     `closeAllMemorySearchManagers`).
 *  3. Call `exit(0)` when both succeed, or `exit(1)` if the timeout elapses
 *     first — never block the container runtime's kill window indefinitely.
 *
 * Server and bridge close are awaited in sequence (server first, so no new
 * requests land while the bridge is shutting down). The function accepts
 * the process and an `exit` function as injected dependencies so the test
 * suite can drive it without actually exiting.
 */
export type GracefulShutdownOptions = {
	signals: readonly NodeJS.Signals[]
	process: NodeJS.Process
	closeServer: () => Promise<void>
	closeBridge: () => Promise<void>
	exit: (code: number) => void
	/** Hard deadline for the full shutdown sequence before force-exit. */
	timeoutMs?: number
}

export function registerGracefulShutdown(
	options: GracefulShutdownOptions,
): void {
	const {
		signals,
		process: proc,
		closeServer,
		closeBridge,
		exit,
		timeoutMs = 10_000,
	} = options
	let shuttingDown = false

	const runShutdown = (signal: NodeJS.Signals): void => {
		if (shuttingDown) {
			return
		}
		shuttingDown = true

		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			// Cannot wait any longer — exit non-zero so orchestrators know we
			// shed work under duress instead of exiting cleanly.
			try {
				exit(1)
			} catch {
				// exit() may be a stub; ignore.
			}
		}, timeoutMs)
		// setTimeout handles have .unref() in Node — do not hold the event loop.
		if (
			typeof (timer as unknown as { unref?: () => void }).unref === "function"
		) {
			;(timer as unknown as { unref: () => void }).unref()
		}

		;(async () => {
			try {
				await closeServer()
			} catch (err) {
				console.error(
					`graceful shutdown: closeServer failed: ${formatErrorMessage(err)}`,
				)
			}
			try {
				await closeBridge()
			} catch (err) {
				console.error(
					`graceful shutdown: closeBridge failed: ${formatErrorMessage(err)}`,
				)
			}
			if (timedOut) {
				return
			}
			clearTimeout(timer)
			try {
				exit(0)
			} catch {
				// exit() may be a stub; ignore.
			}
			void signal // marker — signal identity recorded via the event only
		})()
	}

	for (const signal of signals) {
		proc.on(signal, () => runShutdown(signal))
	}
}

export function createApp(): Hono {
	const app = new Hono()
	app.use("*", secureHeaders())
	// P0.8: one canonical error envelope. Deliberate HTTPExceptions keep their
	// status/body; anything unexpected is logged with a request id and returned
	// as a generic INTERNAL 500 — never raw driver internals to the client.
	app.onError((err, c) => {
		if (err instanceof HTTPException) {
			return err.getResponse()
		}
		return internalError(c, err, "INTERNAL")
	})
	const token = process.env.MEMONGO_API_KEY?.trim()
	const scopedPolicies = parseScopedApiKeyPolicies()
	const rateLimitCredentials = [
		...(token ? [token] : []),
		...scopedPolicies.map((policy) => policy.token),
	]
	const corsPolicy = resolveCorsPolicy(process.env.MEMONGO_CORS_ORIGINS)
	const allowInsecureNoAuth = parseBoolEnv(
		process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH,
	)

	if (corsPolicy.origins.length > 0) {
		app.use("/*", cors({ origin: corsPolicy.origins }))
	}

	// Request id first on /v1 so every downstream error (rate limit, auth,
	// routes) can be correlated server-side via the P0.8 error envelope.
	app.use("/v1/*", requestId())

	// #28 network hardening on /v1: rate-limit first (cheapest rejection, also
	// throttles unauthenticated auth attempts), then cap body size before any
	// handler parses JSON. Set MEMONGO_API_RATE_LIMIT=0 to disable rate limiting.
	const rateLimit = parsePositiveIntEnv(
		process.env.MEMONGO_API_RATE_LIMIT,
		DEFAULT_RATE_LIMIT,
	)
	if (rateLimit > 0) {
		const windowMs = parseStrictlyPositiveIntEnv(
			process.env.MEMONGO_API_RATE_WINDOW_MS,
			DEFAULT_RATE_WINDOW_MS,
		)
		const trustProxy = parseBoolEnv(process.env.MEMONGO_TRUST_PROXY)
		app.use(
			"/v1/*",
			createRateLimiter(rateLimit, windowMs, trustProxy, rateLimitCredentials),
		)
	}
	// MEMONGO_API_MAX_BODY_BYTES=0 disables the cap (symmetric with the rate
	// limit) rather than rejecting every body.
	const maxBodyBytes = parsePositiveIntEnv(
		process.env.MEMONGO_API_MAX_BODY_BYTES,
		DEFAULT_MAX_BODY_BYTES,
	)
	if (maxBodyBytes > 0) {
		app.use(
			"/v1/*",
			bodyLimit({
				maxSize: maxBodyBytes,
				onError: (c) =>
					c.json(
						{
							error: {
								code: "PAYLOAD_TOO_LARGE",
								message: "request body exceeds the configured size limit",
							},
						},
						413,
					),
			}),
		)
	}

	if (token || scopedPolicies.length > 0) {
		app.use("/v1/*", async (c, next) => {
			const auth = c.req.header("Authorization") ?? ""
			const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
			if (token && timingSafeBearerEquals(bearer, token)) {
				await next()
				return
			}
			const scopedPolicy = scopedPolicies.find((policy) =>
				timingSafeBearerEquals(policy.token, bearer),
			)
			if (!scopedPolicy) {
				return c.json(
					{ error: { code: "UNAUTHORIZED", message: "unauthorized" } },
					401,
				)
			}
			const forbidden = await authorizeScopedApiKey(c, scopedPolicy)
			if (forbidden) {
				return c.json({ error: { code: "FORBIDDEN", message: forbidden } }, 403)
			}
			const routeForbidden = routePolicyError(c.req.path, scopedPolicy)
			if (routeForbidden) {
				return c.json(
					{ error: { code: "FORBIDDEN", message: routeForbidden } },
					403,
				)
			}
			if (ADMIN_ONLY_V1_PATHS.has(c.req.path)) {
				return c.json(
					{
						error: {
							code: "FORBIDDEN",
							// Covers every ADMIN_ONLY entry (server-file routes, bulk
							// import, tenant erasure) rather than just one of them.
							message: "scoped API key cannot access an admin-only route",
						},
					},
					403,
				)
			}
			// Class-G: a scope-constrained key may satisfy per-request authorization
			// (it supplies its allowed scope) yet still be reaching an agent-global
			// route that ignores scope entirely. Reject it — there is no tenant
			// boundary to enforce on such routes.
			if (
				policyIsScopeConstrained(scopedPolicy) &&
				isAgentGlobalV1Path(c.req.path)
			) {
				return c.json(
					{
						error: {
							code: "FORBIDDEN",
							message:
								"scope-restricted API key cannot access an agent-global route",
						},
					},
					403,
				)
			}
			await next()
		})
	} else if (allowInsecureNoAuth) {
		if (!unauthenticatedApiWarningEmitted) {
			unauthenticatedApiWarningEmitted = true
			console.warn(
				"WARNING: MEMONGO_ALLOW_INSECURE_NO_AUTH is enabled; /v1 routes are unauthenticated. Use only for trusted local development.",
			)
		}
	} else {
		app.use("/v1/*", async (c) =>
			c.json(
				{
					error: {
						code: "AUTH_NOT_CONFIGURED",
						message: "API authentication is required",
					},
				},
				401,
			),
		)
	}

	// WS-08 / C-014: after auth so only real (authenticated, or explicitly
	// insecure dev) client traffic contributes skew telemetry — spoofed
	// unauthenticated headers never reach it in a token-configured deployment.
	app.use("/v1/*", createClientVersionSkewLogger(MEMONGO_API_VERSION))

	app.get("/health", (c) => c.json({ ok: true, service: "memongo-api" }))
	// P1.7: readiness (deep) beside liveness (cheap). Unauthenticated like
	// /health — orchestrator probes carry no API key; the per-lane payload is
	// sanitized in lib/readiness.ts so it cannot leak secrets. 503 until every
	// required lane (mongo, vector, embedding) is up; the Docker HEALTHCHECK
	// and any orchestrator readiness probe should target this route.
	app.get("/ready", async (c) => {
		const report = await checkReadiness()
		return c.json(report, report.ok ? 200 : 503)
	})
	app.get("/openapi.json", (c) => c.json(openApiSpec))
	app.route("/v1", createV1Router())

	return app
}
