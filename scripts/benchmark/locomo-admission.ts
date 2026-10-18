import type {
	MemoryBenchmarkConversation,
	MemoryBenchmarkScenario,
	MemoryBenchmarkTurn,
} from "../../packages/memory-engine/src/types.js"
import {
	type BenchmarkAdapterDiagnostic,
	type BenchmarkAdapterDiagnosticReason,
	type BenchmarkAdapterDiagnostics,
	BenchmarkAdapterRejectedError,
	summarizeAdapterDiagnostics,
} from "./benchmark-adapter-diagnostics.js"
import type { BenchmarkEvaluationCase } from "./longmemeval-admission.js"

type SourceRecord = Record<string, unknown>

function isPlainObject(value: unknown): value is SourceRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function trimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : ""
}

/** Decision 1, as in the LongMemEval adapter. */
function readGold(value: unknown): { answer: string; numeric: boolean } | null {
	if (typeof value === "string" && value.trim().length > 0)
		return { answer: value, numeric: false }
	if (typeof value === "number" && Number.isFinite(value))
		return { answer: String(value), numeric: true }
	return null
}

const SESSION_KEY = /^session_(\d+)$/

/** OPEN-25: one raw evidence string, split on `;` and whitespace. */
function evidenceTokens(entry: string): string[] {
	return entry.split(/[;\s]+/).filter((token) => token.length > 0)
}

/**
 * OPEN-9 B and OPEN-25: an absent list is empty; otherwise every entry is a
 * nonblank string yielding at least one token. Null when malformed; else the
 * unique tokens in source order.
 */
function readEvidence(item: SourceRecord): string[] | null {
	if (!Object.hasOwn(item, "evidence")) return []
	if (!Array.isArray(item.evidence)) return null
	const tokens = new Set<string>()
	for (const entry of item.evidence) {
		if (typeof entry !== "string") return null
		const entryTokens = evidenceTokens(entry)
		if (entryTokens.length === 0) return null
		for (const token of entryTokens) tokens.add(token)
	}
	return [...tokens]
}

/** OPEN-16 A: every dialog id any QA item names, whatever that item's fate. */
function referencedDialogIds(qa: unknown[]): Set<string> {
	const ids = new Set<string>()
	for (const item of qa)
		if (isPlainObject(item) && Array.isArray(item.evidence))
			for (const entry of item.evidence)
				if (typeof entry === "string")
					for (const token of evidenceTokens(entry)) ids.add(token)
	return ids
}

type AdmittedTurn = {
	role: "user" | "assistant"
	body: string
	speaker: string
	dialogId: string
}

/** Table 3.3 in row order; the first failure is the turn's single entry. */
function admitTurn(
	value: unknown,
	speakerA: string,
	speakerB: string,
	referenced: Set<string>,
): AdmittedTurn | { reason: BenchmarkAdapterDiagnosticReason } {
	if (!isPlainObject(value)) return { reason: "turn-not-object" }
	const speaker = trimmedString(value.speaker)
	if (!speaker) return { reason: "turn-invalid-speaker" }
	if (speaker !== speakerA && speaker !== speakerB)
		return { reason: "turn-unknown-speaker" }
	if (typeof value.text !== "string")
		return { reason: "turn-content-not-string" }
	const dialogId = trimmedString(value.dia_id)
	const body = value.text.trim()
	if (!body)
		return {
			reason:
				dialogId && referenced.has(dialogId)
					? "turn-empty-evidence"
					: "skipped-empty-turn",
		}
	return {
		role: speaker === speakerA ? "user" : "assistant",
		body,
		speaker,
		dialogId,
	}
}

/**
 * Decision 2 session walk: every `session_<digits>` key is inspected. Canonical
 * keys 1..M are admitted, rejected or reported as a gap; non-canonical keys are
 * `session-invalid-key` (OPEN-15 A). Canonical entries come in session order;
 * invalid-key entries follow them and carry no sessionIndex, because such a key
 * has no position in the 1..M walk (lead ruling on 1210 decision 3).
 */
