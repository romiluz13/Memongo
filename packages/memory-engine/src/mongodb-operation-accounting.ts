import { createHash } from "node:crypto"
import type { EnrichmentProvider } from "./mongodb-llm-enrichment.js"
import type {
	BenchmarkCostAccounting,
	BenchmarkOperationAccounting,
	BenchmarkOperationName,
} from "./types.js"

/**
 * Run-scoped operation accounting used by diagnostic harnesses without
 * coupling production search and write modules to benchmark implementations.
 */
export type OperationRunAccounting = {
	snapshot(): BenchmarkCostAccounting
	recordAttempt(
		operation: Exclude<BenchmarkOperationName, "embedding">,
		metadata?: OperationMutation,
	): void
	recordSuccess(
		operation: Exclude<BenchmarkOperationName, "embedding">,
		metadata?: OperationMutation,
	): void
	recordFailure(
		operation: Exclude<BenchmarkOperationName, "embedding">,
		metadata?: OperationMutation,
	): void
}

type OperationMutation = {
	provider?: string
	model?: string
	count?: number
	/**
	 * C-017: token usage reported by the transport for the recorded
	 * successes. Accumulated per operation entry; the snapshot exposes the
	 * totals and downgrades the cost-unavailable note to "prices not
	 * configured" once any tokens have been measured.
	 */
	inputTokens?: number
	outputTokens?: number
}

export type OperationRunConfiguration = {
	executionProfile: "shipped" | "diagnostic"
	retrievalLane: "native" | "raw-session"
	maxResults: number
	minScore: number
	settings: Record<string, string | number | boolean | null>
}

export type OperationRunContext = {
	runId: string
	configuration: Readonly<OperationRunConfiguration>
	configurationHash: string
	accounting: OperationRunAccounting
}

const AUTOMATED_EMBEDDING_ACCOUNTING: BenchmarkOperationAccounting = {
	operation: "embedding",
	observability: "unknown",
	attempted: null,
	succeeded: null,
	failed: null,
	unavailableReason:
		"MongoDB automated embedding calls are not exposed to the calling process",
}

const VECTOR_QUERY_ACCOUNTING: BenchmarkOperationAccounting = {
	operation: "vector-query",
	observability: "unknown",
	attempted: null,
	succeeded: null,
	failed: null,
	unavailableReason:
		"MongoDB search execution does not expose per-stage vector operation counts",
}

const OBSERVED_PROVIDER_OPERATIONS = [
	"rerank",
	"enrichment",
	"query-decomposition",
	"answer-generation",
	"answer-judge",
	"decoy-judge",
	"structured-extraction",
	"temporal-extraction",
	"contradiction-detection",
	"relation-extraction",
] as const

