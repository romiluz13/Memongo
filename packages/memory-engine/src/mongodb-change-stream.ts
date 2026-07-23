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
 * MongoDBChangeStreamWatcher watches for changes to the chunks collection
 * and invokes a callback when relevant inserts/updates/deletes are detected.
 *
 * Requires a replica set (same as transactions). Degrades gracefully on
 * standalone topologies by simply not opening a stream.
 */
export class MongoDBChangeStreamWatcher {
	private stream: ChangeStream<Document, ChangeStreamDocument> | null = null
	private debounceTimer: NodeJS.Timeout | null = null
	private pendingPaths: Set<string> = new Set()
	private pendingOpType: string = "unknown"
	private closed = false
	private _reopenAttempts = 0
	private static readonly MAX_REOPEN_ATTEMPTS = 3
	/**
	 * F21: Last resume token for reconnection after restart.
	 * The manager can persist this token externally across restarts.
	 */
	private _lastResumeToken: unknown = null

	constructor(
		private readonly collection: Collection,
		private readonly callback: ChangeStreamCallback,
		private readonly debounceMs: number = 1000,
	) {}

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
			} else if (isResumeTokenInvalid(err)) {
				log.info("resume token invalid mid-stream, re-opening from now")
				void this.reopenFromNow("midstream")
			} else {
				log.warn(`change stream error: ${msg}`)
			}
		})
	}

	/**
	 * Re-open the stream from the current time after a stale/invalid resume token.
	 * Emits a gapDetected signal so the manager can trigger a full re-scan of
	 * affected paths. Caps re-open attempts to MAX_REOPEN_ATTEMPTS to avoid a
	 * tight crash loop; after the cap, closes gracefully.
	 */
	private reopenFromNow(from: "startup" | "midstream"): boolean {
		if (this.closed) {
			return false
		}
		if (
			this._reopenAttempts >= MongoDBChangeStreamWatcher.MAX_REOPEN_ATTEMPTS
		) {
			log.warn("change stream re-open cap reached, closing watcher")
			void this.close()
			return false
		}
		this._reopenAttempts++

		// Close the old stream in the background (don't block the re-open).
		if (this.stream) {
			void this.stream.close().catch(() => {
				// Ignore close errors on the old stream.
			})
			this.stream = null
		}

		try {
			this.stream = this.openStream({})
			this.attachStreamHandlers()
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			log.warn(`failed to re-open change stream from now: ${msg}`)
			return false
		}

		// Signal the gap so the manager can trigger a full re-scan.
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

		// Do NOT reset _reopenAttempts here. openStream() returns synchronously
		// without a server round-trip, so a successful return doesn't prove the
		// stream is alive. The counter is reset in handleChange() on the first
		// real change event, which proves the new stream is working. This
		// prevents a re-stream storm: if the server keeps emitting stale-token
		// errors on each freshly opened stream, the cap actually bounds the
		// rate instead of resetting every iteration.
		log.info(`change stream re-opened from now (${from})`)
		return true
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
 * NOTE: ChangeStreamInvalidated (346) is deliberately NOT included — it means
 * the collection was dropped/renamed, which requires startAfter, not a
 * from-now re-stream.
 */
const RESUME_TOKEN_INVALID_CODES = new Set<number>([136, 260, 286])
const RESUME_TOKEN_INVALID_CODE_NAMES = new Set<string>([
	"CappedPositionLost",
	"InvalidResumeToken",
	"ChangeStreamHistoryLost",
])

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
