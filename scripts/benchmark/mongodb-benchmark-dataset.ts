import {
	BENCHMARK_TIMESTAMP_POLICY_VERSION,
	BenchmarkTimestampRejectedError,
	parseBenchmarkTimestamp,
	type BenchmarkTimestampRejection,
} from "./benchmark-timestamp.js"
import path, { basename } from "node:path"
import { readFile, realpath } from "node:fs/promises"
import type { MemoryScope } from "@memongo/lib"
import type {
	MemoryBenchmarkConversation,
	MemoryBenchmarkDataset,
	MemoryBenchmarkDatasetKind,
	MemoryBenchmarkEvaluationCase,
	MemoryBenchmarkScenario,
	MemoryBenchmarkTurn,
	MemoryConversationImportRejection,
} from "../../packages/memory-engine/src/types.js"

const VALID_ROLES = new Set(["user", "assistant", "system", "tool"])

function isPathWithinRoot(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate)
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	)
}

export async function resolveBenchmarkDatasetPath(params: {
	datasetPath: string
	baseDir?: string
	allowedRoots?: string[]
}): Promise<string> {
	const raw = params.datasetPath.trim()
	if (!raw) {
		throw new Error("datasetPath is required")
	}
	if (!path.isAbsolute(raw) && raw.split(/[\\/]+/).includes("..")) {
		throw new Error("datasetPath must not contain parent-directory traversal")
	}

	const candidate = path.isAbsolute(raw)
		? path.resolve(raw)
		: path.resolve(params.baseDir ?? process.cwd(), raw)
	const resolved = await realpath(candidate).catch(() => {
		throw new Error("benchmark dataset does not exist or is not accessible")
	})
	const ext = path.extname(resolved).toLowerCase()
	if (ext !== ".json" && ext !== ".jsonl") {
		throw new Error("benchmark dataset must be a .json or .jsonl file")
	}

	if (params.allowedRoots && params.allowedRoots.length > 0) {
		const normalizedRoots = await Promise.all(
			params.allowedRoots.map(
				async (root) => await realpath(root).catch(() => path.resolve(root)),
			),
		)
		const allowed = normalizedRoots.some((root) =>
			isPathWithinRoot(resolved, root),
		)
		if (!allowed) {
			throw new Error(
				"datasetPath must resolve inside the workspace or configured benchmark dataset directory",
			)
		}
	}

	return resolved
}

type BenchmarkRecordLocation = Pick<
	MemoryConversationImportRejection,
	"line" | "conversationIndex"
>

// B01:C07: same coordinates and reasons as the engine importer. Timestamps are
// not a reason here: validateRawTimestamps applies the versioned benchmark
// policy to the raw input before normalization.
function normalizeTurn(
	value: unknown,
	turnIndex: number,
	at: BenchmarkRecordLocation,
):
	| { ok: true; value: MemoryBenchmarkTurn }
	| { ok: false; rejection: MemoryConversationImportRejection } {
	const reject = (reason: MemoryConversationImportRejection["reason"]) => ({
		ok: false as const,
		rejection: { ...at, turnIndex, reason },
	})
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return reject("turn-not-object")
	}
	const record = value as Record<string, unknown>
	const role = typeof record.role === "string" ? record.role : ""
	const body = typeof record.body === "string" ? record.body.trim() : ""
	if (!VALID_ROLES.has(role)) {
		return reject("invalid-role")
	}
	if (body.length === 0) {
		return reject("empty-body")
	}
	return {
		ok: true,
		value: {
			role: role as MemoryBenchmarkTurn["role"],
			body,
			timestamp:
				typeof record.timestamp === "string" &&
				record.timestamp.trim().length > 0
					? record.timestamp
					: undefined,
			metadata:
				record.metadata && typeof record.metadata === "object"
					? (record.metadata as Record<string, unknown>)
					: undefined,
		},
	}
}

