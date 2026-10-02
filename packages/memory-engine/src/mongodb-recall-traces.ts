import { randomUUID } from "node:crypto"
import type { Db } from "mongodb"
import type { DiagnosticQueryPrivacyMode } from "./mongodb-diagnostic-privacy.js"
import { applyDiagnosticQueryPrivacy } from "./mongodb-diagnostic-privacy.js"
import { recallTracesCollection } from "./mongodb-schema.js"
import {
	type AdmissionToken,
	captureAdmissionToken,
	ErasureGateConflictError,
	withFencedWrite,
} from "./mongodb-write-fence.js"
import type { RecallTrace } from "./types.js"

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100

function clampListLimit(limit?: number): number {
	if (!Number.isFinite(limit)) {
		return DEFAULT_LIST_LIMIT
	}
	return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit ?? 0)))
}

export async function recordRecallTrace(params: {
	db: Db
	prefix: string
	admission?: AdmissionToken
	/**
	 * RET-21: the recorder — not the call sites — applies the diagnostic
	 * privacy policy, so no trace writer can persist a raw query around
	 * the configured mode. Required parameter: a missed site is a compile
	 * error, not a silent leak.
	 */
	privacyMode: DiagnosticQueryPrivacyMode
	trace: Omit<RecallTrace, "traceId" | "timestamp" | "query"> & {
		query: string
		traceId?: string
		timestamp?: Date
	}
}): Promise<string> {
	const { db, prefix, privacyMode, trace } = params
	const admission =
		params.admission ??
		(await captureAdmissionToken({ db, prefix, agentId: trace.agentId }))
	if (admission.agentId !== trace.agentId)
		throw new ErasureGateConflictError(trace.agentId)
	const traceId = trace.traceId ?? randomUUID()
	const { query, ...rest } = trace
	// Same transform the relevance-run path applies (one policy module):
	// "none" → no query text and no hash; "redacted-hash" → redacted text
	// + hash; "raw" → verbatim text + hash.
	const { queryHash, queryRedacted } = applyDiagnosticQueryPrivacy(
		query,
		privacyMode,
	)
	const doc: RecallTrace = {
		...rest,
		...(queryRedacted !== undefined ? { query: queryRedacted } : {}),
		...(queryHash ? { queryHash } : {}),
		traceId,
		timestamp: trace.timestamp ?? new Date(),
	}
	await withFencedWrite({
		db,
		prefix,
		token: admission,
		fn: (session) =>
			recallTracesCollection(db, prefix).insertOne(doc, { session }),
	})
	return traceId
}

export async function listRecallTraces(params: {
	db: Db
	prefix: string
	agentId: string
	limit?: number
}): Promise<RecallTrace[]> {
	const { db, prefix, agentId } = params
	const limit = clampListLimit(params.limit)
	const docs = await recallTracesCollection(db, prefix)
		.find({ agentId })
		.sort({ timestamp: -1 })
		.limit(limit)
		.toArray()
	return docs as unknown as RecallTrace[]
}

export async function getRecallTrace(params: {
	db: Db
	prefix: string
	traceId: string
	agentId?: string
}): Promise<RecallTrace | null> {
	const { db, prefix, traceId, agentId } = params
	const doc = await recallTracesCollection(db, prefix).findOne({
		traceId,
		...(agentId ? { agentId } : {}),
	})
	return (doc as RecallTrace | null) ?? null
}
