/* eslint-disable @typescript-eslint/unbound-method -- Vitest mock method assertions */
import type { Db, Collection, Document } from "mongodb"
import { describe, it, expect, vi } from "vitest"
import {
	detectCapabilities,
	ensureCollections,
	ensureSearchIndexes,
	ensureStandardIndexes,
	isSearchIndexReadyWithFilterFields,
	isEventsVectorBitemporalPrefilterReady,
	waitForSearchCapabilities,
	queryCacheCollection,
	telemetryCollection,
	accessEventsCollection,
	sessionChunksCollection,
	memoryEvidenceCollection,
	waitForSearchIndexesQueryable,
} from "./mongodb-schema.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockCollection(name: string, indexes: Document[] = []): Collection {
	return {
		collectionName: name,
		createIndex: vi.fn(async () => name),
		listIndexes: vi.fn(() => ({ toArray: async () => indexes })),
		createSearchIndex: vi.fn(async () => name),
		updateSearchIndex: vi.fn(async () => undefined),
		dropIndex: vi.fn(async () => ({ ok: 1 })),
		listSearchIndexes: vi.fn(() => ({ toArray: async () => [] })),
		aggregate: vi.fn(() => ({ toArray: async () => [] })),
	} as unknown as Collection
}

function mockDb(
	existingCollections: Array<
		string | { name: string; type: "collection" | "timeseries" }
	> = [],
	versionArray?: unknown,
	indexesByCollection: Record<string, Document[]> = {},
): Db {
	const collections = new Map<string, Collection>()
	const collectionTypes = new Map(
		existingCollections.map((entry) =>
			typeof entry === "string"
				? [entry, "collection" as const]
				: [entry.name, entry.type],
		),
	)

	const db = {
		collection: vi.fn((name: string) => {
			if (!collections.has(name)) {
				collections.set(
					name,
					mockCollection(name, indexesByCollection[name] ?? []),
				)
			}
			return collections.get(name)!
		}),
		command: vi.fn(async () => ({ ok: 1 })),
		...(versionArray !== undefined
			? {
					admin: vi.fn(() => ({
						command: vi.fn(async () => ({ versionArray })),
					})),
				}
			: {}),
		createCollection: vi.fn(async (name: string) => {
			collectionTypes.set(name, "collection")
			collections.set(
				name,
				mockCollection(name, indexesByCollection[name] ?? []),
			)
			return collections.get(name)!
		}),
		listCollections: vi.fn((filter?: { name?: string }) => ({
			map: vi.fn(() => ({
				toArray: async () =>
					[...collectionTypes.keys()].filter(
						(name) => !filter?.name || name === filter.name,
					),
			})),
			toArray: async () =>
				[...collectionTypes.entries()]
					.filter(([name]) => !filter?.name || name === filter.name)
					.map(([name, type]) => ({ name, type })),
		})),
	} as unknown as Db

	return db
}

describe("wiki source categorization fields", () => {
	it("KB_SCHEMA includes optional wikiSource field", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_knowledge_base",
		)
		expect(kbCall).toBeDefined()
		const schema = kbCall?.[1]?.validator.$jsonSchema
		expect(schema.properties.wikiSource).toBeDefined()
		expect(schema.properties.wikiSource.bsonType).toBe("string")
		// Must NOT be in required
		expect(schema.required).not.toContain("wikiSource")
	})

	it("KB_SCHEMA includes optional vault and section fields", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_knowledge_base",
		)
		expect(kbCall).toBeDefined()
		const schema = kbCall?.[1]?.validator.$jsonSchema
		expect(schema.properties.vault).toBeDefined()
		expect(schema.properties.vault.bsonType).toBe("string")
		expect(schema.properties.section).toBeDefined()
		expect(schema.properties.section.bsonType).toBe("string")
		expect(schema.required).not.toContain("vault")
		expect(schema.required).not.toContain("section")
	})

	it("KB_CHUNKS_SCHEMA includes optional wikiSource field", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbChunksCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_kb_chunks",
		)
		expect(kbChunksCall).toBeDefined()
		const schema = kbChunksCall?.[1]?.validator.$jsonSchema
		expect(schema.properties.wikiSource).toBeDefined()
		expect(schema.properties.wikiSource.bsonType).toBe("string")
		expect(schema.required).not.toContain("wikiSource")
	})

	it("KB_CHUNKS_SCHEMA includes optional vault and section fields", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const kbChunksCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_kb_chunks",
		)
		expect(kbChunksCall).toBeDefined()
		const schema = kbChunksCall?.[1]?.validator.$jsonSchema
		expect(schema.properties.vault).toBeDefined()
		expect(schema.properties.vault.bsonType).toBe("string")
		expect(schema.properties.section).toBeDefined()
		expect(schema.properties.section.bsonType).toBe("string")
		expect(schema.required).not.toContain("vault")
		expect(schema.required).not.toContain("section")
	})
})

