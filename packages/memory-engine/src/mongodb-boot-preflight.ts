// M2 preflight: one read-only pass over every boot requirement. It reports
// each unmet requirement and never writes: no collection, index or document
// is created or changed, and no query embeds.
import type { MemongoConfig } from "@memongo/lib"
import { type Db, MongoClient } from "mongodb"
import {
	type ResolvedMemoryBackendConfig,
	resolveMemoryBackendConfig,
} from "./backend-config.js"
import {
	BOOT_READINESS_DEADLINE_MS,
	observeManifestPerCollection,
	verifySearchPrivileges,
	verifyServerVersion,
} from "./mongodb-boot-contract.js"
import { createBootBudget } from "./mongodb-boot-budget.js"
import {
	type MemongoBootFailureDetail,
	describeDriverError,
	isMemongoBootError,
	safeBootText,
	sanitizeBootDetail,
} from "./mongodb-boot-errors.js"
import { mongodbDeploymentIdentity } from "./mongodb-capability-registry.js"
import { assessRequiredIndex, unmetDetail } from "./mongodb-index-assessment.js"
import {
	type RequiredIndexManifestOptions,
	buildRequiredIndexManifest,
} from "./mongodb-required-index-manifest.js"

export type BootPreflightUnmet = MemongoBootFailureDetail & {
	message: string
	/** Boot would create or update this itself. */
	repairable: boolean
}

export type BootPreflightReport = {
	ok: boolean
	serverVersion?: string
	manifest: Array<{ collection: string; index: string; type: string }>
	unmet: BootPreflightUnmet[]
}

function unmetEntry(
	detail: MemongoBootFailureDetail,
	message: string,
	repairable: boolean,
): BootPreflightUnmet {
	return {
		...sanitizeBootDetail(detail),
		message: safeBootText(message),
		repairable,
	}
}

function toUnmet(err: unknown): BootPreflightUnmet[] {
	if (!isMemongoBootError(err)) {
		return [
			unmetEntry(
				{
					code: "index-metadata-unknown",
					requirement: "a completed preflight check",
				},
				describeDriverError(err),
				false,
			),
		]
	}
	return err.failures.map((detail) => unmetEntry(detail, err.message, false))
}

export type BootPreflightOptions = RequiredIndexManifestOptions & {
	requiredCollections?: string[]
	/** The one total deadline for every check; defaults to the boot deadline. */
	deadlineMs?: number
	now?: () => number
}

/**
 * One read-only pass over every boot requirement. Reports each unmet one and
 * never writes: no collection, index or document is created or changed. Each
 * check runs independently inside one total deadline: a failed check, or a
 * collection whose Search indexes cannot be listed, does not hide the unmet
 * requirements of the others. Once the deadline expires no further check
 * starts and the report says so.
 */
