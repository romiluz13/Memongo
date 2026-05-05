import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
)
const docsDir = path.join(repoRoot, "apps/docs")
const docsJsonPath = path.join(docsDir, "docs.json")
const docsOutputPath = path.join(docsDir, ".turbo", "docs-integrity.txt")

function fail(message) {
	console.error(`Docs integrity check failed: ${message}`)
	process.exit(1)
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function ensureFile(relativePath) {
	const fullPath = path.join(docsDir, relativePath)
	if (!fs.existsSync(fullPath)) {
		fail(`missing file: apps/docs/${relativePath}`)
	}
}

function visitPages(node, pages) {
	if (typeof node === "string") {
		pages.add(node)
		return
	}
	if (Array.isArray(node)) {
		for (const entry of node) {
			visitPages(entry, pages)
		}
		return
	}
	if (!node || typeof node !== "object") {
		return
	}
	if ("pages" in node) {
		visitPages(node.pages, pages)
	}
}

function collectDocsPages(config) {
	const pages = new Set()
	visitPages(config.navigation?.tabs ?? [], pages)
	for (const redirect of config.redirects ?? []) {
		const destination = redirect.destination
		if (typeof destination === "string" && destination.startsWith("/")) {
			pages.add(destination.slice(1))
		}
	}
	return pages
}

function collectInternalLinks(filePath) {
	const content = fs.readFileSync(filePath, "utf8")
	const links = []
	const regexes = [
		/\[[^\]]+\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/g,
		/href="(\/[^"]+)"/g,
	]
	for (const regex of regexes) {
		let match
		for (;;) {
			match = regex.exec(content)
			if (!match) {
				break
			}
			links.push(match[1])
		}
	}
	return links
}

function validateInternalLinks(filePath) {
	const relativeToRepo = path.relative(repoRoot, filePath)
	for (const link of collectInternalLinks(filePath)) {
		if (link.startsWith("/")) {
			const docPath = path.join(docsDir, `${link.slice(1)}.mdx`)
			if (!fs.existsSync(docPath)) {
				fail(`${relativeToRepo} links to missing docs page: ${link}`)
			}
			continue
		}
		const resolved = path.resolve(path.dirname(filePath), link)
		if (!fs.existsSync(resolved)) {
			fail(`${relativeToRepo} links to missing file: ${link}`)
		}
	}
}

if (!fs.existsSync(docsJsonPath)) {
	fail("apps/docs/docs.json is missing")
}

const config = readJson(docsJsonPath)

if (typeof config.name !== "string" || config.name.trim() === "") {
	fail("apps/docs/docs.json must define a non-empty `name`")
}

const faviconPath = config.favicon?.replace(/^\//, "")
if (faviconPath) {
	ensureFile(faviconPath)
}

const darkLogo = config.logo?.dark?.replace(/^\//, "")
const lightLogo = config.logo?.light?.replace(/^\//, "")
if (darkLogo) {
	ensureFile(darkLogo)
}
if (lightLogo) {
	ensureFile(lightLogo)
}

const referencedPages = collectDocsPages(config)
for (const page of referencedPages) {
	ensureFile(`${page}.mdx`)
}

const mdxFiles = []
function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) {
			continue
		}
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			walk(fullPath)
			continue
		}
		if (entry.isFile() && fullPath.endsWith(".mdx")) {
			mdxFiles.push(fullPath)
		}
	}
}

walk(docsDir)

for (const filePath of mdxFiles) {
	validateInternalLinks(filePath)
}

fs.mkdirSync(path.dirname(docsOutputPath), { recursive: true })
fs.writeFileSync(
	docsOutputPath,
	`docs-integrity-ok:${new Date().toISOString()}\n`,
	"utf8",
)

console.log(
	`Docs integrity checks passed for ${mdxFiles.length} page${mdxFiles.length === 1 ? "" : "s"}.`,
)
