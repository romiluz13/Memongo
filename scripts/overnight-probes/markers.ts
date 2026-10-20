import type { Observation } from "./types.ts"

const MAX_DEPTH = 24

export const ECHO_KEYS: ReadonlySet<string> = new Set([
	"query",
	"queryUsed",
	"queriesTried",
	"queryHash",
	"originalQuery",
	"rewrittenQuery",
	"request",
])

function requireMarker(marker: string): string {
	if (marker.trim().length === 0) {
		throw new Error("a marker must not be empty: it would match everything")
	}
	return marker
}

function collect(
	value: unknown,
	into: string[],
	depth: number,
	skipEcho: boolean,
): string[] {
	if (depth > MAX_DEPTH) return into
	if (typeof value === "string") {
		into.push(value)
	} else if (Array.isArray(value)) {
		for (const item of value) collect(item, into, depth + 1, skipEcho)
	} else if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			if (skipEcho && ECHO_KEYS.has(key)) continue
			collect(item, into, depth + 1, skipEcho)
		}
	}
	return into
}

function matching(
	strings: readonly string[],
	markers: Readonly<Record<string, string>>,
): string[] {
	for (const marker of Object.values(markers)) requireMarker(marker)
	return Object.entries(markers)
		.filter(([, marker]) => strings.some((text) => text.includes(marker)))
		.map(([role]) => role)
}

export function rawContains(value: unknown, marker: string): boolean {
	requireMarker(marker)
	return collect(value, [], 0, false).some((text) => text.includes(marker))
}

export function bodyContains(body: unknown, marker: string): boolean {
	requireMarker(marker)
	return collect(body, [], 0, true).some((text) => text.includes(marker))
}

export function containsMarker(
	observation: Observation,
	marker: string,
): boolean {
	requireMarker(marker)
	return (
		observation.kind === "response" && bodyContains(observation.body, marker)
	)
}

export function bodyMarkers(
	body: unknown,
	markers: Readonly<Record<string, string>>,
): string[] {
	return matching(collect(body, [], 0, true), markers)
}

export function findMarkers(
	observation: Observation,
	markers: Readonly<Record<string, string>>,
): string[] {
	return observation.kind === "response"
		? bodyMarkers(observation.body, markers)
		: matching([], markers)
}
