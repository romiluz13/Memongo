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
	observeManifest,
	verifySearchPrivileges,
	verifyServerVersion,
} from "./mongodb-boot-contract.js"
import {
	type MemongoBootFailureDetail,
	describeDriverError,
	isMemongoBootError,
} from "./mongodb-boot-errors.js"
import { mongodbDeploymentIdentity } from "./mongodb-capability-registry.js"
import { assessRequiredIndex, unmetDetail } from "./mongodb-index-assessment.js"
import {
	type RequiredIndexManifestOptions,
	buildRequiredIndexManifest,
} from "./mongodb-required-index-manifest.js"
import type { SearchIndexDescription } from "./mongodb-schema-search-readiness.js"

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

function toUnmet(err: unknown): BootPreflightUnmet[] {
	if (!isMemongoBootError(err)) {
		return [
			{
				code: "index-metadata-unknown",
				requirement: "a completed preflight check",
				message: describeDriverError(err),
				repairable: false,
			},
		]
	}
	return err.failures.map((detail) => ({
		...detail,
		message: err.message,
		repairable: false,
	}))
}

/**
 * One read-only pass over every boot requirement. Reports each unmet one and
 * never writes: no collection, index or document is created or changed.
 */
export async function runBootPreflight(
	db: Db,
	options: RequiredIndexManifestOptions & { requiredCollections?: string[] },
): Promise<BootPreflightReport> {
	const unmet: BootPreflightUnmet[] = []
	let serverVersion: number[] | undefined
	try {
		serverVersion = await verifyServerVersion(db)
	} catch (err) {
		unmet.push(...toUnmet(err))
	}
	const manifest = buildRequiredIndexManifest({
		...options,
		serverVersionArray: serverVersion,
	})
	try {
		await verifySearchPrivileges(db, manifest)
	} catch (err) {
		unmet.push(...toUnmet(err))
	}
	if (options.requiredCollections?.length) {
		try {
			const existing = new Set(
				(await db.listCollections({}, { nameOnly: true }).toArray()).map(
					(collection) => collection.name,
				),
			)
			for (const name of options.requiredCollections) {
				if (!existing.has(name)) {
					unmet.push({
						code: "collection-absent",
						requirement: "the collection exists",
						collection: name,
						message: `collection ${name} is absent; boot creates it`,
						repairable: true,
					})
				}
			}
		} catch (err) {
			unmet.push(...toUnmet(err))
		}
	}
	let observed: Map<string, SearchIndexDescription> | undefined
	try {
		observed = await observeManifest(db, manifest)
	} catch (err) {
		unmet.push(...toUnmet(err))
	}
	if (observed) {
		for (const entry of manifest) {
			const assessment = assessRequiredIndex(entry, observed.get(entry.name))
			if (assessment.state === "serving") continue
			const { detail, reason } = unmetDetail(entry, assessment)
			unmet.push({
				...detail,
				message: `${entry.name} (${entry.collectionName}) ${reason}; requires ${detail.requirement}`,
				repairable:
					assessment.state === "absent" ||
					(assessment.state === "drift" && !assessment.autoEmbedMissing),
			})
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
				{
					code: "config-invalid",
					requirement: "a MongoDB memory backend",
					setting: "memory.backend",
					message: "the resolved memory backend has no MongoDB config",
					repairable: false,
				},
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
					{
						code: "server-unreachable",
						requirement: "a reachable MongoDB deployment",
						message: `MongoDB is unreachable (${describeDriverError(err)})`,
						repairable: false,
					},
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
