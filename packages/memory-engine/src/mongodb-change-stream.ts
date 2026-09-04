import type {
	ChangeStream,
	ChangeStreamDocument,
	Collection,
	Document,
} from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"

const log = createSubsystemLogger("memory:mongodb:changestream")

/**
 * Callback invoked when relevant changes are detected in the chunks collection.
 * The watcher debounces and batches events, so this is called at most once
 * per debounce window.
 */
export type ChangeStreamCallback = (event: {
	operationType: string
	paths: string[]
	timestamp: Date
	resumeToken?: unknown
	gapDetected?: { reason: string; from: "startup" | "midstream" }
}) => void

/**
 * C-016: change-stream watcher liveness, surfaced through
 * `MongoDBManagerAdminOps.getDetailedStatus()` so a dead/recovering watcher
 * is visible in status instead of silently stopping cross-instance sync.
 */
export type ChangeStreamLiveness = {
	/** A stream is currently open and the watcher is not closed. */
	active: boolean
	state: "active" | "recovering" | "stopped"
	/** Re-opens since the last change event proved the stream alive. */
	reopenAttempts: number
	/** Ms until the next scheduled re-open (null when none is scheduled). */
	nextReopenDelayMs: number | null
}

/** C-016: re-open backoff policy — exponential delay with a ceiling. */
export type ChangeStreamReopenPolicy = {
	/** Delay before the SECOND re-open; doubles from there. Default 1000. */
	baseDelayMs?: number
	/** Upper bound on the re-open delay. Default 30_000. */
	maxDelayMs?: number
}

const DEFAULT_REOPEN_BASE_DELAY_MS = 1_000
const DEFAULT_REOPEN_MAX_DELAY_MS = 30_000

/**
 * MongoDBChangeStreamWatcher watches for changes to the chunks collection
 * and invokes a callback when relevant inserts/updates/deletes are detected.
 *
 * Requires a replica set (same as transactions). Degrades gracefully on
 * standalone topologies by simply not opening a stream.
 *
 * C-016 supervision: re-opens are unlimited but rate-limited by exponential
 * backoff with a ceiling — the first re-open is immediate (a stale token at
 * startup is routine), each subsequent re-open without a delivered event
 * waits baseDelayMs * 2^(n-2) capped at maxDelayMs. The watcher never stops
 * permanently on its own; liveness is observable via the `liveness` getter.
 */
export class MongoDBChangeStreamWatcher {
	private stream: ChangeStream<Document, ChangeStreamDocument> | null = null
	private debounceTimer: NodeJS.Timeout | null = null
	private pendingPaths: Set<string> = new Set()
	private pendingOpType: string = "unknown"
	private closed = false
	private _reopenAttempts = 0
	private reopenTimer: NodeJS.Timeout | null = null
	private reopenFireAtMs = 0
	private readonly reopenBaseDelayMs: number
	private readonly reopenMaxDelayMs: number
	/**
	 * F21: Last resume token for reconnection after restart.
	 * The manager can persist this token externally across restarts.
	 */
	private _lastResumeToken: unknown = null

	constructor(
		private readonly collection: Collection,
		private readonly callback: ChangeStreamCallback,
		private readonly debounceMs: number = 1000,
		reopenPolicy: ChangeStreamReopenPolicy = {},
	) {
		this.reopenBaseDelayMs =
			reopenPolicy.baseDelayMs ?? DEFAULT_REOPEN_BASE_DELAY_MS
		this.reopenMaxDelayMs =
			reopenPolicy.maxDelayMs ?? DEFAULT_REOPEN_MAX_DELAY_MS
	}

	/** F21: Get the last resume token for external persistence across restarts */
	get lastResumeToken(): unknown {
		return this._lastResumeToken
	}

	/**
	 * F21: Open the change stream. Accepts an optional resumeAfter token
	 * to resume from a previously persisted position. If the token is stale
	 * (oplog rotated past it), re-opens from now and signals a gap.
	 * Returns false if change streams are not supported (standalone MongoDB).
	 */
	async start(resumeAfter?: unknown): Promise<boolean> {
		if (this.closed) {
			return false
		}

		try {
			this.stream = this.openStream({ resumeAfter })
			this.attachStreamHandlers()
			log.info("change stream started")
			return true
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (isChangeStreamNotSupported(msg)) {
				log.info("change streams not supported (standalone topology)")
				return false
			}
			if (isResumeTokenInvalid(err)) {
				log.info("resume token stale at startup, re-opening from now")
				return this.reopenFromNow("startup")
			}
			log.warn(`failed to start change stream: ${msg}`)
			return false
		}
	}

