import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
} from "@ai-sdk/provider"
import type { MemongoScope } from "@memongo/client"
// Canonical scope enum from the single contract source (P2.2).
import { MEMORY_SCOPE_VALUES } from "@memongo/lib"
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai"
import { renderMemoryContextBlock } from "../memory-context.js"
import {
	createMemongoMiddlewareCore,
	type MemongoCoreOptions,
	type MemongoRequestIdentity,
} from "../middleware-core.js"
import { _clearCache } from "../cache-identity.js"

export type { MemongoCoreOptions } from "../middleware-core.js"

/** Exported for testing only. */
export { _clearCache }

/* ------------------------------------------------------------------ */
/*  Per-request identity via providerOptions (P1.5)                    */
/*                                                                     */
/*  The Vercel AI SDK's official channel into middleware is            */
/*  `providerOptions` -> `params.providerOptions.memongo`:             */
/*    { agentId?, userId?, scope?, sessionId?, mode? }                 */
/*  Identity is read per request — never from module closures — so     */
/*  concurrent Fluid Compute invocations for different tenants sharing */
/*  one warm process can never be keyed together.                      */
/* ------------------------------------------------------------------ */

const VALID_SCOPES: ReadonlySet<string> = new Set(MEMORY_SCOPE_VALUES)

function identityFromParams(
	params: LanguageModelV2CallOptions,
): MemongoRequestIdentity {
	const raw = params.providerOptions?.memongo
	if (!raw || typeof raw !== "object") {
		return {}
	}
	const identity: MemongoRequestIdentity = {}
	if (typeof raw.agentId === "string") identity.agentId = raw.agentId
	if (typeof raw.userId === "string") identity.userId = raw.userId
	if (typeof raw.sessionId === "string") identity.sessionId = raw.sessionId
	if (typeof raw.scope === "string" && VALID_SCOPES.has(raw.scope)) {
		identity.scope = raw.scope as MemongoScope
	}
	if (raw.mode === "wake-up" || raw.mode === "full") {
		identity.mode = raw.mode
	}
	return identity
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
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export function withMemongo(
	model: LanguageModelV2,
	options: MemongoCoreOptions,
): LanguageModelV2 {
	const core = createMemongoMiddlewareCore(options)

	const middleware: LanguageModelMiddleware = {
		transformParams: async ({ params }) => {
			const identity = identityFromParams(params)
			const userQuery = extractUserQuery(params.prompt)
			const rendered = await core.getContextBundle(identity, userQuery)

			if (!rendered) return params

			const newPrompt: LanguageModelV2CallOptions["prompt"] = [
				{
					role: "system" as const,
					content: renderMemoryContextBlock(rendered),
				},
				...params.prompt,
			]
			return { ...params, prompt: newPrompt }
		},

		wrapGenerate: async ({ doGenerate, params }) => {
			const identity = identityFromParams(params)
			const result = await doGenerate()

			// After-turn capture (P1.4). AI SDK v5's LanguageModelV2Middleware has
			// no `onEnd` lifecycle callback — only transformParams / wrapGenerate /
			// wrapStream — so capture runs here, after doGenerate resolves. It is
			// awaited so a serverless invocation cannot be frozen before the write
			// lands; captureTurn never throws (failures go to onError).
			const userQuery = extractUserQuery(params.prompt)
			const responseText = extractResponseText(
				result.content as Array<{ type: string; text?: string }>,
			)
			await core.captureTurn(identity, {
				user: userQuery,
				assistant: responseText,
			})

			return result
		},

		wrapStream: async ({ doStream, params }) => {
			const identity = identityFromParams(params)
			const result = await doStream()

			// Awaited capture of the user message before streaming starts (P1.4).
			const userQuery = extractUserQuery(params.prompt)
			if (userQuery) {
				await core.captureTurn(identity, { user: userQuery })
			}

			// Collect streamed text chunks; the TransformStream flush() is the
			// stream equivalent of an onEnd callback — it runs after the last
			// chunk and may return a promise the stream waits for, so the
			// assistant capture is awaited there too. The user query is passed as
			// hashSource so both roles of this logical turn share one turn id.
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
					async flush() {
						const fullText = chunks.join("")
						if (fullText) {
							await core.captureTurn(
								identity,
								{ assistant: fullText },
								userQuery,
							)
						}
					},
				}),
			)

			return { ...result, stream: transformedStream }
		},
	}

	return wrapLanguageModel({ model, middleware })
}
