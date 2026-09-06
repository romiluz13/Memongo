import fs from "node:fs/promises"
import type { Dirent, Stats } from "node:fs"
import path from "node:path"
import os from "node:os"
import { redactSecrets, createSubsystemLogger } from "@memongo/lib"
import { hashText } from "./internal.js"
import { isFileMissingError } from "./fs-utils.js"

const log = createSubsystemLogger("memory")

export type SessionFileEntry = {
	path: string
	absPath: string
	mtimeMs: number
	size: number
	hash: string
	content: string
	/** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
	lineMap: number[]
}

function resolveSessionTranscriptsDir(agentId: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
	return agentId
		? path.join(home, ".memongo", "agents", agentId, "sessions")
		: path.join(home, ".memongo", "agents", "sessions")
}

export async function listSessionFilesForAgent(
	agentId: string,
): Promise<string[]> {
	const dir = resolveSessionTranscriptsDir(agentId)
	let entries: Dirent[]
	try {
		entries = await fs.readdir(dir, { withFileTypes: true })
	} catch (err) {
		// W14: a missing sessions directory is legitimately empty, but any
		// other readdir failure (EACCES, EMFILE, …) must not read as "no
		// sessions" — the caller's stale cleanup would then delete every
		// stored session transcript's chunks. readdir rejects wholesale
		// (no partial-result mode), so surface the failure.
		if (isFileMissingError(err)) {
			return []
		}
		throw err
	}
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => path.join(dir, name))
}

export function sessionPathForFile(absPath: string): string {
	return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/")
}

function normalizeSessionText(value: string): string {
	return value
		.replace(/\s*\n+\s*/g, " ")
		.replace(/\s+/g, " ")
		.trim()
}

export function extractSessionText(content: unknown): string | null {
	if (typeof content === "string") {
		const normalized = normalizeSessionText(content)
		return normalized ? normalized : null
	}
	if (!Array.isArray(content)) {
		return null
	}
	const parts: string[] = []
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue
		}
		const record = block as { type?: unknown; text?: unknown }
		if (record.type !== "text" || typeof record.text !== "string") {
			continue
		}
		const normalized = normalizeSessionText(record.text)
		if (normalized) {
			parts.push(normalized)
		}
	}
	if (parts.length === 0) {
		return null
	}
	return parts.join(" ")
}

export async function buildSessionEntry(
	absPath: string,
): Promise<SessionFileEntry | null> {
	// W14: return null ONLY for a confirmed-missing file (the caller then
	// correctly treats its indexed data as stale). Transient read failures
	// (EACCES, EMFILE, …) must throw so the caller counts the file as failed
	// and skips stale cleanup instead of deleting its data.
	let stat: Stats
	try {
		stat = await fs.stat(absPath)
	} catch (err) {
		if (isFileMissingError(err)) {
			log.debug(`Session file vanished before read: ${absPath}`)
			return null
		}
		throw err
	}
	let raw: string
	try {
		raw = await fs.readFile(absPath, "utf-8")
	} catch (err) {
		if (isFileMissingError(err)) {
			log.debug(`Session file vanished before read: ${absPath}`)
			return null
		}
		throw err
	}
	const lines = raw.split("\n")
	const collected: string[] = []
	const lineMap: number[] = []
	for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
		const line = lines[jsonlIdx]
		if (!line.trim()) {
			continue
		}
		let record: unknown
		try {
			record = JSON.parse(line)
		} catch {
			continue
		}
		if (
			!record ||
			typeof record !== "object" ||
			(record as { type?: unknown }).type !== "message"
		) {
			continue
		}
		const message = (record as { message?: unknown }).message as
			| { role?: unknown; content?: unknown }
			| undefined
		if (!message || typeof message.role !== "string") {
			continue
		}
		if (message.role !== "user" && message.role !== "assistant") {
			continue
		}
		const text = extractSessionText(message.content)
		if (!text) {
			continue
		}
		const safe = redactSecrets(text)
		const label = message.role === "user" ? "User" : "Assistant"
		collected.push(`${label}: ${safe}`)
		lineMap.push(jsonlIdx + 1)
	}
	const content = collected.join("\n")
	return {
		path: sessionPathForFile(absPath),
		absPath,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		hash: hashText(`${content}\n${lineMap.join(",")}`),
		content,
		lineMap,
	}
}
