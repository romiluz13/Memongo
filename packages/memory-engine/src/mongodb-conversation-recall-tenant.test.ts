// M2 T13 (#120): recall is confined to one tenant. Both the chronological
// find and the hybrid lane carry agentId, scope and scopeRef; a request that
// lacks any of them fails typed before a collection is touched.
import type { Collection, Db, Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./mongodb-schema.js", () => ({ eventsCollection: vi.fn() }))
vi.mock("./mongodb-telemetry.js", () => ({ emitTelemetry: vi.fn() }))
import { recallConversation } from "./mongodb-conversation-recall.js"
import { eventsCollection } from "./mongodb-schema.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { TenantIdentityRequiredError } from "./mongodb-tenant-identity.js"

const TENANT = { scope: "workspace", scopeRef: "workspace:mine" } as const
const event = {
	eventId: "event1",
	role: "user",
	agentId: "a1",
	body: "result",
	timestamp: new Date("2026-01-01T00:00:00Z"),
}

let pipelines: Document[][] = []
let filters: Document[] = []

beforeEach(() => {
	pipelines = []
	filters = []
	resetSearchAdmissionForTests(Date.now())
	vi.mocked(eventsCollection).mockReturnValue({
		aggregate: vi.fn((pipeline: Document[]) => {
			pipelines.push(pipeline)
			return { toArray: async () => [event] }
		}),
		find: vi.fn((filter: Document) => {
			filters.push(filter)
			return {
				sort: () => ({ limit: () => ({ toArray: async () => [event] }) }),
			}
		}),
	} as unknown as Collection)
})
afterEach(() => vi.clearAllMocks())

function recall(request: Record<string, unknown>) {
	return recallConversation({
		db: {} as Db,
		prefix: "test_",
		request: { agentId: "a1", ...request } as never,
	})
}

describe("recall confines the chronological listing to the tenant", () => {
	it("filters on agentId, scope and the trimmed scopeRef", async () => {
		await recall({ scope: "workspace", scopeRef: "  workspace:mine  " })

		expect(filters).toHaveLength(1)
		expect(filters[0]).toMatchObject({
			agentId: "a1",
			scope: "workspace",
			scopeRef: "workspace:mine",
		})
	})
})

describe("recall confines the hybrid lane to the tenant", () => {
	it("carries scope and scopeRef in the vector filter, the text filter and both revalidation stages", async () => {
		await recall({ ...TENANT, query: "deploy" })

		const inner = pipelines[0]?.[0]?.$rankFusion?.input?.pipelines
		const vectorFilter = inner?.vector?.[0]?.$vectorSearch?.filter
		expect(vectorFilter).toMatchObject({
			scope: { $eq: "workspace" },
			scopeRef: { $eq: "workspace:mine" },
		})
		const textFilter = JSON.stringify(inner?.text?.[0]?.$search?.compound)
		expect(textFilter).toContain("workspace:mine")
		expect(JSON.stringify(inner?.vector?.[1])).toContain("workspace:mine")
		expect(JSON.stringify(inner?.text?.[1])).toContain("workspace:mine")
	})
})

describe("recall without the full tenant identity fails typed", () => {
	it.each([
		["no scope", { scopeRef: "workspace:mine" }, ["scope"]],
		["no scopeRef", { scope: "workspace" }, ["scopeRef"]],
		[
			"an empty scopeRef",
			{ scope: "workspace", scopeRef: "   " },
			["scopeRef"],
		],
		["an unknown scope", { scope: "galaxy", scopeRef: "x" }, ["scope"]],
		["neither", {}, ["scope", "scopeRef"]],
	])("%s, with a query", async (_label, identity, missing) => {
		const failure = await recall({ ...identity, query: "deploy" }).then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(TenantIdentityRequiredError)
		expect(failure).toMatchObject({ operation: "recallConversation", missing })
		expect(eventsCollection).not.toHaveBeenCalled()
		expect(pipelines).toHaveLength(0)
		expect(filters).toHaveLength(0)
	})

	it.each([
		["no scope", { scopeRef: "workspace:mine" }],
		["no scopeRef", { scope: "workspace" }],
		["neither", {}],
	])("%s, without a query", async (_label, identity) => {
		await expect(recall({ ...identity })).rejects.toBeInstanceOf(
			TenantIdentityRequiredError,
		)
		expect(eventsCollection).not.toHaveBeenCalled()
		expect(filters).toHaveLength(0)
	})

	it("fails on identity before it validates an inverted date range", async () => {
		await expect(
			recall({
				startTime: "2026-01-02T00:00:00Z",
				endTime: "2026-01-01T00:00:00Z",
			}),
		).rejects.toBeInstanceOf(TenantIdentityRequiredError)
	})
})