/** conversation is null when the record itself is rejected; rejections also lists rejected turns of an accepted conversation. */
function normalizeConversation(
	value: unknown,
	at: BenchmarkRecordLocation,
): {
	conversation: MemoryBenchmarkConversation | null
	rejections: MemoryConversationImportRejection[]
} {
	const rejections: MemoryConversationImportRejection[] = []
	const reject = (reason: MemoryConversationImportRejection["reason"]) => {
		rejections.push({ ...at, turnIndex: null, reason })
		return { conversation: null, rejections }
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return reject("conversation-not-object")
	}
	const record = value as Record<string, unknown>
	if (!Array.isArray(record.turns)) {
		return reject("turns-not-array")
	}
	const turns: MemoryBenchmarkTurn[] = []
	for (const [turnIndex, turn] of record.turns.entries()) {
		const result = normalizeTurn(turn, turnIndex, at)
		if (result.ok) turns.push(result.value)
		else rejections.push(result.rejection)
	}
	if (turns.length === 0) {
		return reject("no-valid-turns")
	}
	const scope =
		record.scope === "session" ||
		record.scope === "user" ||
		record.scope === "agent" ||
		record.scope === "workspace" ||
		record.scope === "tenant" ||
		record.scope === "global"
			? (record.scope as MemoryScope)
			: undefined
	return {
		conversation: {
			conversationId:
				typeof record.conversationId === "string" &&
				record.conversationId.trim().length > 0
					? record.conversationId
					: undefined,
			sessionId:
				typeof record.sessionId === "string" &&
				record.sessionId.trim().length > 0
					? record.sessionId
					: undefined,
			scope,
			turns,
		},
		rejections,
	}
}

function normalizeConversations(
	values: unknown[],
	line: number | null,
	rejections: MemoryConversationImportRejection[],
): MemoryBenchmarkConversation[] {
	const conversations: MemoryBenchmarkConversation[] = []
	for (const [conversationIndex, value] of values.entries()) {
		const result = normalizeConversation(value, { line, conversationIndex })
		for (const rejection of result.rejections) rejections.push(rejection)
		if (result.conversation) conversations.push(result.conversation)
	}
	return conversations
}

/** B01:C07 receipt counts, split by turnIndex exactly as the engine importer reports them. */
export function countBenchmarkRejections(
	rejections: readonly MemoryConversationImportRejection[] | undefined,
): { rejectedTurns: number; rejectedConversations: number } {
	let rejectedTurns = 0
	for (const rejection of rejections ?? [])
		if (rejection.turnIndex !== null) rejectedTurns++
	return {
		rejectedTurns,
		rejectedConversations: (rejections?.length ?? 0) - rejectedTurns,
	}
}

/** No conversation survived; carries the same value-free diagnostics a receipt would. */
export class BenchmarkInputRejectedError extends Error {
	readonly failedLines: number
	readonly rejections: MemoryConversationImportRejection[]

	constructor(
		rejections: MemoryConversationImportRejection[],
		failedLines = 0,
	) {
		const { rejectedTurns, rejectedConversations } =
			countBenchmarkRejections(rejections)
		super(
			`benchmark dataset contains no valid conversations (failedLines=${failedLines}, rejectedConversations=${rejectedConversations}, rejectedTurns=${rejectedTurns})`,
		)
		this.name = "BenchmarkInputRejectedError"
		this.failedLines = failedLines
		this.rejections = rejections
	}
}

