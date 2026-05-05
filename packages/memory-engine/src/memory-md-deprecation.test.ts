/**
 * MEMORY.md Deprecation Verification Test
 *
 * Validates that MEMORY.md has been fully removed from the Memongo runtime:
 * - internal.ts isMemoryPath rejects MEMORY.md root files
 * - internal.ts listMemoryFiles skips MEMORY.md root files
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isMemoryPath, listMemoryFiles } from "./internal.js"

describe("MEMORY.md deprecation", () => {
	// --- isMemoryPath ---
	it("isMemoryPath rejects MEMORY.md root file", () => {
		expect(isMemoryPath("MEMORY.md")).toBe(false)
	})

	it("isMemoryPath rejects memory.md root file", () => {
		expect(isMemoryPath("memory.md")).toBe(false)
	})

	it("isMemoryPath still accepts memory/ subdirectory files", () => {
		expect(isMemoryPath("memory/2026-03-01.md")).toBe(true)
	})

	// --- listMemoryFiles ---
	describe("listMemoryFiles skips root MEMORY.md", () => {
		let tmpDir = ""
		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(
				path.join(os.tmpdir(), "memory-md-deprecation-"),
			)
		})
		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true })
		})

		it("does not include root MEMORY.md even when file exists", async () => {
			await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# bridge note")
			await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true })
			await fs.writeFile(
				path.join(tmpDir, "memory", "2026-03-01.md"),
				"# daily",
			)

			const files = await listMemoryFiles(tmpDir)
			const basenames = files.map((f) => path.basename(f))
			expect(basenames).not.toContain("MEMORY.md")
			expect(basenames).toContain("2026-03-01.md")
		})
	})
})
