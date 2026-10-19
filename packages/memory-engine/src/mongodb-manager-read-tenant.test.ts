// M2 T13 (#120): readFile confines every tenant-owned locator to the tenant it
// names (`?scope=...&scopeRef=...`). A document of another scopeRef that shares
// the agent is never reopened, and a locator without the full identity fails
// typed before the erasure gate or any collection is touched.
import type { ClientSession, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MongoDBManagerReadOps } from "./mongodb-manager-read.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { TenantIdentityRequiredError } from "./mongodb-tenant-identity.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const gate = vi.hoisted(() => ({
	capture: vi.fn(async () => ({
		kind: "admission",
		agentId: "agent-1",
		epoch: 0,
	})),
	session: { fenceSession: true } as unknown as ClientSession,
}))

vi.mock("./mongodb-erasure-epoch.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-erasure-epoch.js")>()
	return { ...actual, captureAdmissionToken: gate.capture }
})

vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./mongodb-write-fence.js")>()
	return {
		...actual,
		withFencedWrite: vi.fn(
			async (params: { fn: (session: ClientSession) => Promise<unknown> }) =>
				params.fn(gate.session),
		),
	}
})

const PREFIX = "test_"
const AGENT_ID = "agent-1"
const MINE = { scope: "workspace", scopeRef: "workspace:mine" } as const
const THEIRS = { scope: "workspace", scopeRef: "workspace:theirs" } as const
const MINE_QUERY = "scope=workspace&scopeRef=workspace%3Amine"

function tenantDoc(tenant: Document, fields: Document): Document {
	return { agentId: AGENT_ID, ...tenant, ...fields }
}

type Tenants = Array<[string, Document]>

const BOTH: Tenants = [
	["theirs", THEIRS],
	["mine", MINE],
]
const ONLY_THEIRS: Tenants = [["theirs", THEIRS]]

function seed(
	fake: ReturnType<typeof createStatefulMongoFake>,
	tenants: Tenants,
) {
	const both = (suffix: string, fields: (who: string) => Document) =>
		fake
			.collection(suffix)
			.insertMany(
				tenants.map(([who, tenant]) => tenantDoc(tenant, fields(who))),
			)
	return Promise.all([
		both("structured_mem", (who) => ({
			type: "fact",
			key: "sky",
			value: `value of ${who}`,
		})),
		both("entities", (who) => ({
			entityId: "ent-1",
			name: `entity of ${who}`,
		})),
		both("procedures", (who) => ({
			procedureId: "proc-1",
			name: `procedure of ${who}`,
		})),
		both("events", (who) => ({
			eventId: `evt-${who}`,
			role: "user",
			body: `event of ${who}`,
			timestamp: new Date("2026-01-01T00:00:00Z"),
		})),
		both("episodes", (who) => ({
			episodeId: "ep-1",
			status: "active",
			type: "daily",
			title: `episode of ${who}`,
			summary: "summary",
			sourceEventIds: ["evt-1"],
			timeRange: {
				start: new Date("2026-01-01T00:00:00Z"),
				end: new Date("2026-01-02T00:00:00Z"),
			},
		})),
		both("chunks", (who) => ({
			path: `sessions/s-${who}`,
			source: "conversation",
			text: `chunk of ${who}`,
			startLine: 1,
			endLine: 2,
		})),
	])
}

function makeOps(db: Db): MongoDBManagerReadOps {
	return new MongoDBManagerReadOps({
		db,
		prefix: PREFIX,
		agentId: AGENT_ID,
		readCanonicalEvent: (
			eventId: string,
			rawPath: string,
			session?: ClientSession,
		) => ops.readCanonicalEvent(eventId, rawPath, session),
		readConversationChunk: (
			rawPath: string,
			from?: number,
			lines?: number,
			session?: ClientSession,
		) => ops.readConversationChunk(rawPath, from, lines, session),
		readEpisodeLocator: (
			params: Parameters<typeof ops.readEpisodeLocator>[0],
		) => ops.readEpisodeLocator(params),
		readBridgeChunk: vi.fn(),
	} as unknown as MongoDBManagerHost)
}

let ops: MongoDBManagerReadOps

