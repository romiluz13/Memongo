import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/**
 * M2 source check: the search contract has no fallback, so the source must
 * not contain one. The check reads the production sources of the repo (tests,
 * test helpers, generated output and documentation are out of scope) and
 * fails on:
 *
 *   bson-regex-operator       a `$regex` or `$options` operator
 *   regexp-in-query           a RegExp value placed as an object property
 *                             value, an assignment to a property, or an array
 *                             element of such a value: how a RegExp reaches a
 *                             find filter
 *   regexp-construction       a RegExp built at run time from a non-literal
 *                             pattern: how a content regex starts
 *   text-operator             the `$text` operator, or any string that names it
 *   removed-config            a removed configuration key, alias or env name
 *   js-fusion-entry-point     a JavaScript fusion or rerank entry point
 *
 * An explicit allowlist (file plus reason) covers parsing and validation
 * regex and the modules that must name removed keys in order to reject them.
 * An allowlisted file that does not exist fails the check, so a rename cannot
 * leave a silent hole. An entry that suppresses nothing is reported as a note.
 */

export type Rule =
	| "bson-regex-operator"
	| "regexp-in-query"
	| "regexp-construction"
	| "text-operator"
	| "removed-config"
	| "js-fusion-entry-point"

export type AllowlistEntry = {
	file: string
	rules: Rule[]
	reason: string
}

export type Violation = {
	file: string
	line: number
	column: number
	rule: Rule
	message: string
}

export type CheckResult = {
	violations: Violation[]
	missingAllowlistFiles: string[]
	unusedAllowlistEntries: AllowlistEntry[]
	scannedFiles: number
}

/** Relative to the repo root, forward slashes. */
export const ALLOWLIST: AllowlistEntry[] = [
	{
		file: "packages/memory-engine/src/search-equivalence.ts",
		rules: ["bson-regex-operator"],
		reason:
			"serializes a filter into a retrieval-equivalence cache key; the `$regex` object is a key encoding that is never sent to a database",
	},
	{
		file: "packages/memory-engine/src/mongodb-retrieval-planner.ts",
		rules: ["regexp-in-query", "regexp-construction"],
		reason:
			"query-shape parsing: pattern tables classify the caller's query text in memory; no pattern reaches a database filter",
	},
	{
		file: "packages/memory-engine/src/mongodb-search-executor.ts",
		rules: ["regexp-in-query", "regexp-construction", "removed-config"],
		reason:
			"parses and validates query text and constraint tokens in memory, and rejects the removed searchConfig.lexicalPrefilter request key with a typed failure; no pattern reaches a database filter",
	},
	{
		file: "packages/memory-engine/src/mongodb-injection-classifier.ts",
		rules: ["regexp-in-query", "regexp-construction"],
		reason:
			"validates content for prompt-injection shapes with an in-memory pattern table; no pattern reaches a database filter",
	},
	{
		file: "packages/memory-engine/src/query-diagnostics.ts",
		rules: ["regexp-in-query", "regexp-construction"],
		reason:
			"splits and classifies query text for diagnostics in memory; no pattern reaches a database filter",
	},
	{
		file: "packages/memory-engine/src/mongodb-derived-memory.ts",
		rules: ["regexp-in-query", "regexp-construction"],
		reason:
			"the deterministic derived-memory extractor parses event text with in-memory patterns; no pattern reaches a database filter",
	},
	{
		file: "packages/memory-engine/src/mongodb-search-lanes.ts",
		rules: ["regexp-construction"],
		reason:
			"scores already-retrieved Search hits against the query terms in memory; the pattern is never part of a database filter",
	},
	{
		file: "packages/memory-engine/src/mongodb-consolidator.ts",
		rules: ["regexp-in-query"],
		reason:
			"the deterministic fact-extraction pattern table parses event text in memory; no pattern reaches a database filter",
	},
	{
		file: "packages/memory-engine/src/mongodb-post-retrieval-scoring.ts",
		rules: ["regexp-in-query"],
		reason:
			"temporal-phrase table that reads the query text in memory; no pattern reaches a database filter",
	},
	{
		file: "packages/memory-engine/src/mongodb-userfact-evidence.ts",
		rules: ["regexp-in-query"],
		reason:
			"user-fact extraction pattern table parses message text in memory; no pattern reaches a database filter",
	},
	{
		file: "packages/memory-engine/src/backend-config.ts",
		rules: ["removed-config"],
		reason:
			"names every removed key, alias and env variable in order to fail boot with config-removed",
	},
	{
		file: "packages/lib/src/redact.ts",
		rules: ["regexp-construction"],
		reason:
			"clones a redaction pattern with the `d` flag to find match offsets; it reads no database",
	},
	{
		file: "packages/pi-extension/extensions/diagnostics.ts",
		rules: ["regexp-construction"],
		reason:
			"clones a redaction pattern with the `d` flag to find match offsets; it reads no database",
	},
	{
		file: "scripts/check-publishability.ts",
		rules: ["regexp-construction"],
		reason:
			"parses an exported constant out of a built file; it reads no database",
	},
	{
		file: "scripts/ci/proof-pack-diagnostics.ts",
		rules: ["regexp-construction"],
		reason:
			"escapes a secret value so a CI log can be scrubbed of it; it reads no database",
	},
	{
		file: "scripts/mongodb-cluster-preflight.ts",
		rules: ["bson-regex-operator"],
		reason:
			"the `$currentOp` filter that finds the preflight's own operations on the server; it reads no memory content",
	},
	{
		file: "scripts/ci/check-no-fallbacks.ts",
		rules: [
			"bson-regex-operator",
			"regexp-in-query",
			"regexp-construction",
			"text-operator",
			"removed-config",
			"js-fusion-entry-point",
		],
		reason: "this check defines the forbidden tokens it searches for",
	},
]

