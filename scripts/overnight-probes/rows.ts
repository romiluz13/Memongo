import { ECHO_KEYS } from "./markers.ts"

export type Row = Record<string, unknown>

const IGNORED_KEYS: ReadonlySet<string> = new Set(["rendered", ...ECHO_KEYS])

export function isRecord(value: unknown): value is Row {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasToken(value: unknown, token: string): boolean {
	if (typeof value === "string") return value.includes(token)
	return (
		Array.isArray(value) &&
		value.some((item) => typeof item === "string" && item.includes(token))
	)
}

export function rowsContaining(
	value: unknown,
	token: string,
	depth = 0,
): Row[] {
	if (depth > 24) return []
	if (Array.isArray(value)) {
		return value.flatMap((item) => rowsContaining(item, token, depth + 1))
	}
	if (!isRecord(value)) return []
	const entries = Object.entries(value).filter(
		([key]) => !IGNORED_KEYS.has(key),
	)
	if (entries.some(([, item]) => hasToken(item, token))) return [value]
	return entries.flatMap(([, item]) => rowsContaining(item, token, depth + 1))
}

export function passed(timestamp: unknown, at: number): boolean {
	if (typeof timestamp !== "string") return false
	const parsed = Date.parse(timestamp)
	return Number.isFinite(parsed) && parsed <= at
}

function labelsOf(row: Row) {
	const trust = isRecord(row.trust) ? row.trust : undefined
	return {
		state: typeof row.state === "string" ? row.state : undefined,
		validTo: row.validTo,
		contradiction:
			typeof trust?.contradiction === "string"
				? trust.contradiction
				: undefined,
	}
}

export function historical(row: Row, at: number): boolean {
	const labels = labelsOf(row)
	return (
		labels.state === "invalidated" ||
		labels.contradiction === "invalidated" ||
		passed(labels.validTo, at)
	)
}

export function labelled(row: Row): boolean {
	const labels = labelsOf(row)
	return (
		labels.state !== undefined ||
		labels.validTo !== undefined ||
		labels.contradiction !== undefined
	)
}

export type LifecycleView = {
	revision?: number
	state?: string
	value: string
	validTo?: unknown
}

export function viewOf(entry: unknown): LifecycleView | undefined {
	if (!isRecord(entry)) return undefined
	const handle = isRecord(entry.handle) ? entry.handle : undefined
	const data = isRecord(entry.data) ? entry.data : undefined
	if (!handle || !data) return undefined
	return {
		...(typeof handle.revision === "number"
			? { revision: handle.revision }
			: {}),
		...(typeof handle.state === "string" ? { state: handle.state } : {}),
		validTo: handle.validTo,
		value: typeof data.value === "string" ? data.value : "",
	}
}

export function textField(text: string, name: string): string | undefined {
	const prefix = `${name}: `
	const line = text
		.split("\n")
		.find((candidate) => candidate.startsWith(prefix))
	return line?.slice(prefix.length).trim()
}