function normalizeEvaluationCase(
	value: unknown,
): MemoryBenchmarkEvaluationCase | null {
	if (!value || typeof value !== "object") {
		return null
	}
	const record = value as Record<string, unknown>
	const query = typeof record.query === "string" ? record.query.trim() : ""
	if (!query) {
		return null
	}
	const caseId =
		typeof record.caseId === "string" && record.caseId.trim().length > 0
			? record.caseId
			: query
	const expectedSessionIds = Array.isArray(record.expectedSessionIds)
		? record.expectedSessionIds
				.filter(
					(value): value is string =>
						typeof value === "string" && value.trim().length > 0,
				)
				.map((value) => value.trim())
		: []
	const expectedTurnIds = Array.isArray(record.expectedTurnIds)
		? record.expectedTurnIds
				.filter(
					(value): value is string =>
						typeof value === "string" && value.trim().length > 0,
				)
				.map((value) => value.trim())
		: undefined
	const expectedDialogIds = Array.isArray(record.expectedDialogIds)
		? record.expectedDialogIds
				.filter(
					(value): value is string =>
						typeof value === "string" && value.trim().length > 0,
				)
				.map((value) => value.trim())
		: undefined
	return {
		caseId,
		query,
		expectedSessionIds,
		expectedTurnIds,
		expectedDialogIds,
		answer:
			typeof record.answer === "string" && record.answer.trim().length > 0
				? record.answer
				: undefined,
		questionType:
			typeof record.questionType === "string" &&
			record.questionType.trim().length > 0
				? record.questionType
				: undefined,
		sourceScope:
			record.sourceScope === "all" ||
			record.sourceScope === "memory" ||
			record.sourceScope === "kb" ||
			record.sourceScope === "structured"
				? record.sourceScope
				: undefined,
		abstention: record.abstention === true,
		expectedSources: Array.isArray(record.expectedSources)
			? record.expectedSources
					.filter(
						(value): value is string =>
							typeof value === "string" && value.trim().length > 0,
					)
					.map((value) => value.trim())
			: undefined,
		minTopScore:
			typeof record.minTopScore === "number" &&
			Number.isFinite(record.minTopScore)
				? record.minTopScore
				: undefined,
		metadata:
			record.metadata && typeof record.metadata === "object"
				? (record.metadata as Record<string, unknown>)
				: undefined,
	}
}

function buildDataset(
	name: string,
	datasetKind: MemoryBenchmarkDatasetKind,
	scenarios: MemoryBenchmarkScenario[],
	failedLines = 0,
): MemoryBenchmarkDataset {
	return {
		name,
		datasetKind,
		scenarios,
		evaluations: scenarios.flatMap((scenario) => scenario.evaluations),
		conversations: scenarios.flatMap((scenario) => scenario.conversations),
		failedLines,
	}
}

function isLongMemEvalEntry(value: unknown): value is Record<string, unknown> {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof (value as Record<string, unknown>).question_id === "string" &&
			Array.isArray((value as Record<string, unknown>).haystack_sessions),
	)
}

