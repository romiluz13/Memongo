/**
 * Exact McNemar test for paired binary outcomes: conditional on the
 * discordant pairs, the direction count is Binomial(gains + losses, 1/2)
 * under equal marginal success. Two-sided p = min(1, 2 * P(X <= min)),
 * matching statsmodels `mcnemar(exact=True)`. Concordant pairs and the
 * total population do not enter the p-value. Valid only for independent,
 * complete, genuinely matched pairs on one binary endpoint.
 */
export type ExactMcNemarResult = {
	gains: number
	losses: number
	discordant: number
	pTwoSided: number
}

function assertCount(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RangeError(`${label} must be a non-negative safe integer`)
}

// num/den rounded once to a double; BigInt keeps every binomial term exact.
function ratio(num: bigint, den: bigint): number {
	if (num >= den) return 1
	const shift = Math.max(
		0,
		den.toString(2).length - num.toString(2).length + 64,
	)
	const scaled = Number((num << BigInt(shift)) / den)
	return shift <= 1023
		? scaled / 2 ** shift
		: scaled / 2 ** 1023 / 2 ** (shift - 1023)
}

export function exactMcNemar(
	gains: number,
	losses: number,
): ExactMcNemarResult {
	assertCount(gains, "gains")
	assertCount(losses, "losses")
	const discordant = gains + losses
	assertCount(discordant, "discordant pairs")
	const n = BigInt(discordant)
	const smaller = BigInt(Math.min(gains, losses))
	let term = 1n
	let tail = 1n
	for (let i = 1n; i <= smaller; i++) {
		term = (term * (n - i + 1n)) / i
		tail += term
	}
	return {
		gains,
		losses,
		discordant,
		pTwoSided: ratio(2n * tail, 1n << n),
	}
}