function walkSessions(params: {
	conversation: SourceRecord
	sampleId: string
	sampleIndex: number
	speakerA: string
	speakerB: string
	referenced: Set<string>
}): {
	entries: BenchmarkAdapterDiagnostic[]
	conversations: MemoryBenchmarkConversation[]
	dialogSessions: Map<string, string>
} {
	const { conversation, sampleId, sampleIndex } = params
	const canonical = new Set<number>()
	let invalidKeys = 0
	for (const key of Object.keys(conversation)) {
		const digits = SESSION_KEY.exec(key)?.[1]
		if (digits === undefined) continue
		if (digits.startsWith("0")) invalidKeys++
		else canonical.add(Number(digits))
	}
	const entries: BenchmarkAdapterDiagnostic[] = []
	const conversations: MemoryBenchmarkConversation[] = []
	const dialogSessions = new Map<string, string>()
	const at = (sessionIndex: number) => ({
		format: "locomo" as const,
		sampleIndex,
		sessionIndex,
	})
	for (let index = 1; index <= Math.max(0, ...canonical); index++) {
		const sessionKey = `session_${index}`
		const sessionIndex = index - 1
		const session = conversation[sessionKey]
		if (!canonical.has(index) || !Array.isArray(session)) {
			entries.push({
				...at(sessionIndex),
				reason: canonical.has(index) ? "session-not-array" : "session-gap",
			})
			continue
		}
		const sessionId = `${sampleId}::${sessionKey}`
		const date = conversation[`${sessionKey}_date_time`]
		const timestamp =
			typeof date === "string" && date.trim().length > 0
				? date.trim()
				: undefined
		const turns: MemoryBenchmarkTurn[] = []
		const turnEntries: BenchmarkAdapterDiagnostic[] = []
		for (const [turnIndex, value] of session.entries()) {
			const admitted = admitTurn(
				value,
				params.speakerA,
				params.speakerB,
				params.referenced,
			)
			if ("reason" in admitted) {
				turnEntries.push({
					...at(sessionIndex),
					turnIndex,
					reason: admitted.reason,
				})
				continue
			}
			if (admitted.dialogId) dialogSessions.set(admitted.dialogId, sessionId)
			turns.push({
				role: admitted.role,
				body: admitted.body,
				timestamp,
				metadata: {
					benchmarkDatasetKind: "locomo",
					locomoDialogId: admitted.dialogId || undefined,
					locomoSpeaker: admitted.speaker,
				},
			})
		}
		if (turns.length === 0)
			entries.push({ ...at(sessionIndex), reason: "session-emptied" })
		entries.push(...turnEntries)
		if (turns.length > 0)
			conversations.push({ conversationId: sampleId, sessionId, turns })
	}
	for (let count = 0; count < invalidKeys; count++)
		entries.push({
			format: "locomo",
			sampleIndex,
			reason: "session-invalid-key",
		})
	return {
		entries,
		conversations,
		dialogSessions,
	}
}

type SampleAdmission = {
	entries: BenchmarkAdapterDiagnostic[]
	scenario: MemoryBenchmarkScenario | null
}

