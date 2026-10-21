import type { MemoryResultRole } from "../../packages/memory-engine/src/types.js"

/**
 * Dated answer context lines shared by the official answer prompt and the
 * custom-v2 answer prompt. `passageDates` and `passageRoles` are
 * index-aligned with `contextPassages`; a passage with no date or role
 * renders without that prefix.
 */
export type DatedAnswerPassages = {
	contextPassages: string[]
	passageDates?: string[][]
	passageRoles?: Array<MemoryResultRole | undefined>
}

const DATED_ANSWER_ROLE_LABELS: Record<MemoryResultRole, string> = {
	user: "User",
	assistant: "Assistant",
	system: "System",
	tool: "Tool",
}

/** The question line, carrying its ask date when known. */
export function renderDatedQuestionLine(
	question: string,
	questionDate: string | undefined,
): string {
	return questionDate
		? `QUESTION (asked on ${questionDate}): ${question}`
		: `QUESTION: ${question}`
}

/**
 * B9-2: chunk text already carries its role label ("User: ..." from the
 * event renderer), so a second label from this prompt builder would read
 * "User: User: ...". The prompt only adds its own label when the passage
 * text does not already start with it.
 */
function passageAlreadyCarriesRoleLabel(
	passage: string,
	label: string,
): boolean {
	return passage.startsWith(`${label}:`) || passage.startsWith(`${label} :`)
}

/**
 * One numbered line per passage index in `order`, numbered by position in
 * `order`, each labeled with that passage's own date(s) and speaking role.
 */
export function renderDatedPassageLines(
	passages: DatedAnswerPassages,
	order: readonly number[],
): string[] {
	const lines: string[] = []
	order.forEach((index, position) => {
		const passage = passages.contextPassages[index]
		if (passage === undefined) return
		const dates = passages.passageDates?.[index] ?? []
		const role = passages.passageRoles?.[index]
		const label =
			role !== undefined ? (DATED_ANSWER_ROLE_LABELS[role] ?? role) : undefined
		const datePrefix = dates.length > 0 ? ` [${dates.join("; ")}]` : ""
		const rolePrefix =
			label !== undefined && !passageAlreadyCarriesRoleLabel(passage, label)
				? ` ${label}:`
				: ""
		lines.push(`[${position + 1}]${datePrefix}${rolePrefix} ${passage}`)
	})
	return lines
}

/**
 * One turn's text with its speaking-role label, under the B9-2 rule: the
 * label is added only when the text does not already start with it.
 */
export function roleLabeledText(
	text: string,
	role: MemoryResultRole | undefined,
): string {
	if (role === undefined) return text
	const label = DATED_ANSWER_ROLE_LABELS[role] ?? role
	return passageAlreadyCarriesRoleLabel(text, label)
		? text
		: `${label}: ${text}`
}
