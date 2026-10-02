import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	CANDIDATE_SUFFIX,
	STATE_VERSION,
	SURFACES,
	decideRetention,
	digestMultiset,
	digestsEqual,
	loadState,
	ownsNamespace,
	parseArgs,
	planInstallAction,
	resolveConfig,
	saveState,
	serverSupported,
	sha256Hex,
	validateStateForConfig,
	type NamespaceInfo,
	type StateFile,
	type SurfaceState,
} from "./migrate-diagnostics-to-ordinary.js"

describe("parseArgs", () => {
	it("defaults to a read-only dry run", () => {
		expect(parseArgs([])).toEqual({
			mode: "dry-run",
			acceptRetentionChange: false,
			statePath: "migrate-diagnostics-state.json",
			maxTimeMs: undefined,
		})
	})

	it("selects apply or abort mode", () => {
		expect(parseArgs(["--apply"]).mode).toBe("apply")
		expect(parseArgs(["--abort"]).mode).toBe("abort")
	})

	it("rejects --apply combined with --abort in either order", () => {
		expect(() => parseArgs(["--apply", "--abort"])).toThrow(
			"use either --apply or --abort",
		)
		expect(() => parseArgs(["--abort", "--apply"])).toThrow(
			"use either --apply or --abort",
		)
	})

	it("accepts --accept-retention-change but not together with --abort", () => {
		expect(parseArgs(["--accept-retention-change"]).acceptRetentionChange).toBe(
			true,
		)
		expect(() => parseArgs(["--abort", "--accept-retention-change"])).toThrow(
			"--accept-retention-change cannot be combined with --abort",
		)
	})

	it("requires a value for --state and --max-time-ms", () => {
		expect(() => parseArgs(["--state"])).toThrow("--state requires a path")
		expect(() => parseArgs(["--state", ""])).toThrow("--state requires a path")
		expect(() => parseArgs(["--max-time-ms"])).toThrow(
			"--max-time-ms requires a value",
		)
	})

	it("validates --max-time-ms as a positive integer within the TTL range", () => {
		expect(parseArgs(["--max-time-ms", "5000"]).maxTimeMs).toBe(5000)
		expect(() => parseArgs(["--max-time-ms", "abc"])).toThrow()
		expect(() => parseArgs(["--max-time-ms", "0"])).toThrow()
		expect(() => parseArgs(["--max-time-ms", "-5"])).toThrow()
		expect(() => parseArgs(["--max-time-ms", "2147483648"])).toThrow()
	})

	it("rejects numeric prefixes instead of silently truncating them", () => {
		for (const value of ["1000ms", "1.5", "1e2", " 1000", "1000 "]) {
			expect(() => parseArgs(["--max-time-ms", value])).toThrow(
				"--max-time-ms must be a positive integer",
			)
		}
	})

	it("sets the state path", () => {
		expect(parseArgs(["--state", "/tmp/custom-state.json"]).statePath).toBe(
			"/tmp/custom-state.json",
		)
	})

	it("rejects unknown arguments", () => {
		expect(() => parseArgs(["--nonsense"])).toThrow(
			"unknown argument: --nonsense",
		)
	})

	it("treats the removed custom-retention flags as unknown arguments", () => {
		// Contract: no runtime retention seam exists (ordinary startup enforces
		// an exact canonical TTL match), so custom values were removed.
		expect(() => parseArgs(["--retention-telemetry", "3600"])).toThrow(
			"unknown argument: --retention-telemetry",
		)
		expect(() => parseArgs(["--retention-access", "3600"])).toThrow(
			"unknown argument: --retention-access",
		)
	})
})

