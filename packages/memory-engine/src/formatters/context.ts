import type {
	MemoryContextBundle,
	MemoryContextBundleSection,
	MemoryContextBundleSectionItem,
	MemoryContextFormat,
} from "../types.js"

const ITEM_COLUMNS = [
	"title",
	"summary",
	"path",
	"source",
	"canonicalId",
	"timestamp",
	"scope",
	"scopeRef",
	"sourceEventIds",
	"trust",
	"metadata",
] as const

const AUTO_SAMPLE_LIMIT = 12
const AUTO_MIN_ITEMS = 5
const AUTO_UNIFORM_RATIO = 0.75

type ItemColumn = (typeof ITEM_COLUMNS)[number]

function stableJson(value: unknown): string {
	return JSON.stringify(sortStable(value))
}

function sortStable(value: unknown): unknown {
	if (value instanceof Date) {
		return value.toISOString()
	}
	if (Array.isArray(value)) {
		return value.map(sortStable)
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, sortStable(entry)]),
		)
	}
	return value
}

function scalarToString(value: unknown): string {
	if (value === undefined) {
		return ""
	}
	if (value === null) {
		return "null"
	}
	if (value instanceof Date) {
		return value.toISOString().replace(".000Z", "Z")
	}
	if (Array.isArray(value) || typeof value === "object") {
		return stableJson(value)
	}
	return String(value)
}

function quoteToonCell(value: unknown): string {
	const raw = scalarToString(value)
	if (!/[,\n\r"|[\]{}:#]/.test(raw)) {
		return raw
	}
	return JSON.stringify(raw)
}

function renderMarkdownItem(item: MemoryContextBundleSectionItem): string {
	const summary = item.summary.trim()
	const timeLabel = item.timestamp?.toISOString().replace(".000Z", "Z")
	const pathLabel = item.path?.trim()
	const trustLabel = item.trust?.confidence

	let line = `- ${item.title.trim() || "Untitled"}`
	if (timeLabel) {
		line += ` [${timeLabel}]`
	}
	if (summary) {
		line += `: ${summary}`
	}
	if (trustLabel) {
		line += ` {trust:${trustLabel}}`
	}
	if (pathLabel) {
		line += ` (${pathLabel})`
	}
	return line
}

export function renderContextBundleMarkdown(
	sections: MemoryContextBundleSection[],
): string {
	return sections
		.map((section) => {
			const lines = [`## ${section.title}`]
			if (section.summary?.trim()) {
				lines.push(section.summary.trim())
			}
			for (const item of section.items) {
				lines.push(renderMarkdownItem(item))
			}
			return lines.join("\n")
		})
		.join("\n\n")
}

function itemCell(
	item: MemoryContextBundleSectionItem,
	column: ItemColumn,
): unknown {
	switch (column) {
		case "timestamp":
			return item.timestamp
		case "sourceEventIds":
			return item.sourceEventIds
		case "trust":
			return item.trust
		case "metadata":
			return item.metadata
		default:
			return item[column]
	}
}

function renderToonItemTable(section: MemoryContextBundleSection): string[] {
	if (section.items.length === 0) {
		return ["items[0]{}"]
	}
	const columns = ITEM_COLUMNS.filter((column) =>
		section.items.some((item) => scalarToString(itemCell(item, column)) !== ""),
	)
	const lines = [`items[${section.items.length}]{${columns.join(",")}}`]
	for (const item of section.items) {
		lines.push(
			columns.map((column) => quoteToonCell(itemCell(item, column))).join(","),
		)
	}
	return lines
}

export function renderContextBundleToon(bundle: MemoryContextBundle): string {
	const lines = [
		"context_bundle",
		`agentId: ${quoteToonCell(bundle.agentId)}`,
		`scope: ${quoteToonCell(bundle.scope)}`,
		`scopeRef: ${quoteToonCell(bundle.scopeRef)}`,
	]
	if (bundle.query) {
		lines.push(`query: ${quoteToonCell(bundle.query)}`)
	}
	if (bundle.sessionId) {
		lines.push(`sessionId: ${quoteToonCell(bundle.sessionId)}`)
	}
	lines.push(`builtAt: ${quoteToonCell(bundle.builtAt)}`)
	lines.push("")
	lines.push(
		`sections[${bundle.sections.length}]{kind,title,summary,items,truncated,partial}`,
	)
	for (const section of bundle.sections) {
		lines.push(
			[
				quoteToonCell(section.kind),
				quoteToonCell(section.title),
				quoteToonCell(section.summary),
				quoteToonCell(section.items.length),
				quoteToonCell(section.truncated),
				quoteToonCell(section.partial),
			].join(","),
		)
	}

	for (const section of bundle.sections) {
		lines.push("")
		lines.push(`${section.kind}: ${quoteToonCell(section.title)}`)
		if (section.summary?.trim()) {
			lines.push(`summary: ${quoteToonCell(section.summary.trim())}`)
		}
		lines.push(...renderToonItemTable(section))
	}

	return lines.join("\n")
}

export function renderContextBundleJson(bundle: MemoryContextBundle): string {
	return stableJson({
		agentId: bundle.agentId,
		query: bundle.query,
		scope: bundle.scope,
		scopeRef: bundle.scopeRef,
		sessionId: bundle.sessionId,
		sections: bundle.sections,
		metadata: bundle.metadata,
		builtAt: bundle.builtAt,
	})
}

function itemKeySet(item: MemoryContextBundleSectionItem): string {
	return Object.entries(item)
		.filter(([, value]) => value !== undefined)
		.map(([key]) => key)
		.sort()
		.join("|")
}

function hasObjectCell(item: MemoryContextBundleSectionItem): boolean {
	return Object.values(item).some(
		(value) =>
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			!(value instanceof Date),
	)
}

export function selectContextBundleAutoFormat(
	bundle: MemoryContextBundle,
): "toon" | "json" {
	const sample = bundle.sections
		.flatMap((section) => section.items)
		.slice(0, AUTO_SAMPLE_LIMIT)
	if (sample.length < AUTO_MIN_ITEMS) {
		return "json"
	}
	if (sample.some(hasObjectCell)) {
		return "json"
	}

	const counts = new Map<string, number>()
	for (const item of sample) {
		const keySet = itemKeySet(item)
		counts.set(keySet, (counts.get(keySet) ?? 0) + 1)
	}
	const mostCommon = Math.max(...counts.values())
	return mostCommon / sample.length >= AUTO_UNIFORM_RATIO ? "toon" : "json"
}

export function renderContextBundle(
	bundle: MemoryContextBundle,
	format: MemoryContextFormat,
): string {
	if (format === "toon") {
		return renderContextBundleToon(bundle)
	}
	if (format === "json") {
		return renderContextBundleJson(bundle)
	}
	if (format === "auto") {
		return selectContextBundleAutoFormat(bundle) === "toon"
			? renderContextBundleToon(bundle)
			: renderContextBundleJson(bundle)
	}
	return renderContextBundleMarkdown(bundle.sections)
}
