// M2 startup contract (spec "Deployment contract"). Boot requires MongoDB
// 8.3+, Search index management privileges, autoEmbed definitions and every
// required-index manifest entry READY, queryable and serving its manifest
// definition, all within one total deadline. Boot may create or update a
// manifest index; it never drops one. Every failure is a MemongoBootError.
// Preflight runs the same checks once, reports every unmet requirement and
// writes nothing. Neither path issues a query that embeds.
import type { Collection, Db, Document } from "mongodb"
import { createSubsystemLogger } from "@memongo/lib"
import {
	type MemongoBootFailureDetail,
	MemongoBootError,
	describeDriverError,
	driverErrorCode,
	isMemongoBootError,
	isPrivilegeDenial,
} from "./mongodb-boot-errors.js"
import {
	type BootBudget,
	createBootBudget,
	runBounded,
} from "./mongodb-boot-budget.js"
import { serverVersionAtLeast } from "./mongodb-capability-registry.js"
import {
	type RequiredIndexManifestOptions,
	type RequiredSearchIndex,
	buildRequiredIndexManifest,
} from "./mongodb-required-index-manifest.js"
import {
	assessRequiredIndex,
	bootFailure,
	definitionServes,
	type IndexAssessment,
	unmetDetail,
} from "./mongodb-index-assessment.js"
import {
	isSearchIndexManagementUnavailable,
	type SearchIndexDescription,
} from "./mongodb-schema-search-readiness.js"

const log = createSubsystemLogger("memory:mongodb:boot")

export const BOOT_READINESS_DEADLINE_MS = 180_000
export const BOOT_READINESS_POLL_MS = 1_000
const MINIMUM_SERVER_VERSION = { major: 8, minor: 3 } as const
const SEARCH_MANAGEMENT_ACTIONS = [
	"listSearchIndexes",
	"createSearchIndexes",
	"updateSearchIndex",
] as const
// ---------------------------------------------------------------------------
// Server version and Search management
// ---------------------------------------------------------------------------

export async function verifyServerVersion(
	db: Db,
	budget?: BootBudget,
): Promise<number[]> {
	let versionArray: unknown
	try {
		const buildInfo = await runBounded(budget, "buildInfo", (timeoutMS) =>
			timeoutMS === undefined
				? db.admin().command({ buildInfo: 1 })
				: db.admin().command({ buildInfo: 1 }, { timeoutMS }),
		)
		versionArray = (buildInfo as { versionArray?: unknown }).versionArray
	} catch (err) {
		if (isMemongoBootError(err)) throw err
		throw new MemongoBootError(
			{
				code: "server-version-unreadable",
				requirement: "readable buildInfo version",
			},
			`boot refused: the MongoDB server version is unreadable (buildInfo failed: ${describeDriverError(err)}); Memongo requires MongoDB ${MINIMUM_SERVER_VERSION.major}.${MINIMUM_SERVER_VERSION.minor} or later`,
		)
	}
	if (
		!Array.isArray(versionArray) ||
		versionArray.length < 2 ||
		!versionArray.every((part) => Number.isInteger(part))
	) {
		throw new MemongoBootError(
			{
				code: "server-version-unreadable",
				requirement: "readable buildInfo version",
			},
			"boot refused: buildInfo returned no readable versionArray; Memongo requires MongoDB 8.3 or later",
		)
	}
	if (
		!serverVersionAtLeast(
			versionArray,
			MINIMUM_SERVER_VERSION.major,
			MINIMUM_SERVER_VERSION.minor,
		)
	) {
		const version = versionArray.slice(0, 3).join(".")
		throw new MemongoBootError(
			{
				code: "server-version-unsupported",
				requirement: "MongoDB 8.3 or later",
				status: version,
			},
			`boot refused: MongoDB ${version} is unsupported; Memongo requires MongoDB 8.3 or later`,
		)
	}
	return versionArray as number[]
}

