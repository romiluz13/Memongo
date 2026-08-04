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
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import {
	ensureCollections,
	ensureStandardIndexes,
	eventsCollection,
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
const _ALL_AGENTS = [...CODING_AGENTS, ...SUPPORT_AGENTS, PROD_AGENT]

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

function daysAgo(days: number): Date {
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

async function primeEmbeddings(events: SeedEvent[]): Promise<void> {
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

async function seedEvent(
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
let totalSeededEvents = 0

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
// Phase A: Seed Scenarios (450+ events across 3 scenarios)
// ===========================================================================

describe.skipIf(!HAS_REAL_EMBEDDINGS)("Phase A: Seed Scenarios", () => {
	it("seeds Customer Support scenario (2 agents, 150+ events)", async () => {
		// -----------------------------------------------------------------------
		// SUPPORT-AGENT-TIER1 events (80+)
		// -----------------------------------------------------------------------
		const tier1Events: SeedEvent[] = [
			// Customer preferences
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s1",
				role: "user",
				body: "I prefer email communication over phone calls",
				timestamp: daysAgo(27),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s1",
				role: "user",
				body: "I always want a ticket number for every interaction",
				timestamp: daysAgo(27),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s2",
				role: "user",
				body: "I prefer detailed troubleshooting steps over quick fixes",
				timestamp: daysAgo(26),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s2",
				role: "user",
				body: "I like getting follow-up emails after issue resolution",
				timestamp: daysAgo(25),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s3",
				role: "user",
				body: "My timezone is PST, available 9am-5pm",
				timestamp: daysAgo(24),
			},

			// Procedures
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s4",
				role: "user",
				body: "To fix error X, reinstall the driver from Settings > Drivers > Reinstall",
				timestamp: daysAgo(23),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s4",
				role: "assistant",
				body: "Noted the procedure for fixing error X via driver reinstall",
				timestamp: daysAgo(23),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s5",
				role: "user",
				body: "When a customer is locked out, verify identity with email and last 4 of phone",
				timestamp: daysAgo(22),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s5",
				role: "user",
				body: "Always escalate after 3 failed troubleshooting attempts",
				timestamp: daysAgo(21),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s6",
				role: "user",
				body: "For billing disputes, gather invoice date and amount before escalating",
				timestamp: daysAgo(20),
			},

			// Facts
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s7",
				role: "user",
				body: "Customer has 3 open tickets: TICK-101, TICK-102, TICK-103",
				timestamp: daysAgo(19),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s7",
				role: "user",
				body: "Last purchase was $499 on March 15",
				timestamp: daysAgo(18),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s8",
				role: "user",
				body: "Customer account created in 2023, premium tier since 2024",
				timestamp: daysAgo(17),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s8",
				role: "user",
				body: "Customer reported issue with login 5 times in last month",
				timestamp: daysAgo(16),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s9",
				role: "assistant",
				body: "I see a pattern of recurring login issues for this customer",
				timestamp: daysAgo(16),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s9",
				role: "user",
				body: "The customer uses Firefox on macOS Sequoia",
				timestamp: daysAgo(15),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s10",
				role: "user",
				body: "Support hours are Mon-Fri 8am-6pm PST",
				timestamp: daysAgo(14),
			},
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s10",
				role: "user",
				body: "SLA for premium tier is 4-hour response time",
				timestamp: daysAgo(13),
			},

			// Session conversations
			...generateConversationFiller(
				SUPPORT_AGENT_TIER1,
				"t1",
				30,
				65,
				daysAgo(12),
			),

			// ANOMALY: legal threat
			{
				agentId: SUPPORT_AGENT_TIER1,
				sessionId: "t1-s50",
				role: "user",
				body: "The customer is threatening legal action if we don't resolve this within 24 hours",
				timestamp: daysAgo(1),
				isAnomaly: true,
			},
		]

		// -----------------------------------------------------------------------
		// SUPPORT-AGENT-TIER2 events (70+)
		// -----------------------------------------------------------------------
		const tier2Events: SeedEvent[] = [
			// Preferences
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s1",
				role: "user",
				body: "I prefer structured root cause analysis for every escalation",
				timestamp: daysAgo(27),
			},
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s1",
				role: "user",
				body: "I always document workarounds in the knowledge base",
				timestamp: daysAgo(26),
			},
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s2",
				role: "user",
				body: "I prefer investigating logs before contacting engineering",
				timestamp: daysAgo(25),
			},

			// Decisions
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s3",
				role: "user",
				body: "I decided to create runbooks for all recurring issues",
				timestamp: daysAgo(24),
			},
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s3",
				role: "user",
				body: "I chose to implement weekly trend analysis on support tickets",
				timestamp: daysAgo(23),
			},

			// Facts and escalation conversations
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s4",
				role: "user",
				body: "The database timeout threshold is 30 seconds",
				timestamp: daysAgo(22),
			},
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s4",
				role: "assistant",
				body: "30-second timeout might be too aggressive for complex queries",
				timestamp: daysAgo(22),
			},
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s5",
				role: "user",
				body: "Average resolution time for tier 2 is 2 business days",
				timestamp: daysAgo(21),
			},
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s5",
				role: "user",
				body: "We use PagerDuty for on-call rotation",
				timestamp: daysAgo(20),
			},
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s6",
				role: "user",
				body: "The error rate spiked to 5% yesterday",
				timestamp: daysAgo(19),
			},
			{
				agentId: SUPPORT_AGENT_TIER2,
				sessionId: "t2-s6",
				role: "assistant",
				body: "5% error rate is above the 2% threshold for incident declaration",
				timestamp: daysAgo(19),
			},

			// Volume fill
			...generateConversationFiller(
				SUPPORT_AGENT_TIER2,
				"t2",
				25,
				60,
				daysAgo(18),
			),
		]

		const supportEvents = [...tier1Events, ...tier2Events]
		await primeEmbeddings(supportEvents)
		for (const evt of supportEvents) {
			await seedEvent(db, evt)
		}

		const supportTotal = tier1Events.length + tier2Events.length
		totalSeededEvents += supportTotal
		expect(supportTotal).toBeGreaterThan(150)
	})

	it("seeds Personal Productivity scenario (1 agent, 100+ events)", async () => {
		const prodEvents: SeedEvent[] = [
			// Preferences
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s1",
				role: "user",
				body: "I prefer morning meetings before 10am",
				timestamp: daysAgo(21),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s1",
				role: "user",
				body: "I like having no calls on Friday for deep work",
				timestamp: daysAgo(21),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s1",
				role: "user",
				body: "I always use time blocking for important tasks",
				timestamp: daysAgo(20),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s2",
				role: "user",
				body: "I prefer using Todoist for task management",
				timestamp: daysAgo(19),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s2",
				role: "user",
				body: "I always review my goals every Sunday evening",
				timestamp: daysAgo(18),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s3",
				role: "user",
				body: "I prefer Pomodoro technique for focused work sessions",
				timestamp: daysAgo(17),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s3",
				role: "user",
				body: "I like having a weekly 1:1 with my manager on Tuesdays",
				timestamp: daysAgo(16),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s4",
				role: "user",
				body: "I always start the day by checking my priority list",
				timestamp: daysAgo(15),
			},

			// Decisions
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s5",
				role: "user",
				body: "I decided to cancel my newsletter subscription to reduce distractions",
				timestamp: daysAgo(14),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s5",
				role: "user",
				body: "I decided to switch to a standing desk setup",
				timestamp: daysAgo(13),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s6",
				role: "user",
				body: "I chose to batch email replies to 3 times per day",
				timestamp: daysAgo(12),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s6",
				role: "user",
				body: "I went with a 5am wake-up time for morning routines",
				timestamp: daysAgo(11),
			},

			// Facts
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s7",
				role: "user",
				body: "Q4 report is due December 15",
				timestamp: daysAgo(10),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s7",
				role: "user",
				body: "The team has 8 members across 3 time zones",
				timestamp: daysAgo(9),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s7",
				role: "assistant",
				body: "Managing across 3 time zones requires async-first communication",
				timestamp: daysAgo(9),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s8",
				role: "user",
				body: "Annual budget review is in November",
				timestamp: daysAgo(8),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s8",
				role: "user",
				body: "I have 15 days of PTO remaining this year",
				timestamp: daysAgo(7),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s9",
				role: "user",
				body: "My performance review is scheduled for next month",
				timestamp: daysAgo(6),
			},
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s9",
				role: "assistant",
				body: "Start preparing your self-assessment ahead of time",
				timestamp: daysAgo(6),
			},

			// Volume fill
			...generateConversationFiller(PROD_AGENT, "prod", 20, 85, daysAgo(5)),

			// ANOMALY: career change consideration
			{
				agentId: PROD_AGENT,
				sessionId: "prod-s30",
				role: "user",
				body: "I'm seriously considering a complete career change to become a woodworking artisan",
				timestamp: daysAgo(1),
				isAnomaly: true,
			},
		]

		await primeEmbeddings(prodEvents)
		for (const evt of prodEvents) {
			await seedEvent(db, evt)
		}

		totalSeededEvents += prodEvents.length
		expect(prodEvents.length).toBeGreaterThan(100)
	})

	it("seeds structured memory with sourceEventIds for chain testing", async () => {
		// For each coding agent, write structured memory entries pointing to seeded events
		for (const agentId of CODING_AGENTS) {
			const agentEvents = eventIdsByAgent.get(agentId)
			if (!agentEvents || agentEvents.length < 3) continue

			await writeStructuredMemory({
				db,
				prefix: TEST_PREFIX,
				entry: {
					type: "preference",
					key: `preferred-language-${agentId}`,
					value: "TypeScript over JavaScript",
					agentId,
					source: "agent",
					sourceEventIds: [agentEvents[0], agentEvents[1]],
				},
				embeddingMode: "automated",
			})

			await writeStructuredMemory({
				db,
				prefix: TEST_PREFIX,
				entry: {
					type: "decision",
					key: `runtime-choice-${agentId}`,
					value: "Bun instead of Node",
					agentId,
					source: "agent",
					sourceEventIds: [agentEvents[2]],
				},
				embeddingMode: "automated",
			})
		}

		// Support agents: write procedure-style structured memory
		for (const agentId of SUPPORT_AGENTS) {
			const agentEvents = eventIdsByAgent.get(agentId)
			if (!agentEvents || agentEvents.length < 2) continue

			await writeStructuredMemory({
				db,
				prefix: TEST_PREFIX,
				entry: {
					type: "fact",
					key: `error-fix-procedure-${agentId}`,
					value: "Reinstall driver to fix error X",
					agentId,
					source: "agent",
					sourceEventIds: [agentEvents[0]],
				},
				embeddingMode: "automated",
			})
		}

		// Prod agent
		const prodEvents = eventIdsByAgent.get(PROD_AGENT)
		if (prodEvents && prodEvents.length >= 2) {
			await writeStructuredMemory({
				db,
				prefix: TEST_PREFIX,
				entry: {
					type: "preference",
					key: `morning-meetings-${PROD_AGENT}`,
					value: "Morning meetings before 10am",
					agentId: PROD_AGENT,
					source: "agent",
					sourceEventIds: [prodEvents[0]],
				},
				embeddingMode: "automated",
			})
		}
	})

	it("total seeded events >= 450", () => {
		expect(totalSeededEvents).toBeGreaterThanOrEqual(450)
	})
})
