import { randomUUID } from "node:crypto"
import type { ClientSession, Db, Document, ObjectId } from "mongodb"
import { metaCollection } from "./mongodb-schema.js"
import { MAJORITY_TRANSACTION_OPTIONS } from "./mongodb-transactions.js"

const EPOCH_DOC_PREFIX = "tenant-erasure-epoch:"

const DURABLE_GATE_WRITE_CONCERN = {
	w: "majority" as const,
	wtimeoutMS: 5_000,
}

type EpochDoc = {
	_id: string | ObjectId
	agentId: string
	epoch: number
	updatedAt: Date
}

export type ErasureGateState = "open" | "erasing"

export type ErasureGateDoc = {
	_id: string | ObjectId
	agentId: string
	epoch: number
	state: ErasureGateState
	serial: number
	erase?: { runId: string; startedAt: Date }
	updatedAt?: Date
	createdAt?: Date
}

export type AdmissionToken = {
	kind: "admission"
	agentId: string
	epoch: number
}

export type ErasureToken = {
	kind: "erasure"
	agentId: string
	runId: string
	epoch: number
}

export type FenceToken = AdmissionToken | ErasureToken

export class ErasureGateConflictError extends Error {
	readonly code = "ERASURE_GATE_CONFLICT"

	constructor(
		readonly agentId: string,
		message?: string,
	) {
		super(message ?? `erasure gate conflict for agent ${agentId}`)
		this.name = "ErasureGateConflictError"
	}
}

export class MalformedGateError extends Error {
	readonly code = "MALFORMED_ERASURE_GATE"

	constructor(
		readonly agentId: string,
		message: string,
	) {
		super(`malformed erasure gate for agent ${agentId}: ${message}`)
		this.name = "MalformedGateError"
	}
}

export function isErasureGateConflictError(
	err: unknown,
): err is ErasureGateConflictError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "ERASURE_GATE_CONFLICT"
	)
}

export function isMalformedGateError(err: unknown): err is MalformedGateError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "MALFORMED_ERASURE_GATE"
	)
}

function gateDocId(agentId: string): string {
	return `${EPOCH_DOC_PREFIX}${agentId}`
}

function gateIdFilter(agentId: string): { _id: ObjectId } {
	return { _id: gateDocId(agentId) as unknown as ObjectId }
}

function openStateCondition(): Document {
	return { $or: [{ state: "open" }, { state: { $exists: false } }] }
}

export function admissionGateFilter(token: AdmissionToken): Document {
	return {
		...gateIdFilter(token.agentId),
		epoch: token.epoch,
		...openStateCondition(),
	}
}

export function erasureOwnershipGateFilter(token: ErasureToken): Document {
	return {
		...gateIdFilter(token.agentId),
		epoch: token.epoch,
		state: "erasing",
		"erase.runId": token.runId,
	}
}

