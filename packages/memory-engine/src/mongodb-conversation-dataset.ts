import { readFile, realpath } from "node:fs/promises"
import path, { basename } from "node:path"
import type { MemoryScope } from "@memongo/lib"
import { parseExplicitTimestamp } from "./conversation-timestamp.js"

export type ConversationDatasetTurn = {
	role: "user" | "assistant" | "system" | "tool"
	body: string
	timestamp?: string
	metadata?: Record<string, unknown>
}

export type ConversationDatasetConversation = {
	conversationId?: string
	sessionId?: string
	scope?: MemoryScope
	turns: ConversationDatasetTurn[]
}

export type ConversationImportRejectionReason =
	| "conversation-not-object"
	| "turns-not-array"
	| "no-valid-turns"
	| "turn-not-object"
	| "invalid-role"
	| "empty-body"
	| "invalid-timestamp"

/**
 * A value-free pointer to a rejected input record. line is the 1-based
 * physical line for JSONL and null for a JSON document; conversationIndex is
 * the 0-based position among conversation records in the input; turnIndex is
 * the 0-based position in that record's turns array, or null for a
 * conversation-level rejection.
 */
export type ConversationImportRejection = {
	line: number | null
	conversationIndex: number
	turnIndex: number | null
	reason: ConversationImportRejectionReason
}

export type ConversationImportDataset = {
	name: string
	datasetKind: "generic"
	conversations: ConversationDatasetConversation[]
	failedLines?: number
	rejections: ConversationImportRejection[]
}

const VALID_ROLES = new Set(["user", "assistant", "system", "tool"])

function isPathWithinRoot(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate)
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	)
}

export async function resolveConversationDatasetPath(params: {
	datasetPath: string
	baseDir?: string
	allowedRoots?: string[]
}): Promise<string> {
	const raw = params.datasetPath.trim()
	if (!raw) throw new Error("datasetPath is required")
	if (!path.isAbsolute(raw) && raw.split(/[\\/]+/).includes("..")) {
		throw new Error("datasetPath must not contain parent-directory traversal")
	}
	const candidate = path.isAbsolute(raw)
		? path.resolve(raw)
		: path.resolve(params.baseDir ?? process.cwd(), raw)
	const resolved = await realpath(candidate).catch(() => {
		throw new Error("conversation dataset does not exist or is not accessible")
	})
	const extension = path.extname(resolved).toLowerCase()
	if (extension !== ".json" && extension !== ".jsonl") {
		throw new Error("conversation dataset must be a .json or .jsonl file")
	}
	if (params.allowedRoots?.length) {
		const roots = await Promise.all(
			params.allowedRoots.map(
				async (root) => await realpath(root).catch(() => path.resolve(root)),
			),
		)
		if (!roots.some((root) => isPathWithinRoot(resolved, root))) {
			throw new Error(
				"datasetPath must resolve inside the workspace or configured conversation dataset directory",
			)
		}
	}
	return resolved
}

type Located = { line: number | null; conversationIndex: number }

