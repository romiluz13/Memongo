import type { RouteHealth } from "./health.ts"
import { tallyHealth } from "./health.ts"
import { containsMarker, rawContains } from "./markers.ts"
import { isRecord } from "./rows.ts"
import {
	ERASED_ROLES,
	isTargeted,
	pairApplies,
	type Phase,
	postEraseCaseId,
	postEraseControlId,
	preEraseCaseId,
	preEraseControlId,
	READ_ROWS,
	requiredCaseIds,
	type RouteRow,
	TENANT_ROLES,
	type TenantRole,
} from "./route-matrix.ts"
import type { CaseResult, Observation, Outcome } from "./types.ts"
import { aggregateRun } from "./verdict.ts"

export const PROBE_A_VERSION = "A-2"

export const PROBE_A_RULE =
	"A pre-erase case fails when another tenant's marker appears anywhere in the returned content of the response, healthy or not; fields that only echo the request, such as the query, are not content. An erase case fails when an erased tenant's marker appears anywhere in the returned content after an erase confirmed complete. A case passes only when the response was healthy, complete and evaluable and a control on the same route found the reader's own marker (pre-erase) or the untouched agent's marker (post-erase). Every other case is inconclusive."

export type ReadRecord = {
	rowId: string
	phase: Phase
	reader: TenantRole
	foreign?: TenantRole
	observation: Observation
	health: RouteHealth
	request: unknown
}

export type EraseVerdict = { confirmed: boolean; reason?: string }

export type ProbeAEvaluation = {
	outcome: Outcome
	reasons: string[]
	cases: CaseResult[]
	gaps: { rowId: string; reason: string | undefined }[]
	counts: {
		attempted: number
		completed: number
		healthy: number
		evaluable: number
	}
}

type Markers = Readonly<Record<TenantRole, string>>

export function isConfirmedErase(
	response: unknown,
	expectedAgentId: string,
): EraseVerdict {
	if (!isRecord(response))
		return { confirmed: false, reason: "response:not-an-object" }
	if (response.agentId !== expectedAgentId) {
		return { confirmed: false, reason: "agent-mismatch" }
	}
	if (response.status !== "complete") {
		return { confirmed: false, reason: `status:${String(response.status)}` }
	}
	if (response.auditError !== undefined) {
		return { confirmed: false, reason: "audit-error" }
	}
	if (response.ownershipLost === true) {
		return { confirmed: false, reason: "ownership-lost" }
	}
	if (response.finalizeIndeterminate === true) {
		return { confirmed: false, reason: "finalize-indeterminate" }
	}
	if (response.gateState !== undefined && response.gateState !== "open") {
		return {
			confirmed: false,
			reason: `gate-state:${String(response.gateState)}`,
		}
	}
	const receipts = Array.isArray(response.receipts) ? response.receipts : []
	if (receipts.length === 0) return { confirmed: false, reason: "no-receipts" }
	let deleted = 0
	for (const receipt of receipts) {
		if (!isRecord(receipt))
			return { confirmed: false, reason: "receipt:malformed" }
		if (receipt.error !== undefined) {
			return {
				confirmed: false,
				reason: `receipt-error:${String(receipt.collection)}`,
			}
		}
		if (typeof receipt.deleted === "number") deleted += receipt.deleted
	}
	if (deleted === 0) return { confirmed: false, reason: "nothing-deleted" }
	return { confirmed: true }
}

function find(
	records: readonly ReadRecord[],
	rowId: string,
	phase: Phase,
	reader: TenantRole,
	foreign?: TenantRole,
): ReadRecord | undefined {
	return records.find(
		(r) =>
			r.rowId === rowId &&
			r.phase === phase &&
			r.reader === reader &&
			r.foreign === foreign,
	)
}

function requestCarriesMarker(record: ReadRecord, markers: Markers): boolean {
	return TENANT_ROLES.some((role) => rawContains(record.request, markers[role]))
}

function unevaluableReason(
	record: ReadRecord,
	markers: Markers,
): string | undefined {
	if (requestCarriesMarker(record, markers)) return "request-contains-marker"
	if (!record.health.evaluable) {
		return `unevaluable:${record.health.issues.join(",") || "no-response"}`
	}
	return undefined
}

function evidence(record: ReadRecord) {
	return { request: record.request, response: record.observation }
}

type Control = { passed: boolean }

