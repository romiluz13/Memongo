import {
	memongoBridgePingMongo,
	memongoBridgeProbeEmbedding,
	memongoBridgeProbeVector,
} from "@memongo/memory-bridge"

/**
 * P1.7 readiness check backing GET /ready. Three lanes, all required:
 *   - mongo:     live round-trip through the bridge (detects a MongoDB that
 *                died after boot)
 *   - vector:    live search-lane probe (C-016): the engine re-issues an
 *                index-status round trip (listSearchIndexes on the chunks
 *                collection + queryable checks) instead of answering from
 *                the boot-time capability snapshot — catches a mongot that
 *                died after boot or an index dropped mid-process. A probe
 *                transport failure surfaces as a lane failure with the
 *                error message.
 *   - embedding: live vector-index readiness in automated mode (C-016),
 *                same round trip as the vector lane.
 *
 * /ready is infra-facing and unauthenticated, so lane messages are sanitized:
 * URI credentials are redacted and messages are length-capped.
 */
export type ReadinessLane = { ok: boolean; message?: string }

export type ReadinessReport = {
	ok: boolean
	lanes: {
		mongo: ReadinessLane
		vector: ReadinessLane
		embedding: ReadinessLane
	}
}

const LANE_MESSAGE_MAX_LENGTH = 300
const URI_CREDENTIALS_PATTERN = /(mongodb(?:\+srv)?:\/\/)[^\s/"'@]*@/gi

function sanitizeLaneMessage(message: string): string {
	return message
		.replace(URI_CREDENTIALS_PATTERN, "$1***@")
		.slice(0, LANE_MESSAGE_MAX_LENGTH)
}

async function runLane(
	probe: () => Promise<ReadinessLane>,
): Promise<ReadinessLane> {
	try {
		return await probe()
	} catch (err) {
		return {
			ok: false,
			message: sanitizeLaneMessage(
				err instanceof Error ? err.message : String(err),
			),
		}
	}
}

export async function checkReadiness(): Promise<ReadinessReport> {
	const [mongo, vector, embedding] = await Promise.all([
		runLane(async () => {
			const result = await memongoBridgePingMongo({})
			if (result.ok) {
				return { ok: true }
			}
			return {
				ok: false,
				message: result.message
					? sanitizeLaneMessage(result.message)
					: "mongodb ping failed",
			}
		}),
		runLane(async () => {
			const ok = await memongoBridgeProbeVector({})
			return ok
				? { ok: true }
				: {
						ok: false,
						message:
							"vector search index is not queryable (live index-status probe)",
					}
		}),
		runLane(async () => {
			const result = await memongoBridgeProbeEmbedding({})
			return result.ok
				? { ok: true }
				: {
						ok: false,
						message: result.error ?? "embedding provider is not available",
					}
		}),
	])
	return {
		ok: mongo.ok && vector.ok && embedding.ok,
		lanes: { mongo, vector, embedding },
	}
}
