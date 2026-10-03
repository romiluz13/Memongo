import { promises as fs } from "node:fs"
import path from "node:path"

/**
 * LongMemEval official-mode prediction sidecar.
 *
 * Lives beside the benchmark checkpoint (checkpointPath + ".predictions.json").
 * Records per-case answers and judge verdicts in an append-only way: recorded
 * verdicts are never re-decided on resume. The file itself is private
 * (mode 0600) and carries no gold answers, context passages, or credentials.
 */

export const OFFICIAL_PREDICTION_SIDECAR_VERSION = "v2" as const

/**
 * Raised when an existing sidecar cannot be trusted for this run: torn JSON,
 * unsupported version, invalid shape, or an identity mismatch. The sidecar is
 * never silently reset; the operator decides.
 */
export class OfficialPredictionSidecarError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "OfficialPredictionSidecarError"
	}
}

export interface OfficialPredictionSidecarIdentity {
	runId: string
	datasetSha256: string
	configurationHash: string
	answerModel: string
	judgeModel: string
	judgeProtocol: string
	promptVersion: string
	/**
	 * B9-3: the dated answer prompt version. A run that answered with
	 * dated-v1 must never share rows with a dated-v2 run; without this field
	 * the two are indistinguishable in the artifacts.
	 */
	answerPromptVersion: string
	/**
	 * B8/B9-3: the answer-call settings the hypotheses were produced under,
	 * recorded so a resume cannot mix answers made with different settings.
	 */
	answerTemperature: string
	answerMaxTokens: string
}

/**
 * B8-3: a case the measurement could not score reliably (answer truncated by
 * the token budget, empty answer, or a response whose JSON could not be
 * extracted). Unreliable rows carry a null verdict, are never re-attempted on
 * resume (at temperature 0 the failure reproduces), and are excluded from
 * judged coverage so accuracy is never published over silent holes.
 */
export type OfficialPredictionStage = "answered" | "judged" | "unreliable"

export interface OfficialPredictionRow {
	questionId: string
	stage: OfficialPredictionStage
	hypothesis: string
	verdict: string | null
	/** Why the case is unmeasured. Present iff stage is "unreliable". */
	reason?: string
	updatedAt: string
}

interface StoredSidecar {
	version: string
	identity: OfficialPredictionSidecarIdentity
	rows: Record<string, OfficialPredictionRow>
}

export interface OfficialPredictionSidecar {
	identity: OfficialPredictionSidecarIdentity
	rows: Record<string, OfficialPredictionRow>
}

export function deriveOfficialPredictionSidecarPath(
	checkpointPath: string,
): string {
	return `${checkpointPath}.predictions.json`
}

export function createOfficialPredictionSidecar(
	identity: OfficialPredictionSidecarIdentity,
): OfficialPredictionSidecar {
	return { identity, rows: {} }
}

const IDENTITY_FIELDS: Array<keyof OfficialPredictionSidecarIdentity> = [
	"runId",
	"datasetSha256",
	"configurationHash",
	"answerModel",
	"judgeModel",
	"judgeProtocol",
	"promptVersion",
	"answerPromptVersion",
	"answerTemperature",
	"answerMaxTokens",
]

export async function readOfficialPredictionSidecar(
	sidecarPath: string,
	identity: OfficialPredictionSidecarIdentity,
): Promise<OfficialPredictionSidecar | null> {
	let raw: string
	try {
		raw = await fs.readFile(sidecarPath, "utf8")
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ENOENT") {
			return null
		}
		throw error
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new OfficialPredictionSidecarError(
			`Official prediction sidecar at ${sidecarPath} is not valid JSON; delete it or restore its contents before resuming`,
		)
	}
	const stored = parseStoredSidecar(parsed, sidecarPath)
	const mismatches = IDENTITY_FIELDS.filter(
		(field) => stored.identity[field] !== identity[field],
	)
	if (mismatches.length > 0) {
		throw new OfficialPredictionSidecarError(
			`Official prediction sidecar at ${sidecarPath} does not match this run (mismatched fields: ${mismatches.join(", ")})`,
		)
	}
	return { identity, rows: stored.rows }
}