const REMOVED_TOKENS = [
	"MEMONGO_STRICT_SEARCH_INDEX_READY",
	"MEMONGO_REQUIRE_VECTOR",
	"MEMONGO_RERANK_MIN_SCORE",
	"community-mongot",
	"js-merge",
	"legacySearchFallback",
	"lexicalPrefilter",
	"reranking.model",
	"reranking.topN",
	"reranking.minScore",
	"reranking.voyageApiKey",
	"reranking.instruction",
	"reranking.recencyBoost",
	"reranking.accessBoost",
] as const

const REMOVED_RERANKING_KEYS = new Set([
	"model",
	"topN",
	"minScore",
	"voyageApiKey",
	"instruction",
	"recencyBoost",
	"accessBoost",
])

const FUSION_ENTRY_POINTS = new Set([
	"hybridSearchJSFallback",
	"mergeHybridResultsMongoDB",
	"classicTextSearch",
	"crossEncoderRerank",
])

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"])
const TEXT_EXTENSIONS = new Set([".yml", ".yaml", ".sh"])
const TEXT_BASENAMES = new Set([".env.example"])
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	".next",
	".git",
	".turbo",
	"coverage",
	"test-results",
	"test-helpers",
	"__tests__",
	"docs",
	"scratchpad",
	".claude",
])
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const TEXT_ROOTS = [".github", "docker"]
const CODE_ROOTS = ["packages", "apps", "scripts", "benchmarks"]

function toPosix(file: string): string {
	return file.split(path.sep).join("/")
}

function* walk(directory: string): Generator<string> {
	if (!existsSync(directory)) return
	for (const name of readdirSync(directory)) {
		const full = path.join(directory, name)
		const stats = statSync(full)
		if (stats.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(name)) yield* walk(full)
		} else {
			yield full
		}
	}
}

type Source = { file: string; kind: "code" | "text" }

function listSources(root: string): Source[] {
	const sources: Source[] = []
	for (const top of CODE_ROOTS) {
		for (const full of walk(path.join(root, top))) {
			const base = path.basename(full)
			if (
				CODE_EXTENSIONS.has(path.extname(full)) &&
				!TEST_FILE.test(base) &&
				!DECLARATION_FILE.test(base)
			) {
				sources.push({ file: toPosix(path.relative(root, full)), kind: "code" })
			} else if (TEXT_EXTENSIONS.has(path.extname(full))) {
				sources.push({ file: toPosix(path.relative(root, full)), kind: "text" })
			}
		}
	}
	for (const top of TEXT_ROOTS) {
		for (const full of walk(path.join(root, top))) {
			const ext = path.extname(full)
			if (
				TEXT_EXTENSIONS.has(ext) ||
				ext === ".json" ||
				path.basename(full) === "Dockerfile"
			) {
				sources.push({ file: toPosix(path.relative(root, full)), kind: "text" })
			}
		}
	}
	for (const name of readdirSync(root)) {
		if (TEXT_BASENAMES.has(name)) sources.push({ file: name, kind: "text" })
	}
	return [...new Map(sources.map((s) => [s.file, s])).values()]
}

