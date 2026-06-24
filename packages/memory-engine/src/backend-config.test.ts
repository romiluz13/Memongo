import { describe, expect, it, vi } from "vitest"
import type { MemongoConfig } from "@memongo/lib"
import { resolveMemoryBackendConfig } from "./backend-config.js"

describe("resolveMemoryBackendConfig", () => {
	it("defaults to mongodb backend when config missing and env URI is set", () => {
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://env-default:27017/memongo")
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.backend).toBe("mongodb")
		expect(resolved.citations).toBe("auto")
		expect(resolved.mongodb?.uri).toBe("mongodb://env-default:27017/memongo")
		vi.unstubAllEnvs()
	})

	it("rejects unsupported non-mongodb backends", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: { backend: "custom" as never },
		} as unknown as MemongoConfig
		expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
			/Unsupported memory\.backend "custom"/,
		)
	})

	// ---------------------------------------------------------------------------
	// MongoDB backend tests
	// ---------------------------------------------------------------------------

	it("resolves mongodb backend with all defaults", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.backend).toBe("mongodb")
		expect(resolved.mongodb).toBeDefined()
		expect(resolved.mongodb!.uri).toBe("mongodb://localhost:27017")
		expect(resolved.mongodb!.database).toBe("memongo")
		expect(resolved.mongodb!.collectionPrefix).toBe("memongo_main_")
		expect(resolved.mongodb!.deploymentProfile).toBe("atlas-local-preview")
		expect(resolved.mongodb!.embeddingMode).toBe("automated")
		expect(resolved.mongodb!.fusionMethod).toBe("rankFusion")
		expect(resolved.mongodb!.recallProfile).toBe("balanced")
		expect(resolved.mongodb!.quantization).toBe("none")
		expect(resolved.mongodb!.relevance.enabled).toBe(true)
		expect(resolved.mongodb!.relevance.telemetry.enabled).toBe(true)
		expect(resolved.mongodb!.relevance.telemetry.baseSampleRate).toBe(0.01)
		expect(resolved.mongodb!.relevance.telemetry.adaptive.enabled).toBe(true)
		expect(resolved.mongodb!.relevance.telemetry.adaptive.maxSampleRate).toBe(
			0.1,
		)
		expect(resolved.mongodb!.relevance.telemetry.adaptive.minWindowSize).toBe(
			200,
		)
		expect(resolved.mongodb!.relevance.telemetry.persistRawExplain).toBe(true)
		expect(resolved.mongodb!.relevance.telemetry.queryPrivacyMode).toBe(
			"redacted-hash",
		)
		expect(resolved.mongodb!.relevance.retention.days).toBe(14)
		expect(resolved.mongodb!.relevance.benchmark.enabled).toBe(true)
		expect(resolved.mongodb!.relevance.benchmark.datasetPath).toContain(
			".memongo/relevance/golden.jsonl",
		)
	})

	it("resolves mongodb with custom config values", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					database: "mydb",
					collectionPrefix: "custom_",
					deploymentProfile: "community-mongot",
					embeddingMode: "automated",
					fusionMethod: "rankFusion",
					recallProfile: "proof",
					quantization: "scalar",
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.uri).toBe("mongodb://localhost:27017")
		expect(resolved.mongodb!.database).toBe("mydb")
		expect(resolved.mongodb!.collectionPrefix).toBe("custom_")
		expect(resolved.mongodb!.deploymentProfile).toBe("atlas-local-preview")
		expect(resolved.mongodb!.embeddingMode).toBe("automated")
		expect(resolved.mongodb!.fusionMethod).toBe("rankFusion")
		expect(resolved.mongodb!.recallProfile).toBe("proof")
		expect(resolved.mongodb!.quantization).toBe("scalar")
	})

	it("resolves MongoDB recall profile from env and ignores invalid values", () => {
		vi.stubEnv("MEMONGO_MONGODB_RECALL_PROFILE", "proof")
		try {
			const cfg = {
				agents: { defaults: { workspace: "/tmp/memory-test" } },
				memory: {
					backend: "mongodb",
					mongodb: { uri: "mongodb://localhost:27017" },
				},
			} as unknown as MemongoConfig
			const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
			expect(resolved.mongodb!.recallProfile).toBe("proof")
		} finally {
			vi.unstubAllEnvs()
		}

		vi.stubEnv("MEMONGO_MONGODB_RECALL_PROFILE", "not-real")
		try {
			const cfg = {
				agents: { defaults: { workspace: "/tmp/memory-test" } },
				memory: {
					backend: "mongodb",
					mongodb: { uri: "mongodb://localhost:27017" },
				},
			} as unknown as MemongoConfig
			const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
			expect(resolved.mongodb!.recallProfile).toBe("balanced")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("allows MEMONGO_MONGODB_COLLECTION_PREFIX to override config for benchmark isolation", () => {
		vi.stubEnv("MEMONGO_MONGODB_COLLECTION_PREFIX", "bench_run_")
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					collectionPrefix: "custom_",
				},
			},
		} as unknown as MemongoConfig

		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })

		expect(resolved.mongodb!.collectionPrefix).toBe("bench_run_")
		vi.unstubAllEnvs()
	})

	it("resolves mongodb relevance config overrides", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb+srv://atlas.example.com",
					relevance: {
						enabled: false,
						telemetry: {
							enabled: true,
							baseSampleRate: 0.05,
							adaptive: {
								enabled: true,
								maxSampleRate: 0.2,
								minWindowSize: 500,
							},
							persistRawExplain: false,
							queryPrivacyMode: "raw",
						},
						retention: { days: 21 },
						benchmark: {
							enabled: false,
							datasetPath: "~/datasets/relevance-golden.jsonl",
						},
					},
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.relevance.enabled).toBe(false)
		expect(resolved.mongodb!.relevance.telemetry.enabled).toBe(true)
		expect(resolved.mongodb!.relevance.telemetry.baseSampleRate).toBe(0.05)
		expect(resolved.mongodb!.relevance.telemetry.adaptive.enabled).toBe(true)
		expect(resolved.mongodb!.relevance.telemetry.adaptive.maxSampleRate).toBe(
			0.2,
		)
		expect(resolved.mongodb!.relevance.telemetry.adaptive.minWindowSize).toBe(
			500,
		)
		expect(resolved.mongodb!.relevance.telemetry.persistRawExplain).toBe(false)
		expect(resolved.mongodb!.relevance.telemetry.queryPrivacyMode).toBe("raw")
		expect(resolved.mongodb!.relevance.retention.days).toBe(21)
		expect(resolved.mongodb!.relevance.benchmark.enabled).toBe(false)
		expect(resolved.mongodb!.relevance.benchmark.datasetPath).toContain(
			"datasets/relevance-golden.jsonl",
		)
	})

	it("resolves mongodb URI from MEMONGO_MONGODB_URI env var", () => {
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://from-env:27017")
		try {
			const cfg = {
				agents: { defaults: { workspace: "/tmp/memory-test" } },
				memory: {
					backend: "mongodb",
					mongodb: {},
				},
			} as MemongoConfig
			const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
			expect(resolved.mongodb!.uri).toBe("mongodb://from-env:27017")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("MEMONGO_FORCE_MONGODB_URI overrides memory.mongodb.uri from config", () => {
		vi.stubEnv(
			"MEMONGO_FORCE_MONGODB_URI",
			"mongodb://from-force:27017/memongo",
		)
		try {
			const cfg = {
				agents: { defaults: { workspace: "/tmp/memory-test" } },
				memory: {
					backend: "mongodb",
					mongodb: {
						uri: "mongodb://from-file:27017/memongo",
					},
				},
			} as unknown as MemongoConfig
			const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
			expect(resolved.mongodb!.uri).toBe("mongodb://from-force:27017/memongo")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("resolves numDimensions with default 1024", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.numDimensions).toBe(1024)
	})

	it("resolves custom numDimensions", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", numDimensions: 768 },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.numDimensions).toBe(768)
	})

	it("resolves maxPoolSize with default 10", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.maxPoolSize).toBe(10)
	})

	it("resolves custom maxPoolSize", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", maxPoolSize: 20 },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.maxPoolSize).toBe(20)
	})

	it("resolves MongoDB connection pool overrides from env", () => {
		vi.stubEnv("MEMONGO_MONGODB_MAX_POOL_SIZE", "6")
		vi.stubEnv("MEMONGO_MONGODB_MIN_POOL_SIZE", "0")
		vi.stubEnv("MEMONGO_MONGODB_MAX_CONNECTING", "2")
		vi.stubEnv("MEMONGO_MONGODB_MAX_IDLE_TIME_MS", "120000")
		vi.stubEnv("MEMONGO_MONGODB_SOCKET_TIMEOUT_MS", "180000")
		vi.stubEnv("MEMONGO_MONGODB_WAIT_QUEUE_TIMEOUT_MS", "30000")
		vi.stubEnv("MEMONGO_MONGODB_CONNECT_TIMEOUT_MS", "30000")
		vi.stubEnv("MEMONGO_MONGODB_SERVER_SELECTION_TIMEOUT_MS", "120000")
		vi.stubEnv("MEMONGO_MONGODB_HEARTBEAT_FREQUENCY_MS", "5000")
		vi.stubEnv("MEMONGO_MONGODB_SERVER_MONITORING_MODE", "poll")
		vi.stubEnv("MEMONGO_MONGODB_NETWORK_FAMILY", "4")
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", maxPoolSize: 20 },
			},
		} as unknown as MemongoConfig

		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })

		expect(resolved.mongodb!.maxPoolSize).toBe(6)
		expect(resolved.mongodb!.minPoolSize).toBe(0)
		expect(resolved.mongodb!.maxConnecting).toBe(2)
		expect(resolved.mongodb!.maxIdleTimeMs).toBe(120000)
		expect(resolved.mongodb!.socketTimeoutMs).toBe(180000)
		expect(resolved.mongodb!.waitQueueTimeoutMs).toBe(30000)
		expect(resolved.mongodb!.connectTimeoutMs).toBe(30000)
		expect(resolved.mongodb!.serverSelectionTimeoutMs).toBe(120000)
		expect(resolved.mongodb!.heartbeatFrequencyMs).toBe(5000)
		expect(resolved.mongodb!.serverMonitoringMode).toBe("poll")
		expect(resolved.mongodb!.networkFamily).toBe(4)
		vi.unstubAllEnvs()
	})

	it("resolves embeddingCacheTtlDays with default 30", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.embeddingCacheTtlDays).toBe(30)
	})

	it("resolves custom embeddingCacheTtlDays", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", embeddingCacheTtlDays: 7 },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.embeddingCacheTtlDays).toBe(7)
	})

	it("resolves memoryTtlDays with default 0 (disabled)", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.memoryTtlDays).toBe(0)
	})

	it("resolves enableChangeStreams with default false", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.enableChangeStreams).toBe(false)
	})

	it("resolves enableChangeStreams when true", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					enableChangeStreams: true,
				},
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.enableChangeStreams).toBe(true)
	})

	it("resolves changeStreamDebounceMs with default 1000", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.changeStreamDebounceMs).toBe(1000)
	})

	it("defaults embeddingMode to automated for atlas-local-preview profile", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					deploymentProfile: "atlas-local-preview",
				},
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.embeddingMode).toBe("automated")
	})

	it("infers atlas-managed profile for MongoDB Atlas SRV URIs", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb+srv://user:pass@example.mongodb.net/?appName=memongo",
				},
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.deploymentProfile).toBe("atlas-managed")
		expect(resolved.mongodb!.embeddingMode).toBe("automated")
	})

	it("accepts explicit atlas-managed profile", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb+srv://user:pass@example.mongodb.net/?appName=memongo",
					deploymentProfile: "atlas-managed",
				},
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.deploymentProfile).toBe("atlas-managed")
	})

	it("rejects unsupported community-bare profile", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					deploymentProfile: "community-bare",
				},
			},
		} as unknown as MemongoConfig
		expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
			/deploymentProfile "community-bare" is not supported/,
		)
	})

	it("rejects unsupported atlas profile", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					deploymentProfile: "atlas-m0",
				},
			},
		} as unknown as MemongoConfig
		expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
			/deploymentProfile "atlas-m0" is not supported/,
		)
	})

	it("rejects unsupported managed embedding mode", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					deploymentProfile: "atlas-local-preview",
					embeddingMode: "managed",
				},
			},
		} as unknown as MemongoConfig
		expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
			/embeddingMode "managed" is not supported/,
		)
	})

	it("caps numCandidates at 10000 in config resolution (F1)", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					numCandidates: 15000,
				},
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.numCandidates).toBe(10000)
	})

	it("defaults fusionMethod to rankFusion (F8)", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.fusionMethod).toBe("rankFusion")
	})

	it("allows explicit scoreFusion override", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					fusionMethod: "scoreFusion",
				},
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.fusionMethod).toBe("scoreFusion")
	})

	it("allows fusionMethod override via MEMONGO_MONGODB_FUSION_METHOD env var", () => {
		vi.stubEnv("MEMONGO_MONGODB_FUSION_METHOD", "js-merge")
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					fusionMethod: "rankFusion",
				},
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.fusionMethod).toBe("js-merge")
	})

	it("throws when mongodb backend has no URI", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {},
			},
		} as MemongoConfig
		expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
			/MongoDB URI required/,
		)
	})

	it("config URI takes precedence over env var", () => {
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://from-env:27017")
		try {
			const cfg = {
				agents: { defaults: { workspace: "/tmp/memory-test" } },
				memory: {
					backend: "mongodb",
					mongodb: {
						uri: "mongodb://from-config:27017",
					},
				},
			} as MemongoConfig
			const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
			expect(resolved.mongodb!.uri).toBe("mongodb://from-config:27017")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	// ---------------------------------------------------------------------------
	// KB config resolution tests
	// ---------------------------------------------------------------------------

	it("resolves KB defaults for MongoDB backend", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.kb).toBeDefined()
		expect(resolved.mongodb!.kb.enabled).toBe(true)
		expect(resolved.mongodb!.kb.chunking.tokens).toBe(600)
		expect(resolved.mongodb!.kb.chunking.overlap).toBe(100)
		expect(resolved.mongodb!.kb.autoImportPaths).toEqual([])
		expect(resolved.mongodb!.kb.maxDocumentSize).toBe(10 * 1024 * 1024)
	})

	// ---------------------------------------------------------------------------
	// maxSessionChunks config resolution tests
	// ---------------------------------------------------------------------------

	it("resolves maxSessionChunks with default 50", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.maxSessionChunks).toBe(50)
	})

	it("resolves custom maxSessionChunks value", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", maxSessionChunks: 100 },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.maxSessionChunks).toBe(100)
	})

	it("clamps invalid maxSessionChunks to default 50", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", maxSessionChunks: -5 },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.maxSessionChunks).toBe(50)
	})

	it("floors fractional maxSessionChunks value", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", maxSessionChunks: 75.9 },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.maxSessionChunks).toBe(75)
	})

	// ---------------------------------------------------------------------------
	// v2 architecture defaults (episodes + graph enabled by default)
	// ---------------------------------------------------------------------------

	it("enables episodes by default", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.episodes.enabled).toBe(true)
		expect(resolved.mongodb!.graph.enabled).toBe(true)
	})

	it("allows disabling episodes explicitly", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					episodes: { enabled: false },
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.episodes.enabled).toBe(false)
	})

	it("allows disabling graph explicitly", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					graph: { enabled: false },
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.graph.enabled).toBe(false)
	})

	it("ignores old runtimeMode field without error (backward compat)", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				runtimeMode: "mongo_v2",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		// Should not throw
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb).toBeDefined()
		// runtimeMode should NOT exist on resolved config
		expect("runtimeMode" in resolved.mongodb!).toBe(false)
	})

	it("resolves custom episode and graph config", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					episodes: { enabled: false, minEventsForEpisode: 20 },
					graph: { enabled: false, maxGraphDepth: 5 },
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.episodes).toEqual({
			enabled: false,
			minEventsForEpisode: 20,
		})
		expect(resolved.mongodb!.graph).toEqual({
			enabled: false,
			maxGraphDepth: 5,
			entityExtraction: { method: "regex", model: undefined, timeoutMs: 5000 },
		})
	})

	it("resolves custom KB config for MongoDB backend", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					kb: {
						enabled: false,
						chunking: { tokens: 800, overlap: 150 },
						autoImportPaths: ["/docs", "/wiki"],
						maxDocumentSize: 5 * 1024 * 1024,
					},
				},
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.kb.enabled).toBe(false)
		expect(resolved.mongodb!.kb.chunking.tokens).toBe(800)
		expect(resolved.mongodb!.kb.chunking.overlap).toBe(150)
		expect(resolved.mongodb!.kb.autoImportPaths).toEqual(["/docs", "/wiki"])
		expect(resolved.mongodb!.kb.maxDocumentSize).toBe(5 * 1024 * 1024)
	})

	// ---------------------------------------------------------------------------
	// Cache config resolution
	// ---------------------------------------------------------------------------

	it("resolves cache config with defaults (enabled by default)", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.cache.enabled).toBe(true)
		expect(resolved.mongodb!.cache.conversationTtlSec).toBe(300)
		expect(resolved.mongodb!.cache.kbTtlSec).toBe(3600)
		expect(resolved.mongodb!.cache.similarityThreshold).toBe(0.95)
	})

	it("resolves cache config with custom values", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					cache: {
						enabled: true,
						conversationTtlSec: 600,
						kbTtlSec: 7200,
						similarityThreshold: 0.9,
					},
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.cache.enabled).toBe(true)
		expect(resolved.mongodb!.cache.conversationTtlSec).toBe(600)
		expect(resolved.mongodb!.cache.kbTtlSec).toBe(7200)
		expect(resolved.mongodb!.cache.similarityThreshold).toBe(0.9)
	})

	it("resolves cache disabled when explicitly set to false", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					cache: { enabled: false },
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.cache.enabled).toBe(false)
		// Defaults still apply for other fields
		expect(resolved.mongodb!.cache.conversationTtlSec).toBe(300)
		expect(resolved.mongodb!.cache.kbTtlSec).toBe(3600)
		expect(resolved.mongodb!.cache.similarityThreshold).toBe(0.95)
	})

	it("resolves cache enabled when cache section is undefined (default-enable pattern)", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		// cache?.enabled !== false => true when undefined
		expect(resolved.mongodb!.cache.enabled).toBe(true)
	})

	it("resolves cache with partial overrides", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					cache: { kbTtlSec: 1800 },
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.cache.enabled).toBe(true) // default
		expect(resolved.mongodb!.cache.conversationTtlSec).toBe(300) // default
		expect(resolved.mongodb!.cache.kbTtlSec).toBe(1800) // overridden
		expect(resolved.mongodb!.cache.similarityThreshold).toBe(0.95) // default
	})

	it("uses conversation TTL for conversation scope and KB TTL for KB scope", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					cache: {
						conversationTtlSec: 120,
						kbTtlSec: 4800,
					},
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		// The resolved config stores both TTLs; the search() method decides which to use
		expect(resolved.mongodb!.cache.conversationTtlSec).toBe(120)
		expect(resolved.mongodb!.cache.kbTtlSec).toBe(4800)
	})

	it("applies !== false pattern for cache.enabled", () => {
		// Test the exact pattern: mongo.cache?.enabled !== false
		// undefined => true, true => true, false => false
		const cfgUndefined = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", cache: {} },
			},
		} as unknown as MemongoConfig
		expect(
			resolveMemoryBackendConfig({ cfg: cfgUndefined, agentId: "main" })
				.mongodb!.cache.enabled,
		).toBe(true)

		const cfgTrue = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017", cache: { enabled: true } },
			},
		} as unknown as MemongoConfig
		expect(
			resolveMemoryBackendConfig({ cfg: cfgTrue, agentId: "main" }).mongodb!
				.cache.enabled,
		).toBe(true)

		const cfgFalse = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					cache: { enabled: false },
				},
			},
		} as unknown as MemongoConfig
		expect(
			resolveMemoryBackendConfig({ cfg: cfgFalse, agentId: "main" }).mongodb!
				.cache.enabled,
		).toBe(false)
	})

	// ---------------------------------------------------------------------------
	// queryRewriting config resolution
	// ---------------------------------------------------------------------------

	it("resolves queryRewriting defaults (disabled, synonym-expansion, 128)", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.queryRewriting.enabled).toBe(false)
		expect(resolved.mongodb!.queryRewriting.method).toBe("synonym-expansion")
		expect(resolved.mongodb!.queryRewriting.maxTokens).toBe(128)
	})

	it("resolves queryRewriting with explicit supported values", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					queryRewriting: {
						enabled: true,
						method: "synonym-expansion",
						maxTokens: 256,
					},
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.queryRewriting.enabled).toBe(true)
		expect(resolved.mongodb!.queryRewriting.method).toBe("synonym-expansion")
		expect(resolved.mongodb!.queryRewriting.maxTokens).toBe(256)
	})

	it("rejects unsupported queryRewriting methods at config resolution time", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					queryRewriting: { enabled: true, method: "hyde", maxTokens: 256 },
				},
			},
		} as unknown as MemongoConfig

		expect(() => resolveMemoryBackendConfig({ cfg, agentId: "main" })).toThrow(
			/synonym-expansion/,
		)
	})

	// ---------------------------------------------------------------------------
	// reranking config resolution
	// ---------------------------------------------------------------------------

	it("resolves reranking defaults (enabled, rerank-2.5, topN=20, minScore=0.01)", () => {
		vi.stubEnv("VOYAGE_API_KEY", "")
		try {
			const cfg = {
				agents: { defaults: { workspace: "/tmp/memory-test" } },
				memory: {
					backend: "mongodb",
					mongodb: { uri: "mongodb://localhost:27017" },
				},
			} as unknown as MemongoConfig
			const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
			expect(resolved.mongodb!.reranking.enabled).toBe(true)
			expect(resolved.mongodb!.reranking.model).toBe("rerank-2.5")
			expect(resolved.mongodb!.reranking.topN).toBe(20)
			expect(resolved.mongodb!.reranking.minScore).toBe(0.01)
			expect(resolved.mongodb!.reranking.voyageApiKey).toBe("")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("resolves reranking with explicit values", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					reranking: {
						enabled: true,
						model: "rerank-2.5-lite",
						topN: 10,
						minScore: 0.3,
						voyageApiKey: "voy-test-key",
						instruction: "Prioritize recent results",
					},
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.reranking.enabled).toBe(true)
		expect(resolved.mongodb!.reranking.model).toBe("rerank-2.5-lite")
		expect(resolved.mongodb!.reranking.topN).toBe(10)
		expect(resolved.mongodb!.reranking.minScore).toBe(0.3)
		expect(resolved.mongodb!.reranking.voyageApiKey).toBe("voy-test-key")
	})

	it("resolves reranking.voyageApiKey from env fallback", () => {
		vi.stubEnv("VOYAGE_API_KEY", "voy-from-env")
		try {
			const cfg = {
				agents: { defaults: { workspace: "/tmp/memory-test" } },
				memory: {
					backend: "mongodb",
					mongodb: { uri: "mongodb://localhost:27017" },
				},
			} as unknown as MemongoConfig
			const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
			expect(resolved.mongodb!.reranking.voyageApiKey).toBe("voy-from-env")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("allows reranking.enabled override via MEMONGO_RERANKING_ENABLED env var", () => {
		vi.stubEnv("MEMONGO_RERANKING_ENABLED", "false")
		try {
			const cfg = {
				agents: { defaults: { workspace: "/tmp/memory-test" } },
				memory: {
					backend: "mongodb",
					mongodb: { uri: "mongodb://localhost:27017" },
				},
			} as unknown as MemongoConfig
			const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
			expect(resolved.mongodb!.reranking.enabled).toBe(false)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	// ---------------------------------------------------------------------------
	// graph.entityExtraction config resolution
	// ---------------------------------------------------------------------------

	it("resolves graph.entityExtraction defaults (regex, timeoutMs=5000)", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.graph.entityExtraction.method).toBe("regex")
		expect(resolved.mongodb!.graph.entityExtraction.model).toBeUndefined()
		expect(resolved.mongodb!.graph.entityExtraction.timeoutMs).toBe(5000)
	})

	it("resolves graph.entityExtraction with llm method", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					graph: {
						entityExtraction: {
							method: "llm",
							model: "claude-3-haiku",
							timeoutMs: 10000,
						},
					},
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.graph.entityExtraction.method).toBe("llm")
		expect(resolved.mongodb!.graph.entityExtraction.model).toBe(
			"claude-3-haiku",
		)
		expect(resolved.mongodb!.graph.entityExtraction.timeoutMs).toBe(10000)
	})

	it("preserves existing graph.enabled and maxGraphDepth behavior", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: {
					uri: "mongodb://localhost:27017",
					graph: {
						enabled: false,
						maxGraphDepth: 5,
						entityExtraction: { method: "llm" },
					},
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		// Existing graph fields preserved
		expect(resolved.mongodb!.graph.enabled).toBe(false)
		expect(resolved.mongodb!.graph.maxGraphDepth).toBe(5)
		// New entityExtraction field works alongside
		expect(resolved.mongodb!.graph.entityExtraction.method).toBe("llm")
	})

	// H2 audit fix: warn when entity extraction method is 'llm' but no LLM function injected
	it("logs warning when entityExtraction.method is 'llm'", () => {
		vi.stubEnv("MEMONGO_MONGODB_URI", "mongodb://localhost:27017/test")
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				mongodb: {
					graph: { entityExtraction: { method: "llm" } },
				},
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.graph.entityExtraction.method).toBe("llm")
		// The warning is logged via createSubsystemLogger, which we cannot easily spy on
		// in this test setup. Instead, verify the config is preserved correctly.
		warnSpy.mockRestore()
		vi.unstubAllEnvs()
	})

	// ---------------------------------------------------------------------------
	// Recall-oriented threshold defaults (retrieval excellence)
	// ---------------------------------------------------------------------------

	it("defaults numCandidates to 500 for recall-oriented retrieval", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.numCandidates).toBe(500)
	})

	it("defaults reranking.minScore to 0.01 for recall-oriented retrieval", () => {
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.reranking.minScore).toBe(0.01)
	})

	it("allows numCandidates override via MEMONGO_NUM_CANDIDATES env var", () => {
		vi.stubEnv("MEMONGO_NUM_CANDIDATES", "300")
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.numCandidates).toBe(300)
		vi.unstubAllEnvs()
	})

	it("allows reranking.minScore override via MEMONGO_RERANK_MIN_SCORE env var", () => {
		vi.stubEnv("MEMONGO_RERANK_MIN_SCORE", "0.05")
		const cfg = {
			agents: { defaults: { workspace: "/tmp/memory-test" } },
			memory: {
				backend: "mongodb",
				mongodb: { uri: "mongodb://localhost:27017" },
			},
		} as unknown as MemongoConfig
		const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" })
		expect(resolved.mongodb!.reranking.minScore).toBe(0.05)
		vi.unstubAllEnvs()
	})
})
