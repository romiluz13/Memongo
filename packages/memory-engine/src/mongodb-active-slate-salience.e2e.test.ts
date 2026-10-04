import { randomUUID } from "node:crypto"
import { MongoClient, type Document } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { hydrateActiveSlate } from "./mongodb-active-slate.js"
import { buildContextBundle } from "./mongodb-context-bundle.js"
import { ensureCollections, ensureStandardIndexes } from "./mongodb-schema.js"
import { resolvePreviewMongoTestUri } from "./test-helpers/preview-env.js"

const uri = resolvePreviewMongoTestUri(
	"mongodb://admin:admin@localhost:27017/memongo?authSource=admin&replicaSet=rs0&directConnection=true",
)

const client = new MongoClient(uri, { monitorCommands: true })
const name = `memongo_active_salience_${randomUUID().replaceAll("-", "")}`
const db = client.db(name)
const prefix = "test_"
const structured = db.collection(`${prefix}structured_mem`)
const queries: Document[] = []
client.on("commandStarted", (event) => {
	if (event.commandName === "find" && event.command.filter?.salience)
		queries.push(event.command)
})

function params(agentId: string) {
	return {
		db,
		prefix,
		agentId,
		scope: "agent" as const,
		scopeRef: `${agentId}-ref`,
	}
}

function row(
	agentId: string,
	key: string,
	salience: string,
	offset = 0,
	extra: Document = {},
): Document {
	return {
		agentId,
		scope: "agent",
		scopeRef: `${agentId}-ref`,
		type: "todo",
		key,
		value: key,
		salience,
		state: "active",
		updatedAt: new Date(Date.now() - offset),
		...extra,
	}
}

beforeAll(async () => {
	vi.stubEnv("MEMONGO_TELEMETRY_ENABLED", "false")
	await client.connect()
	await ensureCollections(db, prefix)
	await ensureStandardIndexes(db, prefix, { textFallbackIndexes: false })
	await structured.insertMany([
		row("old", "old-blocker", "critical", 100_000),
		...Array.from({ length: 8 }, (_, index) =>
			row("old", `high-${index}`, "high", index * 1000),
		),
		...Array.from({ length: 8 }, (_, index) =>
			row("critical", `critical-${index}`, "critical", index * 1000),
		),
		...Array.from({ length: 8 }, (_, index) =>
			row("high", `high-${index}`, "high", index * 1000),
		),
		row("filtered", "current", "critical"),
		row("foreign", "foreign-agent", "critical", 0, {
			scopeRef: "filtered-ref",
		}),
		row("filtered", "foreign-scope", "critical", 0, { scope: "workspace" }),
		row("filtered", "foreign-ref", "critical", 0, { scopeRef: "other" }),
		row("filtered", "expired", "critical", 0, {
			expiresAt: new Date(Date.now() - 1000),
		}),
		row("filtered", "future", "critical", 0, {
			validFrom: new Date(Date.now() + 3_600_000),
		}),
		row("filtered", "ended", "critical", 0, {
			validTo: new Date(Date.now() - 1000),
		}),
		row("filtered", "inactive", "critical", 0, { state: "invalidated" }),
	])
})

afterAll(async () => {
	try {
		await db.dropDatabase()
		const listed = await client
			.db("admin")
			.admin()
			.listDatabases({ nameOnly: true, filter: { name } })
		expect(listed.databases).toEqual([])
	} finally {
		vi.unstubAllEnvs()
		await client.close()
	}
})

describe("active slate salience on real MongoDB", () => {
	it("retains an older critical item beyond eight newer high items", async () => {
		const start = queries.length
		const slate = await hydrateActiveSlate(params("old"))
		expect(slate.items[0].title).toBe("old-blocker")
		expect(slate.items).toHaveLength(5)
		expect(slate.metadata.partial).toBe(false)
		const query = queries[start]
		expect(Object.fromEntries(query.sort as Map<string, number>)).toEqual({
			salience: 1,
			updatedAt: -1,
		})
		expect(query.limit).toBe(6)
	})

	it("delivers the critical blocker through the default wake-up bundle", async () => {
		const bundle = await buildContextBundle({
			...params("old"),
			request: { mode: "wake-up" },
		})
		expect(bundle.rendered).toContain("old-blocker")
		expect(
			bundle.sections.find((section) => section.kind === "active-slate")
				?.items[0].title,
		).toBe("old-blocker")
		expect(bundle.metadata.partial).toBe(false)
		expect(bundle.metadata.estimatedTokensUsed).toBeLessThanOrEqual(250)
	})

	it.each([
		"critical",
		"high",
	])("keeps bounded newest-first selection within %s salience", async (salience) => {
		const slate = await hydrateActiveSlate({ ...params(salience), maxItems: 6 })
		expect(slate.items.map((item) => item.title)).toEqual(
			[0, 1, 2, 3, 4, 5].map((index) => `${salience}-${index}`),
		)
	})

	it("preserves owning scope, current validity, expiry and active-state filters", async () => {
		expect(
			await structured.countDocuments({ agentId: "filtered", key: "expired" }),
		).toBe(1)
		const slate = await hydrateActiveSlate(params("filtered"))
		expect(slate.items.map((item) => item.title)).toEqual(["current"])
		expect(slate.metadata.partial).toBe(false)
	})

	it("keeps a legitimately empty agent healthy", async () => {
		const slate = await hydrateActiveSlate(params("empty"))
		expect(slate.items).toEqual([])
		expect(slate.metadata.partial).toBe(false)
	})
})