describe("EPISODES_SCHEMA enum completeness", () => {
	it("EPISODES_SCHEMA enum includes all 5 EpisodeType values", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const episodesCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_episodes",
		)
		expect(episodesCall).toBeDefined()
		const schema = episodesCall?.[1]?.validator.$jsonSchema
		const typeEnum = schema.properties.type.enum
		// EpisodeType = "daily" | "weekly" | "thread" | "topic" | "decision"
		expect(typeEnum).toContain("daily")
		expect(typeEnum).toContain("weekly")
		expect(typeEnum).toContain("thread")
		expect(typeEnum).toContain("topic")
		expect(typeEnum).toContain("decision")
		expect(typeEnum).toHaveLength(5)
	})
})

describe("detectCapabilities", () => {
	it("does not claim scoreFusion support on MongoDB 8.2", async () => {
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 2, 0, 0] })),
			})),
			collection: vi.fn(() => ({
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => [
						{
							name: "test_chunks_text",
							type: "search",
							status: "READY",
							queryable: true,
						},
						{
							name: "test_chunks_vector",
							type: "vectorSearch",
							status: "READY",
							queryable: true,
						},
					]),
				})),
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db, "test_chunks")
		expect(caps.rankFusion).toBe(true)
		expect(caps.scoreFusion).toBe(false)
		expect(caps.vectorSearch).toBe(true)
		expect(caps.textSearch).toBe(true)
	})

	it("detects scoreFusion support from MongoDB 8.3", async () => {
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 3, 0, 0] })),
			})),
			collection: vi.fn(() => ({
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => [
						{
							name: "test_chunks_text",
							type: "search",
							status: "READY",
							queryable: true,
						},
						{
							name: "test_chunks_vector",
							type: "vectorSearch",
							status: "READY",
							queryable: true,
						},
					]),
				})),
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db, "test_chunks")
		expect(caps.rankFusion).toBe(true)
		expect(caps.scoreFusion).toBe(true)
		expect(caps.vectorSearch).toBe(true)
		expect(caps.textSearch).toBe(true)
	})

	it("detects no capabilities when everything fails", async () => {
		const db = {
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("unrecognized pipeline stage")
					}),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("not supported")
					}),
				})),
			})),
			listCollections: vi.fn(() => ({
				toArray: async () => [],
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db)
		expect(caps.vectorSearch).toBe(false)
		expect(caps.textSearch).toBe(false)
		expect(caps.scoreFusion).toBe(false)
		expect(caps.rankFusion).toBe(false)
	})

	it("detects rankFusion when stage is recognized but fails on empty data", async () => {
		const db = {
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => {
						// Recognized but fails with a runtime error (not "unrecognized")
						throw new Error("Cannot run $rankFusion on empty pipelines")
					}),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("not supported")
					}),
				})),
			})),
			listCollections: vi.fn(() => ({
				toArray: async () => [],
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db)
		// Stage recognized (error isn't "unrecognized") → capability = true
		expect(caps.rankFusion).toBe(true)
		expect(caps.scoreFusion).toBe(true)
	})

	it("does not claim search readiness when index listing succeeds but is empty", async () => {
		const db = {
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("unrecognized pipeline stage")
					}),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
			listCollections: vi.fn(() => ({
				toArray: async () => [{ name: "test_chunks" }],
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db)
		expect(caps.vectorSearch).toBe(false)
		expect(caps.textSearch).toBe(false)
		// automatedEmbedding removed (F2: dead code)
	})

	it("reports only named queryable search indexes as ready", async () => {
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 3, 0, 0] })),
			})),
			collection: vi.fn(() => ({
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => [
						{
							name: "test_chunks_text",
							type: "search",
							status: "READY",
							queryable: true,
						},
						{
							name: "test_chunks_vector",
							type: "vectorSearch",
							status: "PENDING",
							queryable: false,
						},
					]),
				})),
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db, "test_chunks")
		expect(caps.textSearch).toBe(true)
		expect(caps.vectorSearch).toBe(false)
	})

	it("detects search capabilities through $listSearchIndexes aggregation", async () => {
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 2, 0, 0] })),
			})),
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => [
						{
							name: "test_chunks_text",
							type: "search",
							status: "READY",
							queryable: true,
						},
						{
							name: "test_chunks_vector",
							type: "vectorSearch",
							status: "READY",
							queryable: true,
						},
					]),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => {
						throw new Error("driver helper should not be required")
					}),
				})),
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db, "test_chunks")
		expect(caps.vectorSearch).toBe(true)
		expect(caps.textSearch).toBe(true)
	})

	it("reports storedSource capability from the probe vector index definition", async () => {
		// The scar at detectCapabilities is explicit: storedSource must be set
		// from what the serving index was BUILT with, never from buildInfo —
		// returnStoredSource: true against an index that stores nothing errors.
		// Since P3.3 the probe result is additionally gated by the registry
		// (MongoDB 8.3.7+ or MEMONGO_VECTOR_STORED_SOURCE=1).
		const dbWith = (
			definition: Document | undefined,
			storedSourceProbeError?: Error,
		) =>
			({
				admin: vi.fn(() => ({
					command: vi.fn(async () => ({ versionArray: [8, 3, 7, 0] })),
				})),
				collection: vi.fn(() => ({
					listSearchIndexes: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								name: "test_chunks_vector",
								type: "vectorSearch",
								status: "READY",
								queryable: true,
								latestDefinition: definition,
							},
						]),
					})),
					aggregate: vi.fn((pipeline: Document[]) => ({
						toArray: vi.fn(async () => {
							if (pipeline[0]?.$listSearchIndexes) {
								return [
									{
										name: "test_chunks_vector",
										type: "vectorSearch",
										status: "READY",
										queryable: true,
										latestDefinition: definition,
									},
								]
							}
							if (storedSourceProbeError) {
								throw storedSourceProbeError
							}
							return []
						}),
					})),
				})),
			}) as unknown as Db

		const withStored = await detectCapabilities(
			dbWith({
				fields: [
					{
						type: "autoEmbed",
						path: "text",
						model: "voyage-4-large",
					},
				],
				storedSource: { include: ["text"] },
			}),
			"test_chunks",
		)
		expect(withStored.storedSource).toBe(true)

		const withoutStored = await detectCapabilities(
			dbWith({ fields: [] }),
			"test_chunks",
		)
		expect(withoutStored.storedSource).toBe(false)

		// Server default `storedSource: false` in latestDefinition must not
		// count as stored-source-enabled.
		const withFalse = await detectCapabilities(
			dbWith({ fields: [], storedSource: false }),
			"test_chunks",
		)
		expect(withFalse.storedSource).toBe(false)

		const rejectedAtQueryTime = await detectCapabilities(
			dbWith(
				{
					fields: [
						{
							type: "autoEmbed",
							path: "text",
							model: "voyage-4-large",
						},
					],
					storedSource: { include: ["text"] },
				},
				new Error("storedSource is not configured for this index"),
			),
			"test_chunks",
		)
		expect(rejectedAtQueryTime.storedSource).toBe(false)
	})

	it("keeps storedSource off when the registry gate is closed, whatever the probe index carries (P3.3)", async () => {
		const dbWith = (versionArray: number[]) =>
			({
				admin: vi.fn(() => ({
					command: vi.fn(async () => ({ versionArray })),
				})),
				collection: vi.fn(() => ({
					listSearchIndexes: vi.fn(() => ({
						toArray: vi.fn(async () => [
							{
								name: "test_chunks_vector",
								type: "vectorSearch",
								status: "READY",
								queryable: true,
								latestDefinition: {
									fields: [],
									storedSource: { include: ["text"] },
								},
							},
						]),
					})),
				})),
			}) as unknown as Db

		// Server below 8.3.7, env unset → gate closed.
		const tooOld = await detectCapabilities(dbWith([8, 3, 0, 0]), "test_chunks")
		expect(tooOld.storedSource).toBe(false)

		// Kill-switch: env=0 forces off even on 8.3.7 with a stored-source index.
		const previous = process.env.MEMONGO_VECTOR_STORED_SOURCE
		process.env.MEMONGO_VECTOR_STORED_SOURCE = "0"
		try {
			const killed = await detectCapabilities(
				dbWith([8, 3, 7, 0]),
				"test_chunks",
			)
			expect(killed.storedSource).toBe(false)
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_VECTOR_STORED_SOURCE
			} else {
				process.env.MEMONGO_VECTOR_STORED_SOURCE = previous
			}
		}
	})

	it("evaluates the capability re-enable registry against buildInfo", async () => {
		// P3.6: every gated feature self-evaluates inside detectCapabilities so
		// a server upgrade flips it on without a code change.
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 3, 7, 0] })),
			})),
			collection: vi.fn(() => ({
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db, "test_chunks")
		expect(caps.capabilityGates).toBeDefined()
		expect(caps.capabilityGates?.["vector-stored-source"]).toBe(true)
		expect(caps.capabilityGates?.["autoembed-quantization"]).toBe(true)
		expect(caps.capabilityGates?.["rerank-stage"]).toBe(false)
		expect(caps.capabilityGates?.["lexical-prefilters"]).toBe(false)
	})

	it("keeps the storedSource gate closed below MongoDB 8.3.7", async () => {
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 0, 13, 0] })),
			})),
			collection: vi.fn(() => ({
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => []),
				})),
			})),
		} as unknown as Db

		const caps = await detectCapabilities(db, "test_chunks")
		expect(caps.capabilityGates?.["vector-stored-source"]).toBe(false)
	})

	it("waits for search capabilities to become available", async () => {
		let attempts = 0
		const db = {
			admin: vi.fn(() => ({
				command: vi.fn(async () => ({ versionArray: [8, 2, 0, 0] })),
			})),
			collection: vi.fn(() => ({
				aggregate: vi.fn(() => ({
					toArray: vi.fn(async () => {
						attempts += 1
						if (attempts < 2) {
							throw new Error("mongot warming up")
						}
						return [
							{
								name: "test_chunks_text",
								type: "search",
								status: "READY",
								queryable: true,
							},
							{
								name: "test_chunks_vector",
								type: "vectorSearch",
								status: "READY",
								queryable: true,
							},
						]
					}),
				})),
				listSearchIndexes: vi.fn(() => ({
					toArray: vi.fn(async () => {
						if (attempts < 2) {
							throw new Error("mongot still warming up")
						}
						return []
					}),
				})),
			})),
		} as unknown as Db

		// timeoutMs is the give-up budget, not the expected runtime: the mock
		// succeeds on attempt 2, so this returns in ~1ms. It was 30ms, which the
		// suite blew whenever the machine was loaded — a flaky failure that says
		// nothing about the retry behavior under test.
		const caps = await waitForSearchCapabilities(db, "test_chunks", {
			timeoutMs: 10_000,
			pollMs: 1,
		})
		expect(caps.vectorSearch).toBe(true)
		expect(caps.textSearch).toBe(true)
		expect(attempts).toBe(2)
	})
})