	/**
	 * Open the change stream with the given resume strategy. Returns the stream
	 * (does not attach handlers — caller calls attachStreamHandlers).
	 */
	private openStream(options: {
		resumeAfter?: unknown
	}): ChangeStream<Document, ChangeStreamDocument> {
		const watchOpts: Record<string, unknown> = {
			fullDocument: "updateLookup",
		}
		if (options.resumeAfter) {
			watchOpts.resumeAfter = options.resumeAfter
		}
		// When no resumeAfter is provided, pass NO resume option — the driver
		// auto-captures response.operationTime (a BSON Timestamp) on the initial
		// aggregate, which is the correct type for startAtOperationTime. Passing a
		// JS Date is a type error on the wire (BSON type 9 vs 17). See:
		// node_modules/mongodb/src/cursor/change_stream_cursor.ts:143-150
		return this.collection.watch(
			[
				{
					$match: {
						operationType: { $in: ["insert", "update", "replace", "delete"] },
					},
				},
			],
			watchOpts,
		)
	}

	private attachStreamHandlers(): void {
		if (!this.stream) {
			return
		}
		const streamRef = this.stream
		this.stream.on("change", (change: ChangeStreamDocument) => {
			this.handleChange(change)
		})
		this.stream.on("error", (err: Error) => {
			const msg = err.message ?? String(err)
			if (isChangeStreamNotSupported(msg)) {
				log.info(
					"change streams not supported (standalone topology), closing watcher",
				)
				void this.close()
			} else if (isChangeStreamInvalidated(err)) {
				// Collection dropped/renamed. reopenFromNow opens a FRESH stream
				// with no resume token, which is valid after invalidation, and
				// its gap signal tells the manager to re-scan. Previously this
				// landed in the log-only branch and the watcher went silently
				// dark (fleet audit).
				log.info("change stream invalidated (346), re-opening from now")
				void this.reopenFromNow("midstream")
			} else if (isResumeTokenInvalid(err)) {
				log.info("resume token invalid mid-stream, re-opening from now")
				void this.reopenFromNow("midstream")
			} else {
				log.warn(`change stream error: ${msg}`)
			}
		})
		// A server-side close with no error event (driver-version dependent on
		// invalidate) otherwise left the watcher dark with isActive unpolled.
		// The streamRef guard keeps the deliberate close inside reopenFromNow
		// (which nulls this.stream first) from re-triggering a reopen.
		const onStreamGone = (event: "close" | "end") => {
			if (this.closed || this.stream !== streamRef) {
				return
			}
			log.warn(`change stream ${event} without error, re-opening from now`)
			void this.reopenFromNow("midstream")
		}
		this.stream.on("close", () => onStreamGone("close"))
		this.stream.on("end", () => onStreamGone("end"))
	}