function normalizeLongMemEvalDataset(
	entries: unknown[],
	name: string,
): MemoryBenchmarkDataset | null {
	if (!entries.every(isLongMemEvalEntry)) {
		return null
	}
	const scenarios: MemoryBenchmarkScenario[] = []
	for (const entry of entries) {
		const questionId = String(entry.question_id).trim()
		const question =
			typeof entry.question === "string" ? entry.question.trim() : ""
		if (!questionId || !question) {
			continue
		}
		const rawSessionIds = Array.isArray(entry.haystack_session_ids)
			? entry.haystack_session_ids
			: []
		const rawDates = Array.isArray(entry.haystack_dates)
			? entry.haystack_dates
			: []
		const rawSessions = Array.isArray(entry.haystack_sessions)
			? entry.haystack_sessions
			: []
		const expectedTurnIds: string[] = []
		const officialExpectedSessionIds: string[] = []
		const officialExpectedTurnIds: string[] = []
		const conversations: MemoryBenchmarkConversation[] = []
		for (const [index, session] of rawSessions.entries()) {
			if (!Array.isArray(session)) {
				continue
			}
			const originalSessionId =
				typeof rawSessionIds[index] === "string" &&
				rawSessionIds[index].trim().length > 0
					? rawSessionIds[index].trim()
					: `session_${index + 1}`
			const sessionId = `${questionId}::${originalSessionId}`
			const timestamp =
				typeof rawDates[index] === "string" && rawDates[index].trim().length > 0
					? rawDates[index]
					: undefined
			const turns: MemoryBenchmarkTurn[] = []
			let hasUserAnswerTarget = false
			for (const [turnIndex, turn] of session.entries()) {
				if (!turn || typeof turn !== "object") {
					continue
				}
				const record = turn as Record<string, unknown>
				const role =
					record.role === "user" || record.role === "assistant"
						? record.role
						: ""
				const body =
					typeof record.content === "string" ? record.content.trim() : ""
				if (!role || !body) {
					continue
				}
				const benchmarkTurnId = `${sessionId}::turn_${turnIndex + 1}`
				if (record.has_answer === true) {
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
						...(record.has_answer === true ? { benchmarkHasAnswer: true } : {}),
					},
				})
			}
			if (turns.length === 0) {
				continue
			}
			if (hasUserAnswerTarget) {
				officialExpectedSessionIds.push(sessionId)
			}
			conversations.push({
				conversationId: questionId,
				sessionId,
				turns,
			})
		}
		const expectedSessionIds = Array.isArray(entry.answer_session_ids)
			? entry.answer_session_ids
					.filter(
						(value): value is string =>
							typeof value === "string" && value.trim().length > 0,
					)
					.map((value) => `${questionId}::${value.trim()}`)
			: []
		const questionType =
			typeof entry.question_type === "string" &&
			entry.question_type.trim().length > 0
				? entry.question_type.trim()
				: questionId.endsWith("_abs")
					? "abstention"
					: undefined
		const abstention = questionId.endsWith("_abs")
		const officialEligible = !abstention && officialExpectedTurnIds.length > 0
		scenarios.push({
			scenarioId: questionId,
			conversations,
			evaluations: [
				{
					caseId: questionId,
					query: question,
					expectedSessionIds,
					expectedTurnIds,
					officialRetrieval: {
						evaluator: "longmemeval-main-run",
						eligible: officialEligible,
						expectedSessionIds: officialEligible
							? officialExpectedSessionIds
							: [],
						expectedTurnIds: officialEligible ? officialExpectedTurnIds : [],
						...(!officialEligible
							? {
									ineligibleReason: abstention
										? ("abstention" as const)
										: ("no-user-answer-target" as const),
								}
							: {}),
					},
					answer:
						typeof entry.answer === "string" && entry.answer.trim().length > 0
							? entry.answer
							: undefined,
					questionType,
					abstention,
					metadata: {
						benchmarkDatasetKind: "longmemeval",
						questionDate:
							typeof entry.question_date === "string"
								? entry.question_date
								: undefined,
					},
				},
			],
		})
	}
	return scenarios.length > 0
		? buildDataset(name, "longmemeval", scenarios)
		: null
}