describe("waitForSearchIndexesQueryable", () => {
	it("retries transient search index management errors", async () => {
		let attempts = 0
		const collection = {
			aggregate: vi.fn(() => ({
				toArray: vi.fn(async () => {
					attempts += 1
					if (attempts === 1) {
						throw new Error(
							"Error connecting to Search Index Management service",
						)
					}
					return [
						{
							name: "events_text",
							status: "READY",
							queryable: true,
						},
					]
				}),
			})),
			listSearchIndexes: vi.fn(() => ({
				toArray: vi.fn(async () => []),
			})),
		} as unknown as Collection

		const result = await waitForSearchIndexesQueryable(collection, {
			indexNames: ["events_text"],
			// Same reasoning as the waitForSearchCapabilities retry test above:
			// the give-up budget must not double as the expected runtime.
			timeoutMs: 10_000,
			pollMs: 1,
		})

		expect(result.ready).toBe(true)
		expect(result.lastError).toBeUndefined()
		expect(attempts).toBe(2)
	})
})

describe("isSearchIndexReadyWithFilterFields", () => {
	it("accepts only a queryable ready index whose latest definition contains every filter field", () => {
		expect(
			isSearchIndexReadyWithFilterFields(
				{
					name: "events_vector",
					type: "vectorSearch",
					status: "READY",
					queryable: true,
					latestDefinition: {
						fields: [
							{ type: "autoEmbed", path: "body" },
							{ type: "filter", path: "validAt" },
							{ type: "filter", path: "invalidAt" },
						],
					},
				},
				["validAt", "invalidAt"],
				"vectorSearch",
			),
		).toBe(true)
	})

	it.each([
		{
			label: "building",
			index: {
				status: "BUILDING",
				queryable: true,
				latestDefinition: {
					fields: [
						{ type: "filter", path: "validAt" },
						{ type: "filter", path: "invalidAt" },
					],
				},
			},
		},
		{
			label: "stale",
			index: {
				status: "STALE",
				queryable: true,
				latestDefinition: {
					fields: [
						{ type: "filter", path: "validAt" },
						{ type: "filter", path: "invalidAt" },
					],
				},
			},
		},
		{
			label: "mixed nested readiness",
			index: {
				status: "READY",
				queryable: true,
				statusDetail: [
					{
						mainIndex: { status: "READY", queryable: true },
						definitions: [{ status: "BUILDING", queryable: false }],
					},
				],
				latestDefinition: {
					fields: [
						{ type: "filter", path: "validAt" },
						{ type: "filter", path: "invalidAt" },
					],
				},
			},
		},
		{
			label: "missing definition",
			index: { status: "READY", queryable: true },
		},
		{
			label: "definition drift",
			index: {
				status: "READY",
				queryable: true,
				latestDefinition: {
					fields: [{ type: "filter", path: "validAt" }],
				},
			},
		},
		{
			label: "wrong field type",
			index: {
				status: "READY",
				queryable: true,
				latestDefinition: {
					fields: [
						{ type: "date", path: "validAt" },
						{ type: "filter", path: "invalidAt" },
					],
				},
			},
		},
		{
			label: "wrong index type",
			index: {
				type: "search",
				status: "READY",
				queryable: true,
				latestDefinition: {
					fields: [
						{ type: "filter", path: "validAt" },
						{ type: "filter", path: "invalidAt" },
					],
				},
			},
		},
	])("rejects $label indexes", ({ index }) => {
		expect(
			isSearchIndexReadyWithFilterFields(
				index,
				["validAt", "invalidAt"],
				"vectorSearch",
			),
		).toBe(false)
	})

	it("accepts definition fallback but gives latestDefinition precedence", () => {
		const readyDefinition = {
			fields: [
				{ type: "filter", path: "validAt" },
				{ type: "filter", path: "invalidAt" },
			],
		}
		expect(
			isSearchIndexReadyWithFilterFields(
				{
					type: "vectorSearch",
					status: "READY",
					queryable: true,
					definition: readyDefinition,
				},
				["validAt", "invalidAt"],
				"vectorSearch",
			),
		).toBe(true)
		expect(
			isSearchIndexReadyWithFilterFields(
				{
					type: "vectorSearch",
					status: "READY",
					queryable: true,
					definition: readyDefinition,
					latestDefinition: {
						fields: [{ type: "filter", path: "validAt" }],
					},
				},
				["validAt", "invalidAt"],
				"vectorSearch",
			),
		).toBe(false)
	})
})

