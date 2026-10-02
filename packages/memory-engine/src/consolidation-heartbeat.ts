export function startConsolidationHeartbeat(params: {
	leaseMs: number
	renew: () => Promise<void>
}) {
	let tail = Promise.resolve()
	let failure: { error: unknown } | undefined
	let pending = false
	let stopped = false

	const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
		const result = tail.then(fn)
		tail = result.then(
			() => {},
			() => {},
		)
		return result
	}
	const throwIfFailed = () => {
		if (failure) throw failure.error
	}
	const tick = () => {
		if (stopped || pending || failure) return
		pending = true
		void enqueue(async () => {
			try {
				await params.renew()
			} catch (error) {
				failure ??= { error }
				throw error
			}
		})
			.catch(() => {})
			.finally(() => {
				pending = false
			})
	}
	const timer =
		Number.isFinite(params.leaseMs) && params.leaseMs >= 3000
			? setInterval(
					tick,
					Math.min(Math.floor(params.leaseMs / 3), 2_147_483_647),
				)
			: undefined
	timer?.unref()

	return {
		enqueue,
		throwIfFailed,
		async stop() {
			stopped = true
			if (timer) clearInterval(timer)
			await tail
		},
	}
}
