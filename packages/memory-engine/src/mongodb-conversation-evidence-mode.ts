export type ConversationEvidenceMode = "parallel" | "serial" | "disabled"

export function resolveConversationEvidenceMode(
	value: string | undefined,
): ConversationEvidenceMode {
	const normalized = value?.trim().toLowerCase()
	if (!normalized) {
		return "parallel"
	}
	if (
		normalized === "parallel" ||
		normalized === "serial" ||
		normalized === "disabled"
	) {
		return normalized
	}
	throw new Error(
		`MEMONGO_CONVERSATION_EVIDENCE_MODE must be "parallel", "serial", or "disabled"; received "${value}"`,
	)
}