describe("resolveConfig", () => {
	it("requires a MongoDB URI", () => {
		expect(() => resolveConfig({})).toThrow("MEMONGO_MONGODB_URI is required")
		expect(() => resolveConfig({ MEMONGO_MONGODB_URI: "   " })).toThrow(
			"MEMONGO_MONGODB_URI is required",
		)
	})

	it("applies the documented defaults", () => {
		expect(
			resolveConfig({ MEMONGO_MONGODB_URI: "mongodb://localhost:27017" }),
		).toEqual({
			uri: "mongodb://localhost:27017",
			database: "memongo",
			prefix: "memongo_",
		})
	})

	it("honors explicit database and prefix values", () => {
		expect(
			resolveConfig({
				MEMONGO_MONGODB_URI: "mongodb://localhost:27017",
				MEMONGO_MONGODB_DATABASE: "other",
				MEMONGO_MONGODB_COLLECTION_PREFIX: "p_",
			}),
		).toEqual({
			uri: "mongodb://localhost:27017",
			database: "other",
			prefix: "p_",
		})
	})
})

describe("validateStateForConfig", () => {
	const config = { database: "memongo", prefix: "memongo_" }
	const validState = (): StateFile => ({
		version: STATE_VERSION,
		database: config.database,
		prefix: config.prefix,
		server: { version: "9.0.0", fcv: "9.0" },
		surfaces: {
			telemetry: {
				surface: "telemetry",
				canonicalName: "memongo_memory_telemetry",
				candidateName: `memongo_memory_telemetry${CANDIDATE_SUFFIX}`,
				phase: "copied",
				skipReason: null,
				source: { uuid: "source-uuid", retentionSeconds: 604_800 },
				plan: { retentionSeconds: 604_800, documentCount: 3 },
				digest: { entries: [["digest", 3]], documentCount: 3 },
				candidate: { uuid: "candidate-uuid", documentCount: 3 },
				installed: null,
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		},
	})

	it("accepts identifiers and names derived from the configured prefix", () => {
		expect(() => validateStateForConfig(validState(), config)).not.toThrow()
	})

	it("rejects an unknown surface key", () => {
		const state = validState()
		const telemetry = state.surfaces.telemetry
		state.surfaces = {
			rogue: telemetry,
		} as unknown as StateFile["surfaces"]
		expect(() => validateStateForConfig(state, config)).toThrow(
			"unexpected surface identifier rogue",
		)
	})

	it("rejects a mismatched persisted surface identifier", () => {
		const state = validState()
		if (!state.surfaces.telemetry) throw new Error("missing test surface")
		state.surfaces.telemetry.surface = "access-events"
		expect(() => validateStateForConfig(state, config)).toThrow(
			"mismatched identifier access-events",
		)
	})

	it("rejects canonical and candidate namespace redirection", () => {
		for (const field of ["canonicalName", "candidateName"] as const) {
			const state = validState()
			const surface = state.surfaces.telemetry
			if (!surface) throw new Error("missing test surface")
			surface[field] = "operator_data"
			expect(() => validateStateForConfig(state, config)).toThrow(
				"namespace mismatch",
			)
		}
	})

	it("rejects malformed persisted retention and count values", () => {
		const mutations = [
			(state: StateFile) => {
				const surface = state.surfaces.telemetry
				if (surface?.source) surface.source.retentionSeconds = 1.5
			},
			(state: StateFile) => {
				const surface = state.surfaces.telemetry
				if (surface?.plan) surface.plan.retentionSeconds = 604_800.5
			},
			(state: StateFile) => {
				const surface = state.surfaces.telemetry
				if (surface?.plan) surface.plan.documentCount = -1
			},
			(state: StateFile) => {
				const surface = state.surfaces.telemetry
				if (surface?.candidate) surface.candidate.documentCount = 2.5
			},
			(state: StateFile) => {
				const surface = state.surfaces.telemetry
				if (surface?.digest) surface.digest.documentCount = 2.5
			},
			(state: StateFile) => {
				const surface = state.surfaces.telemetry
				if (surface?.digest) surface.digest.entries = [["digest", 0]]
			},
		]
		for (const mutate of mutations) {
			const state = validState()
			mutate(state)
			expect(() => validateStateForConfig(state, config)).toThrow()
		}
	})

	it("rejects malformed ownership identities", () => {
		const state = validState()
		const surface = state.surfaces.telemetry
		if (!surface?.candidate) throw new Error("missing test candidate")
		surface.candidate.uuid = ""
		expect(() => validateStateForConfig(state, config)).toThrow(
			"candidate identity is malformed",
		)
	})

	it("rejects an unknown persisted phase value", () => {
		const state = validState()
		const surface = state.surfaces.telemetry
		if (!surface) throw new Error("missing test surface")
		surface.phase = "completed" as SurfaceState["phase"]
		expect(() => validateStateForConfig(state, config)).toThrow(
			"unknown phase completed",
		)
	})

	it("accepts each supported phase whose recorded fields match its invariants", () => {
		const accepted: Array<(surface: SurfaceState) => void> = [
			() => {},
			(surface) => {
				surface.candidate = null
			},
			(surface) => {
				surface.phase = "verified"
			},
			(surface) => {
				surface.phase = "installed"
				surface.installed = { uuid: "installed-uuid" }
			},
			(surface) => {
				surface.phase = "complete"
				surface.installed = { uuid: "installed-uuid" }
			},
			(surface) => {
				surface.phase = "skipped"
				surface.skipReason =
					"source collection absent; the fresh initializer will create the ordinary collection"
				surface.digest = null
				surface.candidate = null
				surface.installed = null
			},
			(surface) => {
				surface.phase = "validated"
				surface.digest = null
				surface.candidate = null
				surface.installed = null
			},
			(surface) => {
				surface.phase = "copying"
				surface.candidate = null
				surface.installed = null
			},
		]
		for (const mutate of accepted) {
			const state = validState()
			const surface = state.surfaces.telemetry
			if (!surface) throw new Error("missing test surface")
			mutate(surface)
			expect(() => validateStateForConfig(state, config)).not.toThrow()
		}
	})

	it("rejects persisted phase and identity contradictions", () => {
		const violations: Array<{
			description: string
			expected: string
			mutate: (surface: SurfaceState) => void
		}> = [
			{
				description: "validated records candidate identity",
				expected: "phase validated must not record",
				mutate: (surface) => {
					surface.phase = "validated"
					surface.digest = null
					surface.installed = null
				},
			},
			{
				description: "copying lacks the pinned digest",
				expected: "phase copying requires digest, source, and plan",
				mutate: (surface) => {
					surface.phase = "copying"
					surface.digest = null
					surface.installed = null
				},
			},
			{
				description: "copying records candidate identity",
				expected: "phase copying requires digest, source, and plan",
				mutate: (surface) => {
					surface.phase = "copying"
					surface.installed = null
				},
			},
			{
				description: "verified lacks candidate identity",
				expected: "phase verified requires digest, source, plan, and candidate",
				mutate: (surface) => {
					surface.phase = "verified"
					surface.candidate = null
					surface.installed = null
				},
			},
			{
				description: "verified records installed identity",
				expected:
					"phase verified requires digest, source, plan, and candidate identity and must not record installed identity",
				mutate: (surface) => {
					surface.phase = "verified"
					surface.installed = { uuid: "installed-uuid" }
				},
			},
			{
				description: "installed lacks installed identity",
				expected:
					"phase installed requires digest, source, plan, and installed",
				mutate: (surface) => {
					surface.phase = "installed"
				},
			},
			{
				description: "complete lacks installed identity",
				expected: "phase complete requires digest, source, plan, and installed",
				mutate: (surface) => {
					surface.phase = "complete"
				},
			},
			{
				description: "skipped lacks a skip reason",
				expected: "phase skipped requires a non-empty skip reason",
				mutate: (surface) => {
					surface.phase = "skipped"
					surface.digest = null
					surface.candidate = null
					surface.installed = null
				},
			},
			{
				description: "skipped records digest identity",
				expected: "phase skipped requires a non-empty skip reason",
				mutate: (surface) => {
					surface.phase = "skipped"
					surface.skipReason = "operator skipped"
					surface.candidate = null
					surface.installed = null
				},
			},
		]
		for (const { description, expected, mutate } of violations) {
			const state = validState()
			const surface = state.surfaces.telemetry
			if (!surface) throw new Error("missing test surface")
			mutate(surface)
			expect(() => validateStateForConfig(state, config), description).toThrow(
				expected,
			)
		}
	})
})

describe("digest multiset", () => {
	it("hashes raw buffers with SHA-256", () => {
		expect(sha256Hex(Buffer.from("hello"))).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		)
	})

	it("counts duplicate rows instead of collapsing them", () => {
		const digest = digestMultiset([
			Buffer.from("a"),
			Buffer.from("a"),
			Buffer.from("b"),
		])
		expect(digest.documentCount).toBe(3)
		expect(digest.entries).toHaveLength(2)
		expect(
			digest.entries.find(([hash]) => hash === sha256Hex(Buffer.from("a"))),
		).toEqual([sha256Hex(Buffer.from("a")), 2])
	})

	it("sorts entries by hash for stable comparisons", () => {
		const hashA = sha256Hex(Buffer.from("a"))
		const hashB = sha256Hex(Buffer.from("b"))
		const digest = digestMultiset([Buffer.from("b"), Buffer.from("a")])
		expect(digest.entries.map(([hash]) => hash)).toEqual([hashA, hashB].sort())
	})

	it("compares multisets exactly", () => {
		const a = digestMultiset([
			Buffer.from("x"),
			Buffer.from("x"),
			Buffer.from("y"),
		])
		const same = digestMultiset([
			Buffer.from("y"),
			Buffer.from("x"),
			Buffer.from("x"),
		])
		expect(digestsEqual(a, same)).toBe(true)
		expect(digestsEqual(digestMultiset([]), digestMultiset([]))).toBe(true)
	})

	it("detects count, hash, and size mismatches", () => {
		const a = digestMultiset([Buffer.from("x"), Buffer.from("x")])
		expect(digestsEqual(a, digestMultiset([Buffer.from("x")]))).toBe(false)
		expect(
			digestsEqual(a, digestMultiset([Buffer.from("x"), Buffer.from("y")])),
		).toBe(false)
		expect(digestsEqual(a, digestMultiset([]))).toBe(false)
	})
})

