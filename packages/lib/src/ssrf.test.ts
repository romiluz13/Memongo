import { lookup } from "node:dns/promises"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi, type Mock } from "vitest"
import {
	assertAllowedHostOrIp,
	assertPublicHostname,
	defaultSsrfPolicy,
	isBlockedHostname,
	isPrivateIpAddress,
	isPrivateNetworkAllowedByPolicy,
	SsrFBlockedError,
} from "./ssrf.js"

vi.mock("node:dns/promises", () => ({
	lookup: vi.fn(),
}))

const mockedLookup = lookup as unknown as Mock

afterEach(() => {
	mockedLookup.mockReset()
})

describe("ssrf: SsrFBlockedError", () => {
	it("is an Error with a stable name", () => {
		const err = new SsrFBlockedError("nope")
		expect(err).toBeInstanceOf(Error)
		expect(err.name).toBe("SsrFBlockedError")
		expect(err.message).toBe("nope")
	})
})

describe("ssrf: isPrivateIpAddress (IPv4)", () => {
	it("blocks loopback, RFC1918, link-local, metadata, and 0.x ranges", () => {
		const blocked = [
			"127.0.0.1",
			"127.1.2.3",
			"10.0.0.1",
			"10.255.255.255",
			"192.168.0.1",
			"192.168.255.254",
			"169.254.0.1",
			"169.254.169.254", // cloud metadata endpoint
			"172.16.0.1",
			"172.31.255.255",
			"0.0.0.0",
			"0.1.2.3",
		]
		for (const ip of blocked) {
			expect(isPrivateIpAddress(ip), ip).toBe(true)
		}
	})

	it("allows public IPv4 addresses", () => {
		const allowed = [
			"8.8.8.8",
			"1.1.1.1",
			"203.0.113.10",
			"172.15.0.1", // just below 172.16/12
			"172.32.0.1", // just above 172.31/12
			"11.0.0.1",
			"192.167.0.1",
			"169.253.0.1",
		]
		for (const ip of allowed) {
			expect(isPrivateIpAddress(ip), ip).toBe(false)
		}
	})

	it("trims surrounding whitespace", () => {
		expect(isPrivateIpAddress("  10.0.0.1  ")).toBe(true)
		expect(isPrivateIpAddress("\t8.8.8.8\n")).toBe(false)
	})

	it("pins the 172.16.0.0/12 boundary (property)", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 255 }), (second) => {
				expect(isPrivateIpAddress(`172.${second}.0.1`)).toBe(
					second >= 16 && second <= 31,
				)
			}),
		)
	})

	it("blocks every address under the 10/8, 127/8, and 0/8 prefixes (property)", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("10", "127", "0"),
				fc.integer({ min: 0, max: 255 }),
				fc.integer({ min: 0, max: 255 }),
				fc.integer({ min: 0, max: 255 }),
				(a, b, c, d) => {
					expect(isPrivateIpAddress(`${a}.${b}.${c}.${d}`)).toBe(true)
				},
			),
		)
	})
})

describe("ssrf: isPrivateIpAddress (IPv6)", () => {
	it("blocks loopback, unspecified, link-local, and ULA ranges", () => {
		const blocked = [
			"::1",
			"::",
			"fe80::1",
			"fe80::dead:beef",
			"fc00::1",
			"fd00::1",
			"fdff::ffff",
			"FE80::1", // case-insensitive
		]
		for (const ip of blocked) {
			expect(isPrivateIpAddress(ip), ip).toBe(true)
		}
	})

	it("blocks IPv4-mapped IPv6 when the mapped address is private", () => {
		expect(isPrivateIpAddress("::ffff:127.0.0.1")).toBe(true)
		expect(isPrivateIpAddress("::ffff:10.0.0.1")).toBe(true)
		expect(isPrivateIpAddress("::ffff:192.168.1.1")).toBe(true)
		expect(isPrivateIpAddress("::ffff:169.254.169.254")).toBe(true)
	})

	it("allows public IPv6 and publicly-mapped IPv4", () => {
		expect(isPrivateIpAddress("2001:4860:4860::8888")).toBe(false)
		expect(isPrivateIpAddress("2606:4700:4700::1111")).toBe(false)
		expect(isPrivateIpAddress("::ffff:8.8.8.8")).toBe(false)
	})

	it("strips URL-style brackets around IPv6 literals", () => {
		expect(isPrivateIpAddress("[::1]")).toBe(true)
		expect(isPrivateIpAddress("[fe80::1]")).toBe(true)
		expect(isPrivateIpAddress("[2001:4860:4860::8888]")).toBe(false)
	})
})

describe("ssrf: isBlockedHostname", () => {
	it("blocks exact well-known internal hostnames", () => {
		for (const host of [
			"localhost",
			"localhost.localdomain",
			"metadata.google.internal",
		]) {
			expect(isBlockedHostname(host), host).toBe(true)
		}
	})

	it("is case-insensitive and ignores trailing dots", () => {
		expect(isBlockedHostname("LOCALHOST")).toBe(true)
		expect(isBlockedHostname("LocalHost")).toBe(true)
		expect(isBlockedHostname("localhost.")).toBe(true)
		expect(isBlockedHostname("Metadata.Google.Internal..")).toBe(true)
	})

	it("blocks .localhost, .local, and .internal suffixes", () => {
		expect(isBlockedHostname("foo.localhost")).toBe(true)
		expect(isBlockedHostname("printer.local")).toBe(true)
		expect(isBlockedHostname("db.svc.internal")).toBe(true)
	})

	it("allows public hostnames that merely contain blocked words", () => {
		expect(isBlockedHostname("example.com")).toBe(false)
		expect(isBlockedHostname("localhosts.com")).toBe(false)
		expect(isBlockedHostname("internal.example.com")).toBe(false)
		expect(isBlockedHostname("mylocalhost")).toBe(false)
	})
})

