import type { MemoryScope } from "@memongo/lib"

export type MemoryEvalSeedStep =
	| {
			kind: "write-event"
			agentId: string
			sessionId: string
			role: "user" | "assistant" | "system" | "tool"
			body: string
			timestamp: string
			scope?: MemoryScope
	  }
	| {
			kind: "write-structured"
			agentId: string
			entry: Record<string, unknown>
	  }
	| {
			kind: "write-procedure"
			agentId: string
			entry: Record<string, unknown>
	  }

export type SearchDetailedEvalCase = {
	id: string
	title: string
	tags?: string[]
	kind: "search-detailed"
	request: {
		agentId: string
		query: string
		limit?: number
		searchMode?: "auto" | "direct" | "agentic"
		sourcePreference?: string[]
		needExactEvidence?: boolean
		returnPlan?: boolean
		conversationScope?: { sessionKey?: string }
		structuredScope?: {
			type?: string
			state?: string | string[]
			salience?: string[]
		}
	}
	expect: {
		mustIncludeAll?: string[]
		mustExcludeAll?: string[]
		pathPrefixesAny?: string[]
		evidenceAtLeast?: "none" | "indirect" | "partial" | "direct"
		topConfidenceAtLeast?: "low" | "medium" | "high"
		expectNoResults?: boolean
		requireNoDirectEvidenceReason?: boolean
	}
}

export type HydrateActiveSlateEvalCase = {
	id: string
	title: string
	tags?: string[]
	kind: "hydrate-active-slate"
	request: {
		agentId: string
		scope?: MemoryScope
		scopeRef?: string
		maxItems?: number
	}
	expect: {
		maxItemsAtMost?: number
		mustIncludeKinds?: string[]
		mustIncludeText?: string[]
	}
}

export type DiscoveryProjectionEvalCase = {
	id: string
	title: string
	tags?: string[]
	kind: "discovery-projection"
	request: {
		agentId: string
		kind:
			| "entity-brief"
			| "topic-brief"
			| "what-changed"
			| "contradiction-report"
		query?: string
		scope?: MemoryScope
		scopeRef?: string
		maxItems?: number
		timeRange?: { preset?: string; start?: string; end?: string }
	}
	expect: {
		mustIncludeSectionTitles?: string[]
		mustIncludeText?: string[]
		pathPrefixesAny?: string[]
	}
}

export type ContextBundleEvalCase = {
	id: string
	title: string
	tags?: string[]
	kind: "context-bundle"
	request: {
		agentId: string
		query?: string
		scope?: MemoryScope
		scopeRef?: string
		sessionId?: string
		tokenBudget?: number
		maxActiveItems?: number
		maxEvidenceItems?: number
		maxRecentEvents?: number
		includeDiscoveryProjection?: boolean
		discoveryKind?:
			| "entity-brief"
			| "topic-brief"
			| "what-changed"
			| "contradiction-report"
		includeProfile?: boolean
		timeRange?: { preset?: string; start?: string; end?: string }
	}
	expect: {
		mustIncludeSectionKinds?: string[]
		mustIncludeText?: string[]
		mustExcludeText?: string[]
		maxTokensAtMost?: number
	}
}

export type MemoryEvalCase =
	| SearchDetailedEvalCase
	| HydrateActiveSlateEvalCase
	| DiscoveryProjectionEvalCase
	| ContextBundleEvalCase

export type MemoryEvalFixture = {
	id: string
	primaryAgentId: string
	secondaryAgentId: string
	primarySessionId: string
	secondarySessionId: string
	seed: MemoryEvalSeedStep[]
	cases: MemoryEvalCase[]
}

function isoOffset(base: Date, offsetMinutes: number): string {
	return new Date(base.getTime() + offsetMinutes * 60 * 1000).toISOString()
}