describe("decideRetention", () => {
	it("preserves a matching source retention", () => {
		const decision = decideRetention({
			discovered: 604_800,
			canonical: 604_800,
			acceptChange: false,
		})
		expect(decision).toEqual({
			action: "install",
			retentionSeconds: 604_800,
			note: "source retention 604800s preserved",
		})
	})

	it("adopts the canonical retention only with --accept-retention-change", () => {
		const decision = decideRetention({
			discovered: 86_400,
			canonical: 604_800,
			acceptChange: true,
		})
		expect(decision.action).toBe("install")
		if (decision.action !== "install") return
		expect(decision.retentionSeconds).toBe(604_800)
		expect(decision.note).toContain("--accept-retention-change")
		expect(decision.note).toContain("86400s")
	})

	it("describes an absent source TTL as off/absent", () => {
		const decision = decideRetention({
			discovered: null,
			canonical: 2_592_000,
			acceptChange: true,
		})
		expect(decision.action).toBe("install")
		if (decision.action !== "install") return
		expect(decision.note).toContain("off/absent")
	})

	it("aborts a differing retention without the acknowledgment flag", () => {
		const decision = decideRetention({
			discovered: 86_400,
			canonical: 2_592_000,
			acceptChange: false,
		})
		expect(decision.action).toBe("abort")
		if (decision.action !== "abort") return
		expect(decision.reason).toContain("--accept-retention-change")
		expect(decision.reason).toContain("2592000")
		expect(decision.reason).toContain("exact TTL match")
		// Contract guard: no custom --retention-* escape hatch is offered.
		expect(decision.reason).not.toMatch(/--retention-/)
	})
})