type PrivilegeResource = {
	db?: string
	collection?: string
	anyResource?: boolean
}

function resourceCovers(
	resource: PrivilegeResource | undefined,
	dbName: string,
	collectionName: string,
): boolean {
	if (!resource) return false
	if (resource.anyResource === true) return true
	if (
		typeof resource.db !== "string" ||
		typeof resource.collection !== "string"
	)
		return false
	return (
		(resource.db === "" || resource.db === dbName) &&
		(resource.collection === "" || resource.collection === collectionName)
	)
}

/**
 * Search index management privileges, read from connectionStatus. With no
 * authenticated user the deployment either runs without access control or
 * denies every command; the $listSearchIndexes probe settles which.
 */
export async function findMissingSearchPrivileges(
	db: Db,
	collectionNames: readonly string[],
	budget?: BootBudget,
): Promise<Array<{ action: string; collection: string }>> {
	let status: Document
	try {
		const command = { connectionStatus: 1, showPrivileges: true }
		status = await runBounded(budget, "connectionStatus", (timeoutMS) =>
			timeoutMS === undefined
				? db.command(command)
				: db.command(command, { timeoutMS }),
		)
	} catch (err) {
		if (isMemongoBootError(err)) throw err
		throw new MemongoBootError(
			{
				code: "index-metadata-unknown",
				requirement: "readable connectionStatus privileges",
			},
			`boot refused: connectionStatus failed, so Search index management privileges are unknown (${describeDriverError(err)})`,
		)
	}
	const authInfo = status.authInfo as
		| {
				authenticatedUsers?: unknown
				authenticatedUserPrivileges?: unknown
		  }
		| undefined
	if (!authInfo || !Array.isArray(authInfo.authenticatedUsers)) {
		throw new MemongoBootError(
			{
				code: "index-metadata-unknown",
				requirement: "readable connectionStatus privileges",
			},
			"boot refused: connectionStatus returned no authInfo, so Search index management privileges are unknown",
		)
	}
	if (authInfo.authenticatedUsers.length === 0) {
		return []
	}
	const privileges = Array.isArray(authInfo.authenticatedUserPrivileges)
		? (authInfo.authenticatedUserPrivileges as Array<{
				resource?: PrivilegeResource
				actions?: unknown
			}>)
		: []
	const missing: Array<{ action: string; collection: string }> = []
	for (const collection of collectionNames) {
		for (const action of SEARCH_MANAGEMENT_ACTIONS) {
			const granted = privileges.some(
				(privilege) =>
					Array.isArray(privilege.actions) &&
					privilege.actions.includes(action) &&
					resourceCovers(privilege.resource, db.databaseName, collection),
			)
			if (!granted) missing.push({ action, collection })
		}
	}
	return missing
}

function privilegeFailure(
	missing: Array<{ action: string; collection: string }>,
): MemongoBootError {
	const details: MemongoBootFailureDetail[] = missing.map((entry) => ({
		code: "search-privileges-denied",
		requirement: `${entry.action} privilege`,
		collection: entry.collection,
	}))
	const summary = missing
		.map((entry) => `${entry.action} on ${entry.collection}`)
		.join(", ")
	return new MemongoBootError(
		details[0],
		`boot refused: Search index management privileges are denied (${summary})`,
		details,
	)
}

