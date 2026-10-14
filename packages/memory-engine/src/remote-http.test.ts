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

	it("rejects non-HTTP protocols before fetching", async () => {
		await expect(
			withRemoteHttpResponse({
				url: "file:///etc/passwd",
				onResponse: async (r) => r.status,
			}),
		).rejects.toBeInstanceOf(SsrFBlockedError)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("does not follow redirects that could escape the validated host", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { Location: "http://169.254.169.254/latest/meta-data/" },
			}),
		)
		await expect(
			withRemoteHttpResponse({
				url: "https://api.example.com/v1/embeddings",
				verifyPublicHostname: vi.fn(async () => {}),
				onResponse: async (r) => r.status,
			}),
		).rejects.toBeInstanceOf(SsrFBlockedError)
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" })
	})
})

describe("withRemoteHttpResponse SSRF error text", () => {
	// Any part of a configured URL can carry a secret: userinfo, path, query.
	const SECRETS = ["cnryUser", "cnryPass", "cnryPath", "cnryToken"]
	const PATH_URL =
		"https://api.example.test/v1/cnryPath/chat?api_key=cnryToken#cnryToken"

	async function failure(
		params: Partial<Parameters<typeof withRemoteHttpResponse>[0]>,
	): Promise<{ error: Error | null; fetches: number }> {
		let fetches = 0
		const error = await withRemoteHttpResponse({
			url: PATH_URL,
			onResponse: async (response) => response.status,
			ssrfPolicy: { allowPrivateNetwork: true },
			fetchFn: async (input) => {
				fetches += 1
				// The runtime's own Request rejects some URLs, echoing them.
				new Request(input)
				return new Response(null, {
					status: 307,
					headers: { location: "https://elsewhere.test/" },
				})
			},
			...params,
		}).then(
			() => null,
			(reason: Error) => reason,
		)
		return { error, fetches }
	}

	function expectNoSecret(error: Error | null) {
		expect(error).toBeInstanceOf(SsrFBlockedError)
		const text = `${error?.message} ${String(error?.cause ?? "")} ${JSON.stringify(error)}`
		for (const secret of SECRETS) expect(text).not.toContain(secret)
	}

	it.each([
		["a refused redirect", {}, 1],
		[
			"a request off the pinned host",
			{ ssrfPolicy: { allowPrivateNetwork: true, isAllowed: () => false } },
			0,
		],
		["a non-HTTP URL", { url: "file:///srv/cnryPath?api_key=cnryToken" }, 0],
		[
			"an unparseable URL",
			{
				url: "http://cnryUser:cnryPass@[not-a-host/cnryPath?api_key=cnryToken",
			},
			0,
		],
	])("keeps every URL part out of %s", async (_name, params, expectedFetches) => {
		const { error, fetches } = await failure(params)
		expect(error?.message).toContain("SSRF guard")
		expectNoSecret(error)
		expect(fetches).toBe(expectedFetches)
	})

	it("refuses embedded credentials before the request is constructed", async () => {
		const { error, fetches } = await failure({
			url: "https://cnryUser:cnryPass@api.example.test/v1/cnryPath?api_key=cnryToken",
		})
		expectNoSecret(error)
		expect(error?.message).toContain("embedded credentials")
		expect(fetches).toBe(0)
	})

	it("still sends a credential-free URL unchanged", async () => {
		let received: unknown = null
		const status = await withRemoteHttpResponse({
			url: PATH_URL,
			ssrfPolicy: { allowPrivateNetwork: true },
			fetchFn: async (input) => {
				received = input
				return new Response("{}", { status: 200 })
			},
			onResponse: async (response) => response.status,
		})
		expect(status).toBe(200)
		expect(received).toBe(PATH_URL)
	})
})