describe("serverSupported", () => {
	it("accepts the validated 9.x floor and newer-major gate policy", () => {
		expect(serverSupported({ version: "9.0.0", fcv: "9.0" })).toBe(true)
		expect(serverSupported({ version: "9.2.1", fcv: "9.0" })).toBe(true)
		// This proves admission policy only, not compatibility certification
		// for an untested future server.
		expect(serverSupported({ version: "10.0.0", fcv: "10.0" })).toBe(true)
	})

	it("rejects pre-9 servers and FCV below the required floor", () => {
		expect(serverSupported({ version: "8.0.4", fcv: "8.0" })).toBe(false)
		expect(serverSupported({ version: "9.0.4", fcv: "8.0" })).toBe(false)
		expect(serverSupported({ version: "10.0.0", fcv: "8.0" })).toBe(false)
		expect(serverSupported({ version: "", fcv: "" })).toBe(false)
	})
})

describe("ownsNamespace", () => {
	const observed: NamespaceInfo = {
		name: "memongo_memory_telemetry",
		type: "timeseries",
		uuid: "uuid-a",
		retentionSeconds: 604_800,
	}

	it("matches a recorded UUID exactly", () => {
		expect(ownsNamespace("uuid-a", observed)).toBe(true)
	})

	it("refuses mismatches and missing identities", () => {
		expect(ownsNamespace("uuid-b", observed)).toBe(false)
		expect(ownsNamespace(null, observed)).toBe(false)
		expect(ownsNamespace("uuid-a", null)).toBe(false)
		expect(ownsNamespace("uuid-a", { ...observed, uuid: null })).toBe(false)
	})
})

