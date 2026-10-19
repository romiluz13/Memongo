import type { Db, Document } from "mongodb"

export type FakeSearchIndex = Document & {
	name: string
	type?: string
	status?: string
	queryable?: boolean
	latestDefinition?: Document
}

/** One operation the fake serves; `before` may make it slow. */
export type FakeSearchDbOperation =
	| { kind: "buildInfo" }
	| { kind: "connectionStatus" }
	| { kind: "listCollections" }
	| { kind: "listSearchIndexes"; collection: string }
	| { kind: "createSearchIndex"; collection: string; name: string }
	| { kind: "updateSearchIndex"; collection: string; name: string }

export type FakeSearchDbOptions = {
	/**
	 * Awaited by the operation itself before it answers, so a test makes the
	 * operation slow (or never answer) instead of only moving a fake clock.
	 * The fake ignores `timeoutMS`, as a server that never answers would.
	 */
	before?: (operation: FakeSearchDbOperation) => Promise<void> | void
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
	| {
			op: "aggregate"
			collection: string
			pipeline: Document[]
			timeoutMS?: number
	  }
	| { op: "createSearchIndex"; collection: string; name: string }
	| { op: "updateSearchIndex"; collection: string; name: string }
	| { op: "dropSearchIndex"; collection: string; name: string }
	| { op: "createCollection"; collection: string }
	| { op: "command"; command: Document; timeoutMS?: number }

function timeoutField(options?: { timeoutMS?: number }): {
	timeoutMS?: number
} {
	return options?.timeoutMS === undefined
		? {}
		: { timeoutMS: options.timeoutMS }
}

/**
 * An update is asynchronous on a real deployment: the index keeps serving its
 * old (main) generation while a staged build of the new definition runs, and
 * `latestDefinition` already shows the requested one. It stays that way until
 * `advanceRollouts` promotes the staged build.
 */
function stageUpdate(
	index: FakeSearchIndex,
	definition: Document,
): FakeSearchIndex {
	const previous = index as {
		latestDefinitionVersion?: { version?: number }
		statusDetail?: Array<{ mainIndex?: Document }>
	}
	const currentVersion = previous.latestDefinitionVersion?.version ?? 1
	const main = previous.statusDetail?.[0]?.mainIndex ?? {
		status: "READY",
		queryable: true,
		definition: index.latestDefinition,
		definitionVersion: { version: currentVersion },
	}
	const nextVersion = currentVersion + 1
	return {
		...index,
		latestDefinition: definition,
		latestDefinitionVersion: { version: nextVersion },
		statusDetail: [
			{
				hostname: "fake-host-0",
				status: "READY",
				queryable: true,
				mainIndex: main,
				stagedIndex: {
					status: "BUILDING",
					queryable: false,
					definition,
					definitionVersion: { version: nextVersion },
				},
			},
		],
	}
}

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
	/** Promote every staged build to the serving generation; returns how many. */
	advanceRollouts: () => number
} {
	const calls: FakeSearchDbCall[] = []
	const indexes: Record<string, FakeSearchIndex[]> = structuredClone(
		options.indexes ?? {},
	)
	const runCommand = async (
		command: Document,
		commandOptions?: { timeoutMS?: number },
	): Promise<Document> => {
		calls.push({ op: "command", command, ...timeoutField(commandOptions) })
		if ("buildInfo" in command) {
			await options.before?.({ kind: "buildInfo" })
			if (options.buildInfoError) throw options.buildInfoError
			return { versionArray: options.versionArray ?? [8, 3, 0, 0] }
		}
		if ("connectionStatus" in command) {
			await options.before?.({ kind: "connectionStatus" })
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
		dbName: "memongo_test",
		aggregate: (
			pipeline: Document[],
			aggregateOptions?: { timeoutMS?: number },
		) => {
			calls.push({
				op: "aggregate",
				collection: name,
				pipeline,
				...timeoutField(aggregateOptions),
			})
			return {
				toArray: async () => {
					if (!("$listSearchIndexes" in (pipeline[0] ?? {}))) {
						throw new Error(
							`fake db: unexpected pipeline ${JSON.stringify(pipeline)}`,
						)
					}
					await options.before?.({
						kind: "listSearchIndexes",
						collection: name,
					})
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
					await options.before?.({
						kind: "listSearchIndexes",
						collection: name,
					})
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
			await options.before?.({
				kind: "createSearchIndex",
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
			await options.before?.({
				kind: "updateSearchIndex",
				collection: name,
				name: indexName,
			})
			const error = options.updateError?.(name, indexName)
			if (error) throw error
			indexes[name] = (indexes[name] ?? []).map((index) =>
				index.name === indexName ? stageUpdate(index, definition) : index,
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
			toArray: async () => {
				await options.before?.({ kind: "listCollections" })
				return (options.existingCollections ?? []).map((collectionName) => ({
					name: collectionName,
				}))
			},
		}),
		createCollection: async (collectionName: string) => {
			calls.push({ op: "createCollection", collection: collectionName })
		},
	} as unknown as Db
	const advanceRollouts = (): number => {
		let advanced = 0
		for (const [collectionName, list] of Object.entries(indexes)) {
			indexes[collectionName] = list.map((index) => {
				const hosts = (index as { statusDetail?: Document[] }).statusDetail
				if (!hosts?.some((host) => host.stagedIndex)) return index
				advanced += 1
				return {
					...index,
					statusDetail: hosts.map((host) => {
						const { stagedIndex, ...rest } = host
						return stagedIndex
							? {
									...rest,
									mainIndex: {
										...stagedIndex,
										status: "READY",
										queryable: true,
									},
								}
							: host
					}),
				}
			})
		}
		return advanced
	}
	return { db, calls, indexes, advanceRollouts }
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
