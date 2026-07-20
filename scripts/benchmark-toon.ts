import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { countTokens } from "gpt-tokenizer/model/gpt-4o"

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

type BenchmarkFixture = {
	name: string
	description: string
	payload: JsonValue
}

type FormatName = "json-pretty" | "json-compact" | "markdown" | "toon" | "auto"
type AutoSelectedFormat = "json-compact" | "toon"

type RenderedFormat = {
	format: FormatName
	text: string
	fieldPaths: Set<string>
	renderMs: number
	selectedFormat?: AutoSelectedFormat
}

type BenchmarkRow = {
	fixtureName: string
	formatName: FormatName
	tokenCount: number
	tokenDeltaVsCompactJson: number
	tokenSavingsPctVsCompactJson: number
	byteSize: number
	renderMs: number
	sourceSha256: string
	fieldPathCount: number
	selectedFormat?: AutoSelectedFormat
}

const TOKENIZER = {
	package: "gpt-tokenizer",
	model: "gpt-4o",
	encoding: "o200k_base",
}

const DEFAULT_JSON_OUT = "artifacts/benchmarks/toon-token-benchmark.json"
const FIXED_NOW = "2026-06-27T00:00:00.000Z"
const AUTO_SAMPLE_LIMIT = 12
const AUTO_MIN_ITEMS = 5
const AUTO_UNIFORM_RATIO = 0.75

function stableValue(value: unknown): JsonValue {
	if (value === undefined) {
		return null
	}
	if (value === null || typeof value !== "object") {
		return value as JsonPrimitive
	}
	if (Array.isArray(value)) {
		return value.map(stableValue)
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, stableValue(entry)]),
	) as JsonValue
}

function stableJson(value: unknown, spaces?: number): string {
	return JSON.stringify(stableValue(value), null, spaces)
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex")
}

function byteSize(text: string): number {
	return Buffer.byteLength(text, "utf8")
}

function formatPercent(value: number): string {
	const sign = value > 0 ? "+" : ""
	return `${sign}${value.toFixed(1)}%`
}

function formatNumber(value: number): string {
	return value.toLocaleString("en-US")
}

function isPlainObject(
	value: JsonValue,
): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function collectFieldPaths(value: JsonValue, path = "$"): Set<string> {
	const paths = new Set<string>()
	if (Array.isArray(value)) {
		if (value.length === 0) {
			paths.add(path)
			return paths
		}
		value.forEach((entry, index) => {
			for (const child of collectFieldPaths(entry, `${path}[${index}]`)) {
				paths.add(child)
			}
		})
		return paths
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value)
		if (entries.length === 0) {
			paths.add(path)
			return paths
		}
		for (const [key, entry] of entries) {
			for (const child of collectFieldPaths(entry, `${path}.${key}`)) {
				paths.add(child)
			}
		}
		return paths
	}
	paths.add(path)
	return paths
}

function scalarToString(value: JsonValue): string {
	if (value === null) {
		return "null"
	}
	if (Array.isArray(value) || isPlainObject(value)) {
		return stableJson(value)
	}
	return String(value)
}

