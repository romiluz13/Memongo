// M2 startup contract: whether one Search index is READY, queryable and
// serving its required-index manifest definition, read from
// $listSearchIndexes metadata (status, queryable, latestDefinition,
// latestDefinitionVersion and per-host statusDetail). Unknown or
// inconsistent metadata is a typed failure, never a pass.
import {
	type MemongoBootFailureDetail,
	MemongoBootError,
} from "./mongodb-boot-errors.js"
import type { RequiredSearchIndex } from "./mongodb-required-index-manifest.js"
import {
	type SearchIndexDescription,
	servedSearchIndexType,
} from "./mongodb-schema-search-readiness.js"

const DOCUMENTED_INDEX_STATUSES = new Set([
	"READY",
	"BUILDING",
	"PENDING",
	"FAILED",
	"STALE",
	"DELETING",
	"DOES_NOT_EXIST",
])
const PENDING_INDEX_STATUSES = new Set([
	"BUILDING",
	"PENDING",
	"DELETING",
	"DOES_NOT_EXIST",
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The intended definition is served when every key and value the manifest
 * declares appears in the serving definition (array elements match some
 * serving element). Server-added defaults are tolerated; a missing or
 * different model, path, filter, token or analyzer mapping is not.
 */
export function definitionServes(intended: unknown, serving: unknown): boolean {
	if (Array.isArray(intended)) {
		return (
			Array.isArray(serving) &&
			intended.every((item) =>
				serving.some((candidate) => definitionServes(item, candidate)),
			)
		)
	}
	if (isPlainObject(intended)) {
		return (
			isPlainObject(serving) &&
			Object.entries(intended).every(([key, value]) =>
				definitionServes(value, serving[key]),
			)
		)
	}
	return intended === serving
}

function hasAutoEmbedField(definition: unknown): boolean {
	return (
		isPlainObject(definition) &&
		Array.isArray(definition.fields) &&
		definition.fields.some(
			(field) => isPlainObject(field) && field.type === "autoEmbed",
		)
	)
}

export type IndexAssessment =
	| { state: "serving" }
	| { state: "absent" }
	| { state: "pending"; status: string; reason: string }
	| { state: "drift"; autoEmbedMissing: boolean }
	| { state: "terminal"; failure: MemongoBootFailureDetail; reason: string }

type HostIndexDetail = {
	status?: unknown
	queryable?: unknown
	definitionVersion?: { version?: unknown }
	definition?: unknown
}

type HostStatusDetail = HostIndexDetail & {
	hostname?: unknown
	mainIndex?: HostIndexDetail
	stagedIndex?: HostIndexDetail
}

function upper(value: unknown): string {
	return typeof value === "string" ? value.toUpperCase() : ""
}

export function assessRequiredIndex(
	entry: RequiredSearchIndex,
	index: SearchIndexDescription | undefined,
): IndexAssessment {
	if (!index) return { state: "absent" }
	const at = { index: entry.name, collection: entry.collectionName }
	const terminal = (
		code: MemongoBootFailureDetail["code"],
		requirement: string,
		reason: string,
		status?: string,
	): IndexAssessment => ({
		state: "terminal",
		failure: { code, requirement, status, ...at },
		reason,
	})
	const servedType = servedSearchIndexType(index)
	if (servedType === undefined) {
		return terminal(
			"index-metadata-unknown",
			"a readable index type",
			`reports type ${JSON.stringify(index.type ?? null)} with no search or vectorSearch definition`,
		)
	}
	if (servedType !== entry.type) {
		return terminal(
			"index-type-mismatch",
			`a ${entry.type} index`,
			`exists as a ${servedType} index; boot never drops an index, so remove or rename it`,
		)
	}
	const status = upper(index.status)
	if (!DOCUMENTED_INDEX_STATUSES.has(status)) {
		return terminal(
			"index-metadata-unknown",
			"a documented index status",
			`reports unknown status ${JSON.stringify(index.status ?? null)}`,
			status || undefined,
		)
	}
	const details = (
		Array.isArray(index.statusDetail) ? index.statusDetail : []
	) as HostStatusDetail[]
	const hostStatuses = details.flatMap((host) =>
		[host.status, host.mainIndex?.status, host.stagedIndex?.status].map(upper),
	)
	if (status === "FAILED" || hostStatuses.includes("FAILED")) {
		return terminal(
			"index-failed",
			"a READY index",
			"is FAILED (an invalid definition or build error)",
			"FAILED",
		)
	}
	if (status === "STALE" || hostStatuses.includes("STALE")) {
		return terminal(
			"index-stale",
			"a READY index",
			"is STALE (it stopped replicating and needs a rebuild)",
			"STALE",
		)
	}
	if (PENDING_INDEX_STATUSES.has(status)) {
		return { state: "pending", status, reason: `status ${status}` }
	}
	// READY from here on: the docs define READY as always queryable.
	if (index.queryable !== true) {
		return terminal(
			"index-metadata-unknown",
			"queryable: true on a READY index",
			`reports READY with queryable ${JSON.stringify(index.queryable ?? null)}`,
			status,
		)
	}
	const latestVersion = (
		index as { latestDefinitionVersion?: { version?: unknown } }
	).latestDefinitionVersion?.version
	let servingDefinition: unknown =
		index.latestDefinition ?? index.definition ?? undefined
	for (const host of details) {
		const hostName = typeof host.hostname === "string" ? host.hostname : "host"
		if (host.stagedIndex) {
			return {
				state: "pending",
				status,
				reason: `${hostName} is still building the updated definition`,
			}
		}
		const main = host.mainIndex
		if (!main) {
			return terminal(
				"index-metadata-unknown",
				"per-host serving index metadata",
				`statusDetail for ${hostName} has no mainIndex`,
				status,
			)
		}
		const mainStatus = upper(main.status)
		if (PENDING_INDEX_STATUSES.has(mainStatus)) {
			return {
				state: "pending",
				status: mainStatus,
				reason: `${hostName} reports ${mainStatus}`,
			}
		}
		if (mainStatus !== "READY" || main.queryable !== true) {
			return terminal(
				"index-metadata-unknown",
				"a READY, queryable serving index on every host",
				`${hostName} reports ${mainStatus || "no status"} with queryable ${JSON.stringify(main.queryable ?? null)}`,
				status,
			)
		}
		const servingVersion = main.definitionVersion?.version
		if (
			typeof latestVersion === "number" &&
			typeof servingVersion === "number"
		) {
			if (servingVersion < latestVersion) {
				return {
					state: "pending",
					status,
					reason: `${hostName} serves definition version ${servingVersion}, not ${latestVersion}`,
				}
			}
			if (servingVersion > latestVersion) {
				return terminal(
					"index-metadata-unknown",
					"consistent definition versions",
					`${hostName} serves definition version ${servingVersion}, newer than the latest ${latestVersion}`,
					status,
				)
			}
		}
		if (main.definition !== undefined) {
			if (!definitionServes(entry.definition, main.definition)) {
				return {
					state: "drift",
					autoEmbedMissing:
						hasAutoEmbedField(entry.definition) &&
						!hasAutoEmbedField(main.definition),
				}
			}
			servingDefinition = main.definition
		}
	}
	if (servingDefinition === undefined) {
		return terminal(
			"index-metadata-unknown",
			"a readable serving definition",
			"reports no definition",
			status,
		)
	}
	if (!definitionServes(entry.definition, servingDefinition)) {
		return {
			state: "drift",
			autoEmbedMissing:
				hasAutoEmbedField(entry.definition) &&
				!hasAutoEmbedField(servingDefinition),
		}
	}
	return { state: "serving" }
}

export function unmetDetail(
	entry: RequiredSearchIndex,
	assessment: Exclude<IndexAssessment, { state: "serving" }>,
): { detail: MemongoBootFailureDetail; reason: string } {
	const at = { index: entry.name, collection: entry.collectionName }
	switch (assessment.state) {
		case "absent":
			return {
				detail: {
					code: "index-absent",
					requirement: "the index exists",
					...at,
				},
				reason: "is absent",
			}
		case "pending":
			return {
				detail: {
					code: "index-not-ready",
					requirement: "READY and serving its manifest definition",
					status: assessment.status,
					...at,
				},
				reason: `is not ready (${assessment.reason})`,
			}
		case "drift":
			return assessment.autoEmbedMissing
				? {
						detail: {
							code: "autoembed-unavailable",
							requirement: "an autoEmbed vector definition",
							...at,
						},
						reason: "serves a definition without autoEmbed",
					}
				: {
						detail: {
							code: "index-not-ready",
							requirement: "serving its manifest definition",
							status: "READY",
							...at,
						},
						reason:
							"serves a definition that differs from the manifest (model, path, filter, token or analyzer mapping)",
					}
		case "terminal":
			return { detail: assessment.failure, reason: assessment.reason }
	}
}

export function bootFailure(
	unmet: Array<{ detail: MemongoBootFailureDetail; reason: string }>,
	lead: string,
): MemongoBootError {
	const lines = unmet.map((entry) =>
		entry.detail.index
			? `${entry.detail.index} (${entry.detail.collection}) ${entry.reason}; requires ${entry.detail.requirement}`
			: `${entry.reason}; requires ${entry.detail.requirement}`,
	)
	return new MemongoBootError(
		unmet[0].detail,
		`${lead}: ${lines.join("; ")}`,
		unmet.map((entry) => entry.detail),
	)
}