function controlCase(
	caseId: string,
	record: ReadRecord | undefined,
	marker: string,
	markers: Markers,
): { result: CaseResult | undefined; control: Control } {
	if (!record) return { result: undefined, control: { passed: false } }
	const base = { caseId, controlEligible: false }
	const bad = unevaluableReason(record, markers)
	if (bad) {
		return {
			result: { ...base, outcome: "inconclusive", reason: bad },
			control: { passed: false },
		}
	}
	if (!containsMarker(record.observation, marker)) {
		return {
			result: {
				...base,
				outcome: "inconclusive",
				reason: record.health.denied
					? "own-marker-absent:denied"
					: "own-marker-absent",
			},
			control: { passed: false },
		}
	}
	return {
		result: { ...base, outcome: "pass", controlEligible: true },
		control: { passed: true },
	}
}

function negativeCase(input: {
	caseId: string
	record: ReadRecord
	marker: string
	leakPredicate: string
	control: Control
	markers: Markers
	erase?: EraseVerdict
}): CaseResult {
	const { caseId, record, marker, leakPredicate, control, markers, erase } =
		input
	const present = containsMarker(record.observation, marker)
	const eraseOk = erase === undefined || erase.confirmed
	if (present && eraseOk) {
		return {
			caseId,
			outcome: "fail",
			predicate: leakPredicate,
			reason: leakPredicate,
			controlEligible: control.passed,
			detail: { issues: record.health.issues },
			evidence: evidence(record),
		}
	}
	if (!eraseOk) {
		return {
			caseId,
			outcome: "inconclusive",
			reason: `erase-not-confirmed:${erase?.reason ?? "unknown"}`,
			controlEligible: false,
			detail: { markerPresent: present },
		}
	}
	const bad = unevaluableReason(record, markers)
	if (bad) {
		return {
			caseId,
			outcome: "inconclusive",
			reason: bad,
			controlEligible: false,
		}
	}
	if (!control.passed) {
		return {
			caseId,
			outcome: "inconclusive",
			reason: "control-not-established",
			controlEligible: false,
		}
	}
	return { caseId, outcome: "pass", controlEligible: true }
}

function preErase(
	row: RouteRow,
	records: readonly ReadRecord[],
	markers: Markers,
	into: CaseResult[],
) {
	for (const reader of TENANT_ROLES) {
		const own = find(records, row.id, "pre-erase", reader)
		const control = controlCase(
			preEraseControlId(row.id, reader),
			own,
			markers[reader],
			markers,
		)
		if (control.result) into.push(control.result)
		for (const foreign of TENANT_ROLES) {
			if (!pairApplies(row, reader, foreign)) continue
			const source = isTargeted(row.id)
				? find(records, row.id, "pre-erase", reader, foreign)
				: own
			if (!source) continue
			into.push(
				negativeCase({
					caseId: preEraseCaseId(row.id, reader, foreign),
					record: source,
					marker: markers[foreign],
					leakPredicate: `leak:${foreign}`,
					control: control.control,
					markers,
				}),
			)
		}
	}
}

function postErase(
	row: RouteRow,
	records: readonly ReadRecord[],
	markers: Markers,
	erase: EraseVerdict,
	into: CaseResult[],
) {
	const untouched = find(records, row.id, "post-erase", "agent")
	const control = controlCase(
		postEraseControlId(row.id),
		untouched,
		markers.agent,
		markers,
	)
	if (control.result) {
		into.push(
			erase.confirmed
				? control.result
				: { ...control.result, controlEligible: false },
		)
	}
	for (const erased of ERASED_ROLES) {
		const record = find(records, row.id, "post-erase", erased)
		if (!record) continue
		into.push(
			negativeCase({
				caseId: postEraseCaseId(row.id, erased),
				record,
				marker: markers[erased],
				leakPredicate: `erased-present:${erased}`,
				control: control.control,
				markers,
				erase,
			}),
		)
	}
}

export function evaluateProbeA(input: {
	records: readonly ReadRecord[]
	markers: Markers
	erase: EraseVerdict
}): ProbeAEvaluation {
	const { records, markers, erase } = input
	const cases: CaseResult[] = []
	const gaps: ProbeAEvaluation["gaps"] = []
	for (const row of READ_ROWS) {
		if (row.coverage === "gap") {
			gaps.push({ rowId: row.id, reason: row.gapReason })
			continue
		}
		preErase(row, records, markers, cases)
		postErase(row, records, markers, erase, cases)
	}
	const verdict = aggregateRun(cases, requiredCaseIds())
	return {
		outcome: verdict.outcome,
		reasons: verdict.reasons,
		cases,
		gaps,
		counts: tallyHealth(records.map((record) => record.health)),
	}
}