function quoteToonCell(value: JsonValue): string {
	const raw = scalarToString(value)
	if (!/[,\n\r"|[\]{}:#]/.test(raw)) {
		return raw
	}
	return JSON.stringify(raw)
}

function indent(lines: string[], prefix = "  "): string[] {
	return lines.map((line) => `${prefix}${line}`)
}

function hasUniformObjectRows(
	values: JsonValue[],
): values is Array<{ [key: string]: JsonValue }> {
	if (values.length < 2 || !values.every(isPlainObject)) {
		return false
	}
	const firstKeys = Object.keys(values[0]).sort()
	return values.every((entry) => {
		const keys = Object.keys(entry).sort()
		return (
			keys.length === firstKeys.length &&
			keys.every((key, index) => key === firstKeys[index])
		)
	})
}

function markCoverage(
	coverage: Set<string>,
	value: JsonValue,
	path: string,
): void {
	for (const child of collectFieldPaths(value, path)) {
		coverage.add(child)
	}
}

function renderToonValue(
	key: string,
	value: JsonValue,
	path: string,
	coverage: Set<string>,
): string[] {
	if (Array.isArray(value)) {
		if (hasUniformObjectRows(value)) {
			const columns = Object.keys(value[0]).sort()
			const lines = [`${key}[${value.length}]{${columns.join(",")}}`]
			value.forEach((entry, index) => {
				lines.push(
					columns
						.map((column) => {
							const cell = entry[column] ?? null
							markCoverage(coverage, cell, `${path}[${index}].${column}`)
							return quoteToonCell(cell)
						})
						.join(","),
				)
			})
			return lines
		}
		if (value.length === 0) {
			coverage.add(path)
			return [`${key}[0]`]
		}
		const lines = [`${key}[${value.length}]`]
		value.forEach((entry, index) => {
			lines.push(`[${index}]`)
			lines.push(
				...indent(
					renderToonValue("value", entry, `${path}[${index}]`, coverage),
				),
			)
		})
		return lines
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value)
		if (entries.length === 0) {
			coverage.add(path)
			return [`${key}: {}`]
		}
		const lines = [`${key}:`]
		for (const [childKey, childValue] of entries) {
			lines.push(
				...indent(
					renderToonValue(
						childKey,
						childValue,
						`${path}.${childKey}`,
						coverage,
					),
				),
			)
		}
		return lines
	}
	coverage.add(path)
	return [`${key}: ${quoteToonCell(value)}`]
}

function renderToon(payload: JsonValue): {
	text: string
	fieldPaths: Set<string>
} {
	const coverage = new Set<string>()
	const lines = renderToonValue("payload", stableValue(payload), "$", coverage)
	return { text: lines.join("\n"), fieldPaths: coverage }
}

function sampleObjectRows(
	value: JsonValue,
): Array<{ [key: string]: JsonValue }> {
	const sample: Array<{ [key: string]: JsonValue }> = []
	const queue: JsonValue[] = [value]
	for (
		let index = 0;
		index < queue.length && sample.length < AUTO_SAMPLE_LIMIT;
		index += 1
	) {
		const current = queue[index]
		if (Array.isArray(current)) {
			for (const entry of current) {
				if (isPlainObject(entry) && sample.length < AUTO_SAMPLE_LIMIT) {
					sample.push(entry)
				}
				if (Array.isArray(entry) || isPlainObject(entry)) {
					queue.push(entry)
				}
			}
			continue
		}
		if (isPlainObject(current)) {
			for (const entry of Object.values(current)) {
				if (Array.isArray(entry) || isPlainObject(entry)) {
					queue.push(entry)
				}
			}
		}
	}
	return sample
}

function selectAutoBenchmarkFormat(payload: JsonValue): AutoSelectedFormat {
	const sample = sampleObjectRows(payload)
	if (sample.length < AUTO_MIN_ITEMS) {
		return "json-compact"
	}
	if (
		sample.some((row) =>
			Object.values(row).some((value) => isPlainObject(value)),
		)
	) {
		return "json-compact"
	}
	const counts = new Map<string, number>()
	for (const row of sample) {
		const keySet = Object.keys(row).sort().join("|")
		counts.set(keySet, (counts.get(keySet) ?? 0) + 1)
	}
	const mostCommon = Math.max(...counts.values())
	return mostCommon / sample.length >= AUTO_UNIFORM_RATIO
		? "toon"
		: "json-compact"
}

function renderAuto(
	payload: JsonValue,
	allPaths: Set<string>,
): {
	text: string
	fieldPaths: Set<string>
	selectedFormat: AutoSelectedFormat
} {
	const selectedFormat = selectAutoBenchmarkFormat(payload)
	if (selectedFormat === "toon") {
		return { ...renderToon(payload), selectedFormat }
	}
	return {
		text: stableJson(payload),
		fieldPaths: new Set(allPaths),
		selectedFormat,
	}
}