function normalizeTurn(
	value: unknown,
	turnIndex: number,
	at: Located,
	rejections: ConversationImportRejection[],
): ConversationDatasetTurn | null {
	const reject = (reason: ConversationImportRejectionReason) => {
		rejections.push({ ...at, turnIndex, reason })
		return null
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		return reject("turn-not-object")
	const record = value as Record<string, unknown>
	const role = typeof record.role === "string" ? record.role : ""
	const body = typeof record.body === "string" ? record.body.trim() : ""
	if (!VALID_ROLES.has(role)) return reject("invalid-role")
	if (!body) return reject("empty-body")
	// Only an absent timestamp means "use write time"; any explicit value must
	// be a valid instant, never silently replaced by the current time.
	if (
		record.timestamp !== undefined &&
		parseExplicitTimestamp(record.timestamp) === null
	)
		return reject("invalid-timestamp")
	return {
		role: role as ConversationDatasetTurn["role"],
		body,
		...(typeof record.timestamp === "string"
			? { timestamp: record.timestamp }
			: {}),
		...(record.metadata && typeof record.metadata === "object"
			? { metadata: record.metadata as Record<string, unknown> }
			: {}),
	}
}

function normalizeConversation(
	value: unknown,
	at: Located,
	rejections: ConversationImportRejection[],
): ConversationDatasetConversation | null {
	const reject = (reason: ConversationImportRejectionReason) => {
		rejections.push({ ...at, turnIndex: null, reason })
		return null
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		return reject("conversation-not-object")
	const record = value as Record<string, unknown>
	if (!Array.isArray(record.turns)) return reject("turns-not-array")
	const turns = record.turns
		.map((turn, turnIndex) => normalizeTurn(turn, turnIndex, at, rejections))
		.filter((turn): turn is ConversationDatasetTurn => turn !== null)
	if (turns.length === 0) return reject("no-valid-turns")
	const scope =
		record.scope === "session" ||
		record.scope === "user" ||
		record.scope === "agent" ||
		record.scope === "workspace" ||
		record.scope === "tenant" ||
		record.scope === "global"
			? record.scope
			: undefined
	return {
		...(typeof record.conversationId === "string" &&
		record.conversationId.trim()
			? { conversationId: record.conversationId }
			: {}),
		...(typeof record.sessionId === "string" && record.sessionId.trim()
			? { sessionId: record.sessionId }
			: {}),
		...(scope ? { scope } : {}),
		turns,
	}
}

function conversationsFromJson(
	value: unknown,
	line: number | null,
	rejections: ConversationImportRejection[],
): ConversationDatasetConversation[] {
	const candidates = Array.isArray(value)
		? value
		: value &&
				typeof value === "object" &&
				Array.isArray((value as Record<string, unknown>).conversations)
			? ((value as Record<string, unknown>).conversations as unknown[])
			: [value]
	return candidates
		.map((candidate, conversationIndex) =>
			normalizeConversation(candidate, { line, conversationIndex }, rejections),
		)
		.filter(
			(conversation): conversation is ConversationDatasetConversation =>
				conversation !== null,
		)
}

// Value-free counts so an all-rejected file still says why.
function noValidConversations(
	rejections: ConversationImportRejection[],
	failedLines = 0,
): Error {
	const reasons = new Map<string, number>()
	for (const entry of rejections)
		reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1)
	const detail = [
		...(failedLines > 0 ? [`failedLines=${failedLines}`] : []),
		...Array.from(reasons, ([reason, count]) => `${reason}=${count}`),
	]
	return new Error(
		`conversation dataset contains no valid conversations${detail.length > 0 ? ` (${detail.join(", ")})` : ""}`,
	)
}

export async function loadConversationDataset(
	datasetPath: string,
	options?: { baseDir?: string; allowedRoots?: string[] },
): Promise<ConversationImportDataset> {
	const resolvedPath = await resolveConversationDatasetPath({
		datasetPath,
		baseDir: options?.baseDir,
		allowedRoots: options?.allowedRoots,
	})
	const raw = await readFile(resolvedPath, "utf-8")
	if (!raw.trim()) throw new Error("conversation dataset is empty")
	try {
		const rejections: ConversationImportRejection[] = []
		// A document on one physical line has a knowable line for every record.
		const contentLines = raw
			.split("\n")
			.flatMap((text, index) => (text.trim() ? [index + 1] : []))
		const conversations = conversationsFromJson(
			JSON.parse(raw),
			contentLines.length === 1 ? (contentLines[0] ?? null) : null,
			rejections,
		)
		if (conversations.length === 0) throw noValidConversations(rejections)
		return {
			name: basename(resolvedPath),
			datasetKind: "generic",
			conversations,
			rejections,
		}
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error
	}
	const conversations: ConversationDatasetConversation[] = []
	const rejections: ConversationImportRejection[] = []
	let failedLines = 0
	let conversationIndex = 0
	for (const [lineIndex, rawLine] of raw.split("\n").entries()) {
		const line = rawLine.trim()
		if (!line || line.startsWith("#")) continue
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch {
			failedLines++
			continue
		}
		const conversation = normalizeConversation(
			parsed,
			{ line: lineIndex + 1, conversationIndex: conversationIndex++ },
			rejections,
		)
		if (conversation) conversations.push(conversation)
	}
	if (conversations.length === 0)
		throw noValidConversations(rejections, failedLines)
	return {
		name: basename(resolvedPath),
		datasetKind: "generic",
		conversations,
		failedLines,
		rejections,
	}
}
