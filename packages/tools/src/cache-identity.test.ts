import { describe, expect, it, vi } from "vitest"
import { _clearCache, sha256Hex } from "./cache-identity.js"

describe("sha256Hex (capture idempotency digest)", () => {
	it("produces a full 64-char SHA-256 hex digest", async () => {
		const digest = await sha256Hex("turn source text")
		expect(digest).toMatch(/^[0-9a-f]{64}$/)
	})

	it("is deterministic for identical input", async () => {
		expect(await sha256Hex("same turn")).toBe(await sha256Hex("same turn"))
	})

	it("differs for distinct input (distinct turns derive distinct ids)", async () => {
		const a = await sha256Hex("Tell me about dogs")
		const b = await sha256Hex("Tell me about cats")
		expect(b).not.toBe(a)
	})

	it("never embeds the raw input material in the digest", async () => {
		const digest = await sha256Hex("a very recognizable secret string")
		expect(digest).toMatch(/^[0-9a-f]{64}$/)
		expect(digest).not.toContain("recognizable")
	})

	it("returns undefined when WebCrypto is unavailable (fail-safe, no weak fallback)", async () => {
		if (!globalThis.crypto?.subtle) {
			// Already absent on this runtime — nothing to stub.
			return
		}
		vi.stubGlobal("crypto", {})
		try {
			expect(await sha256Hex("anything")).toBeUndefined()
		} finally {
			vi.unstubAllGlobals()
		}
	})
})

describe("_clearCache (W7 compatibility no-op)", () => {
	it("stays exported and callable — there is no cache left to clear", () => {
		expect(typeof _clearCache).toBe("function")
		expect(_clearCache()).toBeUndefined()
		expect(() => _clearCache()).not.toThrow()
	})
})
