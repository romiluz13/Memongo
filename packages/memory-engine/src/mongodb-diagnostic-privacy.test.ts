import { describe, expect, it } from "vitest"
import {
	applyDiagnosticQueryPrivacy,
	hashDiagnosticQuery,
	redactDiagnosticQuery,
} from "./mongodb-diagnostic-privacy.js"

describe("mongodb-diagnostic-privacy (RET-21)", () => {
	describe("redactDiagnosticQuery", () => {
		it("redacts ASCII letters and digits while preserving shape", () => {
			expect(redactDiagnosticQuery("Secret Build 123")).toBe("xxxxxx xxxxx xxx")
		})

		it("redacts Hebrew letters — the ASCII-only leak the audit found", () => {
			// RET-21: the previous [A-Za-z0-9] class left this fully readable.
			// סוד(3) ההשקה(5) של(2) המערכת(6) — every letter becomes x, the
			// word shapes survive as structure hints only.
			expect(redactDiagnosticQuery("סוד ההשקה של המערכת")).toBe(
				"xxx xxxxx xx xxxxxx",
			)
		})

		it("redacts CJK and Arabic-Indic text", () => {
			expect(redactDiagnosticQuery("秘密 plan ١٢٣")).toBe("xx xxxx xxx")
			expect(redactDiagnosticQuery("مرحبا 456")).toBe("xxxxx xxx")
		})

		it("leaves no letter of the original in any script", () => {
			// Devanagari carries \p{M} vowel signs inside graphemes; Hebrew
			// niqqud likewise. Strip the ASCII placeholder and nothing that
			// is a letter may remain — in any script, not just ASCII.
			for (const query of ["नमस्ते 789", "בְּרֵאשִׁית", "مرحبا 456"]) {
				const stripped = redactDiagnosticQuery(query).replace(/x/g, "")
				expect(stripped).not.toMatch(/\p{L}/u)
			}
		})

		it("preserves punctuation, whitespace, and symbols as structure hints", () => {
			expect(redactDiagnosticQuery("user@example.com, pass: 9!")).toBe(
				"xxxx@xxxxxxx.xxx, xxxx: x!",
			)
		})

		it("keeps combining marks attached to their redacted base letter", () => {
			// Hebrew niqqud and Arabic diacritics are \p{M}, not \p{L} — they
			// stay, so the redacted text keeps its grapheme shape.
			const redacted = redactDiagnosticQuery("בְּרֵאשִׁית")
			expect(redacted).toBe("xְּxֵxxִׁxx")
			expect(redacted).toMatch(/\p{M}/u)
		})
	})

	describe("hashDiagnosticQuery", () => {
		it("is stable across whitespace and case variations", () => {
			expect(hashDiagnosticQuery("  Secret   Build 123 ")).toBe(
				hashDiagnosticQuery("secret build 123"),
			)
		})

		it("differs across distinct queries", () => {
			expect(hashDiagnosticQuery("secret build 123")).not.toBe(
				hashDiagnosticQuery("secret build 124"),
			)
		})

		it("is a 64-character sha256 hex digest", () => {
			expect(hashDiagnosticQuery("anything")).toMatch(/^[a-f0-9]{64}$/)
		})
	})

	describe("applyDiagnosticQueryPrivacy", () => {
		it("stores nothing in none mode", () => {
			expect(applyDiagnosticQueryPrivacy("secret query", "none")).toEqual({})
		})

		it("stores the verbatim query plus hash in raw mode", () => {
			const result = applyDiagnosticQueryPrivacy("secret query", "raw")
			expect(result.queryRedacted).toBe("secret query")
			expect(result.queryHash).toMatch(/^[a-f0-9]{64}$/)
		})

		it("stores redacted text plus hash in redacted-hash mode", () => {
			const result = applyDiagnosticQueryPrivacy("סוד ההשקה", "redacted-hash")
			expect(result.queryRedacted).toBe("xxx xxxxx")
			expect(result.queryHash).toMatch(/^[a-f0-9]{64}$/)
			// The leak proof: past the ASCII placeholder, no letter of the
			// original survives in any script.
			expect(result.queryRedacted?.replace(/x/g, "")).not.toMatch(/\p{L}/u)
		})
	})
})
