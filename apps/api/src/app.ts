import { createHash, timingSafeEqual } from "node:crypto"
import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { openApiSpec } from "./openapi-spec.js"
import { createV1Router } from "./routes/v1.js"

/**
 * Constant-time bearer comparison. Using `===` would short-circuit on the
 * first mismatched byte and leak the token prefix via response timing.
 * Hash both inputs before `timingSafeEqual` so different raw lengths do not
 * bypass the constant-time comparison. Empty bearers are always rejected so
 * the caller never matches by accident.
 */
export function timingSafeBearerEquals(a: string, b: string): boolean {
	if (!a || !b) {
		return false
	}
	const aDigest = createHash("sha256").update(a, "utf8").digest()
	const bDigest = createHash("sha256").update(b, "utf8").digest()
	return timingSafeEqual(aDigest, bDigest) && a.length === b.length
}

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

function asStringList(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined
	}
	if (!Array.isArray(value)) {
		return undefined
	}
	const values = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean)
	return values.length > 0 ? values : undefined
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
		agentIds: asStringList(item.agentIds),
		scopes: asStringList(item.scopes),
		scopeRefs: asStringList(item.scopeRefs),
	}
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
		(policy) => !policy.agentIds && !policy.scopes && !policy.scopeRefs,
	)
	if (unconstrained) {
		throw new Error(
			`MEMONGO_API_SCOPED_KEYS policy for token ${unconstrained.token} must constrain agentIds, scopes, or scopeRefs`,
		)
	}
	return policies
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

async function readRequestScopeInput(
	c: Context,
): Promise<Record<string, unknown>> {
	const query = c.req.query() as Record<string, unknown>
	if (c.req.method === "GET" || c.req.method === "HEAD") {
		return query
	}
	const contentType = c.req.header("Content-Type") ?? ""
	if (!contentType.toLowerCase().includes("application/json")) {
		return query
	}
	const body = (await c.req.raw
		.clone()
		.json()
		.catch(() => ({}))) as unknown
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return query
	}
	return { ...query, ...(body as Record<string, unknown>) }
}

function firstStringField(input: Record<string, unknown>, field: string) {
	const containers = [
		input,
		input.handle,
		input.entry,
		input.memory,
		input.params,
	].filter(
		(item): item is Record<string, unknown> =>
			!!item && typeof item === "object" && !Array.isArray(item),
	)
	for (const container of containers) {
		const value = container[field]
		if (typeof value === "string" && value.trim()) {
			return value.trim()
		}
	}
	return undefined
}

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
				const msg = err instanceof Error ? err.message : String(err)
				console.error(`graceful shutdown: closeServer failed: ${msg}`)
			}
			try {
				await closeBridge()
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				console.error(`graceful shutdown: closeBridge failed: ${msg}`)
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

	app.use("/*", cors())

	const token = process.env.MEMONGO_API_KEY?.trim()
	const scopedPolicies = parseScopedApiKeyPolicies()
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
			await next()
		})
	} else if (!unauthenticatedApiWarningEmitted) {
		unauthenticatedApiWarningEmitted = true
		console.warn(
			"WARNING: MEMONGO_API_KEY is not set and MEMONGO_API_SCOPED_KEYS is empty; /v1 routes are unauthenticated. Use only for trusted local development.",
		)
	}

	app.get("/health", (c) => c.json({ ok: true, service: "memongo-api" }))
	app.get("/openapi.json", (c) => c.json(openApiSpec))
	app.route("/v1", createV1Router())

	return app
}
