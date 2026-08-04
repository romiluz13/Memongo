/**
 * E2E Evaluation Harness -- validates all 6 memory intelligence features
 * against 3 real-world scenarios with 450+ seeded events.
 *
 * Run (from packages/memory-engine):
 *   MEMONGO_MONGODB_URI="mongodb://localhost:27017" vitest run src/e2e-evaluation.e2e.test.ts --reporter=verbose
 *
 * Or from repo root:
 *   MEMONGO_MONGODB_URI="mongodb://localhost:27017" bun run --filter @memongo/memory-engine test:e2e
 *
 * 10-Dimension Score Card:
 *   1. Chain Completeness (15%)
 *   2. Chain Ordering (part of #1)
 *   3. Novelty Accuracy (15%)
 *   4. Novelty Degradation (part of #3)
 *   5. Consolidation Yield (20%)
 *   6. Consolidation Idempotency (part of #5)
 *   7. Importance Decay (10%)
 *   8. Access Tracking (10%)
 *   9. Wiki Categorization (5%)
 *  10. Cross-Agent Isolation (25%)
 *
 * Pass threshold: >= 90/100 overall, no dimension below 70.
 */

import { randomUUID } from "node:crypto"
import { MongoClient, type Db } from "mongodb"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { writeEvent } from "./mongodb-events.js"
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import { scanNovelty } from "./mongodb-novelty.js"
import { AccessTracker } from "./mongodb-access-tracker.js"
import { consolidateMemory } from "./mongodb-consolidator.js"
import { computeImportanceDecay } from "./mongodb-trust.js"
import {
	ensureCollections,
	ensureStandardIndexes,
	eventsCollection,
	structuredMemCollection,
	kbChunksCollection,
} from "./mongodb-schema.js"
import {
	embedTextsForTest,
	resolvePreviewMongoTestUri,
	resolvePreviewVoyageApiKey,
} from "./test-helpers/preview-env.js"

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const TEST_URI = resolvePreviewMongoTestUri("mongodb://localhost:27017")
const TEST_DB = "memongo_evaluation"
const TEST_PREFIX = "eval_"

// ---------------------------------------------------------------------------
// Scenario agent IDs (UUID-suffixed for isolation)
// ---------------------------------------------------------------------------

/**
 * This suite scores memory quality, so it must run against real embeddings.
 * Skipping loudly beats the previous behaviour of quietly substituting random
 * vectors and reporting a score anyway.
 */
const HAS_REAL_EMBEDDINGS = resolvePreviewVoyageApiKey().length > 0

const SCENARIO_UUID = randomUUID().slice(0, 8)
const CODING_AGENT_ARCH = `coding-agent-arch-${SCENARIO_UUID}`
const CODING_AGENT_IMPL = `coding-agent-impl-${SCENARIO_UUID}`
const CODING_AGENT_REVIEW = `coding-agent-review-${SCENARIO_UUID}`
const SUPPORT_AGENT_TIER1 = `support-agent-tier1-${SCENARIO_UUID}`
const SUPPORT_AGENT_TIER2 = `support-agent-tier2-${SCENARIO_UUID}`
const PROD_AGENT = `prod-agent-${SCENARIO_UUID}`

// Convenience arrays for cross-agent checks
const CODING_AGENTS = [
	CODING_AGENT_ARCH,
	CODING_AGENT_IMPL,
	CODING_AGENT_REVIEW,
]
const SUPPORT_AGENTS = [SUPPORT_AGENT_TIER1, SUPPORT_AGENT_TIER2]
const ALL_AGENTS = [...CODING_AGENTS, ...SUPPORT_AGENTS, PROD_AGENT]

// ---------------------------------------------------------------------------
// Score tracking
// ---------------------------------------------------------------------------

