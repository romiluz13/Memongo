import { readFile, realpath } from "node:fs/promises"
import path, { basename } from "node:path"
import type { MemoryScope } from "@memongo/lib"

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

export type ConversationImportDataset = {
	name: string
	datasetKind: "generic"
	conversations: ConversationDatasetConversation[]
	failedLines?: number
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

function normalizeTurn(value: unknown): ConversationDatasetTurn | null {
	if (!value || typeof value !== "object") return null
	const record = value as Record<string, unknown>
	const role = typeof record.role === "string" ? record.role : ""
	const body = typeof record.body === "string" ? record.body.trim() : ""
	if (!VALID_ROLES.has(role) || !body) return null
	return {
		role: role as ConversationDatasetTurn["role"],
		body,
		...(typeof record.timestamp === "string" && record.timestamp.trim()
			? { timestamp: record.timestamp }
			: {}),
		...(record.metadata && typeof record.metadata === "object"
			? { metadata: record.metadata as Record<string, unknown> }
			: {}),
	}
}

function normalizeConversation(
	value: unknown,
): ConversationDatasetConversation | null {
	if (!value || typeof value !== "object") return null
	const record = value as Record<string, unknown>
	if (!Array.isArray(record.turns)) return null
	const turns = record.turns
		.map(normalizeTurn)
		.filter((turn): turn is ConversationDatasetTurn => turn !== null)
	if (turns.length === 0) return null
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
): ConversationDatasetConversation[] {
	const candidates = Array.isArray(value)
		? value
		: value &&
				typeof value === "object" &&
				Array.isArray((value as Record<string, unknown>).conversations)
			? ((value as Record<string, unknown>).conversations as unknown[])
			: [value]
	return candidates
		.map(normalizeConversation)
		.filter(
			(conversation): conversation is ConversationDatasetConversation =>
				conversation !== null,
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
		const conversations = conversationsFromJson(JSON.parse(raw))
		if (conversations.length === 0) {
			throw new Error("conversation dataset contains no valid conversations")
		}
		return {
			name: basename(resolvedPath),
			datasetKind: "generic",
			conversations,
		}
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error
	}
	const conversations: ConversationDatasetConversation[] = []
	let failedLines = 0
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.trim()
		if (!line || line.startsWith("#")) continue
		try {
			const conversation = normalizeConversation(JSON.parse(line))
			if (conversation) conversations.push(conversation)
			else failedLines++
		} catch {
			failedLines++
		}
	}
	if (conversations.length === 0) {
		throw new Error("conversation dataset contains no valid conversations")
	}
	return {
		name: basename(resolvedPath),
		datasetKind: "generic",
		conversations,
		failedLines,
	}
}
