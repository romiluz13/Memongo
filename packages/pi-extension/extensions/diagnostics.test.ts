import { describe, expect, it } from "vitest"
import { errMessage, sanitizeDiagnostic } from "./diagnostics.js"

// C-002 round 3: the extension is published standalone, so it carries a
// local minimal classifier. These tests pin its coverage against the
// shapes the round-2/round-3 refutations actually smuggled through other
// packages' boundaries, so parity drift is caught here first.

describe("sanitizeDiagnostic (C-002 local classifier)", () => {
	it("stars connection-string passwords in full", () => {
		const text = [
			"upstream failed at ",
			"mongodb://svc:d",
			"ummy-cred-00000@",
			"mongo.internal:27017/db",
		].join("")
		const result = sanitizeDiagnostic(text)
		expect(result).not.toContain("dummy-cred-00000")
		expect(result).toContain(
			["mongodb:/", "/svc:***@", "mongo.internal:27017/db"].join(""),
		)
	})

	it("stars long (>=18 char) values in full rather than head-tail (round-3 parity)", () => {
		const text = [
			"mongodb://svc:du",
			"mmy-cred-0000000@",
			"mongo.internal:27017/db rejected",
		].join("")
		const result = sanitizeDiagnostic(text)
		expect(result).not.toContain("envelo")
		expect(result).not.toContain("t-99")
		expect(result).toContain(
			["mongodb:/", "/svc:***@", "mongo.internal:27017/db"].join(""),
		)
	})

	it("stars username-only userinfo: the username is the credential", () => {
		const result = sanitizeDiagnostic(
			"redis://dummy-user-0000000000@[::1]:6379/0",
		)
		expect(result).not.toContain("dummy-user-0000000000")
		expect(result).toBe("redis://***@[::1]:6379/0")
	})

	it("stars quoted multiword values (round-3 parity)", () => {
		const result = sanitizeDiagnostic(
			[
				"rejected ",
				'password="du',
				"mmy-pass-001",
				' dummy-pass-002" for turn',
			].join(""),
		)
		expect(result).not.toContain("dummy-pass-001")
		expect(result).not.toContain("dummy-pass-002")
		expect(result).toContain("***")
	})

	it("stars single-quoted multiword values", () => {
		const result = sanitizeDiagnostic(
			[
				"apiKe",
				"y='",
				"spac",
				"e sep",
				"arate",
				"d sec",
				"ret v",
				"alue' rejected",
			].join(""),
		)
		expect(result).not.toContain("space separated")
		expect(result).toContain("***")
	})

	it("stars escaped-quoted credential values inside serialized text (round-3 parity)", () => {
		// An assignment riding inside a JSON-serialized meta value has its
		// quotes escaped (password=\"two words\"); without backslash
		// tolerance the pair survived the classifier raw.
		const result = sanitizeDiagnostic(
			[
				'{"detail":"pass',
				"word=",
				'\\"',
				"dum",
				"my-pa",
				"ss-00",
				"1 dum",
				"my-pa",
				"ss-00",
				"2",
				'\\"',
				'"',
				",",
				'"ok":1}',
			].join(""),
		)
		expect(result).not.toContain("dummy-pass-001")
		expect(result).not.toContain("dummy-pass-002")
		expect(result).toContain('"ok":1')
	})

	it("stars bare credential assignment values", () => {
		const result = sanitizeDiagnostic(
			[
				"AUTH_",
				"TOKE",
				"N=",
				"abcd",
				"1234",
				"efgh",
				"5678",
				" ",
				"expired",
			].join(""),
		)
		expect(result).not.toContain(["abcd", "1234", "efgh", "5678"].join(""))
		expect(result).toContain("***")
	})

	it("stars Bearer tokens", () => {
		const result = sanitizeDiagnostic(
			["Authorization: ", "Bearer", " dum.dum.dum"].join(""),
		)
		expect(result).not.toContain("dum.dum.dum")
		expect(result).toContain("Bearer ***")
	})

	it("truncates webhook URLs to the host", () => {
		const result = sanitizeDiagnostic(
			[
				"notify failed ",
				"https://hoo",
				"ks.slack.com/services/",
				"T000/B000/XYZ",
				"sample",
			].join(""),
		)
		expect(result).not.toContain("XYZsample")
		expect(result).toContain("https://hooks.slack.com/***")
	})

	it("leaves ordinary diagnostic text untouched", () => {
		const text = "wrote 3 memories for session abc-123 in 45ms"
		expect(sanitizeDiagnostic(text)).toBe(text)
	})
})

describe("errMessage (C-002 choke point)", () => {
	it("sanitizes Error messages", () => {
		const err = new Error(
			[
				"connect failed: ",
				"mongodb://svc:",
				"dummy-cred-00@",
				"mongo.internal:27017/db",
			].join(""),
		)
		const result = errMessage(err)
		expect(result).not.toContain("dummy-cred-00")
		expect(result).toContain("***")
	})

	it("sanitizes non-Error values via String()", () => {
		const result = errMessage(
			["to", "ken=dum", "my-to", "ken-", "aaaa", "aaaa", "aaaa", "aaaaaa"].join(
				"",
			),
		)
		expect(result).not.toContain(
			["dummy-to", "ken-aaaa", "aaaa", "aaaa", "aaaa", "aa"].join(""),
		)
	})
})