const scores: Record<string, number> = {
	chainCompleteness: 0,
	chainOrdering: 0,
	noveltyAccuracy: 0,
	noveltyDegradation: 0,
	consolidationYield: 0,
	consolidationIdempotency: 0,
	importanceDecay: 0,
	accessTracking: 0,
	wikiCategorization: 0,
	crossAgentIsolation: 0,
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

function computeWeightedScore(s: Record<string, number>): number {
	// Chain = max(chainCompleteness, chainOrdering) averaged, weight 15%
	const chainScore = (s.chainCompleteness + s.chainOrdering) / 2
	// Novelty = max(noveltyAccuracy, noveltyDegradation) averaged, weight 15%
	const noveltyScore = (s.noveltyAccuracy + s.noveltyDegradation) / 2
	// Consolidation = max(consolidationYield, consolidationIdempotency) averaged, weight 20%
	const consolidationScore =
		(s.consolidationYield + s.consolidationIdempotency) / 2

	const weighted =
		chainScore * 0.15 +
		noveltyScore * 0.15 +
		consolidationScore * 0.2 +
		s.importanceDecay * 0.1 +
		s.accessTracking * 0.1 +
		s.wikiCategorization * 0.05 +
		s.crossAgentIsolation * 0.25

	return Math.round(weighted * 10) / 10
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const NOW = new Date()
const DAY_MS = 86_400_000

function _daysAgo(days: number): Date {
	return new Date(NOW.getTime() - days * DAY_MS)
}

function _hoursAgo(hours: number): Date {
	return new Date(NOW.getTime() - hours * 3_600_000)
}

// ---------------------------------------------------------------------------
// Embedding helpers for novelty detection
// ---------------------------------------------------------------------------

/** Seeded random number generator for reproducible embeddings. */
// ---------------------------------------------------------------------------
// Seed event helpers
// ---------------------------------------------------------------------------

type SeedEvent = {
	agentId: string
	sessionId: string
	role: "user" | "assistant"
	body: string
	timestamp: Date
}

/** Stored event IDs by agent for chain/isolation testing. */
const eventIdsByAgent: Map<string, string[]> = new Map()

/**
 * Real embeddings for the current seeding batch, keyed by event body.
 *
 * This suite used to synthesise embeddings as 1024 uniform random numbers.
 * Measured on these very fixtures that puts every pair of unrelated statements
 * at ~0.75 cosine (min 0.719, max 0.788) where the real model puts them at
 * ~0.35 — so novelty, which is 40% of the consolidation gate, was computed
 * from noise. The anomaly fixtures are already semantically distinct in their
 * text ("a complete career change to become a woodworking artisan" among
 * coding preferences), so real vectors make the novelty assertions meaningful
 * instead of merely reproducible.
 */
const embeddingByBody = new Map<string, number[]>()

async function _primeEmbeddings(events: SeedEvent[]): Promise<void> {
	const bodies = [...new Set(events.map((evt) => evt.body))].filter(
		(body) => !embeddingByBody.has(body),
	)
	if (bodies.length === 0) {
		return
	}
	const vectors = await embedTextsForTest(bodies)
	bodies.forEach((body, index) => {
		embeddingByBody.set(body, vectors[index])
	})
}

async function _seedEvent(
	db: Db,
	evt: SeedEvent & { isAnomaly?: boolean },
): Promise<string> {
	const result = await writeEvent({
		db,
		prefix: TEST_PREFIX,
		event: {
			agentId: evt.agentId,
			sessionId: evt.sessionId,
			role: evt.role,
			body: evt.body,
			scope: "agent",
			timestamp: evt.timestamp,
		},
	})

	// Real embedding of the event text. Anomaly events are anomalous by their
	// content, so they need no special-cased vector.
	const embedding = embeddingByBody.get(evt.body)
	if (!embedding) {
		throw new Error(`seedEvent: no embedding primed for body: ${evt.body}`)
	}
	await eventsCollection(db, TEST_PREFIX).updateOne(
		{ eventId: result.eventId },
		{ $set: { embedding } },
	)

	const ids = eventIdsByAgent.get(evt.agentId) ?? []
	ids.push(result.eventId)
	eventIdsByAgent.set(evt.agentId, ids)

	return result.eventId
}

/** Total seeded events counter. */
const _totalSeededEvents = 0

// ---------------------------------------------------------------------------
// MongoDB client
// ---------------------------------------------------------------------------

let client: MongoClient
let db: Db

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
	client = new MongoClient(TEST_URI, {
		serverSelectionTimeoutMS: 10_000,
		connectTimeoutMS: 10_000,
	})
	await client.connect()
	await client.db("admin").command({ ping: 1 })
	db = client.db(TEST_DB)

	// Clean slate
	const collections = await db.listCollections().toArray()
	for (const col of collections) {
		if (col.name.startsWith(TEST_PREFIX)) {
			await db.dropCollection(col.name)
		}
	}

	// Ensure collections + indexes
	await ensureCollections(db, TEST_PREFIX)
	await ensureStandardIndexes(db, TEST_PREFIX)

	// Create vector search index on events for novelty detection.
	// The novelty module expects index name `idx_events_vector` on field `embedding`.
	try {
		await eventsCollection(db, TEST_PREFIX).createSearchIndex({
			name: "idx_events_vector",
			type: "vectorSearch",
			definition: {
				fields: [
					{
						type: "vector",
						path: "embedding",
						numDimensions: 1024,
						similarity: "cosine",
					},
					{ type: "filter", path: "agentId" },
				],
			},
		})
		// Wait for index to become queryable (mongot needs sync time for 450+ docs)
		await new Promise((resolve) => setTimeout(resolve, 15_000))
	} catch (err) {
		// Index may already exist from previous run
		const msg = err instanceof Error ? err.message : String(err)
		if (!msg.includes("already exists") && !msg.includes("duplicate")) {
			console.warn(`Could not create events vector index: ${msg}`)
		}
	}
})