function scriptKind(file: string): ts.ScriptKind {
	const ext = path.extname(file)
	if (ext === ".tsx") return ts.ScriptKind.TSX
	if (ext === ".js" || ext === ".mjs") return ts.ScriptKind.JS
	return ts.ScriptKind.TS
}

function parse(file: string, text: string): ts.SourceFile {
	return ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		scriptKind(file),
	)
}

function unwrap(node: ts.Expression): ts.Expression {
	let current = node
	for (;;) {
		if (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isNonNullExpression(current) ||
			ts.isSatisfiesExpression(current) ||
			ts.isTypeAssertionExpression(current)
		) {
			current = current.expression
		} else {
			return current
		}
	}
}

function isRegExpConstruction(node: ts.Expression): boolean {
	const expr = unwrap(node)
	if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) return true
	if (ts.isNewExpression(expr) || ts.isCallExpression(expr)) {
		const callee = expr.expression
		return ts.isIdentifier(callee) && callee.text === "RegExp"
	}
	return false
}

function typeIsRegExp(type: ts.TypeNode | undefined): boolean {
	return (
		type !== undefined &&
		ts.isTypeReferenceNode(type) &&
		ts.isIdentifier(type.typeName) &&
		type.typeName.text === "RegExp"
	)
}

/** Function names that return a RegExp, collected across every scanned file. */
function collectRegExpFactories(files: ts.SourceFile[]): Set<string> {
	const names = new Set<string>()
	for (const sourceFile of files) {
		const visit = (node: ts.Node) => {
			if (
				ts.isFunctionDeclaration(node) &&
				node.name &&
				typeIsRegExp(node.type)
			) {
				names.add(node.name.text)
			}
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				(ts.isArrowFunction(node.initializer) ||
					ts.isFunctionExpression(node.initializer)) &&
				typeIsRegExp(node.initializer.type)
			) {
				names.add(node.name.text)
			}
			if (
				ts.isMethodDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				typeIsRegExp(node.type)
			) {
				names.add(node.name.text)
			}
			ts.forEachChild(node, visit)
		}
		visit(sourceFile)
	}
	return names
}

/** Identifiers bound to a RegExp in this file. */
function collectRegExpBindings(
	sourceFile: ts.SourceFile,
	factories: Set<string>,
): Set<string> {
	const names = new Set<string>()
	const producesRegExp = (expr: ts.Expression): boolean => {
		if (isRegExpConstruction(expr)) return true
		const inner = unwrap(expr)
		return (
			ts.isCallExpression(inner) &&
			ts.isIdentifier(inner.expression) &&
			factories.has(inner.expression.text)
		)
	}
	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			if (
				typeIsRegExp(node.type) ||
				(node.initializer && producesRegExp(node.initializer))
			) {
				names.add(node.name.text)
			}
		}
		if (
			ts.isParameter(node) &&
			ts.isIdentifier(node.name) &&
			typeIsRegExp(node.type)
		) {
			names.add(node.name.text)
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return names
}

function positionOf(sourceFile: ts.SourceFile, node: ts.Node) {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile),
	)
	return { line: line + 1, column: character + 1 }
}

function propertyNameText(name: ts.PropertyName): string | undefined {
	if (
		ts.isIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isNoSubstitutionTemplateLiteral(name)
	) {
		return name.text
	}
	return undefined
}

