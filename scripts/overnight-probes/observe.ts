import { MemongoClientError } from "@memongo/client"
import type { Observation } from "./types.ts"

export async function observeCall(
	route: string,
	call: () => Promise<unknown>,
): Promise<Observation> {
	try {
		return { kind: "response", route, body: await call() }
	} catch (error) {
		if (error instanceof MemongoClientError) {
			return {
				kind: "http-error",
				route,
				status: error.status,
				...(error.code !== undefined ? { code: error.code } : {}),
				...(error.apiMessage !== undefined
					? { message: error.apiMessage }
					: {}),
				...(error.outcomes !== undefined ? { outcomes: error.outcomes } : {}),
			}
		}
		return {
			kind: "transport-error",
			route,
			message: error instanceof Error ? error.message : String(error),
		}
	}
}

export function isResponse(
	observation: Observation,
): observation is Extract<Observation, { kind: "response" }> {
	return observation.kind === "response"
}
