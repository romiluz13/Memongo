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

function hoursAgo(hours: number): Date {
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
let _totalSeededEvents = 0

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
	it("seeds AI Coding Assistant scenario (3 agents, 200+ events)", async () => {
		// -----------------------------------------------------------------------
		// CODING-AGENT-ARCH events (70+)
		// -----------------------------------------------------------------------
		const archEvents: SeedEvent[] = [
			// Preferences (10)
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s1",
				role: "user",
				body: "I prefer TypeScript over JavaScript for all new projects",
				timestamp: daysAgo(27),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s1",
				role: "user",
				body: "I always use dark mode in my editor",
				timestamp: daysAgo(27),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s1",
				role: "user",
				body: "I prefer tabs over spaces, 4-width",
				timestamp: daysAgo(26),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s1",
				role: "user",
				body: "I prefer functional programming patterns over OOP",
				timestamp: daysAgo(26),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s2",
				role: "user",
				body: "I always use ESLint for code quality",
				timestamp: daysAgo(25),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s2",
				role: "user",
				body: "I prefer Vitest over Jest for testing",
				timestamp: daysAgo(25),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s2",
				role: "user",
				body: "I prefer monorepos with pnpm workspaces",
				timestamp: daysAgo(24),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s3",
				role: "user",
				body: "I always use strict TypeScript settings",
				timestamp: daysAgo(23),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s3",
				role: "user",
				body: "I prefer Zod for runtime validation",
				timestamp: daysAgo(22),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s3",
				role: "user",
				body: "I prefer pure functions over classes when possible",
				timestamp: daysAgo(21),
			},

			// Decisions (8)
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s4",
				role: "user",
				body: "I decided to use Bun instead of Node for the runtime",
				timestamp: daysAgo(20),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s4",
				role: "user",
				body: "I decided to use MongoDB Atlas for the database",
				timestamp: daysAgo(20),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s4",
				role: "user",
				body: "I chose GitHub Actions for CI/CD",
				timestamp: daysAgo(19),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s5",
				role: "user",
				body: "I picked Hono for the API framework",
				timestamp: daysAgo(18),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s5",
				role: "user",
				body: "I decided to deploy on Vercel for the frontend",
				timestamp: daysAgo(17),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s5",
				role: "user",
				body: "I chose Tailwind CSS for styling",
				timestamp: daysAgo(16),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s6",
				role: "user",
				body: "I went with Docker for containerization",
				timestamp: daysAgo(15),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s6",
				role: "user",
				body: "I selected Turborepo for build orchestration",
				timestamp: daysAgo(14),
			},

			// Facts (10)
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s7",
				role: "user",
				body: "Our deployment pipeline uses GitHub Actions with Docker",
				timestamp: daysAgo(13),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s7",
				role: "user",
				body: "The staging environment is on AWS ECS",
				timestamp: daysAgo(13),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s7",
				role: "user",
				body: "Production budget is $5k per month",
				timestamp: daysAgo(12),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s8",
				role: "user",
				body: "The team uses Slack for communication",
				timestamp: daysAgo(11),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s8",
				role: "user",
				body: "Sprint cycles are 2 weeks",
				timestamp: daysAgo(10),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s8",
				role: "user",
				body: "Code reviews require at least 2 approvals",
				timestamp: daysAgo(9),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s9",
				role: "user",
				body: "The API rate limit is 1000 requests per minute",
				timestamp: daysAgo(8),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s9",
				role: "user",
				body: "Database backups run every 6 hours",
				timestamp: daysAgo(7),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s10",
				role: "user",
				body: "The project started in January 2026",
				timestamp: daysAgo(6),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s10",
				role: "user",
				body: "We have 12 microservices in production",
				timestamp: daysAgo(5),
			},

			// Assistant responses (15)
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s1",
				role: "assistant",
				body: "TypeScript is an excellent choice for type safety",
				timestamp: daysAgo(27),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s1",
				role: "assistant",
				body: "Dark mode is easier on the eyes for long coding sessions",
				timestamp: daysAgo(27),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s2",
				role: "assistant",
				body: "ESLint with TypeScript plugin provides great coverage",
				timestamp: daysAgo(25),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s3",
				role: "assistant",
				body: "Zod integrates well with TypeScript inference",
				timestamp: daysAgo(22),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s4",
				role: "assistant",
				body: "Bun offers significant speed improvements for dev workflows",
				timestamp: daysAgo(20),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s5",
				role: "assistant",
				body: "Hono is lightweight and fast, perfect for APIs",
				timestamp: daysAgo(18),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s6",
				role: "assistant",
				body: "Docker ensures consistent environments across stages",
				timestamp: daysAgo(15),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s7",
				role: "assistant",
				body: "Your CI/CD pipeline sounds well-structured",
				timestamp: daysAgo(13),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s8",
				role: "assistant",
				body: "Two-week sprints are a good balance of velocity and quality",
				timestamp: daysAgo(10),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s9",
				role: "assistant",
				body: "1000 req/min is a reasonable starting point",
				timestamp: daysAgo(8),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s10",
				role: "assistant",
				body: "12 microservices need solid observability tooling",
				timestamp: daysAgo(5),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s11",
				role: "assistant",
				body: "Let me review the architecture for your suggestion",
				timestamp: daysAgo(4),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s11",
				role: "assistant",
				body: "The current patterns look solid for this scale",
				timestamp: daysAgo(4),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s12",
				role: "assistant",
				body: "I recommend adding health check endpoints to every service",
				timestamp: daysAgo(3),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s12",
				role: "assistant",
				body: "Consider implementing circuit breakers for resilience",
				timestamp: daysAgo(3),
			},

			// ANOMALY: sudden tech switch
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s13",
				role: "user",
				body: "I'm seriously considering switching everything to Rust for performance reasons",
				timestamp: daysAgo(2),
				isAnomaly: true,
			},
			// ANOMALY: reconsidering cloud provider
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s13",
				role: "user",
				body: "I'm thinking about migrating from AWS to Google Cloud entirely",
				timestamp: daysAgo(1),
				isAnomaly: true,
			},

			// Normal follow-up (5)
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s14",
				role: "user",
				body: "What caching strategy do you recommend for our API?",
				timestamp: hoursAgo(20),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s14",
				role: "assistant",
				body: "For your scale, Redis with LRU eviction works well",
				timestamp: hoursAgo(20),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s14",
				role: "user",
				body: "How should we handle database migrations?",
				timestamp: hoursAgo(18),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s14",
				role: "assistant",
				body: "Use a migration tool that supports rollbacks",
				timestamp: hoursAgo(18),
			},
			{
				agentId: CODING_AGENT_ARCH,
				sessionId: "arch-s15",
				role: "user",
				body: "Can you review the error handling in our service layer?",
				timestamp: hoursAgo(10),
			},
		]

		// -----------------------------------------------------------------------
		// CODING-AGENT-IMPL events (70+)
		// -----------------------------------------------------------------------
		const implEvents: SeedEvent[] = [
			// Preferences
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s1",
				role: "user",
				body: "I prefer async/await over callbacks everywhere",
				timestamp: daysAgo(27),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s1",
				role: "user",
				body: "I always use named exports instead of default exports",
				timestamp: daysAgo(27),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s1",
				role: "user",
				body: "I prefer early returns over nested if statements",
				timestamp: daysAgo(26),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s2",
				role: "user",
				body: "I prefer descriptive variable names over abbreviations",
				timestamp: daysAgo(25),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s2",
				role: "user",
				body: "I always use const unless mutation is needed",
				timestamp: daysAgo(24),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s3",
				role: "user",
				body: "I prefer Map/Set over plain objects for collections",
				timestamp: daysAgo(23),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s3",
				role: "user",
				body: "I prefer explicit error types over generic Error",
				timestamp: daysAgo(22),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s3",
				role: "user",
				body: "I always use template literals for string interpolation",
				timestamp: daysAgo(21),
			},

			// Decisions
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s4",
				role: "user",
				body: "I decided to use dependency injection for testability",
				timestamp: daysAgo(20),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s4",
				role: "user",
				body: "I chose the repository pattern for data access",
				timestamp: daysAgo(19),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s5",
				role: "user",
				body: "I picked builder pattern for complex object creation",
				timestamp: daysAgo(18),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s5",
				role: "user",
				body: "I decided to use Result types instead of exceptions for business errors",
				timestamp: daysAgo(17),
			},

			// Facts and conversations
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s6",
				role: "user",
				body: "The user service handles authentication and profile management",
				timestamp: daysAgo(16),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s6",
				role: "assistant",
				body: "Good separation of concerns for the user service",
				timestamp: daysAgo(16),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s6",
				role: "user",
				body: "We use JWT tokens with 24-hour expiration",
				timestamp: daysAgo(15),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s7",
				role: "user",
				body: "The order service processes about 10k orders per day",
				timestamp: daysAgo(14),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s7",
				role: "assistant",
				body: "At that volume you should batch database operations",
				timestamp: daysAgo(14),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s7",
				role: "user",
				body: "Payment processing uses Stripe API",
				timestamp: daysAgo(13),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s8",
				role: "user",
				body: "File uploads go to S3 with presigned URLs",
				timestamp: daysAgo(12),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s8",
				role: "user",
				body: "We use SendGrid for transactional emails",
				timestamp: daysAgo(11),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s8",
				role: "assistant",
				body: "SendGrid has good delivery rates for transactional email",
				timestamp: daysAgo(11),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s9",
				role: "user",
				body: "The notification service uses WebSockets for real-time updates",
				timestamp: daysAgo(10),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s9",
				role: "user",
				body: "Background jobs run on Bull MQ with Redis backing",
				timestamp: daysAgo(9),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s10",
				role: "user",
				body: "API versioning uses URL path prefixes",
				timestamp: daysAgo(8),
			},
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s10",
				role: "assistant",
				body: "URL-based versioning is the most explicit approach",
				timestamp: daysAgo(8),
			},

			// More conversations to fill volume
			...generateConversationFiller(
				CODING_AGENT_IMPL,
				"impl",
				25,
				70,
				daysAgo(7),
			),

			// ANOMALY: considering Supabase
			{
				agentId: CODING_AGENT_IMPL,
				sessionId: "impl-s20",
				role: "user",
				body: "I'm seriously considering switching our entire backend to Supabase instead of MongoDB",
				timestamp: daysAgo(1),
				isAnomaly: true,
			},
		]

		// -----------------------------------------------------------------------
		// CODING-AGENT-REVIEW events (60+)
		// -----------------------------------------------------------------------
		const reviewEvents: SeedEvent[] = [
			// Preferences
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s1",
				role: "user",
				body: "I prefer thorough code reviews with inline comments",
				timestamp: daysAgo(27),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s1",
				role: "user",
				body: "I always use semantic commit messages",
				timestamp: daysAgo(26),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s2",
				role: "user",
				body: "I prefer small, focused pull requests over large ones",
				timestamp: daysAgo(25),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s2",
				role: "user",
				body: "I always use branch protection rules",
				timestamp: daysAgo(24),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s3",
				role: "user",
				body: "I prefer automated tests over manual testing",
				timestamp: daysAgo(23),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s3",
				role: "user",
				body: "I like using conventional commits for changelog generation",
				timestamp: daysAgo(22),
			},

			// Decisions
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s4",
				role: "user",
				body: "I decided to enforce 80% code coverage minimum",
				timestamp: daysAgo(21),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s4",
				role: "user",
				body: "I chose to require passing CI before merge",
				timestamp: daysAgo(20),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s5",
				role: "user",
				body: "I selected SonarQube for static analysis",
				timestamp: daysAgo(19),
			},

			// Facts and review conversations
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s6",
				role: "user",
				body: "The review checklist has 15 items",
				timestamp: daysAgo(18),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s6",
				role: "assistant",
				body: "A structured checklist helps catch common issues",
				timestamp: daysAgo(18),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s7",
				role: "user",
				body: "Average PR review time is 4 hours",
				timestamp: daysAgo(17),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s7",
				role: "user",
				body: "We merge about 20 PRs per week",
				timestamp: daysAgo(16),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s8",
				role: "user",
				body: "Security reviews are required for auth changes",
				timestamp: daysAgo(15),
			},
			{
				agentId: CODING_AGENT_REVIEW,
				sessionId: "rev-s8",
				role: "assistant",
				body: "Security-focused reviews for auth code is best practice",
				timestamp: daysAgo(15),
			},

			// Fill volume
			...generateConversationFiller(
				CODING_AGENT_REVIEW,
				"rev",
				15,
				65,
				daysAgo(14),
			),
		]

		// Seed all coding events
		const codingEvents = [...archEvents, ...implEvents, ...reviewEvents]
		await primeEmbeddings(codingEvents)
		for (const evt of codingEvents) {
			await seedEvent(db, evt)
		}

		const codingTotal =
			archEvents.length + implEvents.length + reviewEvents.length
		_totalSeededEvents += codingTotal
		expect(codingTotal).toBeGreaterThan(200)
	})
})