function scanCode(file: string, text: string, factories: Set<string>) {
	const sourceFile = parse(file, text)
	const bindings = collectRegExpBindings(sourceFile, factories)
	const found: Violation[] = []
	const add = (node: ts.Node, rule: Rule, message: string) => {
		found.push({ file, ...positionOf(sourceFile, node), rule, message })
	}

	const regExpValued = (expr: ts.Expression): boolean => {
		const inner = unwrap(expr)
		if (isRegExpConstruction(inner)) return true
		if (ts.isIdentifier(inner)) return bindings.has(inner.text)
		if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
			return factories.has(inner.expression.text)
		}
		if (ts.isConditionalExpression(inner)) {
			return regExpValued(inner.whenTrue) || regExpValued(inner.whenFalse)
		}
		if (ts.isBinaryExpression(inner)) {
			const op = inner.operatorToken.kind
			if (
				op === ts.SyntaxKind.BarBarToken ||
				op === ts.SyntaxKind.QuestionQuestionToken ||
				op === ts.SyntaxKind.AmpersandAmpersandToken
			) {
				return regExpValued(inner.left) || regExpValued(inner.right)
			}
		}
		if (ts.isArrayLiteralExpression(inner)) {
			return inner.elements.some((element) => regExpValued(element))
		}
		return false
	}

	const checkText = (node: ts.Node, value: string) => {
		if (value === "$regex" || value === "$options") {
			add(node, "bson-regex-operator", `\`${value}\` operator`)
		}
		if (value.includes("$text")) {
			add(node, "text-operator", "names the `$text` operator")
		}
		for (const token of REMOVED_TOKENS) {
			if (value.includes(token)) {
				add(node, "removed-config", `removed configuration \`${token}\``)
			}
		}
		for (const name of FUSION_ENTRY_POINTS) {
			if (value.includes(name)) {
				add(node, "js-fusion-entry-point", `JS fusion entry point \`${name}\``)
			}
		}
	}

	const visit = (node: ts.Node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			checkText(node, node.text)
		} else if (ts.isTemplateExpression(node)) {
			checkText(node, node.head.text)
			for (const span of node.templateSpans) checkText(span, span.literal.text)
		} else if (ts.isIdentifier(node)) {
			if (node.text === "$regex" || node.text === "$options") {
				add(node, "bson-regex-operator", `\`${node.text}\` operator`)
			}
			if (node.text === "$text") {
				add(node, "text-operator", "the `$text` operator")
			}
			if (FUSION_ENTRY_POINTS.has(node.text)) {
				add(
					node,
					"js-fusion-entry-point",
					`JS fusion entry point \`${node.text}\``,
				)
			}
			if (
				node.text === "legacySearchFallback" ||
				node.text === "lexicalPrefilter"
			) {
				add(node, "removed-config", `removed configuration \`${node.text}\``)
			}
		}

		if (ts.isPropertyAssignment(node)) {
			if (regExpValued(node.initializer)) {
				add(node, "regexp-in-query", "a RegExp value as a property value")
			}
			const key = propertyNameText(node.name)
			if (key === "reranking") {
				const value = unwrap(node.initializer)
				if (ts.isObjectLiteralExpression(value)) {
					for (const member of value.properties) {
						const memberKey =
							member.name === undefined
								? undefined
								: propertyNameText(member.name)
						if (memberKey && REMOVED_RERANKING_KEYS.has(memberKey)) {
							add(
								member,
								"removed-config",
								`removed configuration \`reranking.${memberKey}\``,
							)
						}
					}
				}
			}
		} else if (ts.isShorthandPropertyAssignment(node)) {
			if (bindings.has(node.name.text)) {
				add(node, "regexp-in-query", "a RegExp value as a property value")
			}
		} else if (
			(ts.isNewExpression(node) || ts.isCallExpression(node)) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "RegExp"
		) {
			const pattern = node.arguments?.[0]
			if (
				pattern &&
				!ts.isStringLiteral(pattern) &&
				!ts.isNoSubstitutionTemplateLiteral(pattern)
			) {
				add(
					node,
					"regexp-construction",
					"a RegExp built at run time from a non-literal pattern",
				)
			}
		} else if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			(ts.isPropertyAccessExpression(node.left) ||
				ts.isElementAccessExpression(node.left)) &&
			regExpValued(node.right)
		) {
			add(node, "regexp-in-query", "a RegExp value assigned to a property")
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return found
}

