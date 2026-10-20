const MAX_DEPTH = 24

export function collectStrings(
	value: unknown,
	into: string[] = [],
	depth = 0,
): string[] {
	if (depth > MAX_DEPTH) return into
	if (typeof value === "string") {
		into.push(value)
	} else if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, into, depth + 1)
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value))
			collectStrings(item, into, depth + 1)
	}
	return into
}

export function findMarkers(
	value: unknown,
	markers: Readonly<Record<string, string>>,
): string[] {
	const strings = collectStrings(value)
	return Object.entries(markers)
		.filter(([, marker]) => strings.some((text) => text.includes(marker)))
		.map(([role]) => role)
}

export function containsMarker(value: unknown, marker: string): boolean {
	return collectStrings(value).some((text) => text.includes(marker))
}