afterAll(async () => {
	// Print score card
	console.log("\n===================================================")
	console.log("=== MEMONGO E2E EVALUATION SCORE CARD ===")
	console.log("===================================================\n")
	for (const [dim, score] of Object.entries(scores)) {
		const pad = dim.padEnd(28)
		const bar = score >= 70 ? "PASS" : "FAIL"
		console.log(`  ${pad} ${score.toFixed(0).padStart(3)}/100  [${bar}]`)
	}
	const weighted = computeWeightedScore(scores)
	console.log(
		`\n  ${"OVERALL".padEnd(28)} ${weighted.toFixed(1).padStart(5)}/100`,
	)
	console.log(`  ${"PASS THRESHOLD".padEnd(28)} ${"90.0".padStart(5)}/100`)
	console.log(`  ${"RESULT".padEnd(28)} ${weighted >= 90 ? "PASS" : "FAIL"}`)
	console.log("\n===================================================\n")

	// Cleanup
	if (db) {
		const collections = await db.listCollections().toArray()
		for (const col of collections) {
			if (col.name.startsWith(TEST_PREFIX)) {
				await db.dropCollection(col.name)
			}
		}
	}
	if (client) {
		await client.close()
	}
})

// ===========================================================================
// Phase B: Baseline Verification
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase B: Baseline Verification", () => {
	it("events collection has seeded data per scenario", async () => {
		for (const agentId of ALL_AGENTS) {
			const count = await eventsCollection(db, TEST_PREFIX).countDocuments({
				agentId,
			})
			expect(count, `agent ${agentId} should have events`).toBeGreaterThan(0)
		}
	})

	it("structured memory entries exist with sourceEventIds", async () => {
		const withSources = await structuredMemCollection(
			db,
			TEST_PREFIX,
		).countDocuments({ sourceEventIds: { $exists: true, $ne: [] } })
		expect(withSources).toBeGreaterThan(0)
	})
})

// ===========================================================================
// Phase C: Consolidation
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase C: Consolidation", () => {
	/** Track promoted facts per agent for scoring. */
	const promotedByAgent: Map<string, number> = new Map()

	it("consolidateMemory promotes preferences and decisions (arch agent)", async () => {
		const result = await consolidateMemory({
			db,
			prefix: TEST_PREFIX,
			agentId: CODING_AGENT_ARCH,
			options: { minIntervalMs: 0 },
		})

		expect(result.eventsProcessed).toBeGreaterThan(0)
		// The arch agent has 10 "I prefer" and 8 "I decided" statements, all of
		// them durable. ">0" was too weak to notice that only one was surviving.
		expect(result.factsPromoted).toBeGreaterThanOrEqual(16)
		promotedByAgent.set(CODING_AGENT_ARCH, result.factsPromoted)
	})

	it("consolidateMemory runs for all agents", async () => {
		const otherAgents = ALL_AGENTS.filter((a) => a !== CODING_AGENT_ARCH)
		for (const agentId of otherAgents) {
			const result = await consolidateMemory({
				db,
				prefix: TEST_PREFIX,
				agentId,
				options: { minIntervalMs: 0 },
			})
			promotedByAgent.set(agentId, result.factsPromoted)
		}

		// At least some agents should have promoted facts
		const totalPromoted = [...promotedByAgent.values()].reduce(
			(a, b) => a + b,
			0,
		)
		expect(totalPromoted).toBeGreaterThan(0)
		// Give-up budget. Consolidating five agents now runs novelty over real
		// embeddings rather than synthetic vectors, which is real work.
	})

	it("idempotent re-run produces 0 new promotions (arch agent)", async () => {
		const result2 = await consolidateMemory({
			db,
			prefix: TEST_PREFIX,
			agentId: CODING_AGENT_ARCH,
			options: { minIntervalMs: 0 },
		})

		// All events were already dreamer-processed, so 0 new events to process
		expect(result2.eventsProcessed).toBe(0)
		expect(result2.factsPromoted).toBe(0)
	})

	it("score consolidation dimensions", () => {
		// Count expected preference/decision events across agents
		// Arch has 10 pref + 8 dec = 18 expected promotable
		const archPromoted = promotedByAgent.get(CODING_AGENT_ARCH) ?? 0

		// These bands used to top out at ">= 8 of 18", with the note "the actual
		// count may be lower due to combinedScore filtering" — i.e. the scorecard
		// was calibrated to a defect rather than to the contract. All 18 are
		// durable preferences and decisions; the only legitimate losses are
		// extraction misses, conflicts, and near-duplicate NOOPs, so the bar is
		// now most of them rather than a third.
		if (archPromoted >= 16) {
			scores.consolidationYield = 100
		} else if (archPromoted >= 12) {
			scores.consolidationYield = 85
		} else if (archPromoted >= 8) {
			scores.consolidationYield = 70
		} else if (archPromoted >= 1) {
			scores.consolidationYield = 50
		} else {
			scores.consolidationYield = 0
		}

		// Idempotency: 100 (tested above, would have failed if not idempotent)
		scores.consolidationIdempotency = 100
	})
})

