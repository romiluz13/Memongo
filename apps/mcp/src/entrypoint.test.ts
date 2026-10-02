import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { isEntrypoint } from "./entrypoint.js"

const dir = mkdtempSync(join(tmpdir(), "memongo entry # % "))
const main = join(dir, "main.mjs")
const other = join(dir, "other.mjs")
const link = join(dir, "launcher")
const chain = join(dir, "chain")
writeFileSync(main, "")
writeFileSync(other, "")
symlinkSync(main, link)
symlinkSync(link, chain)
const moduleUrl = pathToFileURL(main).href

afterAll(() => rmSync(dir, { recursive: true, force: true }))
describe("canonical process entrypoint", () => {
	it("recognizes a direct path with URL-encoded characters", () => {
		expect(isEntrypoint(main, moduleUrl)).toBe(true)
	})
	it("recognizes a launcher symlink", () => {
		expect(isEntrypoint(link, moduleUrl)).toBe(true)
	})
	it("recognizes a chained symlink and preserved module URL", () => {
		expect(isEntrypoint(chain, pathToFileURL(link).href)).toBe(true)
	})
	it("keeps an importer separate", () => {
		expect(isEntrypoint(other, moduleUrl)).toBe(false)
	})
	it("does not start for an absent launcher", () => {
		expect(isEntrypoint(undefined, moduleUrl)).toBe(false)
	})
	it("does not reject imports with an unavailable launcher path", () => {
		expect(isEntrypoint(join(dir, "missing"), moduleUrl)).toBe(false)
	})
	it("resolves a relative launcher without changing cwd", () => {
		expect(isEntrypoint(relative(process.cwd(), main), moduleUrl)).toBe(true)
	})
})
