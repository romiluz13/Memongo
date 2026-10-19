// M2 T13 (#120): extractEvent's ownership check applies the event lifecycle and
// runs for every caller, so an expired, invalidated or not-yet-valid event is
// never scheduled for extraction, with or without a scope.
import type { Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { MongoDBManagerWriteOps } from "./mongodb-manager-write.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

vi.mock("./mongodb-write-fence.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => ({
		kind: "admission" as const,
		agentId,
		epoch: 0,
	})),
}))

const AGENT_ID = "agent-1"
const PREFIX = "test_"
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const ahead = (days: number) => new Date(Date.now() + days * DAY)

function event(eventId: string, over: Document = {}): Document {
	return {
		agentId: AGENT_ID,
		scope: "agent",
		scopeRef: `agent:${AGENT_ID}`,
		eventId,
		role: "user",
		body: eventId,
		timestamp: ago(1),
		...over,
	}
}

const scheduleBackgroundExtraction = vi.fn(async (eventId: string) => ({
	jobId: `extraction-${eventId}`,
	scheduled: true,
}))

async function writeOps(events: Document[]) {
	const fake = createStatefulMongoFake({ prefix: PREFIX })
	await fake.collection("events").insertMany(events)
	const host = {
		db: fake.db as unknown as Db,
		prefix: PREFIX,
		agentId: AGENT_ID,
		closed: false,
		memoryJobWorkerGeneration: 0,
		scheduleBackgroundExtraction,
	} as unknown as MongoDBManagerHost
	return new MongoDBManagerWriteOps(host)
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	)
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("extractEvent applies the event lifecycle to its ownership check", () => {
	it("schedules a live event, with a scope and without one", async () => {
		const ops = await writeOps([event("live")])

		await expect(ops.extractEvent({ eventId: "live" })).resolves.toMatchObject({
			scheduled: true,
		})
		await expect(
			ops.extractEvent({
				eventId: "live",
				scope: "agent",
				scopeRef: `agent:${AGENT_ID}`,
			}),
		).resolves.toMatchObject({ scheduled: true })
		expect(scheduleBackgroundExtraction).toHaveBeenCalledTimes(2)
	})

	it.each([
		["expired", { expiresAt: ago(1) }],
		["invalidated", { invalidAt: ago(1) }],
		["not yet valid", { validAt: ahead(1) }],
	])("refuses an %s event as EventNotInScopeError and schedules nothing", async (_label, lifecycle) => {
		const ops = await writeOps([event("dead", lifecycle)])

		const unscoped = await failureOf(ops.extractEvent({ eventId: "dead" }))
		const scoped = await failureOf(
			ops.extractEvent({
				eventId: "dead",
				scope: "agent",
				scopeRef: `agent:${AGENT_ID}`,
			}),
		)

		for (const failure of [unscoped, scoped]) {
			expect(failure).toBeInstanceOf(Error)
			expect((failure as Error).name).toBe("EventNotInScopeError")
		}
		expect(scheduleBackgroundExtraction).not.toHaveBeenCalled()
	})

	it("refuses an unknown event and another agent's event without a scope", async () => {
		const ops = await writeOps([event("theirs", { agentId: "agent-2" })])

		for (const eventId of ["theirs", "missing"]) {
			const failure = await failureOf(ops.extractEvent({ eventId }))
			expect((failure as Error).name).toBe("EventNotInScopeError")
		}
		expect(scheduleBackgroundExtraction).not.toHaveBeenCalled()
	})

	it("still refuses an event of another scopeRef when a scope is named", async () => {
		const ops = await writeOps([
			event("elsewhere", { scopeRef: "agent:other" }),
		])

		const failure = await failureOf(
			ops.extractEvent({
				eventId: "elsewhere",
				scope: "agent",
				scopeRef: `agent:${AGENT_ID}`,
			}),
		)

		expect((failure as Error).name).toBe("EventNotInScopeError")
		expect(scheduleBackgroundExtraction).not.toHaveBeenCalled()
	})
})
