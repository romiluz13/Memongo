import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
} from "@ai-sdk/provider"
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai"

export interface MemongoCoreOptions {
	apiUrl: string
	apiKey: string
	userId: string
	agentId?: string
	mode?: "wake-up" | "full"
}

/* ------------------------------------------------------------------ */
/*  Simple LRU cache: Map with max 50 entries, 60s TTL                */
/* ------------------------------------------------------------------ */

interface CacheEntry {
	rendered: string
	expiresAt: number
}

const MAX_CACHE_SIZE = 50
const CACHE_TTL_MS = 60_000

const cache = new Map<string, CacheEntry>()

function hashQuery(text: string): string {
	let h = 0
	for (let i = 0; i < text.length; i++) {
		h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
	}
	return String(h)
}

function cacheGet(key: string): string | undefined {
	const entry = cache.get(key)
	if (!entry) return undefined
	if (Date.now() > entry.expiresAt) {
		cache.delete(key)
		return undefined
	}
	return entry.rendered
}

function cacheSet(key: string, rendered: string): void {
	if (cache.size >= MAX_CACHE_SIZE) {
		const oldest = cache.keys().next().value
		if (oldest !== undefined) cache.delete(oldest)
	}
	cache.set(key, { rendered, expiresAt: Date.now() + CACHE_TTL_MS })
}

/** Exported for testing only. */
export function _clearCache(): void {
	cache.clear()
}

/* ------------------------------------------------------------------ */
/*  Helpers: extract user query, extract response text                */
/* ------------------------------------------------------------------ */

function extractUserQuery(
	prompt: LanguageModelV2CallOptions["prompt"],
): string | undefined {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const msg = prompt[i]
		if (msg.role === "user") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text
			}
		}
	}
	return undefined
}

function extractResponseText(
	content: Array<{ type: string; text?: string }>,
): string {
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("")
}

/* ------------------------------------------------------------------ */
/*  Core: fetch context bundle from Memongo API                       */
/* ------------------------------------------------------------------ */

async function fetchContextBundle(
	options: MemongoCoreOptions,
	userQuery?: string,
): Promise<string> {
	const mode =
		userQuery && options.mode !== "wake-up"
			? "full"
			: (options.mode ?? "wake-up")
	const cacheKey = `${options.userId}:${hashQuery(userQuery ?? "")}`
	const cached = cacheGet(cacheKey)
	if (cached !== undefined) return cached

	const body: Record<string, unknown> = {
		agentId: options.agentId ?? options.userId,
		mode,
	}
	if (mode === "full" && userQuery) {
		body.query = userQuery
	}

	try {
		const res = await fetch(`${options.apiUrl}/v1/context-bundle`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${options.apiKey}`,
			},
			body: JSON.stringify(body),
		})

		if (!res.ok) return ""

		const data = (await res.json()) as { rendered?: string }
		const rendered = data.rendered ?? ""
		if (rendered) cacheSet(cacheKey, rendered)
		return rendered
	} catch {
		return ""
	}
}

/* ------------------------------------------------------------------ */
/*  Fire-and-forget write-event                                       */
/* ------------------------------------------------------------------ */

function fireWriteEvent(
	options: MemongoCoreOptions,
	role: "user" | "assistant",
	body: string,
): void {
	fetch(`${options.apiUrl}/v1/write-event`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${options.apiKey}`,
		},
		body: JSON.stringify({
			role,
			body,
			agentId: options.agentId ?? options.userId,
		}),
	}).catch((err) => {
		console.warn("[memongo] write-event failed:", role, err)
	})
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export function withMemongo(
	model: LanguageModelV2,
	options: MemongoCoreOptions,
): LanguageModelV2 {
	const middleware: LanguageModelMiddleware = {
		transformParams: async ({ params }) => {
			const userQuery = extractUserQuery(params.prompt)
			const rendered = await fetchContextBundle(options, userQuery)

			if (!rendered) return params

			const newPrompt: LanguageModelV2CallOptions["prompt"] = [
				{
					role: "system" as const,
					content: `[Memory Context]\n${rendered}`,
				},
				...params.prompt,
			]
			return { ...params, prompt: newPrompt }
		},

		wrapGenerate: async ({ doGenerate, params }) => {
			const result = await doGenerate()

			// Fire-and-forget: save user message
			const userQuery = extractUserQuery(params.prompt)
			if (userQuery) {
				fireWriteEvent(options, "user", userQuery)
			}

			// Fire-and-forget: save assistant response
			const responseText = extractResponseText(
				result.content as Array<{ type: string; text?: string }>,
			)
			if (responseText) {
				fireWriteEvent(options, "assistant", responseText)
			}

			return result
		},

		wrapStream: async ({ doStream, params }) => {
			const result = await doStream()

			// Fire-and-forget: save user message
			const userQuery = extractUserQuery(params.prompt)
			if (userQuery) {
				fireWriteEvent(options, "user", userQuery)
			}

			// Collect streamed text chunks and save assistant message after stream ends
			const originalStream = result.stream
			const chunks: string[] = []
			const transformedStream = originalStream.pipeThrough(
				new TransformStream({
					transform(chunk, controller) {
						if (chunk.type === "text-delta" && chunk.delta) {
							chunks.push(chunk.delta)
						}
						controller.enqueue(chunk)
					},
					flush() {
						const fullText = chunks.join("")
						if (fullText) {
							fireWriteEvent(options, "assistant", fullText)
						}
					},
				}),
			)

			return { ...result, stream: transformedStream }
		},
	}

	return wrapLanguageModel({ model, middleware })
}