/** Classify a $listSearchIndexes / search-index command error. */
export function classifySearchIndexError(
	err: unknown,
	context: {
		collection: string
		index?: string
		operation: string
		database?: string
	},
): MemongoBootError {
	if (isMemongoBootError(err)) return err
	const diagnostic = describeDriverError(err)
	// Only a definition the server refused may show the server's wording.
	const refusal = describeDriverError(err, {
		excerpt: true,
		database: context.database,
	})
	const where = context.index
		? `${context.index} on ${context.collection}`
		: context.collection
	if (isPrivilegeDenial(err)) {
		return new MemongoBootError(
			{
				code: "search-privileges-denied",
				requirement: `${context.operation} privilege`,
				collection: context.collection,
				index: context.index,
			},
			`boot refused: ${context.operation} was denied for ${where} (${diagnostic})`,
		)
	}
	const message = err instanceof Error ? err.message : String(err)
	// Keyless atlas-local refuses autoEmbed with "CanonicalModel: <model> not
	// registered yet, supported models are: []".
	if (/autoEmbed|CanonicalModel|not registered/i.test(message)) {
		return new MemongoBootError(
			{
				code: "autoembed-unavailable",
				requirement: "autoEmbed vector index definitions",
				collection: context.collection,
				index: context.index,
			},
			`boot refused: the deployment rejected the autoEmbed definition of ${where} (${refusal}); autoEmbed requires the atlas-local preview image or Atlas`,
		)
	}
	// A listing failure means Search management cannot be used; a create or
	// update the service answered and refused is a rejected definition.
	if (
		context.operation !== "$listSearchIndexes" &&
		!isSearchIndexManagementUnavailable(message)
	) {
		return new MemongoBootError(
			{
				code: "index-definition-rejected",
				requirement: "a definition the deployment accepts",
				collection: context.collection,
				index: context.index,
			},
			`boot refused: the deployment rejected ${context.operation} on ${where} (${refusal})`,
		)
	}
	return new MemongoBootError(
		{
			code: "search-management-unavailable",
			requirement: "Search index management",
			collection: context.collection,
			index: context.index,
		},
		isSearchIndexManagementUnavailable(message)
			? `boot refused: Search index management is unavailable (${context.operation} on ${where}: ${diagnostic})`
			: `boot refused: ${context.operation} failed on ${where} (${diagnostic})`,
	)
}

async function listCollectionSearchIndexes(
	collection: Collection,
	budget?: BootBudget,
): Promise<SearchIndexDescription[]> {
	try {
		return (await runBounded(
			budget,
			`$listSearchIndexes on ${collection.collectionName}`,
			(timeoutMS) => {
				const pipeline = [{ $listSearchIndexes: {} }]
				return (
					timeoutMS === undefined
						? collection.aggregate(pipeline)
						: collection.aggregate(pipeline, { timeoutMS })
				).toArray()
			},
		)) as SearchIndexDescription[]
	} catch (err) {
		if (isMemongoBootError(err)) throw err
		// A collection that does not exist yet has no Search indexes.
		if (driverErrorCode(err) === 26) return []
		throw classifySearchIndexError(err, {
			collection: collection.collectionName,
			operation: "$listSearchIndexes",
			database: collection.dbName,
		})
	}
}

// ---------------------------------------------------------------------------
// Repair: create or update, never drop
// ---------------------------------------------------------------------------

type SearchIndexCollection = Collection & {
	createSearchIndex: (description: {
		name: string
		type: "search" | "vectorSearch"
		definition: Document
	}) => Promise<string>
	updateSearchIndex: (name: string, definition: Document) => Promise<void>
}

async function createRequiredIndex(
	collection: SearchIndexCollection,
	entry: RequiredSearchIndex,
	budget?: BootBudget,
): Promise<void> {
	try {
		await runBounded(budget, `createSearchIndex ${entry.name}`, () =>
			collection.createSearchIndex({
				name: entry.name,
				type: entry.type,
				definition: entry.definition,
			}),
		)
		log.info(`created ${entry.label} search index ${entry.name}`)
	} catch (err) {
		if (isMemongoBootError(err)) throw err
		const message = err instanceof Error ? err.message : String(err)
		// A concurrent boot created it first; the readiness wait verifies it.
		if (/already exists|duplicate/i.test(message)) return
		throw classifySearchIndexError(err, {
			collection: entry.collectionName,
			index: entry.name,
			operation: "createSearchIndex",
			database: collection.dbName,
		})
	}
}