function renderMarkdownValue(
	key: string,
	value: JsonValue,
	path: string,
	coverage: Set<string>,
	depth = 0,
): string[] {
	const prefix = "  ".repeat(depth)
	if (Array.isArray(value)) {
		if (value.length === 0) {
			coverage.add(path)
			return [`${prefix}- ${key}: []`]
		}
		const lines = [`${prefix}- ${key}:`]
		value.forEach((entry, index) => {
			lines.push(`${prefix}  - item ${index + 1}:`)
			lines.push(
				...renderMarkdownValue(
					"value",
					entry,
					`${path}[${index}]`,
					coverage,
					depth + 2,
				),
			)
		})
		return lines
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value)
		if (entries.length === 0) {
			coverage.add(path)
			return [`${prefix}- ${key}: {}`]
		}
		const lines = [`${prefix}- ${key}:`]
		for (const [childKey, childValue] of entries) {
			lines.push(
				...renderMarkdownValue(
					childKey,
					childValue,
					`${path}.${childKey}`,
					coverage,
					depth + 1,
				),
			)
		}
		return lines
	}
	coverage.add(path)
	return [`${prefix}- ${key}: ${scalarToString(value)}`]
}

function renderMarkdown(payload: JsonValue): {
	text: string
	fieldPaths: Set<string>
} {
	const stable = stableValue(payload)
	const coverage = new Set<string>()
	const lines = ["# Memory context payload"]
	lines.push(...renderMarkdownValue("payload", stable, "$", coverage))
	return { text: lines.join("\n"), fieldPaths: coverage }
}

function measureRender(
	format: FormatName,
	render: () => {
		text: string
		fieldPaths: Set<string>
		selectedFormat?: AutoSelectedFormat
	},
): RenderedFormat {
	const timings: number[] = []
	let result = render()
	for (let index = 0; index < 35; index += 1) {
		const start = performance.now()
		result = render()
		timings.push(performance.now() - start)
	}
	timings.sort((left, right) => left - right)
	return {
		format,
		text: result.text,
		fieldPaths: result.fieldPaths,
		renderMs: timings[Math.floor(timings.length / 2)] ?? 0,
		selectedFormat: result.selectedFormat,
	}
}

function renderFormats(payload: JsonValue): RenderedFormat[] {
	const stable = stableValue(payload)
	const allPaths = collectFieldPaths(stable)
	return [
		measureRender("json-pretty", () => ({
			text: stableJson(stable, 2),
			fieldPaths: new Set(allPaths),
		})),
		measureRender("json-compact", () => ({
			text: stableJson(stable),
			fieldPaths: new Set(allPaths),
		})),
		measureRender("markdown", () => renderMarkdown(stable)),
		measureRender("toon", () => renderToon(stable)),
		measureRender("auto", () => renderAuto(stable, allPaths)),
	]
}

function uniformMemory(index: number): JsonValue {
	const number = String(index + 1).padStart(3, "0")
	const type = index % 2 === 0 ? "fact" : "preference"
	return {
		confidence: Number((0.72 + (index % 8) * 0.025).toFixed(3)),
		content:
			type === "fact"
				? `User has project ${number} in active planning.`
				: `User prefers concise status updates for project ${number}.`,
		createdAt: `2026-06-${String((index % 26) + 1).padStart(2, "0")}T09:00:00Z`,
		id: `mem-${number}`,
		relatedMemoryIds:
			index === 0 ? [] : [`mem-${String(index).padStart(3, "0")}`],
		score: Number((0.61 + (index % 13) * 0.021).toFixed(3)),
		sourceId: `src-${String((index % 7) + 1).padStart(2, "0")}`,
		tags: [`topic-${index % 5}`, type],
		type,
		updatedAt: `2026-06-${String((index % 26) + 1).padStart(2, "0")}T10:15:00Z`,
	}
}

function uniformFixture(count: number, name: string): BenchmarkFixture {
	return {
		name,
		description: `${count} uniform fact/preference memories with identical fields.`,
		payload: {
			agentId: "agent-benchmark",
			generatedAt: FIXED_NOW,
			memories: Array.from({ length: count }, (_, index) =>
				uniformMemory(index),
			),
			scope: "user",
			scopeRef: "user:benchmark",
		},
	}
}

