import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { openApiSpec } from "./openapi-spec.js"
import { createV1Router } from "./routes/v1.js"

type ScopedApiKeyPolicy = {
	token: string
	agentIds?: string[]
	scopes?: string[]
	scopeRefs?: string[]
}

const WILDCARD = "*"

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

export function createApp(): Hono {
	const app = new Hono()

	app.use("/*", cors())

	const token = process.env.MEMONGO_API_KEY?.trim()
	const scopedPolicies = parseScopedApiKeyPolicies()
	if (token || scopedPolicies.length > 0) {
		app.use("/v1/*", async (c, next) => {
			const auth = c.req.header("Authorization") ?? ""
			const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
			if (token && bearer === token) {
				await next()
				return
			}
			const scopedPolicy = scopedPolicies.find(
				(policy) => policy.token === bearer,
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
	}

	app.get("/health", (c) => c.json({ ok: true, service: "memongo-api" }))
	app.get("/openapi.json", (c) => c.json(openApiSpec))
	app.route("/v1", createV1Router())

	return app
}
