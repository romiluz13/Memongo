/**
 * Task 2.SE-4 export determinism tests (ADR-006 scope expansion).
 *
 * **fast-check seed recorded in the capability-audit evidence doc:**
 *   `docs/benchmarks/capability-audit/export-evidence.md` (seed = 20260512).
 */

import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	canonicalizeExportBundle,
	signExportBundle,
	verifyExportBundle,
	type ExportBundle,
} from "./memongo-export.js"

const FAST_CHECK_SEED = 20260512

const SAMPLE_BUNDLE: ExportBundle = {
	agentId: "agent-1",
	scope: "agent",
	scopeRef: "agent:agent-1",
	exportedAt: "2026-05-12T10:00:00.000Z",
	events: [
		{ eventId: "evt-1", body: "hello", timestamp: "2026-04-01T00:00:00.000Z" },
		{ eventId: "evt-2", body: "world", timestamp: "2026-04-02T00:00:00.000Z" },
	],
	episodes: [],
	kb: [],
}

describe("canonicalizeExportBundle (Task 2.SE-4)", () => {
	it("produces byte-identical output for semantically equal bundles", () => {
		const a = canonicalizeExportBundle({ ...SAMPLE_BUNDLE })
		const b = canonicalizeExportBundle({
			// Different key insertion order — canonicalization must normalize.
			kb: [],
			episodes: [],
			events: [
				{ timestamp: "2026-04-01T00:00:00.000Z", body: "hello", eventId: "evt-1" },
				{ timestamp: "2026-04-02T00:00:00.000Z", body: "world", eventId: "evt-2" },
			],
			exportedAt: "2026-05-12T10:00:00.000Z",
			scopeRef: "agent:agent-1",
			scope: "agent",
			agentId: "agent-1",
		})
		expect(a).toBe(b)
	})

	it("changes output if any value differs", () => {
		const a = canonicalizeExportBundle(SAMPLE_BUNDLE)
		const b = canonicalizeExportBundle({
			...SAMPLE_BUNDLE,
			events: [
				{ eventId: "evt-1", body: "HELLO", timestamp: "2026-04-01T00:00:00.000Z" },
				{ eventId: "evt-2", body: "world", timestamp: "2026-04-02T00:00:00.000Z" },
			],
		})
		expect(a).not.toBe(b)
	})
})

describe("signExportBundle + verifyExportBundle (Task 2.SE-4)", () => {
	it("HMAC-SHA256 signature is deterministic for the same input + key", () => {
		const sigA = signExportBundle(SAMPLE_BUNDLE, "test-signing-key")
		const sigB = signExportBundle(SAMPLE_BUNDLE, "test-signing-key")
		expect(sigA).toBe(sigB)
		// 64 hex chars = 32 bytes = HMAC-SHA256 output
		expect(sigA).toMatch(/^[0-9a-f]{64}$/)
	})

	it("signature changes when bundle changes", () => {
		const sigA = signExportBundle(SAMPLE_BUNDLE, "k")
		const sigB = signExportBundle(
			{ ...SAMPLE_BUNDLE, agentId: "agent-other" },
			"k",
		)
		expect(sigA).not.toBe(sigB)
	})

	it("signature changes when key changes", () => {
		const sigA = signExportBundle(SAMPLE_BUNDLE, "key-one")
		const sigB = signExportBundle(SAMPLE_BUNDLE, "key-two")
		expect(sigA).not.toBe(sigB)
	})

	it("verifyExportBundle accepts a valid signature", () => {
		const sig = signExportBundle(SAMPLE_BUNDLE, "k")
		expect(verifyExportBundle(SAMPLE_BUNDLE, sig, "k")).toBe(true)
	})

	it("verifyExportBundle rejects a tampered bundle", () => {
		const sig = signExportBundle(SAMPLE_BUNDLE, "k")
		expect(
			verifyExportBundle(
				{ ...SAMPLE_BUNDLE, agentId: "agent-mutated" },
				sig,
				"k",
			),
		).toBe(false)
	})

	it("verifyExportBundle rejects a wrong key", () => {
		const sig = signExportBundle(SAMPLE_BUNDLE, "k-correct")
		expect(verifyExportBundle(SAMPLE_BUNDLE, sig, "k-wrong")).toBe(false)
	})

	it("throws on empty signing key — strict mode, no silent fallback", () => {
		expect(() => signExportBundle(SAMPLE_BUNDLE, "")).toThrow(
			/signing key/i,
		)
	})
})

describe("export determinism invariant (Task 2.SE-4 — property test)", () => {
	it("Property 14 (ADR-006): signed bundle is byte-identical across two exports with no intervening writes", () => {
		fc.assert(
			fc.property(
				fc.record({
					agentId: fc.string({ minLength: 1, maxLength: 24 }),
					scope: fc.constantFrom("agent", "session", "project", "org"),
					scopeRef: fc.string({ minLength: 1, maxLength: 32 }),
					exportedAt: fc.constant("2026-05-12T10:00:00.000Z"),
					events: fc.array(
						fc.record({
							eventId: fc.string({ minLength: 1, maxLength: 16 }),
							body: fc.string({ minLength: 0, maxLength: 64 }),
							timestamp: fc.constant("2026-04-01T00:00:00.000Z"),
						}),
						{ minLength: 0, maxLength: 10 },
					),
					episodes: fc.constant([]),
					kb: fc.constant([]),
				}),
				fc.string({ minLength: 1, maxLength: 32 }),
				(bundle, key) => {
					// Same input → same canonical JSON → same signature, every time.
					const sigA = signExportBundle(bundle as ExportBundle, key)
					const sigB = signExportBundle(bundle as ExportBundle, key)
					expect(sigA).toBe(sigB)
					// And verification round-trips.
					expect(
						verifyExportBundle(bundle as ExportBundle, sigA, key),
					).toBe(true)
				},
			),
			{ seed: FAST_CHECK_SEED, numRuns: 200 },
		)
	})
})