describe("planInstallAction", () => {
	const ns = (type: string, uuid: string): NamespaceInfo => ({
		name: `ns-${uuid}`,
		type,
		uuid,
		retentionSeconds: null,
	})
	const ts = ns("timeseries", "uuid-source")
	const ordinary = ns("collection", "uuid-installed")

	it("renames an owned candidate when the source is gone", () => {
		expect(
			planInstallAction({
				canonicalObserved: null,
				candidateObserved: ns("collection", "uuid-candidate"),
				sourceUuid: "uuid-source",
				candidateUuid: "uuid-candidate",
				installedUuid: null,
			}),
		).toBe("rename")
	})

	it("aborts when nothing owned remains", () => {
		expect(
			planInstallAction({
				canonicalObserved: null,
				candidateObserved: null,
				sourceUuid: "uuid-source",
				candidateUuid: "uuid-candidate",
				installedUuid: null,
			}),
		).toBe("abort-missing")
	})

	it("never erases a foreign candidate", () => {
		expect(
			planInstallAction({
				canonicalObserved: null,
				candidateObserved: ns("collection", "uuid-foreign"),
				sourceUuid: "uuid-source",
				candidateUuid: "uuid-candidate",
				installedUuid: null,
			}),
		).toBe("abort-foreign-candidate")
	})

	it("restarts from copy when the owned source survives but the candidate is gone", () => {
		expect(
			planInstallAction({
				canonicalObserved: ts,
				candidateObserved: null,
				sourceUuid: "uuid-source",
				candidateUuid: "uuid-candidate",
				installedUuid: null,
			}),
		).toBe("restart-from-copy")
	})

	it("renames when both the source and the owned candidate are present", () => {
		expect(
			planInstallAction({
				canonicalObserved: ts,
				candidateObserved: ns("collection", "uuid-candidate"),
				sourceUuid: "uuid-source",
				candidateUuid: "uuid-candidate",
				installedUuid: null,
			}),
		).toBe("rename")
	})

	it("aborts on a foreign time-series canonical regardless of the candidate", () => {
		expect(
			planInstallAction({
				canonicalObserved: ns("timeseries", "uuid-foreign"),
				candidateObserved: ns("collection", "uuid-candidate"),
				sourceUuid: "uuid-source",
				candidateUuid: "uuid-candidate",
				installedUuid: null,
			}),
		).toBe("abort-foreign-canonical")
	})

	it("recognizes an installed canonical by the recorded UUIDs", () => {
		expect(
			planInstallAction({
				canonicalObserved: ordinary,
				candidateObserved: null,
				sourceUuid: "uuid-source",
				candidateUuid: "uuid-candidate",
				installedUuid: "uuid-installed",
			}),
		).toBe("already-installed")
		// Uncertain renameCollection response: the canonical carries the
		// verified candidate UUID, so the rename did happen.
		expect(
			planInstallAction({
				canonicalObserved: ordinary,
				candidateObserved: null,
				sourceUuid: "uuid-source",
				candidateUuid: "uuid-installed",
				installedUuid: null,
			}),
		).toBe("already-installed")
	})

	it("aborts on a foreign ordinary canonical", () => {
		expect(
			planInstallAction({
				canonicalObserved: ns("collection", "uuid-foreign"),
				candidateObserved: null,
				sourceUuid: "uuid-source",
				candidateUuid: "uuid-candidate",
				installedUuid: null,
			}),
		).toBe("abort-foreign-canonical")
	})
})