function admitSample(value: unknown, sampleIndex: number): SampleAdmission {
	const reject = (
		reason: BenchmarkAdapterDiagnosticReason,
	): SampleAdmission => ({
		entries: [{ format: "locomo", sampleIndex, reason }],
		scenario: null,
	})
	if (!isPlainObject(value)) return reject("sample-not-object")
	const sampleId = trimmedString(value.sample_id)
	if (!sampleId) return reject("sample-invalid-id")
	const conversation = value.conversation
	if (!isPlainObject(conversation)) return reject("sample-invalid-conversation")
	const qa = value.qa
	if (!Array.isArray(qa)) return reject("sample-invalid-qa")
	const speakerA = trimmedString(conversation.speaker_a)
	const speakerB = trimmedString(conversation.speaker_b)
	if (!speakerA || !speakerB || speakerA === speakerB)
		return reject("sample-invalid-speakers")
	const { entries, conversations, dialogSessions } = walkSessions({
		conversation,
		sampleId,
		sampleIndex,
		speakerA,
		speakerB,
		referenced: referencedDialogIds(qa),
	})

	const evaluations: BenchmarkEvaluationCase[] = []
	for (const [qaIndex, item] of qa.entries()) {
		const rejectQa = (reason: BenchmarkAdapterDiagnosticReason) =>
			entries.push({ format: "locomo", sampleIndex, qaIndex, reason })
		if (!isPlainObject(item)) {
			rejectQa("qa-not-object")
			continue
		}
		const query = trimmedString(item.question)
		if (!query) {
			rejectQa("qa-invalid-question")
			continue
		}
		const category = item.category
		if (
			typeof category !== "number" ||
			!Number.isInteger(category) ||
			category < 1 ||
			category > 5
		) {
			rejectQa("qa-invalid-category")
			continue
		}
		const abstention = category === 5
		const gold = abstention ? null : readGold(item.answer)
		if (!abstention && !gold) {
			rejectQa("qa-invalid-gold")
			continue
		}
		const evidence = readEvidence(item)
		if (!evidence) {
			rejectQa("qa-invalid-evidence")
			continue
		}
		if (!evidence.every((dialogId) => dialogSessions.has(dialogId))) {
			rejectQa("qa-evidence-unresolved")
			continue
		}
		// OPEN-23: category-5 references are validated, then stay reference-only.
		const expectedDialogIds = abstention ? [] : evidence
		const ineligibleReason = abstention
			? ("abstention" as const)
			: evidence.length === 0
				? ("no-evidence" as const)
				: null
		evaluations.push({
			caseId: `${sampleId}::qa_${qaIndex + 1}`,
			query,
			expectedSessionIds: Array.from(
				new Set(
					expectedDialogIds.flatMap(
						(dialogId) => dialogSessions.get(dialogId) ?? [],
					),
				),
			),
			expectedDialogIds,
			...(ineligibleReason
				? {
						officialRetrieval: {
							evaluator: "locomo-evidence" as const,
							eligible: false,
							expectedSessionIds: [],
							expectedTurnIds: [],
							ineligibleReason,
						},
					}
				: {}),
			...(gold ? { answer: gold.answer } : {}),
			...(gold?.numeric ? { goldAnswerSourceType: "number" as const } : {}),
			questionType: `category-${category}`,
			abstention,
			metadata: {
				benchmarkDatasetKind: "locomo",
				locomoCategory: category,
				evidence: Array.isArray(item.evidence) ? item.evidence : [],
				...(abstention && Object.hasOwn(item, "answer")
					? { locomoReferenceAnswer: item.answer }
					: {}),
				...(abstention && Object.hasOwn(item, "adversarial_answer")
					? { locomoAdversarialAnswer: item.adversarial_answer }
					: {}),
			},
		})
	}
	return {
		entries,
		scenario: { scenarioId: sampleId, conversations, evaluations },
	}
}

/**
 * OPEN-26 (1) and 1206 Q5: identity faults over every structurally inspectable
 * source identity, including those under an ancestor that is rejected later.
 * Generated ids (`<sample>::session_<N>`, `<sample>::qa_<k>`) cannot collide
 * once sample ids are unique, because their suffixes end in digits only.
 */
function preflightLoCoMoIdentity(entries: unknown[]): void {
	const sampleIds = new Set<string>()
	for (const value of entries) {
		if (!isPlainObject(value)) continue
		const sampleId = trimmedString(value.sample_id)
		if (sampleId) {
			if (sampleIds.has(sampleId))
				throw new BenchmarkAdapterRejectedError("duplicate-sample-id")
			sampleIds.add(sampleId)
		}
		if (!isPlainObject(value.conversation)) continue
		const dialogIds = new Set<string>()
		for (const [key, session] of Object.entries(value.conversation)) {
			if (!SESSION_KEY.test(key) || !Array.isArray(session)) continue
			for (const turn of session) {
				const dialogId = isPlainObject(turn) ? trimmedString(turn.dia_id) : ""
				if (!dialogId) continue
				if (dialogIds.has(dialogId))
					throw new BenchmarkAdapterRejectedError("duplicate-dialog-id")
				dialogIds.add(dialogId)
			}
		}
	}
}

/**
 * Admits a document already recognized as LoCoMo (decision 2): every element
 * is admitted or becomes a LoCoMo rejection; nothing falls through to another
 * parser.
 */
export function admitLoCoMoDocument(entries: unknown[]): {
	scenarios: MemoryBenchmarkScenario[]
	adapterDiagnostics: BenchmarkAdapterDiagnostics
} {
	preflightLoCoMoIdentity(entries)
	const diagnostics: BenchmarkAdapterDiagnostic[] = []
	const scenarios: MemoryBenchmarkScenario[] = []
	for (const [sampleIndex, value] of entries.entries()) {
		const admission = admitSample(value, sampleIndex)
		diagnostics.push(...admission.entries)
		if (admission.scenario) scenarios.push(admission.scenario)
	}
	const adapterDiagnostics = summarizeAdapterDiagnostics(diagnostics)
	if (!scenarios.some((scenario) => scenario.evaluations.length > 0))
		throw new BenchmarkAdapterRejectedError("all-rejected", adapterDiagnostics)
	return { scenarios, adapterDiagnostics }
}