function normalizeLoCoMoDataset(
	entries: unknown[],
	name: string,
): MemoryBenchmarkDataset | null {
	const scenarios: MemoryBenchmarkScenario[] = []
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") {
			return null
		}
		const record = entry as Record<string, unknown>
		const sampleId =
			typeof record.sample_id === "string" ? record.sample_id.trim() : ""
		const conversation =
			record.conversation && typeof record.conversation === "object"
				? (record.conversation as Record<string, unknown>)
				: null
		const qa = Array.isArray(record.qa) ? record.qa : null
		if (!sampleId || !conversation || !qa) {
			return null
		}
		const speakerA =
			typeof conversation.speaker_a === "string"
				? conversation.speaker_a.trim()
				: ""
		const speakerB =
			typeof conversation.speaker_b === "string"
				? conversation.speaker_b.trim()
				: ""
		const dialogIdToSessionId = new Map<string, string>()
		const conversations: MemoryBenchmarkConversation[] = []
		for (let index = 1; ; index++) {
			const sessionKey = `session_${index}`
			const sessionValue = conversation[sessionKey]
			if (!Array.isArray(sessionValue)) {
				break
			}
			const sessionId = `${sampleId}::${sessionKey}`
			const timestampKey = `${sessionKey}_date_time`
			const timestamp =
				typeof conversation[timestampKey] === "string" &&
				String(conversation[timestampKey]).trim().length > 0
					? String(conversation[timestampKey]).trim()
					: undefined
			const turns: MemoryBenchmarkTurn[] = []
			for (const turn of sessionValue) {
				if (!turn || typeof turn !== "object") {
					continue
				}
				const dialog = turn as Record<string, unknown>
				const speaker =
					typeof dialog.speaker === "string" ? dialog.speaker.trim() : ""
				const role =
					speaker && speaker === speakerA
						? "user"
						: speaker && speaker === speakerB
							? "assistant"
							: "user"
				const body = typeof dialog.text === "string" ? dialog.text.trim() : ""
				if (!body) {
					continue
				}
				const dialogId =
					typeof dialog.dia_id === "string" ? dialog.dia_id.trim() : ""
				if (dialogId) {
					dialogIdToSessionId.set(dialogId, sessionId)
				}
				turns.push({
					role,
					body,
					timestamp,
					metadata: {
						benchmarkDatasetKind: "locomo",
						locomoDialogId: dialogId || undefined,
						locomoSpeaker: speaker || undefined,
					},
				})
			}
			if (turns.length > 0) {
				conversations.push({
					conversationId: sampleId,
					sessionId,
					turns,
				})
			}
		}

		const evaluations: MemoryBenchmarkEvaluationCase[] = []
		for (const [index, value] of qa.entries()) {
			if (!value || typeof value !== "object") {
				continue
			}
			const item = value as Record<string, unknown>
			const query =
				typeof item.question === "string" ? item.question.trim() : ""
			if (!query) {
				continue
			}
			const evidence = Array.isArray(item.evidence) ? item.evidence : []
			const expectedDialogIds = Array.from(
				new Set(
					evidence
						.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
						.filter(Boolean),
				),
			)
			const expectedSessionIds = Array.from(
				new Set(
					expectedDialogIds
						.map((dialogRef) => {
							const directMatch = dialogIdToSessionId.get(dialogRef)
							if (directMatch) {
								return directMatch
							}
							const dialogPrefix = dialogRef.split(":")[0] ?? dialogRef
							return dialogIdToSessionId.get(dialogPrefix)
						})
						.filter((sessionId): sessionId is string => Boolean(sessionId)),
				),
			)
			const questionType =
				typeof item.category === "string" || typeof item.category === "number"
					? `category-${String(item.category)}`
					: undefined
			const abstention = String(item.category) === "5"
			evaluations.push({
				caseId: `${sampleId}::qa_${index + 1}`,
				query,
				expectedSessionIds,
				expectedDialogIds,
				answer:
					typeof item.answer === "string" && item.answer.trim().length > 0
						? item.answer
						: undefined,
				questionType,
				abstention,
				metadata: {
					benchmarkDatasetKind: "locomo",
					locomoCategory: item.category,
					evidence,
				},
			})
		}

		scenarios.push({
			scenarioId: sampleId,
			conversations,
			evaluations,
		})
	}
	return scenarios.length > 0 ? buildDataset(name, "locomo", scenarios) : null
}