beforeEach(() => {
	gate.capture.mockClear()
})

describe("readFile reopens only the tenant's document", () => {
	it.each([
		["structured", `structured:fact:sky?${MINE_QUERY}`, "value of mine"],
		["entity", `entity:ent-1?${MINE_QUERY}`, "entity of mine"],
		["procedure", `procedure:proc-1?${MINE_QUERY}`, "procedure of mine"],
		["event", `event:evt-mine?${MINE_QUERY}`, "event of mine"],
		["episode", `episode:ep-1?${MINE_QUERY}`, "episode of mine"],
		["conversation chunk", `sessions/s-mine?${MINE_QUERY}`, "chunk of mine"],
	])("%s locator returns the tenant's document", async (_family, locator, text) => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seed(fake, BOTH)
		ops = makeOps(fake.db as unknown as Db)

		const result = await ops.readFile({ relPath: locator })

		expect(result.text).toContain(text)
		expect(result.path).toContain("?")
	})

	it.each([
		["structured", "structured:fact:sky"],
		["entity", "entity:ent-1"],
		["procedure", "procedure:proc-1"],
		["event", "event:evt-theirs"],
		["episode", "episode:ep-1"],
		["conversation chunk", "sessions/s-theirs"],
	])("%s locator of another scopeRef reads as a miss, never the other tenant's document", async (_family, base) => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		await seed(fake, ONLY_THEIRS)
		ops = makeOps(fake.db as unknown as Db)

		const result = await ops.readFile({ relPath: `${base}?${MINE_QUERY}` })

		expect(result.text).toBe("")
	})
})

describe("readFile without the full tenant identity fails typed before any gate or read", () => {
	const untouched = {
		collection: () => {
			throw new Error("a collection was touched")
		},
	} as unknown as Db

	const locators = [
		"structured:fact:sky",
		"entity:ent-1",
		"procedure:proc-1",
		"event:evt-1",
		"episode:ep-1",
		"episode:ep-1?expand=events",
		"relation:ent-a-ent-b",
		"conversation:sessions/s-1",
		"events/evt-1",
		"sessions/s-1",
	]
	const identities: Array<[string, string, string[]]> = [
		["no identity", "", ["scope", "scopeRef"]],
		["no scope", "scopeRef=workspace%3Amine", ["scope"]],
		["no scopeRef", "scope=workspace", ["scopeRef"]],
		["an empty scopeRef", "scope=workspace&scopeRef=%20", ["scopeRef"]],
		["an unknown scope", "scope=galaxy&scopeRef=x", ["scope"]],
	]

	it.each(
		locators.flatMap((locator) =>
			identities.map(([label, query, missing]) => ({
				locator,
				label,
				missing,
				relPath: query
					? `${locator}${locator.includes("?") ? "&" : "?"}${query}`
					: locator,
			})),
		),
	)("$locator with $label", async ({ relPath, missing }) => {
		ops = makeOps(untouched)

		const failure = await ops.readFile({ relPath }).then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(TenantIdentityRequiredError)
		expect(failure).toMatchObject({ operation: "readFile", missing })
		expect(gate.capture).not.toHaveBeenCalled()
	})

	it("a kb locator keeps its documented default identity and a bridge locator is not a tenant locator", async () => {
		const fake = createStatefulMongoFake({ prefix: PREFIX })
		const readBridgeChunk = vi.fn(async () => ({
			text: "",
			path: "bridge/notes.md",
			locator: "bridge/notes.md",
			source: "reference" as const,
			sourceType: "reference" as const,
		}))
		const kbOps = new MongoDBManagerReadOps({
			db: fake.db as unknown as Db,
			prefix: PREFIX,
			agentId: AGENT_ID,
			resolveSearchIdentity: () => ({ ...MINE }),
			readBridgeChunk,
		} as unknown as MongoDBManagerHost)

		const kb = await kbOps.readFile({ relPath: "kb:docs/x.md" })
		const bridge = await kbOps.readFile({ relPath: "bridge/notes.md" })

		expect(kb.source).toBe("reference")
		expect(bridge.path).toBe("bridge/notes.md")
		expect(readBridgeChunk).toHaveBeenCalledTimes(1)
	})
})
