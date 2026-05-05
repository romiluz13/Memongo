import { type MemongoConfig, resolveUserPath } from "@memongo/lib"

type AgentMemorySearchConfig = {
	extraPaths?: string[]
}

type AgentConfigShape = {
	id?: string
	workspace?: string
	memorySearch?: AgentMemorySearchConfig
}

type AgentsShape = Record<string, unknown> & {
	defaults?: AgentConfigShape
	list?: AgentConfigShape[]
}

function isAgentConfigShape(value: unknown): value is AgentConfigShape {
	return typeof value === "object" && value !== null
}

function getAgents(cfg: MemongoConfig): AgentsShape | undefined {
	return typeof cfg.agents === "object" && cfg.agents !== null
		? (cfg.agents as AgentsShape)
		: undefined
}

export function resolveAgentConfig(
	cfg: MemongoConfig,
	agentId: string,
): AgentConfigShape | undefined {
	const agents = getAgents(cfg)
	const direct = agents?.[agentId]
	if (isAgentConfigShape(direct)) {
		return direct
	}
	if (Array.isArray(agents?.list)) {
		const fromList = agents.list.find(
			(entry) => isAgentConfigShape(entry) && entry.id === agentId,
		)
		if (fromList) {
			return fromList
		}
	}
	return undefined
}

export function resolveAgentWorkspaceDir(
	cfg: MemongoConfig,
	agentId: string,
): string {
	const agentConfig = resolveAgentConfig(cfg, agentId)
	const defaults = getAgents(cfg)?.defaults
	const workspace =
		agentConfig?.workspace?.trim() || defaults?.workspace?.trim()
	return workspace
		? resolveUserPath(workspace)
		: resolveUserPath(`~/.memongo/agents/${agentId}`)
}

export function resolveAgentMemorySearchExtraPaths(
	cfg: MemongoConfig,
	agentId: string,
): string[] | undefined {
	const agentConfig = resolveAgentConfig(cfg, agentId)
	const defaults = getAgents(cfg)?.defaults
	return (
		agentConfig?.memorySearch?.extraPaths ?? defaults?.memorySearch?.extraPaths
	)
}