function buildFixtures(): BenchmarkFixture[] {
	return [
		uniformFixture(5, "small-uniform-5"),
		uniformFixture(50, "medium-uniform-50"),
		uniformFixture(250, "large-uniform-250"),
		{
			name: "mixed-memory-types",
			description:
				"Facts, preferences, procedures, episodes, graph edges, and provenance.",
			payload: {
				agentId: "agent-benchmark",
				episode: {
					events: [
						{
							at: "2026-06-25T12:00:00Z",
							role: "user",
							summary: "Asked about launch checklist.",
						},
						{
							at: "2026-06-25T12:04:00Z",
							role: "assistant",
							summary: "Drafted launch checklist.",
						},
					],
					id: "episode-001",
					summary: "Planning session for a memory product launch.",
				},
				facts: [
					{
						confidence: 0.93,
						id: "fact-001",
						text: "The launch target is July.",
						type: "fact",
					},
					{
						confidence: 0.88,
						id: "fact-002",
						text: "The API must preserve citations.",
						type: "fact",
					},
				],
				graphRelationships: [
					{ from: "user", kind: "owns", score: 0.77, to: "project-memongo" },
					{
						from: "project-memongo",
						kind: "depends_on",
						score: 0.69,
						to: "mongodb-atlas",
					},
				],
				preferences: [
					{
						confidence: 0.91,
						id: "pref-001",
						text: "Prefer short terminal summaries.",
						type: "preference",
					},
					{
						confidence: 0.84,
						id: "pref-002",
						text: "Prefer American spelling.",
						type: "preference",
					},
				],
				procedures: [
					{
						id: "proc-001",
						steps: [
							"Run tests",
							"Review benchmark warnings",
							"Attach artifact",
						],
						title: "Release evidence flow",
					},
				],
				provenance: [
					{
						citation: "session:s-001#turn-004",
						memoryId: "fact-001",
						sourceId: "src-chat-001",
					},
					{
						citation: "doc:benchmark-pack.md",
						memoryId: "proc-001",
						sourceId: "src-doc-002",
					},
				],
				scope: "user",
				scopeRef: "user:benchmark",
			},
		},
		{
			name: "nested-metadata",
			description:
				"Uniform memories with nested source, score, confidence, tag, and relation metadata.",
			payload: {
				agentId: "agent-benchmark",
				memories: Array.from({ length: 12 }, (_, index) => ({
					content: `Nested metadata memory ${index + 1}`,
					id: `nested-${String(index + 1).padStart(3, "0")}`,
					metadata: {
						confidence: {
							calibrated: Number((0.7 + index * 0.01).toFixed(3)),
							raw: Number((0.64 + index * 0.012).toFixed(3)),
						},
						relatedMemoryIds: [
							`nested-${String(((index + 1) % 12) + 1).padStart(3, "0")}`,
						],
						scores: {
							recency: Number((0.4 + index * 0.02).toFixed(3)),
							relevance: Number((0.8 - index * 0.01).toFixed(3)),
						},
						source: {
							createdAt: `2026-05-${String((index % 28) + 1).padStart(2, "0")}T08:30:00Z`,
							sourceIds: [`source-${index % 3}`, `source-${(index + 1) % 3}`],
							updatedAt: `2026-06-${String((index % 26) + 1).padStart(2, "0")}T11:45:00Z`,
						},
						tags: ["nested", `cohort-${index % 4}`],
					},
					type: index % 2 === 0 ? "fact" : "preference",
				})),
			},
		},
		{
			name: "realistic-retrieved-context",
			description:
				"Search result snippets with relevance scores, sessions, timestamps, and memory type.",
			payload: {
				agentId: "agent-benchmark",
				query: "What launch constraints did the user mention?",
				results: Array.from({ length: 18 }, (_, index) => ({
					content: `Retrieved memory ${index + 1} says the launch needs evidence, citations, and scoped claims.`,
					createdAt: `2026-06-${String((index % 26) + 1).padStart(2, "0")}T13:00:00Z`,
					id: `result-${String(index + 1).padStart(3, "0")}`,
					memoryType: ["fact", "preference", "episode"][index % 3],
					relevanceScore: Number((0.95 - index * 0.018).toFixed(3)),
					sessionId: `session-${String((index % 4) + 1).padStart(2, "0")}`,
					snippet: `Evidence snippet ${index + 1}: keep claims local to fixtures and report negative cases.`,
					updatedAt: `2026-06-${String((index % 26) + 1).padStart(2, "0")}T14:30:00Z`,
				})),
				scope: "user",
				scopeRef: "user:benchmark",
			},
		},
		{
			name: "toon-unfriendly-irregular",
			description:
				"Non-uniform deeply nested records with long comma/newline-heavy text.",
			payload: {
				agentId: "agent-benchmark",
				records: [
					{
						audit: {
							events: [
								{ action: "created", at: "2026-06-01T00:00:00Z" },
								{
									action: "merged",
									at: "2026-06-02T00:00:00Z",
									by: "agent",
								},
							],
						},
						id: "irregular-001",
						longText:
							'User said: keep the original phrasing, commas included, and preserve line breaks.\nSecond line includes JSON-like text: {"risk":"format drift","level":"medium"}.',
					},
					{
						flags: ["manual-review", "citation-required"],
						id: "irregular-002",
						nested: {
							owner: { displayName: "Research, Ops", id: "person-004" },
							thread: { ids: ["thread-1", "thread-2"], latest: "thread-2" },
						},
						score: 0.7123,
					},
					{
						id: "irregular-003",
						notes:
							"Paragraph one has commas, pipes | and colons: all awkward for row-oriented formats.\nParagraph two is intentionally verbose so key repetition is not the dominant cost.",
						unexpected: {
							deep: {
								deeper: {
									confidence: 0.58,
									sourceIds: ["src-a", "src-b", "src-c"],
								},
							},
						},
					},
				],
			},
		},
	]
}

