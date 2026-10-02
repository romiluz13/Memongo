import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { listMemoryFiles, listLegacyMarkdownMemoryFiles } from "./internal.js"

let workspace: string
beforeEach(async () => {
	workspace = await fs.mkdtemp(
		path.join(os.tmpdir(), "memongo-listing-complete-"),
	)
})
afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(workspace, { recursive: true, force: true })
})

describe.each([
	["current", listMemoryFiles],
	["legacy", listLegacyMarkdownMemoryFiles],
] as const)("%s listing completeness", (_name, list) => {
	it("retains the initially absent default-root control", async () => {
		await expect(list(workspace)).resolves.toEqual([])
	})
	it.each([
		"root",
		"nested",
	] as const)("propagates real ENOENT after a %s directory was observed", async (mode) => {
		const root = path.join(workspace, "memory"),
			child = path.join(root, "nested")
		await fs.mkdir(child, { recursive: true })
		await fs.writeFile(path.join(child, "note.md"), "owned")
		const original = fs.readdir
		let removed = false
		let actualError: unknown
		vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
			if (mode === "root" && String(args[0]) === root && !removed) {
				removed = true
				await fs.rm(root, { recursive: true })
			}
			try {
				const entries = await Reflect.apply(original, fs, args)
				if (mode === "nested" && String(args[0]) === root && !removed) {
					removed = true
					await fs.rm(child, { recursive: true })
				}
				return entries
			} catch (error) {
				actualError = error
				throw error
			}
		})
		await expect(list(workspace)).rejects.toMatchObject({
			code: "ENOENT",
			path: mode === "root" ? root : child,
		})
		expect(removed).toBe(true)
		expect(actualError).toMatchObject({ code: "ENOENT" })
		vi.restoreAllMocks()
		await fs.mkdir(root, { recursive: true })
		await fs.writeFile(path.join(root, "fresh.md"), "fresh")
		await expect(list(workspace)).resolves.toEqual([
			path.join(root, "fresh.md"),
		])
	})
	it("rejects a configured missing extra rather than returning a partial list", async () => {
		const root = path.join(workspace, "memory"),
			missing = path.join(workspace, "missing-extra")
		await fs.mkdir(root)
		await fs.writeFile(path.join(root, "note.md"), "owned")
		await expect(list(workspace, [missing])).rejects.toMatchObject({
			code: "ENOENT",
			path: missing,
		})
	})
	it("propagates a nested disappearance in an extra directory", async () => {
		const extra = path.join(workspace, "extra"),
			child = path.join(extra, "nested")
		await fs.mkdir(child, { recursive: true })
		await fs.writeFile(path.join(child, "note.md"), "owned")
		const original = fs.readdir
		let removed = false
		vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
			const entries = await Reflect.apply(original, fs, args)
			if (String(args[0]) === extra && !removed) {
				removed = true
				await fs.rm(child, { recursive: true })
			}
			return entries
		})
		await expect(list(workspace, [extra])).rejects.toMatchObject({
			code: "ENOENT",
			path: child,
		})
		expect(removed).toBe(true)
	})
})
