import type { ClientSession, Db } from "mongodb"
import {
	admissionGateFilter,
	ErasureGateConflictError,
	type ErasureToken,
	erasureOwnershipGateFilter,
	type FenceToken,
	parseErasureGateDoc,
	readErasureGate,
} from "./mongodb-erasure-epoch.js"
import { metaCollection } from "./mongodb-schema.js"
import { MAJORITY_TRANSACTION_OPTIONS } from "./mongodb-transactions.js"

async function runInFenceSession<T>(params: {
	db: Db
	session?: ClientSession
	body: (session: ClientSession) => Promise<T>
}): Promise<T> {
	const { db, body } = params
	if (params.session) {
		const session = params.session
		if (session.inTransaction()) {
			return body(session)
		}
		return session.withTransaction(
			() => body(session),
			MAJORITY_TRANSACTION_OPTIONS,
		)
	}

	const session = db.client.startSession()
	try {
		return await session.withTransaction(
			() => body(session),
			MAJORITY_TRANSACTION_OPTIONS,
		)
	} finally {
		await session.endSession()
	}
}

async function applyGateFence(params: {
	db: Db
	prefix: string
	token: FenceToken
	session: ClientSession
}): Promise<void> {
	const { db, prefix, token, session } = params
	const gate = await readErasureGate({
		db,
		prefix,
		agentId: token.agentId,
		session,
	})
	if (
		!gate ||
		(token.kind === "admission"
			? gate.state !== "open" || gate.epoch !== token.epoch
			: gate.state !== "erasing" ||
				gate.epoch !== token.epoch ||
				gate.erase?.runId !== token.runId)
	) {
		throw new ErasureGateConflictError(token.agentId)
	}

	const filter =
		token.kind === "admission"
			? admissionGateFilter(token)
			: erasureOwnershipGateFilter(token)
	const result = await metaCollection(db, prefix).updateOne(
		filter,
		{ $inc: { serial: 1 }, $set: { updatedAt: new Date() } },
		{ session },
	)
	if (result.matchedCount === 0) {
		throw new ErasureGateConflictError(token.agentId)
	}
}

export async function withFencedWrite<T>(params: {
	db: Db
	prefix: string
	token: FenceToken
	fn: (session: ClientSession) => Promise<T>
	session?: ClientSession
}): Promise<T> {
	const { db, prefix, token, fn } = params
	assertValidToken(token)
	return runInFenceSession({
		db,
		session: params.session,
		body: async (session) => {
			await applyGateFence({ db, prefix, token, session })
			return fn(session)
		},
	})
}

export async function finalizeErasure(params: {
	db: Db
	prefix: string
	token: ErasureToken
	writeAudit?: (session: ClientSession) => Promise<void>
	session?: ClientSession
}): Promise<void> {
	const { db, prefix, token, writeAudit } = params
	assertValidToken(token)
	await runInFenceSession({
		db,
		session: params.session,
		body: async (session) => {
			const gate = await readErasureGate({
				db,
				prefix,
				agentId: token.agentId,
				session,
			})
			if (
				!gate ||
				gate.state !== "erasing" ||
				gate.epoch !== token.epoch ||
				gate.erase?.runId !== token.runId
			) {
				throw new ErasureGateConflictError(token.agentId)
			}

			await writeAudit?.(session)
			const raw = await metaCollection(db, prefix).findOneAndUpdate(
				erasureOwnershipGateFilter(token),
				{
					$set: { state: "open", updatedAt: new Date() },
					$unset: { erase: "" },
				},
				{
					session,
					returnDocument: "after",
					includeResultMetadata: false,
				},
			)
			const reopened = parseErasureGateDoc(token.agentId, raw)
			if (!reopened || reopened.state !== "open") {
				throw new ErasureGateConflictError(
					token.agentId,
					`erasure finalization lost the gate race for agent ${token.agentId}`,
				)
			}
		},
	})
}

function assertValidToken(token: FenceToken): void {
	if (!token || typeof token !== "object") {
		throw new TypeError("fence token must be an object")
	}
	if (typeof token.agentId !== "string" || token.agentId.length === 0) {
		throw new TypeError("fence token requires a non-empty agentId")
	}
	if (!isValidEpoch(token.epoch)) {
		throw new TypeError(
			`fence token epoch must be a non-negative integer, got ${String(token.epoch)}`,
		)
	}
	if (token.kind === "admission") {
		return
	}
	if (token.kind === "erasure") {
		if (typeof token.runId !== "string" || token.runId.length === 0) {
			throw new TypeError("erasure token requires a non-empty runId")
		}
		return
	}
	throw new TypeError(
		`unknown fence token kind: ${String((token as FenceToken).kind)}`,
	)
}

function isValidEpoch(epoch: number): boolean {
	return (
		typeof epoch === "number" &&
		Number.isFinite(epoch) &&
		Number.isInteger(epoch) &&
		epoch >= 0
	)
}

export {
	type AdmissionToken,
	beginErasure,
	captureAdmissionToken,
	ErasureGateConflictError,
	type ErasureToken,
	type FenceToken,
	isErasureGateConflictError,
	isMalformedGateError,
	MalformedGateError,
	readErasureGate,
	takeoverErasure,
} from "./mongodb-erasure-epoch.js"