async function updateRequiredIndex(
	collection: SearchIndexCollection,
	entry: RequiredSearchIndex,
	budget?: BootBudget,
): Promise<void> {
	try {
		await runBounded(budget, `updateSearchIndex ${entry.name}`, () =>
			collection.updateSearchIndex(entry.name, entry.definition),
		)
		log.info(`updated ${entry.label} search index ${entry.name}`)
	} catch (err) {
		throw classifySearchIndexError(err, {
			collection: entry.collectionName,
			index: entry.name,
			operation: "updateSearchIndex",
			database: collection.dbName,
		})
	}
}

/**
 * Bring one manifest index toward its definition: create it when absent,
 * update it when it serves a different definition. Never drops.
 */
export async function reconcileRequiredIndex(
	collection: Collection,
	entry: RequiredSearchIndex,
	existing?: SearchIndexDescription,
	budget?: BootBudget,
): Promise<"created" | "updated" | "unchanged"> {
	const searchCollection = collection as SearchIndexCollection
	const current =
		existing ??
		(await listCollectionSearchIndexes(collection, budget)).find(
			(index) => index.name === entry.name,
		)
	const assessment = assessRequiredIndex(entry, current)
	if (assessment.state === "absent") {
		await createRequiredIndex(searchCollection, entry, budget)
		return "created"
	}
	if (
		assessment.state === "terminal" &&
		assessment.failure.code === "index-type-mismatch"
	) {
		throw bootFailure(
			[{ detail: assessment.failure, reason: assessment.reason }],
			"boot refused",
		)
	}
	const serving = current?.latestDefinition ?? current?.definition
	if (
		assessment.state === "drift" ||
		(serving !== undefined && !definitionServes(entry.definition, serving))
	) {
		await updateRequiredIndex(searchCollection, entry, budget)
		return "updated"
	}
	return "unchanged"
}

// ---------------------------------------------------------------------------
// Boot and preflight
// ---------------------------------------------------------------------------

export type BootContractOptions = RequiredIndexManifestOptions & {
	/** "repair" creates or updates manifest indexes; "verify" never writes. */
	mode: "repair" | "verify"
	deadlineMs?: number
	pollMs?: number
	now?: () => number
	sleep?: (ms: number) => Promise<void>
	/** Runs after version and management checks, before any repair write. */
	beforeRepair?: () => Promise<void>
}

export type BootContractResult = {
	serverVersion: number[]
	manifest: RequiredSearchIndex[]
	indexes: Map<string, SearchIndexDescription>
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))

export function manifestCollections(manifest: RequiredSearchIndex[]): string[] {
	return [...new Set(manifest.map((entry) => entry.collectionName))]
}

/** Boot is fail-fast: the first collection that cannot be listed throws. */
export async function observeManifest(
	db: Db,
	manifest: RequiredSearchIndex[],
	budget?: BootBudget,
): Promise<Map<string, SearchIndexDescription>> {
	const observed = new Map<string, SearchIndexDescription>()
	for (const collectionName of manifestCollections(manifest)) {
		const indexes = await listCollectionSearchIndexes(
			db.collection(collectionName),
			budget,
		)
		for (const index of indexes) {
			if (typeof index.name === "string") observed.set(index.name, index)
		}
	}
	return observed
}

export type ManifestObservation = {
	indexes: Map<string, SearchIndexDescription>
	/** Per collection: why its Search indexes could not be listed. */
	failures: Map<string, MemongoBootError>
}

/**
 * Preflight reads every collection independently: a listing that fails is
 * recorded against its collection and the others are still observed. An
 * expired deadline stops the remaining reads, since none could start.
 */