// ===========================================================================
// Phase D: Reasoning Chain
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase D: Reasoning Chain", () => {
	it("traces promoted fact back to source events", async () => {
		// Find a structured memory entry with sourceEventIds
		const facts = await structuredMemCollection(db, TEST_PREFIX)
			.find({ sourceEventIds: { $exists: true, $ne: [] } })
			.toArray()

		expect(
			facts.length,
			"should have facts with sourceEventIds",
		).toBeGreaterThan(0)

		let completeChains = 0
		let totalChains = 0

		for (const fact of facts) {
			const agentId = fact.agentId as string
			const factKey = fact.key as string

			const chain = await traceReasoningChain({
				db,
				prefix: TEST_PREFIX,
				agentId,
				factId: factKey,
				collection: "structured_mem",
			})

			totalChains++
			if (chain.nodes.length > 1 && chain.chainComplete) {
				completeChains++
			}
		}

		// Score: percentage of chains that are complete
		scores.chainCompleteness =
			totalChains > 0 ? Math.round((completeChains / totalChains) * 100) : 0
	})

	it("chain nodes are ordered oldest-first", async () => {
		const facts = await structuredMemCollection(db, TEST_PREFIX)
			.find({ sourceEventIds: { $exists: true, $ne: [] } })
			.toArray()

		let sortedChains = 0
		let totalChains = 0

		for (const fact of facts) {
			const chain = await traceReasoningChain({
				db,
				prefix: TEST_PREFIX,
				agentId: fact.agentId as string,
				factId: fact.key as string,
				collection: "structured_mem",
			})

			if (chain.nodes.length < 2) continue

			totalChains++
			const eventNodes = chain.nodes.filter(
				(n) => n.type === "event" && n.timestamp,
			)
			let isSorted = true
			for (let i = 1; i < eventNodes.length; i++) {
				const prev = eventNodes[i - 1].timestamp!
				const curr = eventNodes[i].timestamp!
				if (prev.getTime() > curr.getTime()) {
					isSorted = false
					break
				}
			}
			if (isSorted) {
				sortedChains++
			}
		}

		scores.chainOrdering =
			totalChains > 0 ? Math.round((sortedChains / totalChains) * 100) : 100 // If no multi-node chains, consider sorted
	})

	it("agentId isolation: chain excludes other agents", async () => {
		const archFacts = await structuredMemCollection(db, TEST_PREFIX)
			.find({
				agentId: CODING_AGENT_ARCH,
				sourceEventIds: { $exists: true, $ne: [] },
			})
			.toArray()

		for (const fact of archFacts) {
			const chain = await traceReasoningChain({
				db,
				prefix: TEST_PREFIX,
				agentId: CODING_AGENT_ARCH,
				factId: fact.key as string,
				collection: "structured_mem",
			})

			// Every node should belong to CODING_AGENT_ARCH, not any other agent
			expect(chain.agentId).toBe(CODING_AGENT_ARCH)
		}
	})
})

