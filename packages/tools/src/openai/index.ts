import type { MemongoCoreOptions } from "../vercel/index.js"

/* ------------------------------------------------------------------ */
/*  OpenAI-compatible chat message shape                              */
/* ------------------------------------------------------------------ */

interface ChatMessage {
	role: string
	content: string | null
}

interface ChatCreateParams {
	messages: ChatMessage[]
	[key: string]: unknown
}

interface ChatChoice {
	message: ChatMessage
}

interface ChatCompletion {
	choices: ChatChoice[]
	[key: string]: unknown
}

/* ------------------------------------------------------------------ */
/*  Helpers: shared with Vercel middleware via MemongoCoreOptions      */
/* ------------------------------------------------------------------ */

async function fetchContextBundle(
	options: MemongoCoreOptions,
	userQuery?: string,
): Promise<string> {
	const mode =
		userQuery && options.mode !== "wake-up"
			? "full"
			: (options.mode ?? "wake-up")

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
		return data.rendered ?? ""
	} catch {
		return ""
	}
}

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

function extractUserQuery(messages: ChatMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user" && messages[i].content) {
			return messages[i].content!
		}
	}
	return undefined
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Wrap an OpenAI client instance so that every `chat.completions.create()`
 * call is enriched with Memongo memory context. No runtime `openai` dependency
 * is required: the middleware accepts any object matching the shape.
 */
export function createOpenAIMiddleware<
	T extends { chat: { completions: { create: (...args: any[]) => any } } },
>(client: T, options: MemongoCoreOptions): T {
	const completionsProxy = new Proxy(client.chat.completions, {
		get(target, prop, receiver) {
			if (prop === "create") {
				return async (params: ChatCreateParams, ...rest: unknown[]) => {
					const userQuery = extractUserQuery(params.messages)
					const rendered = await fetchContextBundle(options, userQuery)

					const enrichedMessages = rendered
						? [
								{
									role: "system" as const,
									content: `[Memory Context]\n${rendered}`,
								},
								...params.messages,
							]
						: params.messages

					const result = await (target.create as any)(
						{ ...params, messages: enrichedMessages },
						...rest,
					)

					// Fire-and-forget: save user message
					if (userQuery) {
						fireWriteEvent(options, "user", userQuery)
					}

					// Only extract assistant text for non-streaming calls
					if (!params.stream) {
						const completion = result as ChatCompletion
						const assistantText =
							completion?.choices?.[0]?.message?.content ?? ""
						if (assistantText) {
							fireWriteEvent(options, "assistant", assistantText)
						}
					}
					// Streaming calls: context is injected but assistant text
					// is not saved (stream chunks are not interceptable via Proxy).
					// Use writeEvent manually or use the Vercel AI SDK middleware
					// which supports wrapStream natively.

					return result
				}
			}
			return Reflect.get(target, prop, receiver)
		},
	})

	const chatProxy = new Proxy(client.chat, {
		get(target, prop, receiver) {
			if (prop === "completions") {
				return completionsProxy
			}
			return Reflect.get(target, prop, receiver)
		},
	})

	return new Proxy(client, {
		get(target, prop, receiver) {
			if (prop === "chat") {
				return chatProxy
			}
			return Reflect.get(target, prop, receiver)
		},
	})
}
