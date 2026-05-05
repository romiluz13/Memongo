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
} from "./types.js"

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

function normalizeTurn(value: unknown): MemoryBenchmarkTurn | null {
	if (!value || typeof value !== "object") {
		return null
	}
	const record = value as Record<string, unknown>
	const role = typeof record.role === "string" ? record.role : ""
	const body = typeof record.body === "string" ? record.body.trim() : ""
	if (!VALID_ROLES.has(role) || body.length === 0) {
		return null
	}
	return {
		role: role as MemoryBenchmarkTurn["role"],
		body,
		timestamp:
			typeof record.timestamp === "string" && record.timestamp.trim().length > 0
				? record.timestamp
				: undefined,
		metadata:
			record.metadata && typeof record.metadata === "object"
				? (record.metadata as Record<string, unknown>)
				: undefined,
	}
}

function normalizeConversation(
	value: unknown,
): MemoryBenchmarkConversation | null {
	if (!value || typeof value !== "object") {
		return null
	}
	const record = value as Record<string, unknown>
	if (!Array.isArray(record.turns)) {
		return null
	}
	const turns = record.turns
		.map((turn) => normalizeTurn(turn))
		.filter((turn): turn is MemoryBenchmarkTurn => turn !== null)
	if (turns.length === 0) {
		return null
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
		conversationId:
			typeof record.conversationId === "string" &&
			record.conversationId.trim().length > 0
				? record.conversationId
				: undefined,
		sessionId:
			typeof record.sessionId === "string" && record.sessionId.trim().length > 0
				? record.sessionId
				: undefined,
		scope,
		turns,
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
		scenarios.push({
			scenarioId: questionId,
			conversations,
			evaluations: [
				{
					caseId: questionId,
					query: question,
					expectedSessionIds,
					expectedTurnIds,
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
		const conversations = parsed
			.map((entry) => normalizeConversation(entry))
			.filter((entry): entry is MemoryBenchmarkConversation => entry !== null)
		if (conversations.length === 0) {
			return null
		}
		return buildDataset(name, "generic", [
			{
				scenarioId: "generic",
				conversations,
				evaluations: [],
			},
		])
	}
	if (!parsed || typeof parsed !== "object") {
		return null
	}
	const record = parsed as Record<string, unknown>
	if (!Array.isArray(record.conversations)) {
		const conversation = normalizeConversation(record)
		if (!conversation) {
			return null
		}
		return buildDataset(name, "generic", [
			{
				scenarioId: conversation.conversationId ?? "generic",
				conversations: [conversation],
				evaluations: [],
			},
		])
	}
	const conversations = record.conversations
		.map((entry) => normalizeConversation(entry))
		.filter((entry): entry is MemoryBenchmarkConversation => entry !== null)
	if (conversations.length === 0) {
		return null
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
		scenarios: [
			{
				scenarioId,
				conversations,
				evaluations,
			},
		],
	}
}

export async function loadBenchmarkDataset(
	datasetPath: string,
	options?: {
		baseDir?: string
		allowedRoots?: string[]
	},
): Promise<MemoryBenchmarkDataset> {
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
			const dataset = normalizeGenericJsonDataset(
				parsed,
				basename(resolvedDatasetPath),
			)
			if (!dataset) {
				throw new Error("benchmark dataset contains no valid conversations")
			}
			return dataset
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
	for (const rawLine of raw.split("\n")) {
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
		const conversation = normalizeConversation(parsed)
		if (conversation) {
			conversations.push(conversation)
		} else {
			failedLines++
		}
	}

	if (conversations.length === 0) {
		throw new Error("benchmark dataset contains no valid conversations")
	}

	return {
		name: basename(resolvedDatasetPath),
		datasetKind: "generic",
		conversations,
		failedLines,
		scenarios: [
			{
				scenarioId: "generic",
				conversations,
				evaluations: [],
			},
		],
	}
}