export function createOperationRunContext(params: {
	runId: string
	configuration: OperationRunConfiguration
	initialAccounting?: BenchmarkCostAccounting
}): OperationRunContext {
	const configuration: Readonly<OperationRunConfiguration> = Object.freeze({
		...params.configuration,
		settings: Object.freeze({ ...params.configuration.settings }),
	})
	const configurationHash = hashOperationRunConfiguration(configuration)
	const operations = new Map<string, BenchmarkOperationAccounting>()
	const operationKey = (
		operation: Exclude<BenchmarkOperationName, "embedding">,
		metadata?: OperationMutation,
	) => `${operation}\0${metadata?.provider ?? ""}\0${metadata?.model ?? ""}`
	/** C-017: any tokens recorded during the run flips the snapshot note. */
	let tokensMeasured = false
	operations.set(operationKey("vector-query"), { ...VECTOR_QUERY_ACCOUNTING })
	for (const operation of OBSERVED_PROVIDER_OPERATIONS) {
		operations.set(operationKey(operation), {
			operation,
			observability: "not-run",
			attempted: 0,
			succeeded: 0,
			failed: 0,
		})
	}
	for (const entry of params.initialAccounting?.operations ?? []) {
		if (entry.operation === "embedding") continue
		const key = operationKey(entry.operation, {
			provider: entry.provider,
			model: entry.model,
		})
		if (entry.provider || entry.model) {
			operations.delete(operationKey(entry.operation))
		}
		operations.set(key, { ...entry })
	}
	const measuredOperation = (
		operation: Exclude<BenchmarkOperationName, "embedding">,
		metadata?: OperationMutation,
	): BenchmarkOperationAccounting => {
		const key = operationKey(operation, metadata)
		const defaultKey = operationKey(operation)
		if (key !== defaultKey) {
			const defaultEntry = operations.get(defaultKey)
			if (defaultEntry?.observability === "not-run") {
				operations.delete(defaultKey)
			}
		}
		const existing = operations.get(key)
		if (existing) {
			if (existing.observability !== "measured") {
				existing.observability = "measured"
				existing.attempted = 0
				existing.succeeded = 0
				existing.failed = 0
				delete existing.unavailableReason
			}
			return existing
		}
		const created: BenchmarkOperationAccounting = {
			operation,
			observability: "measured",
			attempted: 0,
			succeeded: 0,
			failed: 0,
			...(metadata?.provider ? { provider: metadata.provider } : {}),
			...(metadata?.model ? { model: metadata.model } : {}),
		}
		operations.set(key, created)
		return created
	}
	return {
		runId: params.runId,
		configuration,
		configurationHash,
		accounting: {
			snapshot() {
				return {
					currency: null,
					totalCost: null,
					unavailableReason: tokensMeasured
						? "provider token usage is measured; prices are not configured"
						: "provider token usage and prices are not instrumented",
					operations: [
						{ ...AUTOMATED_EMBEDDING_ACCOUNTING },
						...Array.from(operations.values(), (entry) => ({ ...entry })),
					],
				}
			},
			recordAttempt(operation, metadata) {
				const count = metadata?.count ?? 1
				if (!Number.isFinite(count) || count <= 0) return
				const entry = measuredOperation(operation, metadata)
				entry.attempted = (entry.attempted ?? 0) + count
			},
			recordSuccess(operation, metadata) {
				const count = metadata?.count ?? 1
				if (!Number.isFinite(count) || count <= 0) return
				const entry = measuredOperation(operation, metadata)
				entry.succeeded = (entry.succeeded ?? 0) + count
				// C-017: accumulate transport-reported tokens alongside the call
				// count so a run snapshot answers "how many tokens" not just
				// "how many calls". Transports without a usage block leave the
				// fields untouched (absent = not reported, distinct from 0).
				const inputTokens = metadata?.inputTokens
				const outputTokens = metadata?.outputTokens
				if (inputTokens !== undefined && Number.isFinite(inputTokens)) {
					entry.inputTokens = (entry.inputTokens ?? 0) + inputTokens
					tokensMeasured = true
				}
				if (outputTokens !== undefined && Number.isFinite(outputTokens)) {
					entry.outputTokens = (entry.outputTokens ?? 0) + outputTokens
					tokensMeasured = true
				}
			},
			recordFailure(operation, metadata) {
				const count = metadata?.count ?? 1
				if (!Number.isFinite(count) || count <= 0) return
				const entry = measuredOperation(operation, metadata)
				entry.failed = (entry.failed ?? 0) + count
			},
		},
	}
}

function hashOperationRunConfiguration(
	configuration: OperationRunConfiguration,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				executionProfile: configuration.executionProfile,
				retrievalLane: configuration.retrievalLane,
				maxResults: configuration.maxResults,
				minScore: configuration.minScore,
				settings: Object.fromEntries(
					Object.entries(configuration.settings).toSorted(([left], [right]) =>
						left.localeCompare(right),
					),
				),
			}),
		)
		.digest("hex")
}

export function assertOperationRunConfiguration(
	context: OperationRunContext,
	current: OperationRunConfiguration,
): void {
	const currentHash = hashOperationRunConfiguration(current)
	if (currentHash !== context.configurationHash) {
		throw new Error(
			`operation configuration changed during execution: started=${context.configurationHash} current=${currentHash}`,
		)
	}
}

export function instrumentOperationProvider(params: {
	provider: EnrichmentProvider
	runContext: OperationRunContext
	operation: Exclude<BenchmarkOperationName, "embedding" | "vector-query">
	model?: string
}): EnrichmentProvider {
	return {
		...params.provider,
		async chatCompletion(request) {
			const metadata = {
				provider: params.provider.name,
				model: request.model,
			}
			params.runContext.accounting.recordAttempt(params.operation, metadata)
			try {
				const response = await params.provider.chatCompletion(request)
				params.runContext.accounting.recordSuccess(params.operation, {
					...metadata,
					...(response.usage
						? {
								inputTokens: response.usage.inputTokens,
								outputTokens: response.usage.outputTokens,
							}
						: {}),
				})
				return response
			} catch (error) {
				params.runContext.accounting.recordFailure(params.operation, metadata)
				throw error
			}
		},
	}
}