describe("ssrf: isPrivateNetworkAllowedByPolicy", () => {
	it("fails closed when no policy opts in", () => {
		expect(isPrivateNetworkAllowedByPolicy(undefined)).toBe(false)
		expect(isPrivateNetworkAllowedByPolicy({})).toBe(false)
		expect(
			isPrivateNetworkAllowedByPolicy({ allowPrivateNetwork: false }),
		).toBe(false)
	})

	it("honors either opt-in flag", () => {
		expect(isPrivateNetworkAllowedByPolicy({ allowPrivateNetwork: true })).toBe(
			true,
		)
		expect(
			isPrivateNetworkAllowedByPolicy({ dangerouslyAllowPrivateNetwork: true }),
		).toBe(true)
	})

	it("ships a default policy that does not allow private networks", () => {
		expect(isPrivateNetworkAllowedByPolicy(defaultSsrfPolicy)).toBe(false)
	})
})

describe("ssrf: assertAllowedHostOrIp", () => {
	it("throws SsrFBlockedError for blocked hostnames", () => {
		expect(() => assertAllowedHostOrIp("localhost")).toThrow(SsrFBlockedError)
		expect(() => assertAllowedHostOrIp("db.internal")).toThrow(
			/Blocked hostname/,
		)
	})

	it("throws SsrFBlockedError for private IPs, including metadata endpoints", () => {
		for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "::1"]) {
			expect(() => assertAllowedHostOrIp(ip), ip).toThrow(SsrFBlockedError)
			expect(() => assertAllowedHostOrIp(ip), ip).toThrow(
				/Blocked private\/internal IP/,
			)
		}
	})

	it("permits public hosts and IPs", () => {
		expect(() => assertAllowedHostOrIp("example.com")).not.toThrow()
		expect(() => assertAllowedHostOrIp("8.8.8.8")).not.toThrow()
		expect(() => assertAllowedHostOrIp("2001:4860:4860::8888")).not.toThrow()
	})

	it("short-circuits all checks when private networks are allowed", () => {
		const policy = { allowPrivateNetwork: true }
		expect(() => assertAllowedHostOrIp("localhost", policy)).not.toThrow()
		expect(() => assertAllowedHostOrIp("10.0.0.1", policy)).not.toThrow()
		expect(() => assertAllowedHostOrIp("169.254.169.254", policy)).not.toThrow()
	})

	it("honors the allowedHostnames allowlist exactly and case-insensitively", () => {
		const policy = { allowedHostnames: ["DB.Internal"] }
		expect(() => assertAllowedHostOrIp("db.internal", policy)).not.toThrow()
		expect(() => assertAllowedHostOrIp("other.internal", policy)).toThrow(
			SsrFBlockedError,
		)
	})

	it("supports the legacy hostnameAllowlist key", () => {
		const policy = { hostnameAllowlist: ["cache.local"] }
		expect(() => assertAllowedHostOrIp("cache.local", policy)).not.toThrow()
	})

	it("supports wildcard allowlist entries, including the apex", () => {
		const policy = { allowedHostnames: ["*.example.com"] }
		expect(() => assertAllowedHostOrIp("a.example.com", policy)).not.toThrow()
		expect(() =>
			assertAllowedHostOrIp("deep.a.example.com", policy),
		).not.toThrow()
		expect(() => assertAllowedHostOrIp("example.com", policy)).not.toThrow()
		expect(() =>
			assertAllowedHostOrIp("evil-example.com", policy),
		).not.toThrow()
		expect(() =>
			assertAllowedHostOrIp("example.com.evil.io", policy),
		).not.toThrow()
		expect(() => assertAllowedHostOrIp("10.0.0.1", policy)).toThrow(
			SsrFBlockedError,
		)
	})
})

describe("ssrf: assertPublicHostname (DNS guard)", () => {
	it("rejects blocked hostnames before any DNS lookup", async () => {
		await expect(assertPublicHostname("localhost")).rejects.toBeInstanceOf(
			SsrFBlockedError,
		)
		expect(mockedLookup).not.toHaveBeenCalled()
	})

	it("resolves when every DNS answer is public", async () => {
		mockedLookup.mockResolvedValue([
			{ address: "8.8.8.8", family: 4 },
			{ address: "1.1.1.1", family: 4 },
		])
		await expect(assertPublicHostname("example.com")).resolves.toBeUndefined()
		expect(mockedLookup).toHaveBeenCalledWith("example.com", { all: true })
	})

	it("rejects when any DNS answer is private (rebinding guard)", async () => {
		mockedLookup.mockResolvedValue([
			{ address: "8.8.8.8", family: 4 },
			{ address: "169.254.169.254", family: 4 },
		])
		await expect(assertPublicHostname("evil.example.com")).rejects.toThrow(
			/resolves to private IP/,
		)
	})

	it("rejects when DNS answers with a private IPv6", async () => {
		mockedLookup.mockResolvedValue([{ address: "fd00::1", family: 6 }])
		await expect(assertPublicHostname("evil.example.com")).rejects.toThrow(
			SsrFBlockedError,
		)
	})
})
