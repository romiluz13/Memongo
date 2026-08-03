import { describe, expect, it } from "vitest"
import {
	applyCapabilityProbeResult,
	CAPABILITY_GATES,
	evaluateCapabilityGates,
	getCapabilityGate,
	isCapabilityEnabled,
	recordCapabilityProbe,
	resetCapabilityProbes,
	serverVersionAtLeast,
} from "./mongodb-capability-registry.js"

describe("capability registry", () => {
	it("every gated feature declares a gate, a re-enable condition, and a tracked TODO", () => {
		expect(CAPABILITY_GATES.length).toBeGreaterThan(0)
		for (const gate of CAPABILITY_GATES) {
			expect(gate.id, gate.id).toBeTruthy()
			expect(gate.description, gate.id).toBeTruthy()
			// Blocked on a server version or on an external fix — one of the two
			// must be recorded, or the gate is untracked debt.
			expect(
				gate.minServerVersion !== undefined || gate.blockedOn !== undefined,
				gate.id,
			).toBe(true)
			expect(gate.todo, gate.id).toMatch(/fix-plan-2026-08-03/)
			expect(typeof gate.shouldEnable, gate.id).toBe("function")
		}
	})

	it("seeds the known gated features", () => {
		const ids = CAPABILITY_GATES.map((gate) => gate.id)
		expect(ids).toContain("vector-stored-source")
		expect(ids).toContain("autoembed-quantization")
		expect(ids).toContain("rerank-stage")
		expect(ids).toContain("lexical-prefilters")
		expect(ids).toContain("flat-indexes")
	})
})

describe("serverVersionAtLeast", () => {
	it("compares major/minor and an optional patch", () => {
		expect(serverVersionAtLeast([8, 3, 7, 0], 8, 3, 7)).toBe(true)
		expect(serverVersionAtLeast([8, 3, 6, 0], 8, 3, 7)).toBe(false)
		expect(serverVersionAtLeast([8, 4, 0, 0], 8, 3, 7)).toBe(true)
		expect(serverVersionAtLeast([9, 0, 0, 0], 8, 3, 7)).toBe(true)
		expect(serverVersionAtLeast([7, 9, 9, 0], 8, 3, 7)).toBe(false)
		expect(serverVersionAtLeast([8, 1, 0, 0], 8, 1)).toBe(true)
		expect(serverVersionAtLeast([8, 0, 13, 0], 8, 1)).toBe(false)
	})

	it("returns false for missing or malformed version arrays", () => {
		expect(serverVersionAtLeast(undefined, 8, 1)).toBe(false)
		expect(serverVersionAtLeast([8], 8, 1)).toBe(false)
		expect(serverVersionAtLeast(["x", "y"], 8, 1)).toBe(false)
	})
})

describe("vector-stored-source gate", () => {
	it("enables on MongoDB 8.3.7+ when the env var is unset", () => {
		expect(
			isCapabilityEnabled("vector-stored-source", {
				versionArray: [8, 3, 7, 0],
				env: {},
			}),
		).toBe(true)
	})

	it("stays off below 8.3.7 when the env var is unset", () => {
		expect(
			isCapabilityEnabled("vector-stored-source", {
				versionArray: [8, 3, 6, 0],
				env: {},
			}),
		).toBe(false)
		expect(
			isCapabilityEnabled("vector-stored-source", {
				versionArray: [8, 0, 13, 0],
				env: {},
			}),
		).toBe(false)
	})

	it("env=0 is a kill-switch even when the version gate passes", () => {
		expect(
			isCapabilityEnabled("vector-stored-source", {
				versionArray: [8, 3, 7, 0],
				env: { MEMONGO_VECTOR_STORED_SOURCE: "0" },
			}),
		).toBe(false)
	})

	it("env=1 forces on when the version gate passes", () => {
		expect(
			isCapabilityEnabled("vector-stored-source", {
				versionArray: [8, 3, 7, 0],
				env: { MEMONGO_VECTOR_STORED_SOURCE: "1" },
			}),
		).toBe(true)
	})

	it("env=1 forces on even when the server version is unknown", () => {
		// Explicit opt-in keeps the pre-gate behavior for live-server probes
		// and for deployments where buildInfo is unavailable.
		expect(
			isCapabilityEnabled("vector-stored-source", {
				versionArray: undefined,
				env: { MEMONGO_VECTOR_STORED_SOURCE: "1" },
			}),
		).toBe(true)
	})
})

describe("probe-adopt capabilities", () => {
	it("a recorded rejection overrides an optimistic gate until reset", () => {
		resetCapabilityProbes()
		// Quantization-on-autoEmbed has no static gate; it is adopted by probe.
		expect(
			isCapabilityEnabled("autoembed-quantization", {
				versionArray: [8, 3, 7, 0],
				env: {},
			}),
		).toBe(true)

		recordCapabilityProbe("autoembed-quantization", false)
		expect(
			isCapabilityEnabled("autoembed-quantization", {
				versionArray: [8, 3, 7, 0],
				env: {},
			}),
		).toBe(false)

		resetCapabilityProbes()
		expect(
			isCapabilityEnabled("autoembed-quantization", {
				versionArray: [8, 3, 7, 0],
				env: {},
			}),
		).toBe(true)
	})

	it("rejects probes for unregistered capabilities", () => {
		resetCapabilityProbes()
		expect(isCapabilityEnabled("no-such-capability", {})).toBe(false)
		expect(getCapabilityGate("no-such-capability")).toBeUndefined()
	})

	it("applyCapabilityProbeResult folds a recorded rejection into an evaluated gate set", () => {
		resetCapabilityProbes()
		const gates = {
			"autoembed-quantization": true,
			"vector-stored-source": true,
		}

		recordCapabilityProbe("autoembed-quantization", false)
		// The manager's detectCapabilities ran BEFORE ensureSearchIndexes
		// recorded the probe rejection; this is how the probe outcome is
		// surfaced onto the already-evaluated capabilities object.
		expect(applyCapabilityProbeResult(gates, "autoembed-quantization")).toEqual(
			{
				"autoembed-quantization": false,
				"vector-stored-source": true,
			},
		)

		resetCapabilityProbes()
		expect(applyCapabilityProbeResult(gates, "autoembed-quantization")).toEqual(
			gates,
		)
	})
})

describe("evaluateCapabilityGates", () => {
	it("evaluates every registered gate for detectCapabilities", () => {
		resetCapabilityProbes()
		const evaluation = evaluateCapabilityGates({
			versionArray: [8, 3, 7, 0],
			env: {},
		})
		expect(Object.keys(evaluation).sort()).toEqual(
			CAPABILITY_GATES.map((gate) => gate.id).sort(),
		)
		// Preview-stage features never self-enable yet.
		expect(evaluation["rerank-stage"]).toBe(false)
		expect(evaluation["lexical-prefilters"]).toBe(false)
		expect(evaluation["vector-stored-source"]).toBe(true)
	})
})
