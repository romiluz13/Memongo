/**
 * M2 T13 (#120): the tenant identity every tenant-owned read confines itself
 * to. A read is confined by `agentId`, `scope` and `scopeRef`; an absent part
 * is a typed failure, never an unfiltered read and never a substitute value.
 */
import { type MemoryScope, isMemoryScopeValue } from "@memongo/lib"

export type TenantIdentity = {
	agentId: string
	scope: MemoryScope
	scopeRef: string
}

export class TenantIdentityRequiredError extends Error {
	readonly code = "TENANT_IDENTITY_REQUIRED"

	constructor(
		readonly operation: string,
		readonly missing: readonly ("agentId" | "scope" | "scopeRef")[],
	) {
		super(`${operation} requires ${missing.join(" and ")}`)
		this.name = "TenantIdentityRequiredError"
	}
}

export function isTenantIdentityRequiredError(
	err: unknown,
): err is TenantIdentityRequiredError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "TENANT_IDENTITY_REQUIRED"
	)
}

function present(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
}

/**
 * Narrow possibly-absent identity parts to a full identity or throw
 * `TenantIdentityRequiredError`, naming every part that is missing or, for
 * `scope`, not a memory scope.
 */
export function requireTenantIdentity(
	operation: string,
	identity: { agentId?: unknown; scope?: unknown; scopeRef?: unknown },
): TenantIdentity {
	const missing: ("agentId" | "scope" | "scopeRef")[] = []
	if (!present(identity.agentId)) missing.push("agentId")
	if (!present(identity.scope) || !isMemoryScopeValue(identity.scope)) {
		missing.push("scope")
	}
	if (!present(identity.scopeRef)) missing.push("scopeRef")
	if (missing.length > 0) {
		throw new TenantIdentityRequiredError(operation, missing)
	}
	return {
		agentId: identity.agentId as string,
		scope: identity.scope as MemoryScope,
		scopeRef: (identity.scopeRef as string).trim(),
	}
}
