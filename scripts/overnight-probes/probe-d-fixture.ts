import type { RouteHealth } from "./health.ts"
import type { Observation } from "./types.ts"

export const D_AS_OF = "2026-03-20T12:00:00.000Z"

export type DEvent = {
	label: string
	timestamp: string
	validAt: string
	invalidAt?: string
}

function event(label: string, timestamp: string, extra: Partial<DEvent> = {}) {
	return { label, timestamp, validAt: timestamp, ...extra }
}

export const D_EVENTS: readonly DEvent[] = [
	event("S1", "2026-03-08T07:59:59.999Z"),
	event("S2", "2026-03-08T08:00:00.000Z"),
	event("S3", "2026-03-09T06:59:59.999Z"),
	event("S4", "2026-03-09T07:00:00.000Z"),
	event("E1", "2026-03-14T23:59:59.999Z"),
	event("E2", "2026-03-15T00:00:00.000Z"),
	event("E3", "2026-03-15T12:00:00.000Z"),
	event("E4", "2026-03-15T23:59:59.999Z"),
	event("E5", "2026-03-16T00:00:00.000Z"),
	event("E6", "2026-03-17T09:30:00.000Z"),
	event("E7", "2026-03-17T09:30:00.000Z"),
	event("E8", "2026-03-19T22:00:00.000Z"),
	event("E9", "2026-03-20T12:00:00.000Z"),
	event("E10", "2026-03-20T12:00:00.001Z"),
	event("T1", "2026-03-20T12:30:00.000Z", {
		validAt: "2026-03-20T10:00:00.000Z",
	}),
	event("V1", "2026-03-18T10:00:00.000Z", {
		invalidAt: "2026-03-19T00:00:00.000Z",
	}),
	event("V2", "2026-03-18T11:00:00.000Z", {
		validAt: "2026-03-21T00:00:00.000Z",
	}),
	event("V3", "2026-03-18T12:00:00.000Z", { invalidAt: D_AS_OF }),
	event("V4", "2026-03-18T13:00:00.000Z", { validAt: D_AS_OF }),
]

export function validAt(item: DEvent, asOf: number): boolean {
	return (
		Date.parse(item.validAt) <= asOf &&
		(item.invalidAt === undefined || Date.parse(item.invalidAt) > asOf)
	)
}

export function eligibleLabels(asOf: string = D_AS_OF): string[] {
	const at = Date.parse(asOf)
	return D_EVENTS.filter(
		(item) => Date.parse(item.timestamp) <= at && validAt(item, at),
	).map((item) => item.label)
}

export type DQueryRead = {
	queryId: string
	observation: Observation
	health: RouteHealth
	request: unknown
}
