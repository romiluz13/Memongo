import { describe, expect, it } from "vitest"
import { resolveExplainSources } from "./mongodb-manager.js"

describe("resolveExplainSources", () => {
	const allActive = { conversation: true, reference: true, structured: true }

	it("allows memory scope when conversation source is active", () => {
		expect(resolveExplainSources("memory", allActive)).toEqual({
			conversation: true,
			reference: false,
			structured: false,
		})
	})

	it("disables memory scope when conversation source is inactive", () => {
		expect(
			resolveExplainSources("memory", {
				...allActive,
				conversation: false,
			}),
		).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})

	it("allows kb scope when reference source is active", () => {
		expect(resolveExplainSources("kb", allActive)).toEqual({
			conversation: false,
			reference: true,
			structured: false,
		})
	})

	it("disables kb scope when reference source is inactive", () => {
		expect(
			resolveExplainSources("kb", {
				...allActive,
				reference: false,
			}),
		).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})

	it("allows structured scope when structured source is active", () => {
		expect(resolveExplainSources("structured", allActive)).toEqual({
			conversation: false,
			reference: false,
			structured: true,
		})
	})

	it("disables structured scope when structured source is inactive", () => {
		expect(
			resolveExplainSources("structured", {
				...allActive,
				structured: false,
			}),
		).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})

	it("returns all active sources for all scope", () => {
		expect(resolveExplainSources("all", allActive)).toEqual(allActive)
	})

	it("filters inactive sources from all scope", () => {
		expect(
			resolveExplainSources("all", {
				conversation: true,
				reference: false,
				structured: true,
			}),
		).toEqual({
			conversation: true,
			reference: false,
			structured: true,
		})
	})

	it("returns all disabled for all scope when all sources are disabled", () => {
		expect(
			resolveExplainSources("all", {
				conversation: false,
				reference: false,
				structured: false,
			}),
		).toEqual({
			conversation: false,
			reference: false,
			structured: false,
		})
	})
})