export async function runBootPreflight(
	db: Db,
	options: BootPreflightOptions,
): Promise<BootPreflightReport> {
	const budget = createBootBudget({
		deadlineMs: options.deadlineMs ?? BOOT_READINESS_DEADLINE_MS,
		now: options.now,
	})
	const unmet: BootPreflightUnmet[] = []
	let deadlineExpired = false
	const check = async <T>(
		operation: () => Promise<T>,
	): Promise<T | undefined> => {
		if (deadlineExpired) return undefined
		try {
			return await operation()
		} catch (err) {
			unmet.push(...toUnmet(err))
			if (isMemongoBootError(err) && err.code === "boot-deadline-exceeded") {
				deadlineExpired = true
			}
			return undefined
		}
	}
	const serverVersion = await check(() => verifyServerVersion(db, budget))
	const manifest = buildRequiredIndexManifest({
		...options,
		serverVersionArray: serverVersion,
	})
	await check(() => verifySearchPrivileges(db, manifest, budget))
	const requiredCollections = options.requiredCollections ?? []
	if (requiredCollections.length > 0) {
		const existing = await check(
			async () =>
				new Set(
					(
						await budget.run("listCollections", (timeoutMS) =>
							db.listCollections({}, { nameOnly: true, timeoutMS }).toArray(),
						)
					).map((collection) => collection.name),
				),
		)
		if (existing) {
			for (const name of requiredCollections) {
				if (existing.has(name)) continue
				unmet.push(
					unmetEntry(
						{
							code: "collection-absent",
							requirement: "the collection exists",
							collection: name,
						},
						`collection ${name} is absent; boot creates it`,
						true,
					),
				)
			}
		}
	}
	if (!deadlineExpired) {
		const observation = await observeManifestPerCollection(db, manifest, budget)
		for (const failure of observation.failures.values()) {
			unmet.push(...toUnmet(failure))
			if (failure.code === "boot-deadline-exceeded") deadlineExpired = true
		}
		for (const entry of manifest) {
			if (observation.failures.has(entry.collectionName)) continue
			const assessment = assessRequiredIndex(
				entry,
				observation.indexes.get(entry.name),
			)
			if (assessment.state === "serving") continue
			const { detail, reason } = unmetDetail(entry, assessment)
			unmet.push(
				unmetEntry(
					detail,
					`${entry.name} (${entry.collectionName}) ${reason}; requires ${detail.requirement}`,
					assessment.state === "absent" ||
						(assessment.state === "drift" && !assessment.autoEmbedMissing),
				),
			)
		}
	}
	if (deadlineExpired) {
		for (const entry of unmet) {
			if (entry.code === "boot-deadline-exceeded") {
				entry.message = `${entry.message}; the checks that had not run were skipped`
			}
		}
	}
	return {
		ok: unmet.length === 0,
		...(serverVersion
			? { serverVersion: serverVersion.slice(0, 3).join(".") }
			: {}),
		manifest: manifest.map((entry) => ({
			collection: entry.collectionName,
			index: entry.name,
			type: entry.type,
		})),
		unmet,
	}
}

/**
 * Preflight for a configured deployment: config validation, then the
 * read-only boot checks. Connects with its own client and closes it; it never
 * creates the collections or indexes that boot would.
 */
export async function runMemongoPreflight(params: {
	cfg: MemongoConfig
	agentId: string
}): Promise<BootPreflightReport> {
	let resolved: ResolvedMemoryBackendConfig
	try {
		resolved = resolveMemoryBackendConfig(params)
	} catch (err) {
		return { ok: false, manifest: [], unmet: toUnmet(err) }
	}
	const mongoCfg = resolved.mongodb
	if (!mongoCfg) {
		return {
			ok: false,
			manifest: [],
			unmet: [
				unmetEntry(
					{
						code: "config-invalid",
						requirement: "a MongoDB memory backend",
						setting: "memory.backend",
					},
					"the resolved memory backend has no MongoDB config",
					false,
				),
			],
		}
	}
	const { buildMongoClientOptions } = await import("./mongodb-manager.js")
	const client = new MongoClient(
		mongoCfg.uri,
		buildMongoClientOptions(mongoCfg),
	)
	try {
		try {
			await client.connect()
			await client.db("admin").command({ ping: 1 })
		} catch (err) {
			return {
				ok: false,
				manifest: [],
				unmet: [
					unmetEntry(
						{
							code: "server-unreachable",
							requirement: "a reachable MongoDB deployment",
						},
						`MongoDB is unreachable (${describeDriverError(err)})`,
						false,
					),
				],
			}
		}
		const prefix = mongoCfg.collectionPrefix
		const collections = buildRequiredIndexManifest({ prefix }).map(
			(entry) => entry.collectionName,
		)
		return await runBootPreflight(client.db(mongoCfg.database), {
			prefix,
			quantization: mongoCfg.quantization,
			deployment: mongodbDeploymentIdentity(mongoCfg.uri, mongoCfg.database),
			requiredCollections: [
				...new Set([`${prefix}knowledge_base`, ...collections]),
			],
		})
	} finally {
		await client.close()
	}
}
