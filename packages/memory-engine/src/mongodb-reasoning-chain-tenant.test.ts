// M2 T13 (#120): the reasoning chain confines the starting fact, the premise
// traversal and the leaf events to the full tenant (agentId, scope, scopeRef),
// and a call without the full identity fails typed before any collection is
// touched.
import type { Db, Document } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { traceReasoningChain } from "./mongodb-reasoning-chain.js"
import { TenantIdentityRequiredError } from "./mongodb-tenant-identity.js"

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const TENANT = {
	agentId: AGENT_ID,
	scope: "workspace",
	scopeRef: "workspace:mine",
} as const

function recordingDb(config: {
	aggregateResults?: Record<string, Document[]>
	findResults?: Record<string, Document[]>
}) {
	const aggregates = new Map<string, ReturnType<typeof vi.fn>>()
	const finds = new Map<string, ReturnType<typeof vi.fn>>()
	const db = {
		collection: (name: string) => {
			const aggregate = vi.fn().mockReturnValue({
				toArray: vi
					.fn()
					.mockResolvedValue(config.aggregateResults?.[name] ?? []),
			})
			const find = vi.fn().mockReturnValue({
				sort: vi.fn().mockReturnValue({
					toArray: vi.fn().mockResolvedValue(config.findResults?.[name] ?? []),
				}),
			})
			aggregates.set(name, aggregate)
			finds.set(name, find)
			return { aggregate, find }
		},
	} as unknown as Db
	return { db, aggregates, finds }
}

describe("traceReasoningChain tenant confinement", () => {
	it("confines the starting fact, the premise traversal and the leaf events to the tenant", async () => {
		const { db, aggregates, finds } = recordingDb({
			aggregateResults: {
				[`${PREFIX}structured_mem`]: [
					{
						key: "fact-1",
						...TENANT,
						value: "a fact",
						sourceEventIds: ["evt-1"],
						premises: [],
					},
				],
			},
			findResults: {
				[`${PREFIX}events`]: [
					{
						eventId: "evt-1",
						body: "an event",
						role: "user",
						timestamp: new Date(),
					},
				],
			},
		})

		await traceReasoningChain({
			db,
			prefix: PREFIX,
			factId: "fact-1",
			collection: "structured_mem",
			...TENANT,
		})

		const pipeline = aggregates.get(`${PREFIX}structured_mem`)?.mock
			.calls[0]?.[0] as Document[]
		expect(pipeline[0]).toMatchObject({ $match: { key: "fact-1", ...TENANT } })
		expect(pipeline[1]).toMatchObject({
			$graphLookup: { restrictSearchWithMatch: TENANT },
		})
		expect(finds.get(`${PREFIX}events`)?.mock.calls[0]?.[0]).toMatchObject({
			eventId: { $in: ["evt-1"] },
			...TENANT,
			$or: [
				{ expiresAt: { $exists: false } },
				{ expiresAt: { $gt: expect.any(Date) } },
			],
		})
	})

	const untouched = {
		collection: () => {
			throw new Error("a collection was touched")
		},
	} as unknown as Db

	it.each([
		["no scope", { agentId: AGENT_ID, scopeRef: "workspace:mine" }, ["scope"]],
		["no scopeRef", { agentId: AGENT_ID, scope: "workspace" }, ["scopeRef"]],
		[
			"an empty scopeRef",
			{ agentId: AGENT_ID, scope: "workspace", scopeRef: " " },
			["scopeRef"],
		],
		[
			"an unknown scope",
			{ agentId: AGENT_ID, scope: "galaxy", scopeRef: "x" },
			["scope"],
		],
	])("fails typed before any read with %s", async (_label, identity, missing) => {
		const failure = await traceReasoningChain({
			db: untouched,
			prefix: PREFIX,
			factId: "fact-1",
			collection: "structured_mem",
			...identity,
		} as never).then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(TenantIdentityRequiredError)
		expect(failure).toMatchObject({
			operation: "traceReasoningChain",
			missing,
		})
	})
})
