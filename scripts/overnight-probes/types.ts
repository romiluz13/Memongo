export const PROBE_LETTERS = ["A", "B", "C", "D", "E", "F", "G"] as const
export type ProbeLetter = (typeof PROBE_LETTERS)[number]

export type Outcome = "pass" | "fail" | "inconclusive" | "not-run"

export const EXIT_CODES = {
	pass: 0,
	fail: 1,
	inconclusive: 2,
	"not-run": 3,
	refusal: 64,
	crash: 70,
} as const

export type Observation =
	| { kind: "response"; route: string; body: unknown }
	| {
			kind: "http-error"
			route: string
			status: number
			code?: string
			message?: string
			outcomes?: unknown
	  }
	| { kind: "transport-error"; route: string; message: string }

export type FailureEvidence = {
	request: unknown
	response: unknown
}

export type ContractBasis = "code-derived" | "documented"

export type FailsByBasis = Record<ContractBasis | "unclassified", number>

export type CaseResult = {
	caseId: string
	outcome: Outcome
	predicate?: string
	reason?: string
	controlEligible: boolean
	contractBasis?: ContractBasis
	detail?: Record<string, unknown>
	evidence?: FailureEvidence
}

export type ProbeRunResult = {
	probe: ProbeLetter
	run: number
	rule: string
	version: string
	outcome: Outcome
	reasons: string[]
	cases: CaseResult[]
	counts: Record<string, number>
	extra?: Record<string, unknown>
}