describe("surface specs", () => {
	it("mirrors the engine's hardcoded canonical TTLs", () => {
		expect(
			SURFACES.find((spec) => spec.surface === "telemetry")
				?.canonicalRetentionSeconds,
		).toBe(604_800)
		expect(
			SURFACES.find((spec) => spec.surface === "access-events")
				?.canonicalRetentionSeconds,
		).toBe(2_592_000)
	})

	it("targets the engine's diagnostic collection names", () => {
		expect(SURFACES.map((spec) => spec.suffix)).toEqual([
			"memory_telemetry",
			"access_events",
		])
	})

	it("appends the fixed candidate suffix to the canonical name", () => {
		expect(CANDIDATE_SUFFIX).toBe("__ordinary_candidate")
		expect(`memongo_memory_telemetry${CANDIDATE_SUFFIX}`).toBe(
			"memongo_memory_telemetry__ordinary_candidate",
		)
	})
})

describe("state file round-trip", () => {
	let dir: string

	const state: StateFile = {
		version: STATE_VERSION,
		database: "memongo",
		prefix: "memongo_",
		server: { version: "9.0.0", fcv: "9.0" },
		surfaces: {
			telemetry: {
				surface: "telemetry",
				canonicalName: "memongo_memory_telemetry",
				candidateName: `memongo_memory_telemetry${CANDIDATE_SUFFIX}`,
				phase: "verified",
				skipReason: "source retention 604800s preserved",
				source: { uuid: "uuid-source", retentionSeconds: 604_800 },
				plan: { retentionSeconds: 604_800, documentCount: 4 },
				digest: {
					entries: [
						["hash-a", 2],
						["hash-b", 2],
					],
					documentCount: 4,
				},
				candidate: { uuid: "uuid-candidate", documentCount: 4 },
				installed: null,
				updatedAt: "2026-09-08T00:00:00.000Z",
			},
		},
	}

	beforeAll(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "migrate-diagnostics-test-"))
	})

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("saves and reloads the state unchanged", async () => {
		const file = path.join(dir, "state.json")
		await saveState(file, state)
		expect(await loadState(file)).toEqual(state)
	})

	it("returns null when no state file exists", async () => {
		expect(await loadState(path.join(dir, "absent.json"))).toBeNull()
	})

	it("keeps the previous complete journal when atomic replacement fails", async () => {
		const file = path.join(dir, "atomic-failure.json")
		await saveState(file, state)
		const changed: StateFile = { ...state, database: "must-not-replace" }
		await expect(
			saveState(file, changed, async () => {
				throw new Error("simulated rename interruption")
			}),
		).rejects.toThrow("simulated rename interruption")
		expect(await loadState(file)).toEqual(state)
		expect(
			(await readdir(dir)).filter((name) =>
				name.startsWith(".atomic-failure.json."),
			),
		).toEqual([])
	})

	it("keeps the old journal visible until the replacement rename completes", async () => {
		const file = path.join(dir, "atomic-boundary.json")
		await saveState(file, state)
		const changed: StateFile = { ...state, database: "replacement" }
		let releaseRename: (() => void) | undefined
		let signalRenameStarted: (() => void) | undefined
		const renameStarted = new Promise<void>((resolve) => {
			signalRenameStarted = resolve
		})
		const renameReleased = new Promise<void>((resolve) => {
			releaseRename = resolve
		})
		const replacement = saveState(file, changed, async (oldPath, newPath) => {
			signalRenameStarted?.()
			await renameReleased
			await rename(oldPath, newPath)
		})
		await renameStarted
		expect(await loadState(file)).toEqual(state)
		releaseRename?.()
		await replacement
		expect(await loadState(file)).toEqual(changed)
	})

	it("refuses a state file with an unexpected version", async () => {
		const file = path.join(dir, "wrong-version.json")
		await writeFile(file, JSON.stringify({ ...state, version: 99 }), "utf8")
		await expect(loadState(file)).rejects.toThrow("expected 1")
	})
})