describe("isEventsVectorBitemporalPrefilterReady", () => {
	const readyIndex = {
		name: "test_events_vector",
		type: "vectorSearch",
		status: "READY",
		queryable: true,
		latestDefinition: {
			fields: [
				{ type: "filter", path: "validAt" },
				{ type: "filter", path: "invalidAt" },
			],
		},
	}

	it("accepts the exact ready index only when event data has no explicit null invalidAt", async () => {
		const collection = {
			findOne: vi.fn(async () => null),
		} as unknown as Collection

		await expect(
			isEventsVectorBitemporalPrefilterReady(collection, "test_events_vector", [
				readyIndex,
			]),
		).resolves.toBe(true)
		expect(collection.findOne).toHaveBeenCalledWith(
			{ invalidAt: { $type: 10 } },
			{ projection: { _id: 1 } },
		)
	})

	it("rejects explicit-null event rows", async () => {
		const collection = {
			findOne: vi.fn(async () => ({ _id: "legacy-null" })),
		} as unknown as Collection

		await expect(
			isEventsVectorBitemporalPrefilterReady(collection, "test_events_vector", [
				readyIndex,
			]),
		).resolves.toBe(false)
	})

	it("selects by exact index name and skips the data probe when no match is ready", async () => {
		const collection = {
			findOne: vi.fn(async () => null),
		} as unknown as Collection

		await expect(
			isEventsVectorBitemporalPrefilterReady(
				collection,
				"other_events_vector",
				[readyIndex],
			),
		).resolves.toBe(false)
		expect(collection.findOne).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Legacy query-cache collection and schema
// ---------------------------------------------------------------------------

describe("queryCacheCollection", () => {
	it("queryCacheCollection returns prefixed collection", () => {
		const db = mockDb()
		queryCacheCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_query_cache")
	})
})

describe("telemetryCollection", () => {
	it("telemetryCollection returns prefixed collection", () => {
		const db = mockDb()
		telemetryCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_memory_telemetry")
	})
})

describe("accessEventsCollection", () => {
	it("accessEventsCollection returns prefixed collection", () => {
		const db = mockDb()
		accessEventsCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_access_events")
	})
})

describe("sessionChunksCollection", () => {
	it("sessionChunksCollection returns prefixed collection", () => {
		const db = mockDb()
		sessionChunksCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_session_chunks")
	})
})

describe("memoryEvidenceCollection", () => {
	it("memoryEvidenceCollection returns prefixed collection", () => {
		const db = mockDb()
		memoryEvidenceCollection(db, "oc_")
		expect(db.collection).toHaveBeenCalledWith("oc_memory_evidence")
	})
})

describe("query_cache schema", () => {
	it("QUERY_CACHE_SCHEMA validates all required fields via ensureCollections", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const cacheCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_query_cache",
		)
		expect(cacheCall).toBeDefined()
		const schema = cacheCall?.[1]?.validator.$jsonSchema
		expect(schema).toBeDefined()
		expect(schema.required).toEqual(
			expect.arrayContaining([
				"queryHash",
				"queryNorm",
				"agentId",
				"scope",
				"scopeRef",
				"results",
				"pathUsed",
				"sourceScope",
				"createdAt",
				"expiresAt",
				"hitCount",
				"lastHitAt",
			]),
		)
	})

	it("query_cache scope field uses SCOPE_ENUM", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const cacheCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_query_cache",
		)
		expect(cacheCall).toBeDefined()
		const schema = cacheCall?.[1]?.validator.$jsonSchema
		expect(schema.properties.scope.enum).toEqual([
			"session",
			"user",
			"agent",
			"workspace",
			"tenant",
			"global",
		])
	})

	it("query_cache hitCount has minimum 0", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const cacheCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_query_cache",
		)
		expect(cacheCall).toBeDefined()
		const schema = cacheCall?.[1]?.validator.$jsonSchema
		expect(schema.properties.hitCount.minimum).toBe(0)
	})
})

