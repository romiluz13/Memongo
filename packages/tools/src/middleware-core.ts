import { MemongoClient, type MemongoScope } from "@memongo/client"
import { formatErrorMessage } from "@memongo/lib"
import { sha256Hex } from "./cache-identity.js"

/**
 * Shared core for the Vercel AI SDK and OpenAI middlewares (P1.5): both
 * route ALL Memongo traffic through `@memongo/client` (no hand-rolled fetch).
 *
 * Fetch context per request so reuse cannot bypass the API's current checks.
 *
 * P1.4: after-turn capture and failure observability.
 * - Capture: after a generation completes, the user prompt and assistant
 *   response are written back as conversation events with DERIVED
 *   idempotency keys (see `captureTurn`). The middlewares await capture so a
 *   serverless invocation cannot be frozen before the write lands; capture
 *   failures never reach the host LLM call.
 * - Observability: the client is created WITHOUT `silent` so the core sees
 *   every failure. Failures degrade exactly like silent mode (inject -> "",
 *   capture -> dropped) but are reported via `onError`; without a handler,
 *   ONE console.warn is emitted per middleware instance (not per request).
 */

/** Which middleware phase a memory-side failure came from. */
export type MemongoMiddlewareErrorPhase = "inject" | "capture"

export interface MemongoCoreOptions {
	apiUrl: string
	apiKey: string
	/**
	 * Trusted-host memory coordinates; these do not authenticate end users.
	 * Vercel requests can override them via `providerOptions.memongo`.
	 */
	userId?: string
	agentId?: string
	scope?: MemongoScope
	/** Explicit owner ref; a constructor ref is inherited only with its scope. */
	scopeRef?: string
	sessionId?: string
	/** Stable ID for one logical model call; use a new ID for each distinct turn. */
	requestId?: string
	mode?: "wake-up" | "full"
	/**
	 * After-turn capture: write the user prompt + assistant response back as
	 * conversation events after each generation. ON by default; set `false`
	 * to opt out (injection still works).
	 */
	capture?: boolean
	/**
	 * Error hook for memory-side failures (injection and capture). Memory
	 * failures never throw into the host LLM call — they are reported here
	 * instead. When omitted, ONE default `console.warn` is emitted per
	 * middleware instance and further failures are silently suppressed.
	 */
	onError?: (err: unknown, phase: MemongoMiddlewareErrorPhase) => void
}

/** Per-request identity overrides (Vercel: `providerOptions.memongo`). */
export interface MemongoRequestIdentity {
	agentId?: string
	userId?: string
	scope?: MemongoScope
	scopeRef?: string
	sessionId?: string
	requestId?: string
	mode?: "wake-up" | "full"
}

/** Conversation parts captured for one turn; empty parts are skipped. */
export interface MemongoCaptureParts {
	user?: string
	assistant?: string
}

export interface MemongoMiddlewareCore {
	getContextBundle(
		identity: MemongoRequestIdentity,
		userQuery?: string,
	): Promise<string>
	/**
	 * Capture one conversation turn as write-events with derived idempotency
	 * keys. Never throws and never blocks on Memongo availability: failures
	 * are reported via `onError` (or the one-time default warning).
	 *
	 * `hashSource` overrides the text the turn hash is derived from; the
	 * streaming path passes the user prompt so both roles of one logical turn
	 * share one turn id even though the assistant text arrives later.
	 */
	captureTurn(
		identity: MemongoRequestIdentity,
		parts: MemongoCaptureParts,
		hashSource?: string,
	): Promise<void>
}

/** Only the tail distinguishes turns — system prefixes are shared. */
const TURN_HASH_TAIL_LENGTH = 200

