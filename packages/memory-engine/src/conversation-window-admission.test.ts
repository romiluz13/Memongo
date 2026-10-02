import type { ClientSession } from "mongodb"
import { afterEach, expect, it, vi } from "vitest"
import { projectConversationWindows } from "./mongodb-conversation-windows.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"
import {
	captureAdmissionToken,
	ErasureGateConflictError,
	readErasureGate,
	type AdmissionToken,
} from "./mongodb-write-fence.js"

afterEach(() => vi.restoreAllMocks())

async function entry(count = 12) {
	const fake = createStatefulMongoFake({ prefix: "test_" })
	await fake.collection("events").insertMany(
		Array.from({ length: count }, (_, i) => ({
			eventId: `event-${i}`,
			agentId: "agent1",
			sessionId: "session1",
			scope: "agent",
			scopeRef: "agent:agent1",
			role: "user",
			body: `old text ${i}`,
			timestamp: new Date(Date.now() + i),
		})),
	)
	const params = {
		db: fake.db,
		prefix: "test_",
		agentId: "agent1",
		sessionId: "session1",
		scope: "agent" as const,
		scopeRef: "agent:agent1",
	}
	const admission = await captureAdmissionToken(params)
	return { fake, params, admission }
}

it("rejects selected old text after erasure advances the gate", async () => {
	const { fake, params } = await entry()
	const events = fake.collection("events")
	const find = events.find.bind(events)
	vi.spyOn(events, "find").mockImplementation((...args) => {
		const cursor = find(...args)
		const toArray = cursor.toArray.bind(cursor)
		cursor.toArray = async () => {
			const selected = await toArray()
			await fake.collection("meta").updateMany(
				{ agentId: params.agentId },
				{
					$inc: { epoch: 1 },
					$set: {
						state: "erasing",
						erase: { runId: "unit-erase", startedAt: new Date() },
					},
				},
			)
			await events.deleteMany({ agentId: params.agentId })
			await fake.collection("chunks").deleteMany({ agentId: params.agentId })
			return selected
		}
		return cursor
	})
	await expect(projectConversationWindows(params)).rejects.toBeInstanceOf(
		ErasureGateConflictError,
	)
	expect(fake.all("chunks")).toEqual([])
})

it.each([
	"wrong owner",
	"stale epoch",
])("rejects a %s admission before selecting events", async (kind) => {
	const { fake, params, admission } = await entry()
	const find = vi.spyOn(fake.collection("events"), "find")
	const token: AdmissionToken = {
		...admission,
		...(kind === "wrong owner"
			? { agentId: "another-agent" }
			: { epoch: admission.epoch + 1 }),
	}
	await expect(
		projectConversationWindows({ ...params, admission: token } as Parameters<
			typeof projectConversationWindows
		>[0]),
	).rejects.toBeInstanceOf(ErasureGateConflictError)
	expect(find).not.toHaveBeenCalled()
})

it("retains supplied admission and passes a session to each window write", async () => {
	const { fake, params, admission } = await entry()
	const capture = vi.spyOn(fake.collection("meta"), "findOneAndUpdate")
	const updates = vi.spyOn(fake.collection("chunks"), "updateOne")
	const result = await projectConversationWindows({
		...params,
		admission,
	} as Parameters<typeof projectConversationWindows>[0])
	expect(result).toEqual({ windowsCreated: 2 })
	expect(capture).not.toHaveBeenCalled()
	expect(updates).toHaveBeenCalledTimes(2)
	for (const call of updates.mock.calls)
		expect(call[2]).toEqual({ upsert: true, session: expect.any(Object) })
	expect((await readErasureGate(params))?.serial).toBe(2)
})

it("counts committed windows once when a transaction callback retries", async () => {
	const { fake, params } = await entry(5)
	const original = fake.db.client.startSession.bind(fake.db.client)
	vi.spyOn(fake.db.client, "startSession").mockImplementation((...args) => {
		const session = original(...args)
		session.withTransaction = (async (fn) => {
			await fn(session)
			return fn(session)
		}) as ClientSession["withTransaction"]
		return session
	})
	expect(await projectConversationWindows(params)).toEqual({
		windowsCreated: 1,
	})
	expect(fake.all("chunks")).toHaveLength(1)
})