describe("query_cache standard indexes", () => {
	it("creates TTL index on expiresAt with expireAfterSeconds: 0", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const qc = db.collection("test_query_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = qc.createIndex.mock.calls
		const ttlCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_query_cache_ttl",
		)
		expect(ttlCall).toBeDefined()
		expect(ttlCall?.[0]).toEqual({ expiresAt: 1 })
		expect((ttlCall?.[1] as Record<string, unknown>).expireAfterSeconds).toBe(0)
	})

	it("keeps only the TTL index for legacy query-cache rows", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const qc = db.collection("test_query_cache") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const names = qc.createIndex.mock.calls.map(
			(call: unknown[]) => (call[1] as Record<string, unknown>)?.name,
		)
		expect(names).toEqual(["idx_query_cache_ttl"])
	})
})

describe("search index budget", () => {
	it("assertIndexBudget accommodates the full planned search index count on unbounded profiles", async () => {
		const db = mockDb()
		// This should NOT fail for unbounded Atlas profiles.
		await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")
		// The legacy query-cache collection no longer gets a Search index.
		const qc = db.collection("test_query_cache") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		expect(qc.createSearchIndex).not.toHaveBeenCalled()
		const sc = db.collection("test_session_chunks") as unknown as {
			createSearchIndex: ReturnType<typeof vi.fn>
		}
		expect(sc.createSearchIndex).toHaveBeenCalledTimes(2)
	})

	it("creates memory_evidence Search and Vector Search indexes when enabled", async () => {
		const previous = process.env.MEMONGO_EVIDENCE_MIRROR_MODE
		process.env.MEMONGO_EVIDENCE_MIRROR_MODE = "enabled"
		try {
			const db = mockDb()
			await ensureSearchIndexes(db, "test_", "atlas-local-preview", "automated")
			const memoryEvidence = db.collection(
				"test_memory_evidence",
			) as unknown as {
				createSearchIndex: ReturnType<typeof vi.fn>
			}
			expect(memoryEvidence.createSearchIndex).toHaveBeenCalledTimes(2)
			const vectorCall = memoryEvidence.createSearchIndex.mock.calls.find(
				(call) =>
					(call[0] as { name?: string }).name === "test_memory_evidence_vector",
			)
			const fields = (vectorCall?.[0] as Document).definition.fields
			const filterPaths = fields
				.filter((field: Document) => field.type === "filter")
				.map((field: Document) => field.path)
			expect(filterPaths).toEqual(
				expect.arrayContaining([
					"agentId",
					"scope",
					"scopeRef",
					"sessionId",
					"unit",
					"status",
					"timestamp",
				]),
			)
		} finally {
			if (previous === undefined) {
				delete process.env.MEMONGO_EVIDENCE_MIRROR_MODE
			} else {
				process.env.MEMONGO_EVIDENCE_MIRROR_MODE = previous
			}
		}
	})
})