function scanText(file: string, text: string): Violation[] {
	const found: Violation[] = []
	const lines = text.split("\n")
	lines.forEach((content, index) => {
		const at = (column: number) => ({
			file,
			line: index + 1,
			column: column + 1,
		})
		if (content.includes("$text")) {
			found.push({
				...at(content.indexOf("$text")),
				rule: "text-operator",
				message: "names the `$text` operator",
			})
		}
		for (const token of REMOVED_TOKENS) {
			if (content.includes(token)) {
				found.push({
					...at(content.indexOf(token)),
					rule: "removed-config",
					message: `removed configuration \`${token}\``,
				})
			}
		}
		for (const name of FUSION_ENTRY_POINTS) {
			if (content.includes(name)) {
				found.push({
					...at(content.indexOf(name)),
					rule: "js-fusion-entry-point",
					message: `JS fusion entry point \`${name}\``,
				})
			}
		}
		for (const operator of ["$regex", "$options"]) {
			if (content.includes(operator)) {
				found.push({
					...at(content.indexOf(operator)),
					rule: "bson-regex-operator",
					message: `\`${operator}\` operator`,
				})
			}
		}
	})
	return found
}

export function checkSources(options: {
	root: string
	allowlist?: AllowlistEntry[]
}): CheckResult {
	const root = path.resolve(options.root)
	const allowlist = options.allowlist ?? ALLOWLIST
	const sources = listSources(root)
	const codeSources = sources
		.filter((source) => source.kind === "code")
		.map((source) => ({
			file: source.file,
			text: readFileSync(path.join(root, source.file), "utf8"),
		}))
	const parsed = codeSources.map((source) => parse(source.file, source.text))
	const factories = collectRegExpFactories(parsed)

	const all: Violation[] = []
	for (const source of codeSources) {
		all.push(...scanCode(source.file, source.text, factories))
	}
	for (const source of sources.filter((s) => s.kind === "text")) {
		all.push(
			...scanText(
				source.file,
				readFileSync(path.join(root, source.file), "utf8"),
			),
		)
	}

	const missingAllowlistFiles = allowlist
		.filter((entry) => !existsSync(path.join(root, entry.file)))
		.map((entry) => entry.file)
	const used = new Set<AllowlistEntry>()
	const violations = all.filter((violation) => {
		const entry = allowlist.find(
			(candidate) =>
				candidate.file === violation.file &&
				candidate.rules.includes(violation.rule),
		)
		if (entry) {
			used.add(entry)
			return false
		}
		return true
	})
	violations.sort(
		(a, b) =>
			a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
	)
	return {
		violations,
		missingAllowlistFiles,
		unusedAllowlistEntries: allowlist.filter(
			(entry) => !used.has(entry) && existsSync(path.join(root, entry.file)),
		),
		scannedFiles: sources.length,
	}
}

export function formatReport(result: CheckResult): string {
	const lines: string[] = []
	for (const violation of result.violations) {
		lines.push(
			`${violation.file}:${violation.line}:${violation.column} [${violation.rule}] ${violation.message}`,
		)
	}
	for (const file of result.missingAllowlistFiles) {
		lines.push(`allowlist: ${file} does not exist; fix or remove the entry`)
	}
	for (const entry of result.unusedAllowlistEntries) {
		lines.push(
			`note: allowlist entry ${entry.file} [${entry.rules.join(", ")}] suppresses nothing`,
		)
	}
	const failed =
		result.violations.length > 0 || result.missingAllowlistFiles.length > 0
	lines.push(
		failed
			? `no-fallback source check FAILED: ${result.violations.length} violation(s), ${result.missingAllowlistFiles.length} missing allowlist file(s) in ${result.scannedFiles} files`
			: `no-fallback source check passed: ${result.scannedFiles} files scanned`,
	)
	return lines.join("\n")
}

export function main(argv: string[] = process.argv.slice(2)): number {
	const rootFlag = argv.indexOf("--root")
	const root =
		rootFlag >= 0 && argv[rootFlag + 1]
			? argv[rootFlag + 1]
			: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
	const result = checkSources({ root })
	const report = formatReport(result)
	const failed =
		result.violations.length > 0 || result.missingAllowlistFiles.length > 0
	;(failed ? console.error : console.log)(report)
	return failed ? 1 : 0
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.exit(main())
}
