import type { Db, Document } from "mongodb"

/**
 * A fake events collection that evaluates the native `$rankFusion` aggregate
 * the event lanes send: the `$vectorSearch` filter, the `$search`
 * compound.filter and `must` text, each input's post-stage `$match` and
 * `$limit`, then RRF (k = 60). Vector similarity comes from the fixture, so a
 * turn that shares no query word can still rank. Lifecycle `$match` stages
 * (`$and` clauses) pass every fixture document. `countDocuments` takes
 * `{ $and: [canonicalFilter, lifecycle] }` and records each filter it gets.
 */

export type FakeEvent = {
	eventId: string
	agentId: string
	scope: string
	scopeRef: string
	sessionId: string
	role: "user" | "assistant"
	body: string
	timestamp: Date
}

function matchesFilter(doc: Document, filter: Document): boolean {
	if ("$and" in filter) return true
	return Object.entries(filter).every(([key, expected]) => {
		const actual = doc[key]
		if (
			expected &&
			typeof expected === "object" &&
			!(expected instanceof Date)
		) {
			if ("$in" in expected) return (expected.$in as unknown[]).includes(actual)
			if ("$lte" in expected) return actual <= expected.$lte
			return false
		}
		return actual === expected
	})
}

function matchesSearchClause(doc: Document, clause: Document): boolean {
	if (clause.equals) return doc[clause.equals.path] === clause.equals.value
	if (clause.in)
		return (clause.in.value as unknown[]).includes(doc[clause.in.path])
	if (clause.range) return doc[clause.range.path] <= clause.range.lte
	return false
}

function words(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
}

function applyTail(docs: Document[], stages: Document[]): Document[] {
	let current = docs
	for (const stage of stages) {
		if (stage.$match)
			current = current.filter((d) => matchesFilter(d, stage.$match))
		if (stage.$limit) current = current.slice(0, stage.$limit)
	}
	return current
}

export function fakeEventsDb(
	corpus: FakeEvent[],
	options: { similarity?: Record<string, number>; reverseTies?: boolean } = {},
) {
	const pipelines: Document[][] = []
	const counts: Document[] = []
	const similarity = options.similarity ?? {}
	const byId = (left: Document, right: Document) =>
		String(left.eventId).localeCompare(String(right.eventId))

	const runVector = (stages: Document[]): Document[] => {
		const spec = stages[0].$vectorSearch
		const ranked = corpus
			.filter((doc) => matchesFilter(doc, spec.filter))
			.toSorted(
				(l, r) =>
					(similarity[r.eventId] ?? 0) - (similarity[l.eventId] ?? 0) ||
					byId(l, r),
			)
			.slice(0, spec.limit)
		return applyTail(ranked, stages.slice(1))
	}
	const runText = (stages: Document[]): Document[] => {
		const compound = stages[0].$search.compound
		const queryWords = words(String(compound.must[0].text.query))
		const overlap = (doc: Document) =>
			[...words(doc.body)].filter((word) => queryWords.has(word)).length
		const ranked = corpus
			.filter((doc) =>
				(compound.filter as Document[]).every((c) =>
					matchesSearchClause(doc, c),
				),
			)
			.filter((doc) => overlap(doc) > 0)
			.toSorted((l, r) => overlap(r) - overlap(l) || byId(l, r))
		return applyTail(ranked, stages.slice(1))
	}

	const db = {
		collection: () => ({
			countDocuments: async (filter: Document) => {
				counts.push(filter)
				return corpus.filter((doc) =>
					(filter.$and as Document[]).every((clause) =>
						matchesFilter(doc, clause),
					),
				).length
			},
			aggregate: (pipeline: Document[]) => {
				pipelines.push(pipeline)
				return {
					toArray: async () => {
						const inputs = pipeline[0].$rankFusion.input.pipelines
						const scores = new Map<string, number>()
						for (const ranked of [
							runVector(inputs.vector),
							runText(inputs.text),
						]) {
							ranked.forEach((doc, index) => {
								scores.set(
									doc.eventId,
									(scores.get(doc.eventId) ?? 0) + 1 / (60 + index + 1),
								)
							})
						}
						const fused = corpus
							.filter((doc) => scores.has(doc.eventId))
							.map((doc) => ({
								...doc,
								score: scores.get(doc.eventId) as number,
							}))
							.toSorted(
								(l, r) =>
									r.score - l.score ||
									(options.reverseTies ? -byId(l, r) : byId(l, r)),
							)
						return applyTail(fused, pipeline.slice(1))
					},
				}
			},
		}),
	} as unknown as Db
	return { db, pipelines, counts }
}