describe("ordinary diagnostic collections", () => {
	it("creates fresh diagnostic sinks as ordinary collections with their retention TTLs", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		const createCalls = (db.createCollection as ReturnType<typeof vi.fn>).mock
			.calls
		const telemetryCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_memory_telemetry",
		)
		const accessEventsCall = createCalls.find(
			(c: unknown[]) => c[0] === "test_access_events",
		)
		expect(telemetryCall).toEqual(["test_memory_telemetry"])
		expect(accessEventsCall).toEqual(["test_access_events"])

		const telemetry = db.collection("test_memory_telemetry") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(telemetry.createIndex).toHaveBeenCalledWith(
			{ ts: 1 },
			{ expireAfterSeconds: 604800 },
		)
		const accessEvents = db.collection("test_access_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(accessEvents.createIndex).toHaveBeenCalledWith(
			{ ts: 1 },
			{ expireAfterSeconds: 30 * 24 * 3600 },
		)
	})

	it("repairs a missing TTL after collection creation was interrupted", async () => {
		// This is the durable state left by a createCollection success followed
		// by a createIndex failure on the prior startup attempt.
		const db = mockDb(["test_memory_telemetry"])
		const telemetry = db.collection("test_memory_telemetry") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		telemetry.createIndex
			.mockRejectedValueOnce(new Error("simulated TTL creation failure"))
			.mockResolvedValue("ts_1")

		await expect(ensureCollections(db, "test_")).rejects.toThrow(
			"simulated TTL creation failure",
		)
		await ensureCollections(db, "test_")

		const telemetryCreates = (
			db.createCollection as ReturnType<typeof vi.fn>
		).mock.calls.filter(
			(call: unknown[]) => call[0] === "test_memory_telemetry",
		)
		expect(telemetryCreates).toHaveLength(0)
		expect(telemetry.createIndex).toHaveBeenCalledTimes(2)
	})

	it("preserves a compatible existing ts_1 TTL index", async () => {
		const db = mockDb(["test_memory_telemetry"], undefined, {
			test_memory_telemetry: [
				{ name: "_id_", key: { _id: 1 } },
				{ name: "ts_1", key: { ts: 1 }, expireAfterSeconds: 604800 },
			],
		})
		await ensureCollections(db, "test_")

		const telemetry = db.collection("test_memory_telemetry") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		expect(telemetry.createIndex).not.toHaveBeenCalled()
	})

	it("rejects an incompatible existing TTL instead of shortening it", async () => {
		const db = mockDb(["test_memory_telemetry"], undefined, {
			test_memory_telemetry: [
				{
					name: "ts_1",
					key: { ts: 1 },
					expireAfterSeconds: 14 * 24 * 3600,
				},
			],
		})

		await expect(ensureCollections(db, "test_")).rejects.toThrow(
			/incompatible TTL index policy.*test_memory_telemetry/,
		)
	})

	it("rejects a partial-only TTL at the expected duration", async () => {
		const db = mockDb(["test_memory_telemetry"], undefined, {
			test_memory_telemetry: [
				{
					name: "partial_policy",
					key: { ts: 1 },
					expireAfterSeconds: 7 * 24 * 3600,
					partialFilterExpression: { "meta.agentId": "one-agent" },
				},
			],
		})

		await expect(ensureCollections(db, "test_")).rejects.toThrow(
			/incompatible TTL index policy.*test_memory_telemetry/,
		)
	})

	it("rejects a shorter partial TTL after the required full TTL", async () => {
		const db = mockDb(["test_memory_telemetry"], undefined, {
			test_memory_telemetry: [
				{
					name: "full_expected",
					key: { ts: 1 },
					expireAfterSeconds: 7 * 24 * 3600,
				},
				{
					name: "partial_policy",
					key: { ts: 1 },
					expireAfterSeconds: 60,
					partialFilterExpression: { "meta.agentId": "one-agent" },
				},
			],
		})

		await expect(ensureCollections(db, "test_")).rejects.toThrow(
			/incompatible TTL index policy.*test_memory_telemetry/,
		)
	})

	it("leaves an existing time-series sink untouched", async () => {
		const db = mockDb([
			{ name: "test_memory_telemetry", type: "timeseries" },
			{ name: "test_access_events", type: "timeseries" },
		])
		await ensureCollections(db, "test_")

		for (const name of ["test_memory_telemetry", "test_access_events"]) {
			const collection = db.collection(name) as unknown as {
				createIndex: ReturnType<typeof vi.fn>
				listIndexes: ReturnType<typeof vi.fn>
			}
			expect(collection.createIndex).not.toHaveBeenCalled()
			expect(collection.listIndexes).not.toHaveBeenCalled()
		}
		const diagnosticCreates = (
			db.createCollection as ReturnType<typeof vi.fn>
		).mock.calls.filter((call: unknown[]) =>
			["test_memory_telemetry", "test_access_events"].includes(String(call[0])),
		)
		expect(diagnosticCreates).toHaveLength(0)
	})
})