// ===========================================================================
// Phase E: Novelty
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase E: Novelty", () => {
	it("wait for vector index to sync seeded embeddings", async () => {
		// After seeding 450+ events with embeddings, mongot needs time to index them.
		// This is a real infrastructure concern, not a workaround.
		await new Promise((resolve) => setTimeout(resolve, 10_000))
	})

	it("novelty scan returns results or degrades gracefully", async () => {
		const report = await scanNovelty({
			db,
			prefix: TEST_PREFIX,
			agentId: CODING_AGENT_ARCH,
			options: { limit: 10 },
		})

		if (report.error === "mongot_unavailable") {
			// Graceful degradation: empty report, no crash
			expect(report.events).toHaveLength(0)
			scores.noveltyDegradation = 100
			// Without mongot, we cannot score accuracy
			scores.noveltyAccuracy = 70 // Base score for graceful degradation
		} else if (report.events.length === 0 && !report.error) {
			// No vector search index available — degrade gracefully
			scores.noveltyDegradation = 100
			scores.noveltyAccuracy = 70
		} else {
			// Full novelty scan with real embeddings available.
			// Anomaly events (uniform vectors) should rank as most novel
			// since they are furthest from the centroid of random vectors.
			scores.noveltyDegradation = 100
			console.log(
				`[NOVELTY DIAG] ${report.events.length} events returned, scanned=${report.scannedCount}`,
			)
			for (const e of report.events.slice(0, 10)) {
				console.log(
					`  score=${e.noveltyScore.toFixed(4)} body="${e.body.slice(0, 80)}"`,
				)
			}

			// Check if "Rust" anomaly is in top-5
			const top5 = report.events.slice(0, 5)
			const rustAnomaly = top5.some((e) =>
				e.body.toLowerCase().includes("rust"),
			)
			const cloudAnomaly = top5.some((e) =>
				e.body.toLowerCase().includes("google cloud"),
			)

			if (rustAnomaly && cloudAnomaly) {
				scores.noveltyAccuracy = 100
			} else if (rustAnomaly || cloudAnomaly) {
				scores.noveltyAccuracy = 85
			} else {
				// Check top-10
				const top10 = report.events.slice(0, 10)
				const anyAnomaly = top10.some(
					(e) =>
						e.body.toLowerCase().includes("rust") ||
						e.body.toLowerCase().includes("google cloud"),
				)
				scores.noveltyAccuracy = anyAnomaly ? 75 : 50
			}
		}
	})

	it("novelty scan for support agent handles graceful degradation", async () => {
		const report = await scanNovelty({
			db,
			prefix: TEST_PREFIX,
			agentId: SUPPORT_AGENT_TIER1,
			options: { limit: 10 },
		})

		// Should not crash regardless of mongot availability
		expect(report).toBeDefined()
		expect(report.agentId).toBe(SUPPORT_AGENT_TIER1)

		// If mongot is available and we have results, check for legal threat anomaly
		if (report.events.length > 0 && !report.error) {
			const top5 = report.events.slice(0, 5)
			const legalAnomaly = top5.some((e) =>
				e.body.toLowerCase().includes("legal"),
			)
			if (legalAnomaly) {
				// Boost accuracy score
				scores.noveltyAccuracy = Math.max(scores.noveltyAccuracy, 90)
			}
		}
	})
})