function normalizeGenericJsonDataset(
	parsed: unknown,
	name: string,
): MemoryBenchmarkDataset | null {
	if (Array.isArray(parsed)) {
		const longMemEval = normalizeLongMemEvalDataset(parsed, name)
		if (longMemEval) {
			return longMemEval
		}
		const loCoMo = normalizeLoCoMoDataset(parsed, name)
		if (loCoMo) {
			return loCoMo
		}
		const rejections: MemoryConversationImportRejection[] = []
		const conversations = normalizeConversations(parsed, null, rejections)
		if (conversations.length === 0) {
			throw new BenchmarkInputRejectedError(rejections)
		}
		return {
			...buildDataset(name, "generic", [
				{
					scenarioId: "generic",
					conversations,
					evaluations: [],
				},
			]),
			rejections,
		}
	}
	if (!parsed || typeof parsed !== "object") {
		return null
	}
	const record = parsed as Record<string, unknown>
	if (!Array.isArray(record.conversations)) {
		const { conversation, rejections } = normalizeConversation(record, {
			line: null,
			conversationIndex: 0,
		})
		if (!conversation) {
			throw new BenchmarkInputRejectedError(rejections)
		}
		return {
			...buildDataset(name, "generic", [
				{
					scenarioId: conversation.conversationId ?? "generic",
					conversations: [conversation],
					evaluations: [],
				},
			]),
			rejections,
		}
	}
	const rejections: MemoryConversationImportRejection[] = []
	const conversations = normalizeConversations(
		record.conversations,
		null,
		rejections,
	)
	if (conversations.length === 0) {
		throw new BenchmarkInputRejectedError(rejections)
	}
	const evaluations = Array.isArray(record.evaluations)
		? record.evaluations
				.map((entry) => normalizeEvaluationCase(entry))
				.filter(
					(entry): entry is MemoryBenchmarkEvaluationCase => entry !== null,
				)
		: []
	const scenarioId =
		typeof record.scenarioId === "string" && record.scenarioId.trim().length > 0
			? record.scenarioId
			: "generic"
	return {
		name:
			typeof record.name === "string" && record.name.trim().length > 0
				? record.name
				: name,
		datasetKind: "generic",
		conversations,
		evaluations,
		rejections,
		scenarios: [
			{
				scenarioId,
				conversations,
				evaluations,
			},
		],
	}
}

export type BenchmarkTimestampValidation = {
	policyVersion: string
	weekdayMismatches: number
	literalMidnightLabels: number
}

// Validate raw fields before normalization can discard null, empty or malformed values.
function validateRawTimestamps(
	parsed: unknown,
	conversationOffset = 0,
): BenchmarkTimestampValidation {
	const rejections: BenchmarkTimestampRejection[] = []
	let weekdayMismatches = 0
	let literalMidnightLabels = 0
	const check = (
		kind: MemoryBenchmarkDatasetKind,
		raw: unknown,
		at: Omit<BenchmarkTimestampRejection, "reason">,
	) => {
		const result = parseBenchmarkTimestamp(kind, raw)
		if (!result.ok) rejections.push({ ...at, reason: result.reason })
		else {
			if (result.weekdayMismatch) weekdayMismatches++
			if (result.literalMidnightLabel) literalMidnightLabels++
		}
	}
	const object = (value: unknown): Record<string, unknown> | null =>
		value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null
	const root = object(parsed)
	const entries = Array.isArray(parsed)
		? parsed
		: Array.isArray(root?.conversations)
			? root.conversations
			: [parsed]
	for (const [index, value] of entries.entries()) {
		const record = object(value)
		if (!record) continue
		const at = {
			conversationIndex: index + conversationOffset,
			sessionIndex: null,
			turnIndex: null,
		}
		if (isLongMemEvalEntry(value)) {
			if (Object.hasOwn(record, "haystack_dates")) {
				const dates = record.haystack_dates
				if (
					!Array.isArray(dates) ||
					dates.length !== (record.haystack_sessions as unknown[]).length
				) {
					rejections.push({
						...at,
						field: "haystack_dates",
						reason: "invalid-shape",
					})
				} else
					for (const [sessionIndex, date] of dates.entries())
						check("longmemeval", date, {
							...at,
							sessionIndex,
							field: "haystack_dates",
						})
			}
			if (Object.hasOwn(record, "question_date"))
				check("longmemeval", record.question_date, {
					...at,
					field: "question_date",
				})
		} else if (object(record.conversation) && Array.isArray(record.qa)) {
			const conversation = object(record.conversation)
			if (!conversation) continue
			for (const [key, date] of Object.entries(conversation)) {
				const match = /^session_(\d+)_date_time$/.exec(key)
				if (match)
					check("locomo", date, {
						...at,
						sessionIndex: Number(match[1]) - 1,
						field: "session_date_time",
					})
			}
		} else if (Array.isArray(record.turns)) {
			for (const [turnIndex, value] of record.turns.entries()) {
				const turn = object(value)
				if (turn && Object.hasOwn(turn, "timestamp"))
					check("generic", turn.timestamp, {
						...at,
						turnIndex,
						field: "turn.timestamp",
					})
			}
		}
	}
	if (Array.isArray(root?.evaluations))
		for (const [index, value] of root.evaluations.entries()) {
			const metadata = object(object(value)?.metadata)
			if (metadata && Object.hasOwn(metadata, "questionDate"))
				check("generic", metadata.questionDate, {
					field: "question_date",
					conversationIndex: index,
					sessionIndex: null,
					turnIndex: null,
				})
		}
	if (rejections.length) throw new BenchmarkTimestampRejectedError(rejections)
	return {
		policyVersion: BENCHMARK_TIMESTAMP_POLICY_VERSION,
		weekdayMismatches,
		literalMidnightLabels,
	}
}