export function recordOfficialAnswer(
	sidecar: OfficialPredictionSidecar,
	questionId: string,
	hypothesis: string,
): OfficialPredictionSidecar {
	const existing = sidecar.rows[questionId]
	if (existing && existing.stage !== "answered") {
		throw new OfficialPredictionSidecarError(
			`Question ${questionId} is already ${existing.stage}; refusing to re-answer`,
		)
	}
	return {
		identity: sidecar.identity,
		rows: {
			...sidecar.rows,
			[questionId]: {
				questionId,
				stage: "answered",
				hypothesis,
				verdict: null,
				updatedAt: new Date().toISOString(),
			},
		},
	}
}

/**
 * B8-3/B9-1: record a case the run could not measure reliably. Terminal like
 * a judged row — never re-attempted on resume — but excluded from judged
 * coverage, so partial coverage honestly withholds accuracy.
 */
export function recordOfficialUnreliable(
	sidecar: OfficialPredictionSidecar,
	questionId: string,
	reason: string,
): OfficialPredictionSidecar {
	const existing = sidecar.rows[questionId]
	if (existing && existing.stage !== "answered") {
		throw new OfficialPredictionSidecarError(
			`Question ${questionId} is already ${existing.stage}; refusing to re-record an unreliable row`,
		)
	}
	return {
		identity: sidecar.identity,
		rows: {
			...sidecar.rows,
			[questionId]: {
				questionId,
				stage: "unreliable",
				hypothesis: "",
				verdict: null,
				reason,
				updatedAt: new Date().toISOString(),
			},
		},
	}
}

export function recordOfficialVerdict(
	sidecar: OfficialPredictionSidecar,
	questionId: string,
	verdict: string,
): OfficialPredictionSidecar {
	const existing = sidecar.rows[questionId]
	if (!existing) {
		throw new OfficialPredictionSidecarError(
			`Question ${questionId} has no recorded answered row to judge`,
		)
	}
	if (existing.stage !== "answered") {
		throw new OfficialPredictionSidecarError(
			`Question ${questionId} is ${existing.stage}, not answered; refusing to judge`,
		)
	}
	return {
		identity: sidecar.identity,
		rows: {
			...sidecar.rows,
			[questionId]: {
				...existing,
				stage: "judged",
				verdict,
				updatedAt: new Date().toISOString(),
			},
		},
	}
}

export async function writeOfficialPredictionSidecarAtomic(
	sidecarPath: string,
	sidecar: OfficialPredictionSidecar,
): Promise<void> {
	const stored: StoredSidecar = {
		version: OFFICIAL_PREDICTION_SIDECAR_VERSION,
		identity: sidecar.identity,
		rows: sidecar.rows,
	}
	const payload = `${JSON.stringify(stored, null, "\t")}\n`
	const directory = path.dirname(sidecarPath)
	const temporaryPath = path.join(
		directory,
		`.${path.basename(sidecarPath)}.${process.pid}.${Date.now()}.tmp`,
	)
	await fs.writeFile(temporaryPath, payload, { mode: 0o600 })
	await fs.chmod(temporaryPath, 0o600)
	await fs.rename(temporaryPath, sidecarPath)
}

export class OfficialQaCaptureError extends Error {
	constructor() {
		super("Official QA capture failed; refusing further provider calls")
		this.name = "OfficialQaCaptureError"
	}
}

export type OfficialQaCaptureWriter = (
	sequence: number,
	kind: "request" | "outcome",
	record: Record<string, unknown>,
) => Promise<void>

