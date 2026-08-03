import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { MemoryScope } from "@memongo/lib"

type ScopeRefParams = {
	scope?: MemoryScope
	agentId: string
	sessionId?: string
	workspaceDir?: string
	userId?: string
	tenantId?: string
	scopeRef?: string
}

function hashWorkspacePath(workspaceDir: string): string {
	const resolved = fs.existsSync(workspaceDir)
		? fs.realpathSync.native(workspaceDir)
		: path.resolve(workspaceDir)
	return createHash("sha256").update(resolved).digest("hex").slice(0, 16)
}

export function resolveScopeRef(params: ScopeRefParams): string {
	if (params.scopeRef?.trim()) {
		return params.scopeRef.trim()
	}

	const scope = params.scope ?? "agent"
	switch (scope) {
		case "session":
			if (!params.sessionId?.trim()) {
				throw new Error("session scope requires sessionId")
			}
			return `session:${params.sessionId.trim()}`
		case "user":
			if (!params.userId?.trim()) {
				throw new Error("user scope requires userId")
			}
			return `user:${params.userId.trim()}`
		case "agent":
			return `agent:${params.agentId}`
		case "workspace":
			if (!params.workspaceDir?.trim()) {
				return `workspace:${params.agentId}`
			}
			return `workspace:${hashWorkspacePath(params.workspaceDir)}`
		case "tenant":
			if (!params.tenantId?.trim()) {
				throw new Error("tenant scope requires tenantId")
			}
			return `tenant:${params.tenantId.trim()}`
		case "global":
			return "global"
	}
}

// ---------------------------------------------------------------------------
// Canonical scope identity (P2.3)
// ---------------------------------------------------------------------------

/**
 * The identity model every Memongo read and write is confined to:
 *
 *   { agentId, scope, scopeRef, sessionId? }
 *
 * `agentId` is the owning agent; `scope` + `scopeRef` are the tenant partition
 * the document lives in (and the only partition a read may touch);
 * `sessionId` is conversational metadata that ALSO acts as a scope hint.
 *
 * ONE rule resolves the scope on both directions, so a write and the search
 * meant to find it can never land in different partitions:
 *
 *   1. an explicit `scope` always wins;
 *   2. otherwise a present `sessionId` (writes) / `sessionKey` (reads —
 *      callers map it onto `sessionId` here) implies `scope: "session"`;
 *   3. otherwise the caller-provided `defaultScope` applies. Reads pass the
 *      `MEMONGO_SEARCH_DEFAULT_SCOPE`-resolved value (P1.4); writes omit it
 *      and fall through to `"agent"`.
 *
 * Before P2.3, rule 2 existed only on reads: `add({ content, sessionId })`
 * wrote to `agent:<id>` while `search({ query, sessionKey })` read from
 * `session:<id>`, so the two directions silently hit different partitions.
 */
export type ScopeIdentity = {
	scope: MemoryScope
	scopeRef: string
}

export function resolveScopeIdentity(params: {
	scope?: MemoryScope
	scopeRef?: string
	agentId: string
	/** Writes pass sessionId; reads pass their sessionKey here. */
	sessionId?: string
	workspaceDir?: string
	userId?: string
	tenantId?: string
	/**
	 * Fallback when neither scope nor sessionId is present. Reads pass the
	 * env-resolved search default; writes omit it (rule 3 -> "agent").
	 */
	defaultScope?: MemoryScope
}): ScopeIdentity {
	const sessionId = params.sessionId?.trim() || undefined
	const scope: MemoryScope =
		params.scope ?? (sessionId ? "session" : (params.defaultScope ?? "agent"))
	const scopeRef = resolveScopeRef({
		scope,
		scopeRef: params.scopeRef,
		agentId: params.agentId,
		sessionId,
		workspaceDir: params.workspaceDir,
		userId: params.userId,
		tenantId: params.tenantId,
	})
	return { scope, scopeRef }
}
