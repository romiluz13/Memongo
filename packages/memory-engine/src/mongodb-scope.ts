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
