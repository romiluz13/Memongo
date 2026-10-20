export const MAX_RUNS = 5
export const HARD_CEILING_USD = 20

export type BudgetRefusalReason = "unpriced" | "invalid" | "ceiling" | "cap"

export class BudgetRefusal extends Error {
	override name = "BudgetRefusal"
	constructor(
		readonly reason: BudgetRefusalReason,
		detail: string,
	) {
		super(`budget refusal (${reason}): ${detail}`)
	}
}

export type UnitPrice = {
	inputUsdPerMTok: number
	outputUsdPerMTok: number
	source: string
}

export type Reservation = {
	readonly id: number
	readonly path: string
	readonly usd: number
	readonly units: number
}

export type BudgetSnapshot = {
	ceilingUsd: number
	reservedUsd: number
	settledUsd: number
	calls: Record<string, number>
	refusals: number
}

export type Budget = {
	reserveLlm(request: {
		path: string
		model: string
		inputBytes: number
		maxOutputTokens: number
		attempts?: number
	}): Reservation
	reserveCount(path: string, units?: number): Reservation
	settle(
		reservation: Reservation,
		actual?: { inputTokens: number; outputTokens: number },
	): void
	snapshot(): BudgetSnapshot
}

function isCount(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0
}

export function validateLimits(limits: { runs: number; ceilingUsd: number }): {
	runs: number
	ceilingUsd: number
} {
	if (!Number.isSafeInteger(limits.runs) || limits.runs < 1) {
		throw new BudgetRefusal("invalid", "runs must be a positive integer")
	}
	if (limits.runs > MAX_RUNS) {
		throw new BudgetRefusal("invalid", `runs must not exceed ${MAX_RUNS}`)
	}
	if (
		!Number.isFinite(limits.ceilingUsd) ||
		limits.ceilingUsd <= 0 ||
		limits.ceilingUsd > HARD_CEILING_USD
	) {
		throw new BudgetRefusal(
			"invalid",
			`ceiling must be a finite number above 0 and at most ${HARD_CEILING_USD}`,
		)
	}
	return { runs: limits.runs, ceilingUsd: limits.ceilingUsd }
}

export function createBudget(config: {
	ceilingUsd: number
	prices: Readonly<Record<string, UnitPrice>>
	caps: Readonly<Record<string, number>>
}): Budget {
	const ceiling = validateLimits({
		runs: 1,
		ceilingUsd: config.ceilingUsd,
	}).ceilingUsd
	let reservedUsd = 0
	let settledUsd = 0
	let refusals = 0
	let nextId = 1
	const calls: Record<string, number> = {}
	const open = new Map<number, { price?: UnitPrice; attempts: number }>()

	function refuse(reason: BudgetRefusalReason, detail: string): never {
		refusals += 1
		throw new BudgetRefusal(reason, detail)
	}

	function takeUnits(path: string, units: number): void {
		if (!Object.hasOwn(config.caps, path)) {
			refuse("unpriced", `path ${path} has no cap`)
		}
		const cap = config.caps[path] as number
		if (!isCount(cap)) refuse("invalid", `cap for ${path} is not a count`)
		if ((calls[path] ?? 0) + units > cap) {
			refuse("cap", `path ${path} would exceed its cap of ${cap}`)
		}
	}

	function begin(
		path: string,
		usd: number,
		units: number,
		pricing?: { price: UnitPrice; attempts: number },
	): Reservation {
		const reservation: Reservation = { id: nextId, path, usd, units }
		nextId += 1
		reservedUsd += usd
		calls[path] = (calls[path] ?? 0) + units
		open.set(reservation.id, {
			attempts: pricing?.attempts ?? 1,
			...(pricing ? { price: pricing.price } : {}),
		})
		return reservation
	}

	return {
		reserveLlm(request) {
			const attempts = request.attempts ?? 1
			if (
				!isCount(request.inputBytes) ||
				!isCount(request.maxOutputTokens) ||
				request.maxOutputTokens < 1 ||
				!Number.isSafeInteger(attempts) ||
				attempts < 1
			) {
				refuse("invalid", "quantities must be non-negative safe integers")
			}
			const price = Object.hasOwn(config.prices, request.model)
				? config.prices[request.model]
				: undefined
			if (!price) refuse("unpriced", `model ${request.model} has no unit price`)
			const usd =
				(attempts *
					(request.inputBytes * (price as UnitPrice).inputUsdPerMTok +
						request.maxOutputTokens * (price as UnitPrice).outputUsdPerMTok)) /
				1_000_000
			if (!Number.isFinite(usd)) refuse("invalid", "worst-case cost not finite")
			takeUnits(request.path, 1)
			if (reservedUsd + usd > ceiling) {
				refuse("ceiling", "reservation would cross the dollar ceiling")
			}
			return begin(request.path, usd, 1, {
				price: price as UnitPrice,
				attempts,
			})
		},
		reserveCount(path, units = 1) {
			if (!isCount(units) || units < 1) {
				refuse("invalid", "units must be a positive integer")
			}
			takeUnits(path, units)
			return begin(path, 0, units)
		},
		settle(reservation, actual) {
			const entry = open.get(reservation.id)
			if (!entry) return
			open.delete(reservation.id)
			let cost = reservation.usd
			if (actual && entry.price && entry.attempts === 1) {
				const reported =
					(actual.inputTokens * entry.price.inputUsdPerMTok +
						actual.outputTokens * entry.price.outputUsdPerMTok) /
					1_000_000
				if (Number.isFinite(reported) && reported >= 0) {
					cost = Math.min(cost, reported)
				}
			}
			reservedUsd -= reservation.usd - cost
			settledUsd += cost
		},
		snapshot() {
			return {
				ceilingUsd: ceiling,
				reservedUsd,
				settledUsd,
				calls: { ...calls },
				refusals,
			}
		},
	}
}
