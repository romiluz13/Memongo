import ts from "typescript"

/** A module request the build identity cannot name statically; refuses identity. */
export class ModuleSyntaxError extends Error {}

type BunScanner = {
	Transpiler: new (options: {
		loader: "ts" | "tsx" | "js"
	}) => { scanImports(code: string): Array<{ path: string }> }
}

function scriptKind(file: string): ts.ScriptKind {
	if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
	return /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS
}

function literalText(node: ts.Node | undefined): string | null {
	return node &&
		(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
		? node.text
		: null
}

/**
 * Every module a file requests: static imports and re-exports, import-equals,
 * import types, and literal dynamic imports or requires. Parsing (not pattern
 * matching) means comments and escapes cannot hide a request; a dynamic import
 * or require of a computed name, or a file that does not parse, throws.
 */
export function moduleRequests(file: string, text: string): string[] {
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		scriptKind(file),
	)
	// Syntax errors are recorded on the source file rather than thrown; the
	// field is not in the public typings.
	if (
		(source as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics
			?.length
	)
		throw new ModuleSyntaxError("does not parse")
	const requests: string[] = []
	const request = (node: ts.Node | undefined, kind: string) => {
		const specifier = literalText(node)
		if (specifier === null)
			throw new ModuleSyntaxError(
				`has a ${kind} the source graph cannot follow`,
			)
		requests.push(specifier)
	}
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier
		)
			request(node.moduleSpecifier, "module specifier")
		else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		)
			request(node.moduleReference.expression, "module specifier")
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			request(node.argument.literal, "type import")
		else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		)
			request(node.arguments[0], "dynamic import")
		ts.forEachChild(node, visit)
	}
	visit(source)
	// Under Bun, the runtime's own scanner must find nothing the parse missed.
	const scanner = (globalThis as { Bun?: Partial<BunScanner> }).Bun?.Transpiler
	if (scanner) {
		const kind = scriptKind(file)
		let scanned: Array<{ path: string }>
		try {
			scanned = new scanner({
				loader:
					kind === ts.ScriptKind.TSX
						? "tsx"
						: kind === ts.ScriptKind.TS
							? "ts"
							: "js",
			}).scanImports(
				// scanImports rejects a hashbang, which is legal only as line one.
				text.startsWith("#!") ? text.replace(/^#!.*/, "") : text,
			)
		} catch {
			throw new ModuleSyntaxError("does not parse")
		}
		if (scanned.some((entry) => !requests.includes(entry.path)))
			throw new ModuleSyntaxError(
				"has an import the runtime finds but the parser does not",
			)
	}
	return requests
}