export async function loadBenchmarkDataset(
	datasetPath: string,
	options?: {
		baseDir?: string
		allowedRoots?: string[]
	},
): Promise<
	MemoryBenchmarkDataset & { timestampValidation: BenchmarkTimestampValidation }
> {
	const resolvedDatasetPath = await resolveBenchmarkDatasetPath({
		datasetPath,
		baseDir: options?.baseDir,
		allowedRoots: options?.allowedRoots,
	})
	const raw = await readFile(resolvedDatasetPath, "utf-8")
	if (!raw || raw.trim().length === 0) {
		throw new Error("benchmark dataset is empty")
	}
	// Avoid creating a second copy of a potentially 200 MB+ string via trim().
	// JSON.parse tolerates leading/trailing whitespace natively.
	const firstChar = raw.trimStart()[0]

	if (firstChar === "{" || firstChar === "[") {
		try {
			const parsed = JSON.parse(raw)
			const timestampValidation = validateRawTimestamps(parsed)
			const dataset = normalizeGenericJsonDataset(
				parsed,
				basename(resolvedDatasetPath),
			)
			if (!dataset) {
				throw new Error("benchmark dataset contains no valid conversations")
			}
			return { ...dataset, timestampValidation }
		} catch (err) {
			if (!(err instanceof SyntaxError)) {
				throw err
			}
			// Fall through to JSONL parsing below. This keeps single-object JSON
			// support while also handling multi-line JSONL files that happen to
			// start with "{".
		}
	}

	const conversations: MemoryBenchmarkConversation[] = []
	let failedLines = 0
	const timestampValidation = {
		policyVersion: BENCHMARK_TIMESTAMP_POLICY_VERSION,
		weekdayMismatches: 0,
		literalMidnightLabels: 0,
	}
	const rejections: MemoryConversationImportRejection[] = []
	let conversationIndex = 0
	for (const [lineIndex, rawLine] of raw.split("\n").entries()) {
		const line = rawLine.trim()
		if (line.length === 0 || line.startsWith("#")) {
			continue
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch {
			failedLines++
			continue
		}
		timestampValidation.weekdayMismatches += validateRawTimestamps(
			parsed,
			conversationIndex,
		).weekdayMismatches
		// Valid JSON with an invalid shape is a typed rejection, not a parse failure.
		const result = normalizeConversation(parsed, {
			line: lineIndex + 1,
			conversationIndex: conversationIndex++,
		})
		for (const rejection of result.rejections) rejections.push(rejection)
		if (result.conversation) conversations.push(result.conversation)
	}

	if (conversations.length === 0) {
		throw new BenchmarkInputRejectedError(rejections, failedLines)
	}

	return {
		name: basename(resolvedDatasetPath),
		timestampValidation,
		datasetKind: "generic",
		conversations,
		failedLines,
		rejections,
		scenarios: [
			{
				scenarioId: "generic",
				conversations,
				evaluations: [],
			},
		],
	}
}
