import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	isMemongoBootError,
	MemongoBootError,
	memongoBridgeGetManager,
} from "./memongo-bridge.js"

// X-04: the real engine acquisition path (no engine mock) fails at config
// resolution before any connection, and the bridge must keep that failure's
// type instead of flattening it into a bare Error.
describe("memongoBridgeGetManager keeps the boot failure type (X-04)", () => {
	beforeEach(() => {
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://127.0.0.1:1/boot")
		vi.stubEnv("MEMONGO_AGENT_ID", "bridge-boot-failure")
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("rethrows a removed-setting failure as MemongoBootError with its code and setting", async () => {
		vi.stubEnv("MEMONGO_STRICT_SEARCH_INDEX_READY", "1")
		const err = await memongoBridgeGetManager().catch((error: unknown) => error)
		expect(err).toBeInstanceOf(MemongoBootError)
		expect(isMemongoBootError(err)).toBe(true)
		expect(err).toMatchObject({
			code: "config-removed",
			setting: "MEMONGO_STRICT_SEARCH_INDEX_READY",
		})
	})

	it("rethrows an invalid fusion method as a typed config failure naming the setting", async () => {
		vi.stubEnv("MEMONGO_MONGODB_FUSION_METHOD", "js-merge")
		const err = await memongoBridgeGetManager().catch((error: unknown) => error)
		expect(err).toMatchObject({
			name: "MemongoBootError",
			code: "config-invalid",
			setting: "MEMONGO_MONGODB_FUSION_METHOD",
		})
	})
})