function assertSameFields(
	fixture: BenchmarkFixture,
	expected: Set<string>,
	rendered: RenderedFormat,
): void {
	const missing = [...expected].filter((path) => !rendered.fieldPaths.has(path))
	const extra = [...rendered.fieldPaths].filter((path) => !expected.has(path))
	if (missing.length > 0 || extra.length > 0) {
		throw new Error(
			[
				`${fixture.name}/${rendered.format} field coverage mismatch`,
				missing.length > 0 ? `missing=${missing.slice(0, 10).join(",")}` : "",
				extra.length > 0 ? `extra=${extra.slice(0, 10).join(",")}` : "",
			]
				.filter(Boolean)
				.join(" "),
		)
	}
}

function benchmarkFixtures(fixtures: BenchmarkFixture[]): {
	rows: BenchmarkRow[]
	validations: string[]
} {
	const rows: BenchmarkRow[] = []
	const validations: string[] = []
	for (const fixture of fixtures) {
		const source = stableValue(fixture.payload)
		const sourceJson = stableJson(source)
		const sourceSha = sha256(sourceJson)
		const expectedFields = collectFieldPaths(source)
		const rendered = renderFormats(source)
		for (const format of rendered) {
			assertSameFields(fixture, expectedFields, format)
		}
		const compact = rendered.find((format) => format.format === "json-compact")
		if (!compact) {
			throw new Error(`missing compact JSON for ${fixture.name}`)
		}
		const compactTokens = countTokens(compact.text)
		for (const format of rendered) {
			const tokenCount = countTokens(format.text)
			const delta = tokenCount - compactTokens
			rows.push({
				fixtureName: fixture.name,
				formatName: format.format,
				tokenCount,
				tokenDeltaVsCompactJson: delta,
				tokenSavingsPctVsCompactJson:
					compactTokens === 0
						? 0
						: ((compactTokens - tokenCount) / compactTokens) * 100,
				byteSize: byteSize(format.text),
				renderMs: Number(format.renderMs.toFixed(4)),
				sourceSha256: sourceSha,
				fieldPathCount: expectedFields.size,
				selectedFormat: format.selectedFormat,
			})
		}
		validations.push(
			`${fixture.name}: same source SHA across formats (${sourceSha.slice(0, 12)}), ${expectedFields.size} field paths covered`,
		)
	}
	return { rows, validations }
}

