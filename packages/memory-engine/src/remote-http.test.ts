import { SsrFBlockedError } from "@memongo/lib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildRemoteBaseUrlPolicy,
	withRemoteHttpResponse,
} from "./remote-http.js"

describe("withRemoteHttpResponse SSRF guard", () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("blocks a cloud-metadata IP literal without fetching (default policy)", async () => {
		await expect(
			withRemoteHttpResponse({
				url: "http://169.254.169.254/latest/meta-data/",
				onResponse: async (r) => r.status,
			}),
		).rejects.toBeInstanceOf(SsrFBlockedError)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("blocks a known internal metadata hostname without fetching", async () => {
		await expect(
			withRemoteHttpResponse({
				url: "http://metadata.google.internal/computeMetadata/v1/",
				onResponse: async (r) => r.status,
			}),
		).rejects.toBeInstanceOf(SsrFBlockedError)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("runs the DNS-resolving guard on public hosts and blocks a rebind to a private IP", async () => {
		const verify = vi.fn(async () => {
			throw new SsrFBlockedError("Hostname resolves to private IP: 10.0.0.5")
		})
		await expect(
			withRemoteHttpResponse({
				url: "https://api.example.com/v1/embeddings",
				verifyPublicHostname: verify,
				onResponse: async (r) => r.status,
			}),
		).rejects.toBeInstanceOf(SsrFBlockedError)
		expect(verify).toHaveBeenCalledWith("api.example.com")
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("allows a public host that resolves publicly", async () => {
		const verify = vi.fn(async () => {})
		const status = await withRemoteHttpResponse({
			url: "https://api.example.com/v1/embeddings",
			verifyPublicHostname: verify,
			onResponse: async (r) => r.status,
		})
		expect(status).toBe(200)
		expect(verify).toHaveBeenCalledOnce()
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it("honors an operator-configured private base URL (self-hosted) and skips the DNS guard", async () => {
		const policy = buildRemoteBaseUrlPolicy("http://localhost:11434")
		const verify = vi.fn(async () => {
			throw new SsrFBlockedError("should not be called")
		})
		const status = await withRemoteHttpResponse({
			url: "http://localhost:11434/api/embeddings",
			ssrfPolicy: policy,
			verifyPublicHostname: verify,
			onResponse: async (r) => r.status,
		})
		expect(status).toBe(200)
		expect(verify).not.toHaveBeenCalled()
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it("honors an operator-configured IPv6 loopback endpoint (self-hosted) and skips the DNS guard", async () => {
		const policy = buildRemoteBaseUrlPolicy("http://[::1]:11434")
		const verify = vi.fn(async () => {
			throw new SsrFBlockedError("should not be called")
		})
		const status = await withRemoteHttpResponse({
			url: "http://[::1]:11434/api/embeddings",
			ssrfPolicy: policy,
			verifyPublicHostname: verify,
			onResponse: async (r) => r.status,
		})
		expect(status).toBe(200)
		expect(verify).not.toHaveBeenCalled()
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it("enforces hostname pinning from the base-URL policy", async () => {
		const policy = buildRemoteBaseUrlPolicy("https://api.example.com")
		await expect(
			withRemoteHttpResponse({
				url: "https://evil.example.net/v1/embeddings",
				ssrfPolicy: policy,
				onResponse: async (r) => r.status,
			}),
		).rejects.toBeInstanceOf(SsrFBlockedError)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