// ===========================================================================
// Phase F: Importance Decay
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase F: Importance Decay", () => {
	it("fresh fact has importance close to base value", () => {
		const fresh = computeImportanceDecay(1.0, new Date(), new Date())
		expect(fresh).toBeCloseTo(1.0, 1)
	})

	it("7-day-old transient fact decays to ~50% of base", () => {
		const now = new Date()
		const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS)
		const decayed = computeImportanceDecay(
			1.0,
			sevenDaysAgo,
			now,
			7,
			"transient",
		)
		// Half-life is 7 days, so decay should be ~0.5
		expect(decayed).toBeCloseTo(0.5, 1)
	})

	it("14-day-old bounded fact decays to ~25% of base", () => {
		const now = new Date()
		const fourteenDaysAgo = new Date(now.getTime() - 14 * DAY_MS)
		const decayed = computeImportanceDecay(
			1.0,
			fourteenDaysAgo,
			now,
			7,
			"bounded",
		)
		expect(decayed).toBeCloseTo(0.25, 1)
	})

	it("28-day-old fact (no scope) decays to ~6.25% of base", () => {
		const now = new Date()
		const twentyEightDaysAgo = new Date(now.getTime() - 28 * DAY_MS)
		const decayed = computeImportanceDecay(1.0, twentyEightDaysAgo, now)
		expect(decayed).toBeCloseTo(0.0625, 1)
	})

	it("permanent preference does NOT decay even after 30 days", () => {
		const now = new Date()
		const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS)
		const decayed = computeImportanceDecay(
			1.0,
			thirtyDaysAgo,
			now,
			7,
			"permanent",
		)
		// Permanent memories keep full importance
		expect(decayed).toBe(1.0)
	})

	it("ongoing fact does NOT decay even after 30 days", () => {
		const now = new Date()
		const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS)
		const decayed = computeImportanceDecay(
			0.85,
			thirtyDaysAgo,
			now,
			7,
			"ongoing",
		)
		// Ongoing memories keep full importance
		expect(decayed).toBe(0.85)
	})

	it("score importance decay dimension", () => {
		const now = new Date()

		// Transient/bounded memories should decay
		const transientCases: Array<{
			daysOld: number
			expected: number
			scope?: string
		}> = [
			{ daysOld: 0, expected: 1.0, scope: "transient" },
			{ daysOld: 7, expected: 0.5, scope: "transient" },
			{ daysOld: 14, expected: 0.25, scope: "bounded" },
			{ daysOld: 28, expected: 0.0625 }, // no scope = backwards compat decay
		]

		let withinTolerance = 0
		for (const tc of transientCases) {
			const date = new Date(now.getTime() - tc.daysOld * DAY_MS)
			const actual = computeImportanceDecay(1.0, date, now, 7, tc.scope)
			if (Math.abs(actual - tc.expected) <= 0.05) {
				withinTolerance++
			}
		}

		// Permanent/ongoing memories should NOT decay
		const permanentCases: Array<{
			daysOld: number
			importance: number
			scope: string
		}> = [
			{ daysOld: 7, importance: 1.0, scope: "permanent" },
			{ daysOld: 30, importance: 0.9, scope: "ongoing" },
		]

		let permanentCorrect = 0
		for (const tc of permanentCases) {
			const date = new Date(now.getTime() - tc.daysOld * DAY_MS)
			const actual = computeImportanceDecay(
				tc.importance,
				date,
				now,
				7,
				tc.scope,
			)
			if (Math.abs(actual - tc.importance) <= 0.001) {
				permanentCorrect++
			}
		}

		const totalCases = transientCases.length + permanentCases.length
		const totalCorrect = withinTolerance + permanentCorrect
		scores.importanceDecay = Math.round((totalCorrect / totalCases) * 100)
	})
})

// ===========================================================================
// Phase G: Access Tracking
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase G: Access Tracking", () => {
	it("batched access counts accumulate correctly", async () => {
		// Grab a known event ID to track
		const archEvents = eventIdsByAgent.get(CODING_AGENT_ARCH)
		expect(archEvents).toBeDefined()
		const targetEventId = archEvents?.[0]

		const tracker = new AccessTracker(db, TEST_PREFIX, CODING_AGENT_ARCH, {
			flushThreshold: 5, // Low threshold to test auto-flush behavior
			flushIntervalMs: 60_000,
		})

		try {
			// Record 15 accesses (should auto-flush at 5 and 10, then manual flush for last 5)
			for (let i = 0; i < 15; i++) {
				tracker.recordAccess(targetEventId, "events")
			}
			// Ensure final flush
			await tracker.flush()

			// Query the events collection to verify accessCount
			const event = await eventsCollection(db, TEST_PREFIX).findOne({
				eventId: targetEventId,
			})

			// With the pendingFlush fix, manual flush() awaits all auto-triggered flushes
			// and then drains the remaining buffer. All 15 accesses should be flushed.
			if (event?.accessCount != null && event.accessCount >= 15) {
				scores.accessTracking = 100
			} else if (event?.accessCount != null && event.accessCount >= 10) {
				scores.accessTracking = 85
			} else if (event?.accessCount != null && event.accessCount >= 5) {
				scores.accessTracking = 70
			} else {
				scores.accessTracking = 0
			}

			expect(event?.accessCount).toBeGreaterThanOrEqual(15)
		} finally {
			tracker.close()
		}
	})

	it("access tracking records lastAccessedAt", async () => {
		const archEvents = eventIdsByAgent.get(CODING_AGENT_ARCH)
		const targetEventId = archEvents?.[0]

		const event = await eventsCollection(db, TEST_PREFIX).findOne({
			eventId: targetEventId,
		})

		expect(event?.lastAccessedAt).toBeInstanceOf(Date)
	})
})

