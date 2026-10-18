import type {
	MemoryBenchmarkConversation,
	MemoryBenchmarkEvaluationCase,
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

/** Decision 1: a numeric gold keeps its source type beside the string form. */
export type BenchmarkEvaluationCase = MemoryBenchmarkEvaluationCase & {
	goldAnswerSourceType?: "number"
}

type SourceRecord = Record<string, unknown>

function isPlainObject(value: unknown): value is SourceRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readGold(value: unknown): { answer: string; numeric: boolean } | null {
	if (typeof value === "string" && value.trim().length > 0)
		return { answer: value, numeric: false }
	if (typeof value === "number" && Number.isFinite(value))
		return { answer: String(value), numeric: true }
	return null
}

/** OPEN-6 B: one nonblank string per session, used trimmed; null when malformed. */
function readSessionIds(value: unknown, sessions: number): string[] | null {
	if (!Array.isArray(value) || value.length !== sessions) return null
	const ids: string[] = []
	for (const entry of value) {
		if (typeof entry !== "string" || entry.trim().length === 0) return null
		ids.push(entry.trim())
	}
	return ids
}

/** Absent evidence is kept (OPEN-8); a present malformed list is null (OPEN-9 B). */
function readEvidence(record: SourceRecord): string[] | null {
	if (!Object.hasOwn(record, "answer_session_ids")) return []
	return readSessionIds(
		record.answer_session_ids,
		Array.isArray(record.answer_session_ids)
			? record.answer_session_ids.length
			: -1,
	)
}

/** Decision 6: occurrence k >= 2 of a source session within one question gets `::occ${k}`. */
function occurrenceSessionId(
	questionId: string,
	originalSessionId: string,
	occurrences: Map<string, number>,
): string {
	const occurrence = (occurrences.get(originalSessionId) ?? 0) + 1
	occurrences.set(originalSessionId, occurrence)
	const sessionId = `${questionId}::${originalSessionId}`
	return occurrence === 1 ? sessionId : `${sessionId}::occ${occurrence}`
}

type AdmittedTurn = {
	role: "user" | "assistant"
	body: string
	hasAnswer: boolean
}

/** Decision 3 and OPEN-7 B; content is stored trimmed. */
function admitTurn(
	value: unknown,
	inEvidenceSession: boolean,
): AdmittedTurn | { reason: BenchmarkAdapterDiagnosticReason } {
	if (!isPlainObject(value)) return { reason: "turn-not-object" }
	if (value.role !== "user" && value.role !== "assistant")
		return { reason: "turn-invalid-role" }
	if (typeof value.content !== "string")
		return { reason: "turn-content-not-string" }
	if (
		Object.hasOwn(value, "has_answer") &&
		typeof value.has_answer !== "boolean"
	)
		return { reason: "turn-invalid-has-answer" }
	const hasAnswer = value.has_answer === true
	const body = value.content.trim()
	if (body.length === 0)
		return {
			reason: hasAnswer
				? "turn-empty-answer-target"
				: inEvidenceSession
					? "turn-empty-evidence"
					: "skipped-empty-turn",
		}
	return { role: value.role, body, hasAnswer }
}

type QuestionAdmission = {
	entries: BenchmarkAdapterDiagnostic[]
	scenario: MemoryBenchmarkScenario | null
}

function admitQuestion(
	value: unknown,
	questionIndex: number,
): QuestionAdmission {
	const reject = (
		reason: BenchmarkAdapterDiagnosticReason,
	): QuestionAdmission => ({
		entries: [{ format: "longmemeval", questionIndex, reason }],
		scenario: null,
	})
	if (!isPlainObject(value)) return reject("question-not-object")
	const questionId =
		typeof value.question_id === "string" ? value.question_id.trim() : ""
	if (!questionId) return reject("question-invalid-id")
	const question =
		typeof value.question === "string" ? value.question.trim() : ""
	if (!question) return reject("question-invalid-text")
	const gold = readGold(value.answer)
	if (!gold) return reject("question-invalid-gold")
	if (!Array.isArray(value.haystack_sessions))
		return reject("question-invalid-sessions")

	const sessionIds = readSessionIds(
		value.haystack_session_ids,
		value.haystack_sessions.length,
	)
	if (!sessionIds) return reject("question-invalid-session-ids")
	const evidence = readEvidence(value)
	if (!evidence) return reject("question-invalid-evidence")

	const rawDates = Array.isArray(value.haystack_dates)
		? value.haystack_dates
		: []
	const nested: BenchmarkAdapterDiagnostic[] = []
	const admittedBySource = new Map<string, string[]>()
	let rejectedSessions = 0
	let lostEvidenceTurn = false
	const expectedTurnIds: string[] = []
	const officialExpectedSessionIds: string[] = []
	const officialExpectedTurnIds: string[] = []
	const conversations: MemoryBenchmarkConversation[] = []
	const occurrences = new Map<string, number>()
	for (const [sessionIndex, session] of value.haystack_sessions.entries()) {
		const originalSessionId = sessionIds[sessionIndex] as string
		const sessionId = occurrenceSessionId(
			questionId,
			originalSessionId,
			occurrences,
		)
		if (!Array.isArray(session)) {
			nested.push({
				format: "longmemeval",
				questionIndex,
				sessionIndex,
				reason: "session-not-array",
			})
			rejectedSessions++
			continue
		}
		const timestamp =
			typeof rawDates[sessionIndex] === "string" &&
			rawDates[sessionIndex].trim().length > 0
				? rawDates[sessionIndex]
				: undefined
		const turns: MemoryBenchmarkTurn[] = []
		const turnEntries: BenchmarkAdapterDiagnostic[] = []
		let hasUserAnswerTarget = false
		for (const [turnIndex, turn] of session.entries()) {
			const admitted = admitTurn(turn, evidence.includes(originalSessionId))
			if ("reason" in admitted) {
				turnEntries.push({
					format: "longmemeval",
					questionIndex,
					sessionIndex,
					turnIndex,
					reason: admitted.reason,
				})
				if (
					admitted.reason === "turn-empty-answer-target" ||
					admitted.reason === "turn-empty-evidence"
				)
					lostEvidenceTurn = true
				continue
			}
			const { role, body, hasAnswer } = admitted
			const benchmarkTurnId = `${sessionId}::turn_${turnIndex + 1}`
			if (hasAnswer) {
				expectedTurnIds.push(benchmarkTurnId)
				if (role === "user") {
					hasUserAnswerTarget = true
					officialExpectedTurnIds.push(benchmarkTurnId)
				}
			}
			turns.push({
				role,
				body,
				timestamp,
				metadata: {
					benchmarkDatasetKind: "longmemeval",
					benchmarkQuestionId: questionId,
					benchmarkOriginalSessionId: originalSessionId,
					benchmarkTurnId,
					...(hasAnswer ? { benchmarkHasAnswer: true } : {}),
				},
			})
		}
		if (turns.length === 0)
			nested.push({
				format: "longmemeval",
				questionIndex,
				sessionIndex,
				reason: "session-emptied",
			})
		nested.push(...turnEntries)
		if (turns.length === 0) continue
		if (hasUserAnswerTarget) officialExpectedSessionIds.push(sessionId)
		conversations.push({ conversationId: questionId, sessionId, turns })
		admittedBySource.set(originalSessionId, [
			...(admittedBySource.get(originalSessionId) ?? []),
			sessionId,
		])
	}
	const derived: BenchmarkAdapterDiagnosticReason | null =
		rejectedSessions === value.haystack_sessions.length
			? "question-no-sessions"
			: lostEvidenceTurn ||
					evidence.some((source) => !admittedBySource.has(source))
				? "question-evidence-unresolved"
				: conversations.length === 0
					? "question-no-sessions"
					: null
	if (derived)
		return {
			entries: [
				{ format: "longmemeval", questionIndex, reason: derived },
				...nested,
			],
			scenario: null,
		}
	const expectedSessionIds = evidence.flatMap(
		(source) => admittedBySource.get(source) ?? [],
	)
	const questionType =
		typeof value.question_type === "string" &&
		value.question_type.trim().length > 0
			? value.question_type.trim()
			: questionId.endsWith("_abs")
				? "abstention"
				: undefined
	const abstention = questionId.endsWith("_abs")
	const noEvidence = !abstention && evidence.length === 0
	const officialEligible =
		!abstention && !noEvidence && officialExpectedTurnIds.length > 0
	const evaluation: BenchmarkEvaluationCase = {
		caseId: questionId,
		query: question,
		expectedSessionIds,
		expectedTurnIds,
		officialRetrieval: {
			evaluator: "longmemeval-main-run",
			eligible: officialEligible,
			expectedSessionIds: officialEligible ? officialExpectedSessionIds : [],
			expectedTurnIds: officialEligible ? officialExpectedTurnIds : [],
			...(!officialEligible
				? {
						ineligibleReason: abstention
							? ("abstention" as const)
							: noEvidence
								? ("no-evidence" as const)
								: ("no-user-answer-target" as const),
					}
				: {}),
		},
		answer: gold.answer,
		...(gold.numeric ? { goldAnswerSourceType: "number" as const } : {}),
		questionType,
		abstention,
		metadata: {
			benchmarkDatasetKind: "longmemeval",
			questionDate:
				typeof value.question_date === "string"
					? value.question_date
					: undefined,
		},
	}
	return {
		entries: nested,
		scenario: {
			scenarioId: questionId,
			conversations,
			evaluations: [evaluation],
		},
	}
}

function isStructurallyValidTurn(value: unknown): value is SourceRecord {
	return (
		isPlainObject(value) &&
		(value.role === "user" || value.role === "assistant") &&
		typeof value.content === "string" &&
		(!Object.hasOwn(value, "has_answer") ||
			typeof value.has_answer === "boolean")
	)
}

/** Decision 6 equality projection over every structurally valid turn, skipped empty turns included (OPEN-11 A). */
function sessionProjection(session: unknown[]): string {
	return JSON.stringify(
		session
			.filter(isStructurallyValidTurn)
			.map((turn) => [
				turn.role,
				(turn.content as string).trim(),
				turn.has_answer === true,
			]),
	)
}

/**
 * OPEN-26 (1): identity faults over every structurally inspectable source
 * identity, including those under an ancestor that is rejected later. Unique
 * session ids also make turn ids unique: a turn id is its session id plus
 * `::turn_<digits>`, which no other session id can produce.
 */
function preflightLongMemEvalIdentity(entries: unknown[]): void {
	const questionIds = new Set<string>()
	const sessionIds = new Set<string>()
	for (const value of entries) {
		if (!isPlainObject(value) || typeof value.question_id !== "string") continue
		const questionId = value.question_id.trim()
		if (!questionId) continue
		if (questionIds.has(questionId))
			throw new BenchmarkAdapterRejectedError("duplicate-question-id")
		questionIds.add(questionId)
		const sessions = Array.isArray(value.haystack_sessions)
			? value.haystack_sessions
			: []
		const ids = Array.isArray(value.haystack_session_ids)
			? value.haystack_session_ids
			: []
		const occurrences = new Map<string, number>()
		const projections = new Map<string, string>()
		for (const [index, session] of sessions.entries()) {
			const raw: unknown = ids[index]
			if (typeof raw !== "string" || raw.trim().length === 0) continue
			const originalSessionId = raw.trim()
			const sessionId = occurrenceSessionId(
				questionId,
				originalSessionId,
				occurrences,
			)
			if (Array.isArray(session)) {
				const projection = sessionProjection(session)
				const first = projections.get(originalSessionId)
				if (first === undefined) projections.set(originalSessionId, projection)
				else if (first !== projection)
					throw new BenchmarkAdapterRejectedError("duplicate-session-mismatch")
			}
			if (sessionIds.has(sessionId))
				throw new BenchmarkAdapterRejectedError("generated-id-collision")
			sessionIds.add(sessionId)
		}
	}
}

/**
 * Admits a document already recognized as LongMemEval (decision 2): every
 * element is admitted or becomes a LongMemEval rejection; nothing falls
 * through to another parser.
 */
export function admitLongMemEvalDocument(entries: unknown[]): {
	scenarios: MemoryBenchmarkScenario[]
	adapterDiagnostics: BenchmarkAdapterDiagnostics
} {
	preflightLongMemEvalIdentity(entries)
	const diagnostics: BenchmarkAdapterDiagnostic[] = []
	const scenarios: MemoryBenchmarkScenario[] = []
	for (const [questionIndex, value] of entries.entries()) {
		const admission = admitQuestion(value, questionIndex)
		diagnostics.push(...admission.entries)
		if (admission.scenario) scenarios.push(admission.scenario)
	}
	const adapterDiagnostics = summarizeAdapterDiagnostics(diagnostics)
	if (scenarios.length === 0)
		throw new BenchmarkAdapterRejectedError("all-rejected", adapterDiagnostics)
	return { scenarios, adapterDiagnostics }
}