export function parseErasureGateDoc(
	agentId: string,
	raw: unknown,
): ErasureGateDoc | null {
	if (raw === null || raw === undefined) {
		return null
	}
	if (typeof raw !== "object") {
		throw new MalformedGateError(agentId, "gate document is not an object")
	}

	const doc = raw as Record<string, unknown>
	if (doc.agentId !== undefined && doc.agentId !== agentId) {
		throw new MalformedGateError(
			agentId,
			`gate document agentId mismatch (${String(doc.agentId)})`,
		)
	}

	const epoch = doc.epoch
	if (
		typeof epoch !== "number" ||
		!Number.isFinite(epoch) ||
		epoch < 0 ||
		!Number.isInteger(epoch)
	) {
		throw new MalformedGateError(
			agentId,
			`epoch must be a non-negative integer, got ${String(epoch)}`,
		)
	}

	const rawState = doc.state
	if (rawState !== undefined && rawState !== "open" && rawState !== "erasing") {
		throw new MalformedGateError(
			agentId,
			`state must be "open" or "erasing", got ${String(rawState)}`,
		)
	}
	const state: ErasureGateState = rawState === "erasing" ? "erasing" : "open"

	const serial = doc.serial
	if (
		serial !== undefined &&
		(typeof serial !== "number" ||
			!Number.isFinite(serial) ||
			serial < 0 ||
			!Number.isInteger(serial))
	) {
		throw new MalformedGateError(
			agentId,
			`serial must be a non-negative integer, got ${String(serial)}`,
		)
	}

	const erase = doc.erase
	if (state === "erasing") {
		if (
			typeof erase !== "object" ||
			erase === null ||
			typeof (erase as Record<string, unknown>).runId !== "string" ||
			((erase as Record<string, unknown>).runId as string).length === 0 ||
			!((erase as Record<string, unknown>).startedAt instanceof Date)
		) {
			throw new MalformedGateError(
				agentId,
				"erasing gate lacks a valid erase {runId, startedAt} record",
			)
		}
	} else if (erase !== undefined) {
		throw new MalformedGateError(
			agentId,
			"open gate carries a leftover erase record",
		)
	}

	return {
		_id: doc._id as string | ObjectId,
		agentId,
		epoch,
		state,
		serial: typeof serial === "number" ? serial : 0,
		...(state === "erasing"
			? {
					erase: {
						runId: (erase as Record<string, unknown>).runId as string,
						startedAt: (erase as Record<string, unknown>).startedAt as Date,
					},
				}
			: {}),
		...(doc.updatedAt instanceof Date ? { updatedAt: doc.updatedAt } : {}),
		...(doc.createdAt instanceof Date ? { createdAt: doc.createdAt } : {}),
	}
}

export async function readErasureGate(params: {
	db: Db
	prefix: string
	agentId: string
	session?: ClientSession
}): Promise<ErasureGateDoc | null> {
	const { db, prefix, agentId, session } = params
	const raw = await metaCollection(db, prefix).findOne(
		gateIdFilter(agentId),
		session ? { session } : {},
	)
	return parseErasureGateDoc(agentId, raw)
}

export async function captureAdmissionToken(params: {
	db: Db
	prefix: string
	agentId: string
}): Promise<AdmissionToken> {
	const { db, prefix, agentId } = params
	const now = new Date()
	const raw = await metaCollection(db, prefix).findOneAndUpdate(
		gateIdFilter(agentId),
		{
			$setOnInsert: {
				agentId,
				epoch: 0,
				state: "open",
				serial: 0,
				createdAt: now,
				updatedAt: now,
			},
		},
		{
			upsert: true,
			returnDocument: "after",
			includeResultMetadata: false,
			writeConcern: DURABLE_GATE_WRITE_CONCERN,
		},
	)
	const gate = parseErasureGateDoc(agentId, raw)
	if (!gate) {
		throw new MalformedGateError(
			agentId,
			"gate initialization returned no document",
		)
	}
	if (gate.state === "erasing") {
		throw new ErasureGateConflictError(
			agentId,
			`cannot admit work while erasure is in progress for agent ${agentId}`,
		)
	}
	return { kind: "admission", agentId, epoch: gate.epoch }
}

export async function beginErasure(params: {
	db: Db
	prefix: string
	agentId: string
}): Promise<ErasureToken> {
	const { db, prefix, agentId } = params
	const runId = randomUUID()
	const startedAt = new Date()

	return runInOwnedTransaction(db, async (session) => {
		const collection = metaCollection(db, prefix)
		const current = parseErasureGateDoc(
			agentId,
			await collection.findOne(gateIdFilter(agentId), { session }),
		)
		if (current?.state === "erasing") {
			throw new ErasureGateConflictError(
				agentId,
				`cannot start erasure while another run owns agent ${agentId}`,
			)
		}

		const now = new Date()
		let raw: unknown
		try {
			raw = await collection.findOneAndUpdate(
				current
					? {
							...gateIdFilter(agentId),
							epoch: current.epoch,
							...openStateCondition(),
						}
					: gateIdFilter(agentId),
				{
					$inc: { epoch: 1 },
					$set: {
						agentId,
						state: "erasing",
						erase: { runId, startedAt },
						updatedAt: now,
					},
					$setOnInsert: { createdAt: now },
				},
				{
					session,
					upsert: current === null,
					returnDocument: "after",
					includeResultMetadata: false,
				},
			)
		} catch (err) {
			if (isDuplicateKeyError(err)) {
				throw new ErasureGateConflictError(
					agentId,
					`another erasure initialized the gate for agent ${agentId}`,
				)
			}
			throw err
		}

		const updated = parseErasureGateDoc(agentId, raw)
		if (
			!updated ||
			updated.state !== "erasing" ||
			updated.erase?.runId !== runId
		) {
			throw new ErasureGateConflictError(
				agentId,
				`erasure start lost the gate race for agent ${agentId}`,
			)
		}
		return {
			kind: "erasure",
			agentId,
			runId,
			epoch: updated.epoch,
		}
	})
}