function deterministicTokenSignature(rows: BenchmarkRow[]): string {
	return sha256(
		stableJson(
			rows.map((row) => ({
				byteSize: row.byteSize,
				fixtureName: row.fixtureName,
				formatName: row.formatName,
				selectedFormat: row.selectedFormat,
				sourceSha256: row.sourceSha256,
				tokenCount: row.tokenCount,
			})),
		),
	)
}

function assertDeterministic(
	fixtures: BenchmarkFixture[],
	rows: BenchmarkRow[],
): string {
	const second = benchmarkFixtures(fixtures).rows
	const firstSignature = deterministicTokenSignature(rows)
	const secondSignature = deterministicTokenSignature(second)
	if (firstSignature !== secondSignature) {
		throw new Error(
			`benchmark token counts are not deterministic: ${firstSignature} !== ${secondSignature}`,
		)
	}
	return firstSignature
}

function pad(
	value: string,
	width: number,
	align: "left" | "right" = "left",
): string {
	if (value.length >= width) {
		return value
	}
	const padding = " ".repeat(width - value.length)
	return align === "right" ? `${padding}${value}` : `${value}${padding}`
}

function printTable(rows: BenchmarkRow[]): void {
	const headers = [
		"Fixture",
		"Format",
		"Tokens",
		"Delta",
		"Savings",
		"Bytes",
		"Render ms",
	]
	const tableRows = rows.map((row) => [
		row.fixtureName,
		row.selectedFormat
			? `${row.formatName}->${row.selectedFormat}`
			: row.formatName,
		formatNumber(row.tokenCount),
		row.tokenDeltaVsCompactJson === 0
			? "0"
			: `${row.tokenDeltaVsCompactJson > 0 ? "+" : ""}${formatNumber(row.tokenDeltaVsCompactJson)}`,
		formatPercent(row.tokenSavingsPctVsCompactJson),
		formatNumber(row.byteSize),
		row.renderMs.toFixed(4),
	])
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...tableRows.map((row) => row[index].length)),
	)
	const numeric = new Set([2, 3, 4, 5, 6])
	console.log(
		headers.map((header, index) => pad(header, widths[index])).join("  "),
	)
	console.log(widths.map((width) => "-".repeat(width)).join("  "))
	for (const row of tableRows) {
		console.log(
			row
				.map((cell, index) =>
					pad(cell, widths[index], numeric.has(index) ? "right" : "left"),
				)
				.join("  "),
		)
	}
}

