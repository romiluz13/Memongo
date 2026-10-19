// A kb_chunks collection double that EVALUATES the fusion aggregate the KB
// lane emits, so a test can assert which chunks the lane returns, not only the
// pipeline it built.
//
// Modeled the way mongot and mongod split the work:
//   - the first stage of each fusion input ($vectorSearch or $search) selects
//     candidates from the INDEXED copy using only its prefilter (the vector
//     `filter`, the compound `filter` equals/in clauses);
//   - every later stage ($match, $limit) runs on the document mongod holds now.
// A document can therefore pass the Search prefilter and still be dropped by
// the hydrated `$match`, which is what the lifecycle re-check relies on.
//
// Not modeled: ranking, analyzers, ANN recall. Every candidate scores `score`.
import type { Collection, Document } from "mongodb"
import { matchesFilter } from "./stateful-mongo-fake.js"

export type KbFusionDouble = {
	collection: Collection
	/** Every pipeline the lane ran, in order. */
	pipelines: Document[][]
	/** Runs after the candidates were chosen and before the fusion result is returned. */
	duringSearch: { hook?: () => void }
}

function prefilterMatches(doc: Document, clause: Document): boolean {
	const equals = clause.equals as { path: string; value: unknown } | undefined
	if (equals) return doc[equals.path] === equals.value
	const inClause = clause.in as { path: string; value: unknown[] } | undefined
	if (inClause) return inClause.value.includes(doc[inClause.path])
	const compound = clause.compound as { filter?: Document[] } | undefined
	if (compound) {
		return (compound.filter ?? []).every((inner) =>
			prefilterMatches(doc, inner),
		)
	}
	throw new Error(
		`kb fusion double: unsupported prefilter ${Object.keys(clause)}`,
	)
}

function runInput(chunks: Document[], input: Document[]): Document[] {
	const [searchStage, ...rest] = input
	let candidates: Document[]
	if (searchStage.$vectorSearch) {
		const filter = (searchStage.$vectorSearch.filter ?? {}) as Document
		candidates = chunks.filter((doc) => matchesFilter(doc, filter))
	} else if (searchStage.$search) {
		const filter = (searchStage.$search.compound?.filter ?? []) as Document[]
		candidates = chunks.filter((doc) =>
			filter.every((clause) => prefilterMatches(doc, clause)),
		)
	} else {
		throw new Error("kb fusion double: input must start with a Search stage")
	}
	let docs = candidates
	for (const stage of rest) {
		if (stage.$match) {
			docs = docs.filter((doc) => matchesFilter(doc, stage.$match as Document))
		} else if (stage.$limit !== undefined) {
			docs = docs.slice(0, stage.$limit as number)
		} else {
			throw new Error(
				`kb fusion double: unsupported input stage ${Object.keys(stage)}`,
			)
		}
	}
	return docs
}

export function createKbFusionDouble(
	chunks: Document[],
	options: { score?: number } = {},
): KbFusionDouble {
	const pipelines: Document[][] = []
	const duringSearch: KbFusionDouble["duringSearch"] = {}
	const collection = {
		aggregate: (pipeline: Document[]) => {
			pipelines.push(pipeline)
			return {
				toArray: async () => {
					const fusion =
						pipeline[0].$scoreFusion ?? pipeline[0].$rankFusion ?? undefined
					if (!fusion) {
						throw new Error("kb fusion double: pipeline has no fusion stage")
					}
					const inputs = fusion.input.pipelines as Record<string, Document[]>
					const merged = new Map<string, Document>()
					for (const input of Object.values(inputs)) {
						for (const doc of runInput(chunks, input)) {
							merged.set(`${doc.docId}:${doc.path}:${doc.startLine}`, doc)
						}
					}
					duringSearch.hook?.()
					const limit = (pipeline.find((stage) => stage.$limit !== undefined)
						?.$limit ?? 100) as number
					return [...merged.values()]
						.slice(0, limit)
						.map((doc) => ({ ...doc, score: options.score ?? 0.9 }))
				},
			}
		},
	}
	return {
		collection: collection as unknown as Collection,
		pipelines,
		duringSearch,
	}
}