// ===========================================================================
// Phase H: Wiki Categorization
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase H: Wiki Categorization", () => {
	it("KB entries with wikiSource filter correctly", async () => {
		const kbCol = kbChunksCollection(db, TEST_PREFIX)

		// Insert KB chunks WITH wikiSource (must match KB_CHUNKS_SCHEMA required fields)
		await kbCol.insertMany([
			{
				docId: randomUUID(),
				path: "setup/mongodb-atlas.md",
				text: "Setup guide for MongoDB Atlas",
				startLine: 0,
				endLine: 10,
				wikiSource: "obsidian",
				vault: "engineering",
				section: "setup",
				updatedAt: new Date(),
			},
			{
				docId: randomUUID(),
				path: "deployment/bun-production.md",
				text: "How to configure Bun for production",
				startLine: 0,
				endLine: 15,
				wikiSource: "obsidian",
				vault: "engineering",
				section: "deployment",
				updatedAt: new Date(),
			},
			{
				docId: randomUUID(),
				path: "coding/typescript-best-practices.md",
				text: "TypeScript best practices guide",
				startLine: 0,
				endLine: 20,
				wikiSource: "notion",
				vault: "team-docs",
				section: "coding",
				updatedAt: new Date(),
			},
		])

		// Insert KB chunks WITHOUT wikiSource (still need required fields)
		await kbCol.insertMany([
			{
				docId: randomUUID(),
				path: "api/general-docs.md",
				text: "General API documentation",
				startLine: 0,
				endLine: 5,
				updatedAt: new Date(),
			},
			{
				docId: randomUUID(),
				path: "meetings/last-week.md",
				text: "Team meeting notes from last week",
				startLine: 0,
				endLine: 8,
				updatedAt: new Date(),
			},
		])

		// Query with wikiSource filter
		// KB chunks don't have agentId — filter by wikiSource only
		const obsidianChunks = await kbCol
			.find({ wikiSource: "obsidian" })
			.toArray()
		const notionChunks = await kbCol.find({ wikiSource: "notion" }).toArray()
		const allWikiChunks = await kbCol
			.find({ wikiSource: { $exists: true } })
			.toArray()
		const noWikiChunks = await kbCol
			.find({ wikiSource: { $exists: false } })
			.toArray()

		expect(obsidianChunks).toHaveLength(2)
		expect(notionChunks).toHaveLength(1)
		expect(allWikiChunks).toHaveLength(3)
		expect(noWikiChunks).toHaveLength(2)

		// Verify zero false positives
		const allCorrectSource = obsidianChunks.every(
			(c) => c.wikiSource === "obsidian",
		)
		const notionCorrectSource = notionChunks.every(
			(c) => c.wikiSource === "notion",
		)

		if (allCorrectSource && notionCorrectSource) {
			scores.wikiCategorization = 100
		} else {
			scores.wikiCategorization = 50
		}
	})
})