	/**
	 * Re-open the stream from the current time after a stale/invalid resume
	 * token or mid-stream loss. Emits a gapDetected signal immediately (before
	 * any backoff delay) so the manager can re-scan the missed window right
	 * away, then schedules the re-open under exponential backoff: the first
	 * re-open is immediate, each subsequent one without a delivered change
	 * event waits baseDelayMs * 2^(n-2) capped at maxDelayMs. Re-opens are
	 * unlimited (supervised) — the backoff, not a cap, bounds the rate. A
	 * standalone topology still closes the watcher for good from the error
	 * handler (change streams can never work there).
	 */
	private reopenFromNow(from: "startup" | "midstream"): boolean {
		if (this.closed) {
			return false
		}

		// Detach from the old stream immediately so none of its late events
		// reach us. Close it in the background (don't block the re-open).
		if (this.stream) {
			void this.stream.close().catch(() => {
				// Ignore close errors on the old stream.
			})
			this.stream = null
		}
		if (this.reopenTimer) {
			clearTimeout(this.reopenTimer)
			this.reopenTimer = null
			this.reopenFireAtMs = 0
		}

		// Signal the gap so the manager can trigger a full re-scan. Emitted
		// before the open (and before any backoff delay): the missed window
		// exists regardless of when the re-open succeeds.
		try {
			this.callback({
				operationType: "gap_detected",
				paths: [],
				timestamp: new Date(),
				resumeToken: this._lastResumeToken,
				gapDetected: { reason: "stale resume token", from },
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`gap signal callback error: ${msg}`)
		}

		this.scheduleReopen()
		return true
	}

	/**
	 * Delay before re-open attempt N (1-indexed): 0 for the first (a stale
	 * token at startup is routine), then baseDelayMs * 2^(n-2) capped at
	 * maxDelayMs.
	 */
	private delayForReopenAttempt(attempt: number): number {
		if (attempt <= 1) {
			return 0
		}
		const exponential = this.reopenBaseDelayMs * 2 ** (attempt - 2)
		return Math.min(exponential, this.reopenMaxDelayMs)
	}

	/**
	 * Count the next re-open attempt and fire it (immediately or after the
	 * backoff delay). Internal retries after a failed open re-enter here
	 * directly — the gap was already signaled, so we must not signal again.
	 */
	private scheduleReopen(): void {
		this._reopenAttempts++
		const delay = this.delayForReopenAttempt(this._reopenAttempts)
		if (delay <= 0) {
			void this.attemptReopen()
			return
		}
		this.reopenFireAtMs = Date.now() + delay
		this.reopenTimer = setTimeout(() => {
			this.reopenTimer = null
			this.reopenFireAtMs = 0
			void this.attemptReopen()
		}, delay)
	}

	private async attemptReopen(): Promise<void> {
		if (this.closed) {
			return
		}
		try {
			this.stream = this.openStream({})
			this.attachStreamHandlers()
			log.info(
				`change stream re-opened from now (attempt ${this._reopenAttempts})`,
			)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`failed to re-open change stream from now: ${msg}`)
			if (isChangeStreamNotSupported(msg)) {
				// Standalone topology can never serve change streams — stop
				// instead of backing off forever.
				log.info("change streams not supported, closing watcher")
				void this.close()
				return
			}
			this.scheduleReopen()
		}
	}

	/**
	 * C-016: liveness snapshot for getDetailedStatus(). `stopped` covers
	 * deliberate close, never-started, and unsupported-standalone topology;
	 * `recovering` means a re-open is scheduled under backoff. Do NOT reset
	 * _reopenAttempts here or in attemptReopen: openStream() returns
	 * synchronously without a server round-trip, so a successful open
	 * doesn't prove the stream is alive. The counter resets in handleChange()
	 * on the first real change event. This prevents a re-stream storm: if the
	 * server keeps killing each freshly opened stream, the backoff bounds the
	 * rate instead of resetting every iteration.
	 */
	get liveness(): ChangeStreamLiveness {
		if (this.closed) {
			return {
				active: false,
				state: "stopped",
				reopenAttempts: this._reopenAttempts,
				nextReopenDelayMs: null,
			}
		}
		if (this.stream !== null) {
			return {
				active: true,
				state: "active",
				reopenAttempts: this._reopenAttempts,
				nextReopenDelayMs: null,
			}
		}
		if (this.reopenTimer !== null) {
			return {
				active: false,
				state: "recovering",
				reopenAttempts: this._reopenAttempts,
				nextReopenDelayMs: Math.max(0, this.reopenFireAtMs - Date.now()),
			}
		}
		return {
			active: false,
			state: "stopped",
			reopenAttempts: this._reopenAttempts,
			nextReopenDelayMs: null,
		}
	}

