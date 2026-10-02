import { renderMemoryContextBlock } from "../memory-context.js"
import {
	createMemongoMiddlewareCore,
	type MemongoCoreOptions,
} from "../middleware-core.js"

/* ------------------------------------------------------------------ */
/*  OpenAI-compatible chat message shape                              */
/* ------------------------------------------------------------------ */

interface ChatMessage {
	role: string
	content: string | null | Array<{ type: string; text?: string }>
}

interface ChatCreateParams {
	messages: ChatMessage[]
	[key: string]: unknown
}

interface ChatChoice {
	message: { role: string; content: string | null }
}

interface ChatCompletion {
	choices: ChatChoice[]
	[key: string]: unknown
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function extractUserQuery(messages: ChatMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "user") continue
		const content = messages[i].content
		if (typeof content === "string" && content) return content
		if (Array.isArray(content)) {
			const text = content
				.filter(
					(part) =>
						part.type === "text" &&
						typeof part.text === "string" &&
						part.text.length > 0,
				)
				.map((part) => part.text)
				.join("\n")
			return text || undefined
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
 *
 * All Memongo traffic routes through `@memongo/client`, with fresh context
 * retrieval for each call. The OpenAI chat-completions shape has no
 * `providerOptions` channel, so identity comes
 * from the constructor options (per middleware instance) only.
 */
export function createOpenAIMiddleware<
	T extends { chat: { completions: { create: (...args: any[]) => any } } },
>(client: T, options: MemongoCoreOptions): T {
	const core = createMemongoMiddlewareCore(options)

	const completionsProxy = new Proxy(client.chat.completions, {
		get(target, prop, receiver) {
			if (prop === "create") {
				return async (params: ChatCreateParams, ...rest: unknown[]) => {
					const userQuery = extractUserQuery(params.messages)
					const rendered = await core.getContextBundle({}, userQuery)

					const enrichedMessages = rendered
						? [
								{
									role: "system" as const,
									content: renderMemoryContextBlock(rendered),
								},
								...params.messages,
							]
						: params.messages

					const result = await (target.create as any)(
						{ ...params, messages: enrichedMessages },
						...rest,
					)

					// After-turn capture (P1.4): awaited so the write lands before a
					// serverless invocation can be frozen; captureTurn never throws
					// (failures go to onError). Streaming calls capture the user
					// message only — stream chunks are not interceptable via Proxy.
					if (!params.stream) {
						const completion = result as ChatCompletion
						const assistantText =
							completion?.choices?.[0]?.message?.content ?? ""
						await core.captureTurn(
							{},
							{ user: userQuery, assistant: assistantText },
						)
					} else if (userQuery) {
						await core.captureTurn({}, { user: userQuery })
					}

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
