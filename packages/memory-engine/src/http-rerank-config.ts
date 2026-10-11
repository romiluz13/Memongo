export const DEFAULT_HTTP_RERANK_MODEL = "rerank-3"
export const DEFAULT_HTTP_RERANK_TOP_N = 20
const MAX_HTTP_RERANK_DOCUMENTS = 1_000

export function resolveEffectiveRerankTopN(
	topN: number = DEFAULT_HTTP_RERANK_TOP_N,
): number {
	// Zero can be the resolver's floored positive fraction; preserve its empty window.
	return Number.isFinite(topN) && topN >= 0
		? Math.min(MAX_HTTP_RERANK_DOCUMENTS, Math.floor(topN))
		: DEFAULT_HTTP_RERANK_TOP_N
}