export function createMemongoMiddlewareCore(
	options: MemongoCoreOptions,
): MemongoMiddlewareCore {
	// NOT silent (P1.4): the core needs to see failures to report them via
	// onError. Every client call below is wrapped so failures still degrade
	// exactly like silent mode (inject -> "", capture -> dropped) and never
	// break the host LLM request.
	const client = new MemongoClient({
		baseUrl: options.apiUrl,
		apiKey: options.apiKey,
	})

	// One default warning per middleware instance — never per request.
	let defaultWarned = false
	function reportError(err: unknown, phase: MemongoMiddlewareErrorPhase): void {
		if (options.onError) {
			try {
				options.onError(err, phase)
			} catch {
				// A throwing user handler must not break the host LLM call.
			}
			return
		}
		if (defaultWarned) return
		defaultWarned = true
		// C-002: the default warning is a diagnostic path — the error chain
		// (which can carry request URLs or credential-bearing client errors)
		// is redacted. onError receives the raw error: it is a programmatic
		// callback, not a log.
		console.warn(
			`[memongo] ${phase} failed; suppressing further warnings for this middleware instance (pass onError to observe every failure):`,
			formatErrorMessage(err),
		)
	}

	function resolveOwner(identity: MemongoRequestIdentity) {
		const agentId = identity.agentId ?? options.agentId
		const userId = identity.userId ?? options.userId
		const scope = identity.scope ?? options.scope
		const sessionId = identity.sessionId ?? options.sessionId
		// A request scope must not reuse a ref belonging to the default scope.
		const inheritRef =
			identity.scope === undefined &&
			(scope !== "user" || identity.userId === undefined)
		const scopeRef =
			identity.scopeRef?.trim() ||
			(inheritRef ? options.scopeRef?.trim() : undefined) ||
			(scope === "user" && userId?.trim() ? `user:${userId.trim()}` : undefined)
		return { agentId, userId, scope, scopeRef, sessionId }
	}

	async function getContextBundle(
		identity: MemongoRequestIdentity,
		userQuery?: string,
	): Promise<string> {
		// Per-request identity wins; constructor values are defaults only.
		const { agentId, userId, scope, scopeRef, sessionId } =
			resolveOwner(identity)
		const modePref = identity.mode ?? options.mode
		const mode =
			userQuery && modePref !== "wake-up" ? "full" : (modePref ?? "wake-up")

		let rendered: string
		try {
			const bundle = await client.buildContextBundle({
				agentId: agentId ?? userId,
				mode,
				query: mode === "full" && userQuery ? userQuery : undefined,
				scope,
				scopeRef,
				sessionId,
			})
			rendered = bundle.rendered ?? ""
		} catch (err) {
			reportError(err, "inject")
			return ""
		}
		return rendered
	}

	async function captureTurn(
		identity: MemongoRequestIdentity,
		parts: MemongoCaptureParts,
		hashSource?: string,
	): Promise<void> {
		if (options.capture === false) return
		if (!parts.user && !parts.assistant) return

		const { agentId, userId, scope, scopeRef, sessionId } =
			resolveOwner(identity)

		// Preserve legacy keys when no caller-supplied logical ID is available.
		const source = hashSource ?? parts.user ?? parts.assistant ?? ""
		const tail = source.slice(-TURN_HASH_TAIL_LENGTH)
		const turnIdentity = [
			options.apiUrl,
			agentId ?? "",
			userId ?? "",
			sessionId ?? "",
			scope ?? "",
			tail,
		]
		if (scopeRef !== undefined) turnIdentity.push(scopeRef)
		const requestId = identity.requestId?.trim()
			? identity.requestId
			: options.requestId?.trim()
				? options.requestId
				: undefined
		const hashIdentity =
			requestId === undefined
				? turnIdentity
				: [
						"memongo-request-v1",
						options.apiUrl,
						agentId ?? null,
						userId ?? null,
						sessionId ?? null,
						scope ?? null,
						scopeRef ?? null,
						requestId,
					]
		const turnHash =
			(await sha256Hex(JSON.stringify(hashIdentity))) ??
			globalThis.crypto?.randomUUID?.() ??
			`${Date.now()}-${Math.random()}`

		const writes: Array<{ role: "user" | "assistant"; body: string }> = []
		if (parts.user) writes.push({ role: "user", body: parts.user })
		if (parts.assistant)
			writes.push({ role: "assistant", body: parts.assistant })

		for (const write of writes) {
			try {
				await client.writeEvent({
					role: write.role,
					body: write.body,
					agentId: agentId ?? userId,
					sessionId,
					scope,
					scopeRef,
					customId: `memongo-turn:${turnHash}:${write.role}`,
				})
			} catch (err) {
				reportError(err, "capture")
			}
		}
	}

	return { getContextBundle, captureTurn }
}