describe("telemetry standard indexes", () => {
	it("creates meta.agentId + ts index on telemetry collection", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const tel = db.collection("test_memory_telemetry") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = tel.createIndex.mock.calls
		const agentCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_telemetry_agent_ts",
		)
		expect(agentCall).toBeDefined()
		expect(agentCall?.[0]).toEqual({ "meta.agentId": 1, ts: -1 })
	})

	it("creates meta.operation + ts index on telemetry collection", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const tel = db.collection("test_memory_telemetry") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = tel.createIndex.mock.calls
		const opCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_telemetry_op_ts",
		)
		expect(opCall).toBeDefined()
		expect(opCall?.[0]).toEqual({ "meta.operation": 1, ts: -1 })
	})
})

describe("access events standard indexes", () => {
	it("creates agent/collection/memory/time index on access events", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const accessEvents = db.collection("test_access_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = accessEvents.createIndex.mock.calls
		const indexCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name ===
					"idx_access_events_agent_collection_memory_ts",
		)
		expect(indexCall).toBeDefined()
		expect(indexCall?.[0]).toEqual({
			"meta.agentId": 1,
			"meta.collection": 1,
			memoryId: 1,
			ts: -1,
		})
	})

	it("creates agent/collection/time index on access events", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const accessEvents = db.collection("test_access_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = accessEvents.createIndex.mock.calls
		const indexCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name ===
					"idx_access_events_agent_collection_ts",
		)
		expect(indexCall).toBeDefined()
		expect(indexCall?.[0]).toEqual({
			"meta.agentId": 1,
			"meta.collection": 1,
			ts: -1,
		})
	})

	it("creates the W11 batchId read-reconcile index on access events", async () => {
		const db = mockDb()
		await ensureStandardIndexes(db, "test_")
		const accessEvents = db.collection("test_access_events") as unknown as {
			createIndex: ReturnType<typeof vi.fn>
		}
		const calls = accessEvents.createIndex.mock.calls
		const indexCall = calls.find(
			(c: unknown[]) =>
				c[1] &&
				typeof c[1] === "object" &&
				(c[1] as Record<string, unknown>).name === "idx_access_events_batch_id",
		)
		expect(indexCall).toBeDefined()
		expect(indexCall?.[0]).toEqual({ batchId: 1 })
	})
})