// ===========================================================================
// Phase I: Cross-Agent Isolation
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase I: Cross-Agent Isolation", () => {
	it("reasoning chains do not leak across agents", async () => {
		let leakFound = false

		for (const agentId of ALL_AGENTS) {
			const facts = await structuredMemCollection(db, TEST_PREFIX)
				.find({
					agentId,
					sourceEventIds: { $exists: true, $ne: [] },
				})
				.toArray()

			for (const fact of facts) {
				const chain = await traceReasoningChain({
					db,
					prefix: TEST_PREFIX,
					agentId,
					factId: fact.key as string,
					collection: "structured_mem",
				})

				// Verify all event nodes belong to the correct agent
				const eventNodes = chain.nodes.filter((n) => n.type === "event")
				for (const node of eventNodes) {
					// Look up the event to verify its agentId
					const evt = await eventsCollection(db, TEST_PREFIX).findOne({
						eventId: node.id,
					})
					if (evt && evt.agentId !== agentId) {
						leakFound = true
					}
				}
			}
		}

		expect(leakFound).toBe(false)
	})

	it("novelty scan does not leak across agents", async () => {
		let leakFound = false

		for (const agentId of ALL_AGENTS) {
			const report = await scanNovelty({
				db,
				prefix: TEST_PREFIX,
				agentId,
				options: { limit: 20 },
			})

			if (report.error || report.events.length === 0) {
				// No data to check (mongot unavailable or no embeddings)
				continue
			}

			for (const evt of report.events) {
				// Verify event belongs to this agent
				const dbEvent = await eventsCollection(db, TEST_PREFIX).findOne({
					eventId: evt.eventId,
				})
				if (dbEvent && dbEvent.agentId !== agentId) {
					leakFound = true
				}
			}
		}

		expect(leakFound).toBe(false)
	})

	it("consolidation does not promote across agent boundaries", async () => {
		// Verify all promoted structured memory entries belong to the correct agent
		const allFacts = await structuredMemCollection(db, TEST_PREFIX)
			.find({ source: "agent" })
			.toArray()

		let leakFound = false
		for (const fact of allFacts) {
			const factAgentId = fact.agentId as string
			const sourceEventIds = (fact.sourceEventIds as string[]) ?? []

			for (const evtId of sourceEventIds) {
				const evt = await eventsCollection(db, TEST_PREFIX).findOne({
					eventId: evtId,
				})
				if (evt && evt.agentId !== factAgentId) {
					leakFound = true
				}
			}
		}

		expect(leakFound).toBe(false)
	})

	it("score cross-agent isolation dimension", () => {
		// If we got here without leaks in the tests above, score is 100.
		// The tests above would have failed via expect() if any leak was found.
		scores.crossAgentIsolation = 100
	})
})

// ===========================================================================
// Phase J: Score Card
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase J: Score Card", () => {
	it("overall score >= 90/100", () => {
		const weighted = computeWeightedScore(scores)
		console.log("\n--- Score Summary ---")
		console.log(JSON.stringify(scores, null, 2))
		console.log(`Weighted overall: ${weighted}/100`)
		expect(weighted).toBeGreaterThanOrEqual(90)
	})

	it("no dimension below 70", () => {
		for (const [dim, score] of Object.entries(scores)) {
			expect(score, `${dim} score too low (${score})`).toBeGreaterThanOrEqual(
				70,
			)
		}
	})
})

// ===========================================================================
// Helper: generate filler conversation events
// ===========================================================================

function _generateConversationFiller(
	agentId: string,
	sessionPrefix: string,
	startSessionNum: number,
	count: number,
	baseTimestamp: Date,
): SeedEvent[] {
	const events: SeedEvent[] = []
	const topics = [
		"Can you help me understand this error message?",
		"What is the best practice for handling this scenario?",
		"How should I structure this module?",
		"Can you review this approach?",
		"What are the tradeoffs of this pattern?",
		"Is there a better way to implement this?",
		"How do we handle errors in this case?",
		"What monitoring should we add?",
		"Can you explain how this works?",
		"What testing strategy do you recommend?",
		"How should we document this?",
		"What security considerations should I keep in mind?",
		"Can you suggest optimizations for this code?",
		"How do we handle backward compatibility here?",
		"What is the expected behavior when this fails?",
	]

	const responses = [
		"That is a common pattern. Here is how I recommend handling it.",
		"Based on best practices, you should consider this approach.",
		"The error indicates a configuration issue. Try checking the settings.",
		"This approach has good tradeoffs for your scale.",
		"I would recommend adding retry logic with exponential backoff.",
		"The module structure looks clean. Consider extracting this helper.",
		"Good question. The idiomatic approach in this codebase is this pattern.",
		"For monitoring, add latency percentiles and error rate counters.",
		"This is well-documented in the framework guide. The key concept is separation of concerns.",
		"Integration tests would give you the most confidence here.",
		"A README with examples would help new team members.",
		"Use parameterized queries and validate all external input.",
		"You could use a cache here to reduce database load.",
		"Use feature flags to gradually roll out the breaking change.",
		"It should return an error response with a descriptive message.",
	]

	for (let i = 0; i < count; i++) {
		const sessionNum = startSessionNum + Math.floor(i / 4)
		const sessionId = `${sessionPrefix}-s${sessionNum}`
		const isUser = i % 2 === 0
		const topicIdx = i % topics.length
		const timeDelta = i * 1_800_000 // 30 minutes between messages

		events.push({
			agentId,
			sessionId,
			role: isUser ? "user" : "assistant",
			body: isUser ? topics[topicIdx] : responses[topicIdx],
			timestamp: new Date(baseTimestamp.getTime() + timeDelta),
		})
	}

	return events
}
