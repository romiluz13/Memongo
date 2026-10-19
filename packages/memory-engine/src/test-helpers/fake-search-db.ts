import type { Db, Document } from "mongodb"

export type FakeSearchIndex = Document & {
	name: string
	type?: string
	status?: string
	queryable?: boolean
	latestDefinition?: Document
}

export type FakeSearchDbOptions = {
	versionArray?: unknown
	buildInfoError?: Error
	connectionStatus?: Document
	connectionStatusError?: Error
	/** Per collection: the indexes $listSearchIndexes returns. */
	indexes?: Record<string, FakeSearchIndex[]>
	listError?: (collection: string) => Error | undefined
	createError?: (collection: string, name: string) => Error | undefined
	updateError?: (collection: string, name: string) => Error | undefined
	/** What a created index looks like on the next listing; undefined = absent. */
	onCreate?: (
		collection: string,
		description: { name: string; type: string; definition: Document },
	) => FakeSearchIndex | undefined
	existingCollections?: string[]
}

export type FakeSearchDbCall =
	| { op: "aggregate"; collection: string; pipeline: Document[] }
	| { op: "createSearchIndex"; collection: string; name: string }
	| { op: "updateSearchIndex"; collection: string; name: string }
	| { op: "dropSearchIndex"; collection: string; name: string }
	| { op: "createCollection"; collection: string }
	| { op: "command"; command: Document }

export function readyIndex(
	name: string,
	type: string,
	definition: Document,
): FakeSearchIndex {
	return {
		name,
		type,
		status: "READY",
		queryable: true,
		latestDefinition: definition,
	}
}

/**
 * A Db double for the startup contract: buildInfo, connectionStatus,
 * $listSearchIndexes and the Search index management commands, with every
 * call recorded so tests can assert what boot and preflight did (and did not)
 * issue.
 */
export function createFakeSearchDb(options: FakeSearchDbOptions = {}): {
	db: Db
	calls: FakeSearchDbCall[]
	indexes: Record<string, FakeSearchIndex[]>
} {
	const calls: FakeSearchDbCall[] = []
	const indexes: Record<string, FakeSearchIndex[]> = structuredClone(
		options.indexes ?? {},
	)
	const runCommand = async (command: Document): Promise<Document> => {
		calls.push({ op: "command", command })
		if ("buildInfo" in command) {
			if (options.buildInfoError) throw options.buildInfoError
			return { versionArray: options.versionArray ?? [8, 3, 0, 0] }
		}
		if ("connectionStatus" in command) {
			if (options.connectionStatusError) throw options.connectionStatusError
			return (
				options.connectionStatus ?? {
					authInfo: { authenticatedUsers: [], authenticatedUserPrivileges: [] },
					ok: 1,
				}
			)
		}
		if ("ping" in command) return { ok: 1 }
		throw new Error(`fake db: unexpected command ${JSON.stringify(command)}`)
	}
	const collection = (name: string) => ({
		collectionName: name,
		aggregate: (pipeline: Document[]) => {
			calls.push({ op: "aggregate", collection: name, pipeline })
			return {
				toArray: async () => {
					if (!("$listSearchIndexes" in (pipeline[0] ?? {}))) {
						throw new Error(
							`fake db: unexpected pipeline ${JSON.stringify(pipeline)}`,
						)
					}
					const error = options.listError?.(name)
					if (error) throw error
					return structuredClone(indexes[name] ?? [])
				},
			}
		},
		listSearchIndexes: (indexName?: string) => {
			calls.push({
				op: "aggregate",
				collection: name,
				pipeline: [
					{ $listSearchIndexes: indexName ? { name: indexName } : {} },
				],
			})
			return {
				toArray: async () => {
					const error = options.listError?.(name)
					if (error) throw error
					return structuredClone(
						(indexes[name] ?? []).filter(
							(index) => indexName === undefined || index.name === indexName,
						),
					)
				},
			}
		},
		createSearchIndex: async (description: {
			name: string
			type: string
			definition: Document
		}) => {
			calls.push({
				op: "createSearchIndex",
				collection: name,
				name: description.name,
			})
			const error = options.createError?.(name, description.name)
			if (error) throw error
			const created = options.onCreate
				? options.onCreate(name, description)
				: readyIndex(description.name, description.type, description.definition)
			if (created) indexes[name] = [...(indexes[name] ?? []), created]
			return description.name
		},
		updateSearchIndex: async (indexName: string, definition: Document) => {
			calls.push({ op: "updateSearchIndex", collection: name, name: indexName })
			const error = options.updateError?.(name, indexName)
			if (error) throw error
			indexes[name] = (indexes[name] ?? []).map((index) =>
				index.name === indexName
					? { ...index, latestDefinition: definition, statusDetail: undefined }
					: index,
			)
		},
		dropSearchIndex: async (indexName: string) => {
			calls.push({ op: "dropSearchIndex", collection: name, name: indexName })
		},
	})
	const db = {
		databaseName: "memongo_test",
		admin: () => ({ command: runCommand }),
		command: runCommand,
		collection,
		listCollections: () => ({
			toArray: async () =>
				(options.existingCollections ?? []).map((collectionName) => ({
					name: collectionName,
				})),
		}),
		createCollection: async (collectionName: string) => {
			calls.push({ op: "createCollection", collection: collectionName })
		},
	} as unknown as Db
	return { db, calls, indexes }
}

export function writeCalls(calls: FakeSearchDbCall[]): FakeSearchDbCall[] {
	return calls.filter(
		(call) =>
			call.op === "createSearchIndex" ||
			call.op === "updateSearchIndex" ||
			call.op === "dropSearchIndex" ||
			call.op === "createCollection",
	)
}

/** Any aggregate that would embed a query string server-side (a paid call). */
export function embeddingQueries(
	calls: FakeSearchDbCall[],
): FakeSearchDbCall[] {
	return calls.filter(
		(call) =>
			call.op === "aggregate" &&
			call.pipeline.some((stage) => {
				const vector = (stage as { $vectorSearch?: { query?: unknown } })
					.$vectorSearch
				return vector !== undefined
			}),
	)
}
