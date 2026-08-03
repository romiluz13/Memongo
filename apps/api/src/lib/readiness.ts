import {
	memongoBridgePingMongo,
	memongoBridgeProbeEmbedding,
	memongoBridgeProbeVector,
} from "@memongo/memory-bridge"

/**
 * P1.7 readiness check backing GET /ready. Three lanes, all required:
 *   - mongo:     live round-trip through the bridge (detects a MongoDB that
 *                died after boot; the vector/embedding probes below are
 *                capability checks computed at manager creation and cannot)
 *   - vector:    vector-search availability on this deployment
 *   - embedding: embedding-provider availability on this deployment
 *
 * Search-index readiness has no bridge-level live signal today (the engine's
 * readSearchIndexStatus is not exported through the bridge), so the vector
 * probe doubles as the vector-lane signal per the P1.7 plan fallback.
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
							"vector search is not available on this MongoDB deployment",
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
