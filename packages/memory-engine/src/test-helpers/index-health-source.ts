// A request index-health source over the real required-index manifest: every
// manifest index READY and serving, except the ones a test patches (STALE,
// deleted). Pass `source` to runWithIndexHealth to run engine code inside one
// request snapshot.
import {
	deploymentFactsOf,
	type IndexHealthSource,
} from "../mongodb-index-health.js"
import { buildRequiredIndexManifest } from "../mongodb-required-index-manifest.js"
import {
	type FakeSearchIndex,
	createFakeSearchDb,
	readyIndex,
} from "./fake-search-db.js"

export function createIndexHealthSource(params: {
	prefix: string
	/** Index name suffix (after the prefix) → patch, or null to delete it. */
	patch?: Record<string, Partial<FakeSearchIndex> | null>
}): IndexHealthSource & {
	listReads: () => number
} {
	const manifest = buildRequiredIndexManifest({
		prefix: params.prefix,
		serverVersionArray: [8, 3, 0, 0],
		env: {} as NodeJS.ProcessEnv,
	})
	const indexes: Record<string, FakeSearchIndex[]> = {}
	for (const entry of manifest) {
		const patch = params.patch?.[entry.name.slice(params.prefix.length)]
		if (patch === null) continue
		indexes[entry.collectionName] = [
			...(indexes[entry.collectionName] ?? []),
			{ ...readyIndex(entry.name, entry.type, entry.definition), ...patch },
		]
	}
	const fake = createFakeSearchDb({ indexes })
	return {
		db: fake.db,
		prefix: params.prefix,
		manifest,
		facts: deploymentFactsOf({
			vectorSearch: true,
			textSearch: true,
			scoreFusion: true,
			rankFusion: true,
			storedSource: true,
			vectorIndexMethod: true,
		}),
		listReads: () =>
			fake.calls.filter(
				(call) =>
					call.op === "aggregate" && "$listSearchIndexes" in call.pipeline[0],
			).length,
	}
}
