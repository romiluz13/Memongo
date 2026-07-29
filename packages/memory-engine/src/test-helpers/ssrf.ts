import { vi } from "vitest"
import type { SsrFPolicy } from "@memongo/lib"

export function mockSsrfPolicy(): SsrFPolicy {
	return { allowPrivateNetwork: true }
}

/**
 * Does nothing, and cannot do anything useful.
 *
 * It reads like it neutralizes the SSRF hostname check, and it does not: the
 * guard resolves the hostname for real via `dnsLookup` bound at import time in
 * @memongo/lib, so nothing called at runtime can intercept it. Tests that
 * relied on this were making live DNS queries for example.com and failed with
 * ENOTFOUND whenever the resolver was unavailable — a network outage
 * presenting as a product regression.
 *
 * To actually avoid DNS, hoist a module mock in the spec file itself:
 *
 *   vi.mock("node:dns/promises", () => ({
 *     lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
 *   }))
 *
 * Kept as a no-op only because call sites still reference it; prefer the mock
 * above and delete the call.
 *
 * @deprecated Hoist a `node:dns/promises` module mock instead.
 */
export function mockPublicPinnedHostname(): void {
	// Intentionally empty — see the doc comment above.
}

export function createMockLookup(addresses: string[] = ["93.184.216.34"]) {
	return vi.fn().mockResolvedValue(
		addresses.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		})),
	)
}