describe("ensureCollections total count with ordinary diagnostic sinks", () => {
	it("creates all regular collections plus both ordinary diagnostic collections", async () => {
		const db = mockDb([])
		await ensureCollections(db, "test_")
		// 30 = 28 baseline + 1 memory_quarantine (embedding_cache removed, #13)
		// + 1 memory_cost_ledger (C-017)
		expect(db.createCollection).toHaveBeenCalledTimes(30)
	})
})

describe("ensureStandardIndexes total count with legacy query_cache TTL", () => {
	it("returns updated total index count including query_cache, telemetry, access event, and session_chunks indexes", async () => {
		const db = mockDb()
		const count = await ensureStandardIndexes(db, "test_")
		// 25 (v1 base, embedding_cache removed #13) + 9 events (6 + 1 dreamerProcessedAt + 1 bi-temporal SE-1 + 1 idempotency) + 3 entities + 4 relations +
		// 2 entity links + 5 episodes (4 + 1 promotion) + 1 ingest_runs + 1 projection_runs +
		// 1 structured scope + 1 structured revisions + 4 procedures + 1 procedure_revisions +
		// 1 query_cache TTL + 2 telemetry + 3 access_events (2 + 1 W11 batchId) + 3 memory_mutations
		// + 1 lane_coverage + 2 consolidation_runs + 3 session_chunks
		// + 1 bi-temporal valid-time (#32) + 2 durable job claim/TTL indexes
		// + 1 extraction outbox partial index + 1 unique relation identity
		// P3.8: −3 retired redundant indexes + 3 ESR compounds + 1 relationId locator
		// P4.4.1: +2 partial TTL indexes (events, structured_mem)
		// C-005: +1 partial TTL index (chunks expiresAt) + 1 session_chunks TTL (idx_session_chunks_ttl_expires_at)
		// C-004: +3 memory_quarantine (unique id, queue listing, pending TTL)
		// C-017 (WS-10): +2 cost ledger (unique agent/day/kind + TTL)
		// = 101
		expect(count).toBe(101)
	})
})