export async function observeManifestPerCollection(
	db: Db,
	manifest: RequiredSearchIndex[],
	budget?: BootBudget,
): Promise<ManifestObservation> {
	const indexes = new Map<string, SearchIndexDescription>()
	const failures = new Map<string, MemongoBootError>()
	for (const collectionName of manifestCollections(manifest)) {
		try {
			for (const index of await listCollectionSearchIndexes(
				db.collection(collectionName),
				budget,
			)) {
				if (typeof index.name === "string") indexes.set(index.name, index)
			}
		} catch (err) {
			const failure = classifySearchIndexError(err, {
				collection: collectionName,
				operation: "$listSearchIndexes",
				database: db.databaseName,
			})
			failures.set(collectionName, failure)
			if (failure.code === "boot-deadline-exceeded") break
		}
	}
	return { indexes, failures }
}

export async function verifySearchPrivileges(
	db: Db,
	manifest: RequiredSearchIndex[],
	budget?: BootBudget,
): Promise<void> {
	const missing = await findMissingSearchPrivileges(
		db,
		manifestCollections(manifest),
		budget,
	)
	if (missing.length > 0) throw privilegeFailure(missing)
}

/**
 * Enforce the startup contract. Resolves only when every manifest index is
 * READY, queryable and serving its manifest definition; otherwise throws a
 * MemongoBootError naming each unmet index and requirement.
 */
export async function enforceBootContract(
	db: Db,
	options: BootContractOptions,
): Promise<BootContractResult> {
	const now = options.now ?? Date.now
	const sleep = options.sleep ?? defaultSleep
	const deadlineMs = options.deadlineMs ?? BOOT_READINESS_DEADLINE_MS
	const deadline = now() + deadlineMs
	const budget = createBootBudget({ deadlineMs, now })
	const pollMs = options.pollMs ?? BOOT_READINESS_POLL_MS

	const serverVersion = await verifyServerVersion(db, budget)
	const manifest = buildRequiredIndexManifest({
		...options,
		serverVersionArray: serverVersion,
	})
	await verifySearchPrivileges(db, manifest, budget)
	let observed = await observeManifest(db, manifest, budget)
	const assess = () =>
		manifest.map((entry) => ({
			entry,
			assessment: assessRequiredIndex(entry, observed.get(entry.name)),
		}))
	// A FAILED, STALE, wrong-type or unreadable index fails boot before any
	// repair write: repair cannot fix it and boot never drops.
	const throwOnTerminal = (assessments: ReturnType<typeof assess>) => {
		const terminal = assessments.filter(
			({ assessment }) => assessment.state === "terminal",
		)
		if (terminal.length > 0) {
			throw bootFailure(
				terminal.map(({ entry, assessment }) =>
					unmetDetail(
						entry,
						assessment as Exclude<IndexAssessment, { state: "serving" }>,
					),
				),
				"boot refused",
			)
		}
	}
	throwOnTerminal(assess())
	const beforeRepair = options.beforeRepair
	if (beforeRepair) await budget.run("beforeRepair", () => beforeRepair())

	if (options.mode === "repair") {
		for (const entry of manifest) {
			if (
				assessRequiredIndex(entry, observed.get(entry.name)).state !== "serving"
			) {
				await reconcileRequiredIndex(
					db.collection(entry.collectionName),
					entry,
					observed.get(entry.name),
					budget,
				)
			}
		}
	}

	for (;;) {
		observed = await observeManifest(db, manifest, budget)
		const assessments = assess()
		throwOnTerminal(assessments)
		const unmet = assessments.filter(
			({ assessment }) => assessment.state !== "serving",
		)
		if (unmet.length === 0) {
			budget.assertLive("the final readiness check")
			return { serverVersion, manifest, indexes: observed }
		}
		if (options.mode === "verify" || now() + pollMs >= deadline) {
			throw bootFailure(
				unmet.map(({ entry, assessment }) =>
					unmetDetail(
						entry,
						assessment as Exclude<IndexAssessment, { state: "serving" }>,
					),
				),
				options.mode === "verify"
					? "required Search indexes are not serving"
					: `boot refused after the ${Math.round(deadlineMs / 1000)} s readiness deadline`,
			)
		}
		await sleep(pollMs)
	}
}