function summarize(rows: BenchmarkRow[]): string[] {
	const toonRows = rows.filter((row) => row.formatName === "toon")
	const autoRows = rows.filter((row) => row.formatName === "auto")
	const wins = toonRows.filter((row) => row.tokenDeltaVsCompactJson < 0)
	const losses = toonRows.filter((row) => row.tokenDeltaVsCompactJson > 0)
	const neutral = toonRows.filter((row) => row.tokenDeltaVsCompactJson === 0)
	const autoToon = autoRows.filter((row) => row.selectedFormat === "toon")
	const autoJson = autoRows.filter(
		(row) => row.selectedFormat === "json-compact",
	)
	const autoWins = autoRows.filter((row) => row.tokenDeltaVsCompactJson < 0)
	const autoLosses = autoRows.filter((row) => row.tokenDeltaVsCompactJson > 0)
	const best = [...wins].sort(
		(left, right) =>
			right.tokenSavingsPctVsCompactJson - left.tokenSavingsPctVsCompactJson,
	)[0]
	const worst = [...losses].sort(
		(left, right) =>
			left.tokenSavingsPctVsCompactJson - right.tokenSavingsPctVsCompactJson,
	)[0]
	return [
		`TOON saved tokens on ${wins.length}/${toonRows.length} fixtures, lost tokens on ${losses.length}/${toonRows.length}, and tied on ${neutral.length}/${toonRows.length}.`,
		`Auto selected TOON on ${autoToon.length}/${autoRows.length} fixtures and compact JSON on ${autoJson.length}/${autoRows.length}; it saved tokens on ${autoWins.length}/${autoRows.length} fixtures and lost tokens on ${autoLosses.length}/${autoRows.length}.`,
		best
			? `Best TOON case: ${best.fixtureName} (${formatPercent(best.tokenSavingsPctVsCompactJson)}, ${best.tokenDeltaVsCompactJson} tokens vs compact JSON).`
			: "No TOON savings were observed in these fixtures.",
		worst
			? `Worst TOON case: ${worst.fixtureName} (${formatPercent(worst.tokenSavingsPctVsCompactJson)}, +${worst.tokenDeltaVsCompactJson} tokens vs compact JSON).`
			: "No TOON losses were observed in these fixtures.",
		"Results are local to these deterministic fixtures and should not be presented as a general product-wide compression claim.",
	]
}

function parseJsonOut(): string {
	const arg = process.argv.find((entry) => entry.startsWith("--json-out="))
	return arg?.slice("--json-out=".length) ?? DEFAULT_JSON_OUT
}

function parseSampleOut(): string | undefined {
	const arg = process.argv.find((entry) => entry.startsWith("--sample-out="))
	return arg?.slice("--sample-out=".length)
}

async function main(): Promise<void> {
	const fixtures = buildFixtures()
	const { rows, validations } = benchmarkFixtures(fixtures)
	const deterministicSignature = assertDeterministic(fixtures, rows)
	const jsonOut = parseJsonOut()
	const sampleOut = parseSampleOut()
	const absoluteJsonOut = resolve(jsonOut)
	const report = {
		generatedAt: FIXED_NOW,
		scope:
			"Local token-format benchmark over deterministic fixtures; not a broad product claim.",
		tokenizer: TOKENIZER,
		deterministicTokenSignature: deterministicSignature,
		formats: ["json-pretty", "json-compact", "markdown", "toon", "auto"],
		compactJsonBaseline:
			"tokenDeltaVsCompactJson and tokenSavingsPctVsCompactJson compare each row to json-compact for the same fixture/sourceSha256.",
		validations: [
			"All formats are rendered from the same stable source fixture object.",
			"Each row records the stable sourceSha256 used for that fixture.",
			"Field-path coverage is checked for every format, including TOON and auto.",
			"Token counts are recomputed in-process and must match before output is written.",
			...validations,
		],
		fixtures: fixtures.map((fixture) => ({
			name: fixture.name,
			description: fixture.description,
		})),
		results: rows,
		interpretation: summarize(rows),
		recommendedThreshold:
			"Use auto selection when representative payloads mix uniform rows and irregular objects; keep explicit TOON only when payloads show at least 10% token savings versus compact JSON and field coverage validation passes.",
	}

	printTable(rows)
	console.log("")
	console.log(
		`Tokenizer: ${TOKENIZER.package} ${TOKENIZER.model} (${TOKENIZER.encoding})`,
	)
	console.log(`Deterministic token signature: ${deterministicSignature}`)
	for (const line of summarize(rows)) {
		console.log(line)
	}
	await mkdir(dirname(absoluteJsonOut), { recursive: true })
	await writeFile(absoluteJsonOut, `${JSON.stringify(report, null, 2)}\n`)
	if (sampleOut) {
		const absoluteSampleOut = resolve(sampleOut)
		await mkdir(dirname(absoluteSampleOut), { recursive: true })
		await writeFile(absoluteSampleOut, `${JSON.stringify(report, null, 2)}\n`)
		console.log(`Sample report: ${sampleOut}`)
	}
	console.log(`JSON report: ${jsonOut}`)
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exitCode = 1
})