export function buildPhase6MemoryEvalFixture(
	seed = "phase6-eval",
): MemoryEvalFixture {
	const primaryAgentId = `${seed}-primary`
	const secondaryAgentId = `${seed}-secondary`
	const primarySessionId = `${seed}-session-main`
	const secondarySessionId = `${seed}-session-side`
	const agentScopeRef = `agent:${primaryAgentId}`
	const now = new Date()
	const anchor = new Date(now.getTime() - 90 * 60 * 1000)

	return {
		id: seed,
		primaryAgentId,
		secondaryAgentId,
		primarySessionId,
		secondarySessionId,
		seed: [
			{
				kind: "write-event",
				agentId: primaryAgentId,
				sessionId: primarySessionId,
				role: "user",
				scope: "session",
				timestamp: isoOffset(anchor, 0),
				body: "Please remember exactly: the launch codeword is Blue Finch.",
			},
			{
				kind: "write-event",
				agentId: primaryAgentId,
				sessionId: primarySessionId,
				role: "assistant",
				scope: "session",
				timestamp: isoOffset(anchor, 1),
				body: "Stored. The launch codeword is Blue Finch.",
			},
			{
				kind: "write-event",
				agentId: primaryAgentId,
				sessionId: secondarySessionId,
				role: "user",
				scope: "session",
				timestamp: isoOffset(anchor, 2),
				body: "In this side thread, Sarah owns the Phoenix rollback.",
			},
			{
				kind: "write-event",
				agentId: primaryAgentId,
				sessionId: primarySessionId,
				role: "user",
				scope: "session",
				timestamp: isoOffset(anchor, 3),
				body: "In this main thread, Marcus owns the Phoenix rollback.",
			},
			{
				kind: "write-structured",
				agentId: primaryAgentId,
				entry: {
					type: "decision",
					key: "phoenix-release-window",
					value: "Phoenix deploys on Friday afternoon.",
					source: "agent",
					scope: "agent",
					salience: "critical",
					state: "active",
					agentId: primaryAgentId,
					sessionId: primarySessionId,
					tags: ["phoenix", "deploy", "release"],
				},
			},
			{
				kind: "write-structured",
				agentId: primaryAgentId,
				entry: {
					type: "decision",
					key: "phoenix-release-window",
					value: "Phoenix deploys on Monday afternoon after validation.",
					source: "agent",
					scope: "agent",
					salience: "critical",
					state: "active",
					agentId: primaryAgentId,
					sessionId: primarySessionId,
					tags: ["phoenix", "deploy", "release"],
				},
			},
			{
				kind: "write-structured",
				agentId: primaryAgentId,
				entry: {
					type: "project",
					key: "phoenix-current-blocker",
					value:
						"Atlas Local preview validation is blocking the Phoenix launch.",
					source: "agent",
					scope: "agent",
					salience: "critical",
					state: "active",
					agentId: primaryAgentId,
					sessionId: primarySessionId,
					tags: ["phoenix", "blocker", "validation"],
				},
			},
			{
				kind: "write-procedure",
				agentId: primaryAgentId,
				entry: {
					procedureId: "phoenix-rollback",
					name: "Phoenix rollback runbook",
					intentTags: ["phoenix", "rollback"],
					steps: [
						"Check health dashboards",
						"Roll back the deployment",
						"Notify the release channel",
					],
					scope: "agent",
					agentId: primaryAgentId,
					sessionId: primarySessionId,
				},
			},
			{
				kind: "write-procedure",
				agentId: primaryAgentId,
				entry: {
					procedureId: "phoenix-rollback",
					name: "Phoenix rollback runbook",
					intentTags: ["phoenix", "rollback"],
					steps: [
						"Check health dashboards",
						"Run proof-pack and capability stress",
						"Roll back the deployment",
						"Notify the release channel",
					],
					scope: "agent",
					agentId: primaryAgentId,
					sessionId: primarySessionId,
				},
			},
			{
				kind: "write-structured",
				agentId: primaryAgentId,
				entry: {
					type: "fact",
					key: "phoenix-approval-policy",
					value: "Phoenix requires only Marcus approval.",
					source: "agent",
					scope: "agent",
					salience: "high",
					state: "conflicted",
					agentId: primaryAgentId,
					sessionId: primarySessionId,
					tags: ["phoenix", "approval", "conflict"],
				},
			},
			{
				kind: "write-procedure",
				agentId: primaryAgentId,
				entry: {
					procedureId: "phoenix-contingency",
					name: "Phoenix contingency escalation",
					intentTags: ["phoenix", "contingency"],
					steps: ["Page Marcus only", "Skip proof lanes"],
					scope: "agent",
					state: "conflicted",
					agentId: primaryAgentId,
					sessionId: primarySessionId,
				},
			},
			{
				kind: "write-event",
				agentId: secondaryAgentId,
				sessionId: `${seed}-session-foreign`,
				role: "user",
				scope: "session",
				timestamp: isoOffset(anchor, 4),
				body: "The foreign launch codeword is Red Kite.",
			},
		],
		cases: [
			{
				id: "current-release-window",
				title: "Current release-window recall prefers latest durable truth",
				tags: ["stale-supersession", "current-state"],
				kind: "search-detailed",
				request: {
					agentId: primaryAgentId,
					query: "What is the current Phoenix release window?",
					limit: 4,
					searchMode: "agentic",
					sourcePreference: ["structured"],
					needExactEvidence: true,
					returnPlan: true,
					structuredScope: {
						state: "active",
						salience: ["critical", "high"],
					},
				},
				expect: {
					mustIncludeAll: ["Monday"],
					mustExcludeAll: ["Friday"],
					pathPrefixesAny: ["structured:"],
					evidenceAtLeast: "partial",
					topConfidenceAtLeast: "medium",
				},
			},
			{
				id: "no-scope-leak-red-kite",
				title: "Unknown foreign-agent fact abstains instead of leaking",
				tags: ["scope-isolation", "abstention", "false-confidence"],
				kind: "search-detailed",
				request: {
					agentId: primaryAgentId,
					query: "What is the Red Kite launch codeword?",
					limit: 4,
					searchMode: "direct",
					needExactEvidence: true,
					returnPlan: true,
				},
				expect: {
					expectNoResults: true,
					requireNoDirectEvidenceReason: true,
				},
			},
			{
				id: "session-owner-isolation",
				title: "Conversation scope keeps rollback ownership session-safe",
				tags: ["scope-isolation", "conversation-scope"],
				kind: "search-detailed",
				request: {
					agentId: primaryAgentId,
					query: "Who owns the Phoenix rollback in this thread?",
					limit: 4,
					searchMode: "agentic",
					sourcePreference: ["conversation"],
					needExactEvidence: true,
					returnPlan: true,
					conversationScope: {
						sessionKey: primarySessionId,
					},
				},
				expect: {
					mustIncludeAll: ["Marcus"],
					mustExcludeAll: ["Sarah"],
					pathPrefixesAny: ["events/"],
					evidenceAtLeast: "partial",
				},
			},
			{
				id: "active-slate",
				title:
					"Tiny active slate stays bounded and surfaces blocker plus runbook",
				tags: ["active-slate"],
				kind: "hydrate-active-slate",
				request: {
					agentId: primaryAgentId,
					scope: "agent",
					scopeRef: agentScopeRef,
					maxItems: 6,
				},
				expect: {
					maxItemsAtMost: 6,
					mustIncludeKinds: ["active-critical", "procedure"],
					mustIncludeText: [
						"Atlas Local preview validation",
						"Phoenix rollback runbook",
					],
				},
			},
			{
				id: "what-changed",
				title: "What-changed projection summarizes durable updates",
				tags: ["temporal", "projection"],
				kind: "discovery-projection",
				request: {
					agentId: primaryAgentId,
					kind: "what-changed",
					scope: "agent",
					scopeRef: agentScopeRef,
					maxItems: 6,
					timeRange: {
						preset: "last-7d",
					},
				},
				expect: {
					mustIncludeSectionTitles: ["Structured changes", "Procedure changes"],
					mustIncludeText: [
						"Monday afternoon",
						"Run proof-pack and capability stress",
					],
					pathPrefixesAny: ["structured:", "procedure:"],
				},
			},
			{
				id: "contradiction-report",
				title: "Contradiction report surfaces conflicted durable memory",
				tags: ["contradiction", "projection"],
				kind: "discovery-projection",
				request: {
					agentId: primaryAgentId,
					kind: "contradiction-report",
					scope: "agent",
					scopeRef: agentScopeRef,
					maxItems: 6,
				},
				expect: {
					mustIncludeSectionTitles: [
						"Structured contradictions",
						"Procedure contradictions",
					],
					mustIncludeText: ["Marcus approval", "Skip proof lanes"],
					pathPrefixesAny: ["structured:", "procedure:"],
				},
			},
			{
				id: "context-bundle-handoff",
				title:
					"Context bundle assembles latest durable truth, blocker, and session-safe recall",
				tags: ["context-bundle", "stale-supersession", "scope-isolation"],
				kind: "context-bundle",
				request: {
					agentId: primaryAgentId,
					query: "Phoenix handoff brief",
					scope: "agent",
					scopeRef: agentScopeRef,
					sessionId: primarySessionId,
					tokenBudget: 260,
					maxEvidenceItems: 4,
					maxRecentEvents: 4,
					includeDiscoveryProjection: true,
					discoveryKind: "topic-brief",
				},
				expect: {
					mustIncludeSectionKinds: [
						"active-slate",
						"query-evidence",
						"recent-events",
					],
					mustIncludeText: [
						"Monday afternoon",
						"Atlas Local preview validation",
						"Marcus",
					],
					mustExcludeText: ["Friday afternoon", "Sarah"],
					maxTokensAtMost: 260,
				},
			},
		],
	}
}