export async function createOfficialQaCaptureWriter(
	sidecarPath: string,
	identity: Pick<
		OfficialPredictionSidecarIdentity,
		"runId" | "datasetSha256" | "configurationHash"
	>,
): Promise<OfficialQaCaptureWriter> {
	const directory = `${sidecarPath}.capture`
	try {
		try {
			await fs.lstat(sidecarPath)
			throw new OfficialQaCaptureError()
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		await fs.mkdir(directory, { mode: 0o700 })
		const owned = await fs.lstat(directory)
		return async (sequence, kind, record) => {
			try {
				const current = await fs.lstat(directory)
				if (
					!current.isDirectory() ||
					current.dev !== owned.dev ||
					current.ino !== owned.ino ||
					(current.mode & 0o777) !== 0o700
				) {
					throw new OfficialQaCaptureError()
				}
				const file = await fs.open(
					path.join(directory, `${sequence}.${kind}.json`),
					"wx",
					0o600,
				)
				try {
					await file.writeFile(
						`${JSON.stringify({ ...record, ...identity, sequence, kind }, null, "\t")}\n`,
					)
					await file.sync()
				} finally {
					await file.close()
				}
			} catch {
				throw new OfficialQaCaptureError()
			}
		}
	} catch {
		throw new OfficialQaCaptureError()
	}
}

function parseStoredSidecar(
	parsed: unknown,
	sidecarPath: string,
): StoredSidecar {
	if (typeof parsed !== "object" || parsed === null) {
		throw new OfficialPredictionSidecarError(
			`Official prediction sidecar at ${sidecarPath} has an invalid shape`,
		)
	}
	const candidate = parsed as Partial<StoredSidecar> & { rows?: unknown }
	if (candidate.version !== OFFICIAL_PREDICTION_SIDECAR_VERSION) {
		throw new OfficialPredictionSidecarError(
			`Official prediction sidecar at ${sidecarPath} has unsupported version ${String(candidate.version)}`,
		)
	}
	if (
		typeof candidate.identity !== "object" ||
		candidate.identity === null ||
		!IDENTITY_FIELDS.every(
			(field) => typeof candidate.identity?.[field] === "string",
		)
	) {
		throw new OfficialPredictionSidecarError(
			`Official prediction sidecar at ${sidecarPath} has an invalid identity`,
		)
	}
	if (typeof candidate.rows !== "object" || candidate.rows === null) {
		throw new OfficialPredictionSidecarError(
			`Official prediction sidecar at ${sidecarPath} has invalid rows`,
		)
	}
	const rows: Record<string, OfficialPredictionRow> = {}
	for (const [key, value] of Object.entries(candidate.rows)) {
		if (typeof value !== "object" || value === null) {
			throw new OfficialPredictionSidecarError(
				`Official prediction sidecar at ${sidecarPath} has invalid row ${key}`,
			)
		}
		const row = value as Partial<OfficialPredictionRow> & {
			reason?: unknown
		}
		if (
			typeof row.questionId !== "string" ||
			(row.stage !== "answered" &&
				row.stage !== "judged" &&
				row.stage !== "unreliable") ||
			typeof row.hypothesis !== "string" ||
			(row.verdict !== null && typeof row.verdict !== "string") ||
			typeof row.updatedAt !== "string"
		) {
			throw new OfficialPredictionSidecarError(
				`Official prediction sidecar at ${sidecarPath} has invalid row ${key}`,
			)
		}
		if (row.stage === "unreliable") {
			// Unreliable rows must carry their reason and must never look
			// judged: a null verdict keeps them out of judged coverage.
			if (typeof row.reason !== "string" || row.reason.length === 0) {
				throw new OfficialPredictionSidecarError(
					`Official prediction sidecar at ${sidecarPath} has unreliable row ${key} without a reason`,
				)
			}
			if (row.verdict !== null) {
				throw new OfficialPredictionSidecarError(
					`Official prediction sidecar at ${sidecarPath} has unreliable row ${key} with a verdict`,
				)
			}
			rows[key] = {
				questionId: row.questionId,
				stage: "unreliable",
				hypothesis: row.hypothesis,
				verdict: null,
				reason: row.reason,
				updatedAt: row.updatedAt,
			}
			continue
		}
		rows[key] = {
			questionId: row.questionId,
			stage: row.stage,
			hypothesis: row.hypothesis,
			verdict: row.verdict,
			updatedAt: row.updatedAt,
		}
	}
	return {
		version: candidate.version,
		identity: candidate.identity,
		rows,
	}
}