export async function takeoverErasure(params: {
	db: Db
	prefix: string
	agentId: string
}): Promise<ErasureToken> {
	const { db, prefix, agentId } = params
	const runId = randomUUID()
	const startedAt = new Date()
	const collection = metaCollection(db, prefix)
	const current = parseErasureGateDoc(
		agentId,
		await collection.findOne(gateIdFilter(agentId)),
	)
	if (current?.state !== "erasing" || !current.erase) {
		throw new ErasureGateConflictError(
			agentId,
			`cannot take over because no erasure owns agent ${agentId}`,
		)
	}
	const raw = await collection.findOneAndUpdate(
		{
			...erasureOwnershipGateFilter({
				kind: "erasure",
				agentId,
				runId: current.erase.runId,
				epoch: current.epoch,
			}),
			agentId,
			"erase.startedAt": current.erase.startedAt,
			...(current.serial === 0
				? { $or: [{ serial: 0 }, { serial: { $exists: false } }] }
				: { serial: current.serial }),
		},
		{
			$set: {
				erase: { runId, startedAt },
				updatedAt: new Date(),
			},
			$inc: { serial: 1 },
		},
		{
			returnDocument: "after",
			includeResultMetadata: false,
			writeConcern: DURABLE_GATE_WRITE_CONCERN,
		},
	)
	const updated = parseErasureGateDoc(agentId, raw)
	if (
		!updated ||
		updated.state !== "erasing" ||
		updated.erase?.runId !== runId
	) {
		throw new ErasureGateConflictError(
			agentId,
			`takeover lost the gate race for agent ${agentId}`,
		)
	}
	return {
		kind: "erasure",
		agentId,
		runId,
		epoch: updated.epoch,
	}
}

async function runInOwnedTransaction<T>(
	db: Db,
	fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
	const session = db.client.startSession()
	try {
		let value: T | undefined
		await session.withTransaction(async () => {
			value = await fn(session)
			return value
		}, MAJORITY_TRANSACTION_OPTIONS)
		if (value === undefined) {
			throw new Error("erasure gate transaction returned no result")
		}
		return value
	} finally {
		await session.endSession()
	}
}

function isDuplicateKeyError(err: unknown): boolean {
	if (typeof err === "object" && err !== null) {
		const code = (err as { code?: unknown }).code
		if (code === 11000 || code === "11000") {
			return true
		}
	}
	return err instanceof Error && err.message.includes("E11000")
}

function epochFilter(agentId: string): { _id: ObjectId } {
	return gateIdFilter(agentId)
}

export async function getTenantErasureEpoch(
	db: Db,
	prefix: string,
	agentId: string,
): Promise<number> {
	const doc = (await metaCollection(db, prefix).findOne(
		epochFilter(agentId),
	)) as EpochDoc | null
	if (!doc || typeof doc.epoch !== "number" || !Number.isFinite(doc.epoch)) {
		return 0
	}
	return doc.epoch
}

export async function bumpTenantErasureEpoch(
	db: Db,
	prefix: string,
	agentId: string,
): Promise<number> {
	const result = await metaCollection(db, prefix).findOneAndUpdate(
		epochFilter(agentId),
		{
			$inc: { epoch: 1 },
			$set: { agentId, updatedAt: new Date() },
		},
		{ upsert: true, returnDocument: "after" },
	)
	const doc = result as unknown as EpochDoc | null
	if (!doc || typeof doc.epoch !== "number" || !Number.isFinite(doc.epoch)) {
		throw new Error("tenant erasure epoch bump returned no usable epoch")
	}
	return doc.epoch
}
