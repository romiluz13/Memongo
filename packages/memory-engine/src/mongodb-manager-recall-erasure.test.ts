// M2 review fix R3: conversation recall honors the erasure gate. The REAL
// manager lifecycle ops and the REAL recall core run over an events double;
// only the erasure gate is modeled (a flag the fence mocks read), because the
// gate is the subject of its own tests in mongodb-write-fence.test.ts. A recall
// is refused typed when the gate is closed at entry, and is never answered
// when the gate closes while the read runs, for both the hybrid (query) and the
// chronological (query-less) recall.
import type { Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isErasureGateConflictError } from "./mongodb-erasure-epoch.js"
import { MongoDBManagerLifecycleOps } from "./mongodb-manager-lifecycle.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"

const gate = vi.hoisted(() => ({
	erasing: false,
	captured: [] as Array<{ agentId: string; epoch: number }>,
	fenced: [] as Array<{ agentId: string; epoch: number }>,
}))
const events = vi.hoisted(() => ({ collection: undefined as unknown }))

vi.mock("./mongodb-write-fence.js", async (importOriginal) => {
	// A local class: importing the real one inside this factory deadlocks on the
	// import cycle through mongodb-schema.js. The production check is by `code`.
	class Conflict extends Error {
		readonly code = "ERASURE_GATE_CONFLICT"
		constructor(readonly agentId: string) {
			super(`erasure gate conflict for agent ${agentId}`)
			this.name = "ErasureGateConflictError"
		}
	}
	return {
		...(await importOriginal<Record<string, unknown>>()),
		captureAdmissionToken: vi.fn(async ({ agentId }: { agentId: string }) => {
			if (gate.erasing) throw new Conflict(agentId)
			const token = { kind: "admission" as const, agentId, epoch: 7 }
			gate.captured.push({ agentId, epoch: token.epoch })
			return token
		}),
		withFencedWrite: vi.fn(
			async ({
				token,
				fn,
			}: {
				token: { agentId: string; epoch: number }
				fn: (session: unknown) => Promise<unknown>
			}) => {
				if (gate.erasing) throw new Conflict(token.agentId)
				gate.fenced.push({ agentId: token.agentId, epoch: token.epoch })
				return fn({})
			},
		),
	}
})
vi.mock("./mongodb-schema.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	eventsCollection: () => events.collection,
}))
vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(async () => undefined),
}))

const AGENT_ID = "recall-erasure"
const TENANT = { scope: "agent", scopeRef: `agent:${AGENT_ID}` } as const
const EVENT: Document = {
	eventId: "event-1",
	sessionId: "session-1",
	role: "user",
	body: "ERASURE-CANARY body that must not leave an erasing tenant",
	timestamp: new Date("2026-01-01T00:00:00Z"),
}

type EventsDouble = {
	find: ReturnType<typeof vi.fn>
	aggregate: ReturnType<typeof vi.fn>
}

function useEvents(duringRead?: () => void): EventsDouble {
	const read = async (): Promise<Document[]> => {
		duringRead?.()
		return [EVENT]
	}
	const double: EventsDouble = {
		find: vi.fn(() => ({
			sort: () => ({ limit: () => ({ toArray: read }) }),
		})),
		aggregate: vi.fn(() => ({ toArray: read })),
	}
	events.collection = double as unknown as Collection
	return double
}

function lifecycleOps(): MongoDBManagerLifecycleOps {
	const host = {
		db: {} as Db,
		prefix: "t_",
		agentId: AGENT_ID,
		config: { mongodb: {} },
		refreshNativeBitemporalVectorPrefilter: vi.fn(async () => false),
	} as unknown as MongoDBManagerHost
	return new MongoDBManagerLifecycleOps(host)
}

async function outcomeOf(promise: Promise<unknown>) {
	return promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	)
}

beforeEach(() => {
	gate.erasing = false
	gate.captured.length = 0
	gate.fenced.length = 0
	resetSearchAdmissionForTests(Date.now())
})

describe.each([
	["a query (hybrid) recall", { query: "what did we say" }],
	["a chronological recall", {}],
] as const)("%s and the erasure gate", (_label, input) => {
	const read = (double: EventsDouble) =>
		input.query === undefined ? double.find : double.aggregate

	it("is a typed erasure conflict when the gate is already closed at entry, and reads no event", async () => {
		const double = useEvents()
		gate.erasing = true

		const failure = await outcomeOf(
			lifecycleOps().recallConversation({ ...TENANT, ...input }),
		)

		expect(failure).toHaveProperty("error")
		expect(
			isErasureGateConflictError((failure as { error: unknown }).error),
		).toBe(true)
		expect(read(double)).not.toHaveBeenCalled()
	})

	it("is a typed erasure conflict when the gate closes while the read runs, never the events", async () => {
		useEvents(() => {
			gate.erasing = true
		})

		const failure = await outcomeOf(
			lifecycleOps().recallConversation({ ...TENANT, ...input }),
		)

		expect(failure).toHaveProperty("error")
		expect(
			isErasureGateConflictError((failure as { error: unknown }).error),
		).toBe(true)
		expect(JSON.stringify(failure)).not.toContain("ERASURE-CANARY")
	})

	it("answers when the gate stays open, fencing the admission it captured", async () => {
		const double = useEvents()

		const answered = await outcomeOf(
			lifecycleOps().recallConversation({ ...TENANT, ...input }),
		)

		expect(answered).toHaveProperty("value")
		expect(
			(answered as { value: { results: unknown[] } }).value.results,
		).toHaveLength(1)
		expect(read(double)).toHaveBeenCalledTimes(1)
		expect(gate.captured).toEqual([{ agentId: AGENT_ID, epoch: 7 }])
		expect(gate.fenced).toEqual(gate.captured)
	})
})
