import { describe, expect, it, vi } from "vitest"
import {
	applyCapabilityProbeResult,
	CAPABILITY_GATES,
	type CapabilityGateContext,
	evaluateCapabilityGates,
	getCapabilityGate,
	isCapabilityEnabled,
	logDisabledCapabilityGates,
	mongodbDeploymentIdentity,
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

describe("deployment-scoped probe results (B10)", () => {
	// Two fake deployments derived from URIs the way the manager derives them.
	const DEP_A = mongodbDeploymentIdentity(
		"mongodb://deploy-a.example.net:27017",
		"memongo_a",
	)
	const DEP_B = mongodbDeploymentIdentity(
		"mongodb+srv://cluster-b.example.net/memongo_b",
	)

	it("two deployments hold opposite support verdicts concurrently", () => {
		resetCapabilityProbes()
		try {
			// Deployment A accepted quantization on its autoEmbed definitions;
			// deployment B rejected it. Both verdicts must coexist in one process.
			recordCapabilityProbe("autoembed-quantization", true, DEP_A)
			recordCapabilityProbe("autoembed-quantization", false, DEP_B)

			expect(
				isCapabilityEnabled("autoembed-quantization", {
					versionArray: [8, 3, 7, 0],
					env: {},
					deployment: DEP_A,
				}),
			).toBe(true)
			expect(
				isCapabilityEnabled("autoembed-quantization", {
					versionArray: [8, 3, 7, 0],
					env: {},
					deployment: DEP_B,
				}),
			).toBe(false)

			// Probing B again must not overwrite A's verdict.
			recordCapabilityProbe("autoembed-quantization", false, DEP_B)
			expect(
				isCapabilityEnabled("autoembed-quantization", {
					versionArray: [8, 3, 7, 0],
					env: {},
					deployment: DEP_A,
				}),
			).toBe(true)

			// A scoped rejection does not leak into the unscoped default bucket
			// that legacy callers (no deployment in context) share.
			expect(
				isCapabilityEnabled("autoembed-quantization", {
					versionArray: [8, 3, 7, 0],
					env: {},
				}),
			).toBe(true)
		} finally {
			resetCapabilityProbes()
		}
	})

	it("evaluateCapabilityGates and applyCapabilityProbeResult respect the deployment key", () => {
		resetCapabilityProbes()
		try {
			recordCapabilityProbe("autoembed-quantization", false, DEP_B)

			const forA = evaluateCapabilityGates({
				versionArray: [8, 3, 7, 0],
				env: {},
				deployment: DEP_A,
			})
			const forB = evaluateCapabilityGates({
				versionArray: [8, 3, 7, 0],
				env: {},
				deployment: DEP_B,
			})
			expect(forA["autoembed-quantization"]).toBe(true)
			expect(forB["autoembed-quantization"]).toBe(false)

			const gates = { "autoembed-quantization": true }
			expect(
				applyCapabilityProbeResult(gates, "autoembed-quantization", DEP_B),
			).toEqual({ "autoembed-quantization": false })
			expect(
				applyCapabilityProbeResult(gates, "autoembed-quantization", DEP_A),
			).toEqual(gates)
		} finally {
			resetCapabilityProbes()
		}
	})

	it("a scoped reset clears only its own deployment's state", () => {
		resetCapabilityProbes()
		try {
			recordCapabilityProbe("autoembed-quantization", false, DEP_A)
			recordCapabilityProbe("autoembed-quantization", false, DEP_B)

			resetCapabilityProbes(DEP_A)
			expect(
				isCapabilityEnabled("autoembed-quantization", {
					versionArray: [8, 3, 7, 0],
					env: {},
					deployment: DEP_A,
				}),
			).toBe(true)
			expect(
				isCapabilityEnabled("autoembed-quantization", {
					versionArray: [8, 3, 7, 0],
					env: {},
					deployment: DEP_B,
				}),
			).toBe(false)
		} finally {
			resetCapabilityProbes()
		}
	})

	it("an unscoped reset still clears every deployment", () => {
		resetCapabilityProbes()
		recordCapabilityProbe("autoembed-quantization", false, DEP_A)
		recordCapabilityProbe("autoembed-quantization", false, DEP_B)
		resetCapabilityProbes()
		for (const deployment of [DEP_A, DEP_B]) {
			expect(
				isCapabilityEnabled("autoembed-quantization", {
					versionArray: [8, 3, 7, 0],
					env: {},
					deployment,
				}),
			).toBe(true)
		}
	})
})

describe("mongodbDeploymentIdentity", () => {
	it("never includes credentials from the connection URI", () => {
		const identity = mongodbDeploymentIdentity(
			"mongodb://memongo-user:s3cret-password@host1.example.net:27017/memdb",
		)
		expect(identity).not.toContain("memongo-user")
		expect(identity).not.toContain("s3cret-password")
		expect(identity).not.toContain("@")
		expect(identity).toContain("host1.example.net:27017")
		expect(identity).toContain("memdb")
	})

	it("strips credentials from mongodb+srv and multi-host URIs", () => {
		const srv = mongodbDeploymentIdentity(
			"mongodb+srv://memongo-user:s3cret-password@cluster0.example.net/memdb",
		)
		expect(srv).not.toContain("memongo-user")
		expect(srv).not.toContain("s3cret-password")
		expect(srv).toContain("cluster0.example.net")
		expect(srv).toContain("memdb")

		// Multi-host standard URIs are not valid WHATWG URLs; the fallback
		// parser must still drop the userinfo segment.
		const multi = mongodbDeploymentIdentity(
			"mongodb://memongo-user:s3cret-password@h1.example.net:27017,h2.example.net:27018/memdb?replicaSet=rs0",
		)
		expect(multi).not.toContain("memongo-user")
		expect(multi).not.toContain("s3cret-password")
		expect(multi).not.toContain("@")
		expect(multi).toContain("h1.example.net:27017")
		expect(multi).toContain("h2.example.net:27018")
		expect(multi).toContain("memdb")
	})

	it("distinguishes deployments by host and database, not by credentials", () => {
		const one = mongodbDeploymentIdentity(
			"mongodb://user-a:pass-a@host1.example.net:27017/memdb",
		)
		const two = mongodbDeploymentIdentity(
			"mongodb://user-b:pass-b@host1.example.net:27017/memdb",
		)
		// Same server + database with different logins is one deployment: a
		// capability verdict is a property of the server, not the credential.
		expect(one).toBe(two)

		const otherDb = mongodbDeploymentIdentity(
			"mongodb://user-a:pass-a@host1.example.net:27017/otherdb",
		)
		expect(otherDb).not.toBe(one)

		const otherHost = mongodbDeploymentIdentity(
			"mongodb://user-a:pass-a@host2.example.net:27017/memdb",
		)
		expect(otherHost).not.toBe(one)
	})

	it("prefers the explicit database argument over the URI path", () => {
		const identity = mongodbDeploymentIdentity(
			"mongodb://host1.example.net:27017/uri_db",
			"config_db",
		)
		expect(identity).toContain("config_db")
		expect(identity).not.toContain("uri_db")
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

describe("flat-indexes gate alignment with index creation", () => {
	// vectorIndexingMethodFromEnv() (mongodb-schema-search-definitions.ts)
	// normalizes the opt-in with trim().toLowerCase(), so "FLAT" still
	// builds flat indexes. The gate must reach the same verdict, or the
	// manager reports the capability disabled while the shipped index is
	// actually flat.
	it("enables for any case variant of the opt-in on 8.3.7+", () => {
		for (const value of ["flat", "FLAT", "Flat", " flat "]) {
			expect(
				isCapabilityEnabled("flat-indexes", {
					versionArray: [8, 3, 7, 0],
					env: { MEMONGO_VECTOR_INDEXING_METHOD: value },
				}),
				`MEMONGO_VECTOR_INDEXING_METHOD="${value}"`,
			).toBe(true)
		}
	})

	it("stays off for hnsw and unrecognized opt-in values on 8.3.7+", () => {
		for (const value of ["hnsw", "HNSW", "nope", ""]) {
			expect(
				isCapabilityEnabled("flat-indexes", {
					versionArray: [8, 3, 7, 0],
					env: { MEMONGO_VECTOR_INDEXING_METHOD: value },
				}),
				`MEMONGO_VECTOR_INDEXING_METHOD="${value}"`,
			).toBe(false)
		}
	})

	it("stays off below 8.3.7 even with the flat opt-in", () => {
		expect(
			isCapabilityEnabled("flat-indexes", {
				versionArray: [8, 3, 6, 0],
				env: { MEMONGO_VECTOR_INDEXING_METHOD: "flat" },
			}),
		).toBe(false)
	})
})

describe("logDisabledCapabilityGates reports the actual blocking condition", () => {
	function disabledLineFor(id: string, context: CapabilityGateContext): string {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			logDisabledCapabilityGates(context)
			return (
				logSpy.mock.calls
					.map((args) => args.join(" "))
					.find((line) => line.includes(`capability ${id} disabled`)) ?? ""
			)
		} finally {
			logSpy.mockRestore()
		}
	}

	it("env kill-switch is reported as the reason, not a version requirement", () => {
		const line = disabledLineFor("vector-stored-source", {
			versionArray: [8, 3, 7, 0],
			env: { MEMONGO_VECTOR_STORED_SOURCE: "0" },
		})
		expect(line).toContain("capability vector-stored-source disabled")
		expect(line).toContain("MEMONGO_VECTOR_STORED_SOURCE=0")
		expect(line).not.toContain("requires MongoDB")
	})

	it("missing flat opt-in on a new-enough server reports the opt-in, not a version requirement", () => {
		const line = disabledLineFor("flat-indexes", {
			versionArray: [8, 3, 7, 0],
			env: {},
		})
		expect(line).toContain("capability flat-indexes disabled")
		expect(line).toContain("MEMONGO_VECTOR_INDEXING_METHOD=flat")
		expect(line).not.toContain("requires MongoDB")
	})

	it("flat opt-in on an old server reports the version requirement", () => {
		const line = disabledLineFor("flat-indexes", {
			versionArray: [8, 0, 13, 0],
			env: { MEMONGO_VECTOR_INDEXING_METHOD: "flat" },
		})
		expect(line).toContain("capability flat-indexes disabled")
		expect(line).toContain("requires MongoDB >= 8.3.7")
	})

	it("a recorded probe rejection is reported as the probe, not the static blocker", () => {
		resetCapabilityProbes()
		try {
			recordCapabilityProbe("autoembed-quantization", false)
			const line = disabledLineFor("autoembed-quantization", {
				versionArray: [8, 3, 7, 0],
				env: {},
			})
			expect(line).toContain("capability autoembed-quantization disabled")
			expect(line).toMatch(/probe|rejected/i)
			expect(line).not.toContain("blocked on")
		} finally {
			resetCapabilityProbes()
		}
	})

	it("hard-disabled preview gates report not implemented, not an Atlas blocker", () => {
		const context: CapabilityGateContext = {
			versionArray: [8, 3, 7, 0],
			env: {},
		}
		const rerank = disabledLineFor("rerank-stage", context)
		expect(rerank).toContain("capability rerank-stage disabled")
		expect(rerank).toContain("not implemented")
		expect(rerank).not.toContain("blocked on")
		const lexical = disabledLineFor("lexical-prefilters", context)
		expect(lexical).toContain("capability lexical-prefilters disabled")
		expect(lexical).toContain("not implemented")
		expect(lexical).not.toContain("blocked on")
	})

	it("operator lines carry no TODO, fix-plan, or GA wording", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			logDisabledCapabilityGates({ versionArray: [8, 0, 13, 0], env: {} })
			const lines = logSpy.mock.calls.map((args) => args.join(" "))
			expect(lines.length).toBeGreaterThan(0)
			for (const line of lines) {
				expect(line, line).not.toMatch(/fix-plan|P3\.|TODO|\bGA\b/)
			}
		} finally {
			logSpy.mockRestore()
		}
	})

	it("missing or malformed server version is distinct from known below-minimum", () => {
		for (const versionArray of [undefined, [8], ["a", "b"]]) {
			const line = disabledLineFor("vector-stored-source", {
				versionArray,
				env: {},
			})
			expect(line).toContain("capability vector-stored-source disabled")
			expect(line).toContain("server version unknown or unavailable")
			expect(line).not.toContain("(server is")
		}
		const known = disabledLineFor("vector-stored-source", {
			versionArray: [8, 0, 13, 0],
			env: {},
		})
		expect(known).toContain("(server is 8.0.13)")
		expect(known).not.toContain("unknown or unavailable")
	})

	it("enabled gates produce no disabled line", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		try {
			logDisabledCapabilityGates({
				versionArray: [8, 3, 7, 0],
				env: {},
				deployment: "enabled-check",
			})
			const lines = logSpy.mock.calls.map((args) => args.join(" "))
			expect(
				lines.some((line) =>
					line.includes("capability vector-stored-source disabled"),
				),
			).toBe(false)
		} finally {
			logSpy.mockRestore()
		}
	})

	it("a deployment's probe rejection does not leak into another deployment", () => {
		resetCapabilityProbes()
		try {
			recordCapabilityProbe("autoembed-quantization", false, "host-a/db")
			const rejected = disabledLineFor("autoembed-quantization", {
				versionArray: [8, 3, 7, 0],
				env: {},
				deployment: "host-a/db",
			})
			expect(rejected).toContain("recorded probe")

			// host-b never observed the rejection: the capability stays
			// enabled there, so no disabled line exists at all.
			const other = disabledLineFor("autoembed-quantization", {
				versionArray: [8, 3, 7, 0],
				env: {},
				deployment: "host-b/db",
			})
			expect(other).toBe("")
		} finally {
			resetCapabilityProbes()
		}
	})

	it("a probe rejection overrides the version gate and the env force", () => {
		resetCapabilityProbes()
		try {
			recordCapabilityProbe("vector-stored-source", false, "host-a/db")
			const line = disabledLineFor("vector-stored-source", {
				versionArray: [8, 3, 7, 0],
				env: { MEMONGO_VECTOR_STORED_SOURCE: "1" },
				deployment: "host-a/db",
			})
			expect(line).toContain("capability vector-stored-source disabled")
			expect(line).toContain("recorded probe")
			expect(line).not.toContain("MEMONGO_VECTOR_STORED_SOURCE")
			expect(line).not.toContain("requires MongoDB")
		} finally {
			resetCapabilityProbes()
		}
	})
})