	private handleChange(change: ChangeStreamDocument): void {
		// F21: Persist resume token for reconnection
		if (change._id) {
			this._lastResumeToken = change._id
		}

		// A real change event proves the current stream is alive — reset the
		// re-open counter so a future stale-token event gets a fresh budget.
		// (openStream() returns synchronously without a server round-trip, so a
		// successful return doesn't prove the stream is alive; only a real event
		// does. This prevents a re-stream storm: see reopenFromNow.)
		this._reopenAttempts = 0

		const opType = change.operationType

		// Extract path from the document (available for insert/update/replace)
		let changedPath: string | undefined
		if ("fullDocument" in change && change.fullDocument) {
			changedPath = change.fullDocument.path as string | undefined
		}
		if (!changedPath && "documentKey" in change && change.documentKey) {
			// For deletes, try to extract path from _id if it's a composite key
			const docId = String(change.documentKey._id)
			const pathEnd = docId.indexOf(":")
			if (pathEnd > 0) {
				changedPath = docId.slice(0, pathEnd)
			}
		}

		if (changedPath) {
			this.pendingPaths.add(changedPath)
		}
		this.pendingOpType = opType

		// Debounce: batch changes within the debounce window
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
		}
		this.debounceTimer = setTimeout(() => {
			this.flush()
		}, this.debounceMs)
	}

	private flush(): void {
		if (this.pendingPaths.size === 0 && this.pendingOpType === "unknown") {
			return
		}

		const paths = Array.from(this.pendingPaths)
		const opType = this.pendingOpType
		this.pendingPaths.clear()
		this.pendingOpType = "unknown"
		this.debounceTimer = null

		try {
			this.callback({
				operationType: opType,
				paths,
				timestamp: new Date(),
				resumeToken: this._lastResumeToken,
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`change stream callback error: ${msg}`)
		}
	}

	async close(): Promise<void> {
		if (this.closed) {
			return
		}
		this.closed = true

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}

		// Cancel any re-open scheduled under backoff: a deliberate close must
		// not be resurrected by the supervision loop.
		if (this.reopenTimer) {
			clearTimeout(this.reopenTimer)
			this.reopenTimer = null
			this.reopenFireAtMs = 0
		}

		if (this.stream) {
			try {
				await this.stream.close()
			} catch {
				// Ignore close errors
			}
			this.stream = null
		}

		log.info("change stream closed")
	}

	get isActive(): boolean {
		return this.stream !== null && !this.closed
	}
}

function isChangeStreamNotSupported(msg: string): boolean {
	return (
		msg.includes("not allowed on a replica set") ||
		msg.includes("The $changeStream stage is only supported") ||
		msg.includes("not replicated") ||
		msg.includes("not a replica set")
	)
}

/**
 * Detect a stale or invalid resume token — the oplog has rotated past the
 * token's position, or the token is structurally unusable. MongoDB surfaces
 * this as ChangeStreamHistoryLost (code 286), InvalidResumeToken (260), or
 * CappedPositionLost (136, legacy). The Node driver surfaces `error.code` and
 * `error.codeName` verbatim from the server response.
 *
 * Primary match: `error.code` / `error.codeName` (stable across server
 * versions and message wording). Fallback: case-insensitive substrings of the
 * REAL server `errmsg` (NOT fabricated strings — the server does NOT put the
 * codeName in the message).
 *
 * Sources: github.com/mongodb/mongo src/mongo/base/error_codes.yml;
 * src/mongo/db/exec/agg/change_stream_check_resumability_stage.cpp:61-66.
 *
 * NOTE: ChangeStreamInvalidated (346) is deliberately NOT included here — it
 * means the collection was dropped/renamed. It is handled explicitly in the
 * error handler via isChangeStreamInvalidated: reopenFromNow opens a fresh
 * token-free stream (valid after invalidation) and emits a gap signal.
 */
const RESUME_TOKEN_INVALID_CODES = new Set<number>([136, 260, 286])
const RESUME_TOKEN_INVALID_CODE_NAMES = new Set<string>([
	"CappedPositionLost",
	"InvalidResumeToken",
	"ChangeStreamHistoryLost",
])

export function isChangeStreamInvalidated(error: unknown): boolean {
	if (error == null || typeof error !== "object") {
		return false
	}
	const code = (error as { code?: unknown }).code
	const codeName = (error as { codeName?: unknown }).codeName
	return code === 346 || codeName === "ChangeStreamInvalidated"
}

export function isResumeTokenInvalid(error: unknown): boolean {
	if (error != null && typeof error === "object") {
		const code = (error as { code?: unknown }).code
		if (typeof code === "number" && RESUME_TOKEN_INVALID_CODES.has(code)) {
			return true
		}
		const codeName = (error as { codeName?: unknown }).codeName
		if (
			typeof codeName === "string" &&
			RESUME_TOKEN_INVALID_CODE_NAMES.has(codeName)
		) {
			return true
		}
	}
	// Fallback: case-insensitive substrings of the REAL server errmsg.
	const msg = (
		error instanceof Error ? error.message : String(error ?? "")
	).toLowerCase()
	return (
		msg.includes("resume of change stream was not possible") ||
		msg.includes("resume point may no longer be in the oplog")
	)
}
