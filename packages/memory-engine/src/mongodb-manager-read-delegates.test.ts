/**
 * U6(iii) — the manager's private read delegates (`mongodb-manager.ts:1310`
 * to :1339) and the `readFile` facade (:1295) must forward the erasure-fence
 * session down to `MongoDBManagerReadOps`, so the ops layer can run every
 * collection touch inside the caller's fenced session.
 *
 * Design (plan `6c755bcf` §15, harness-plan.md File 3):
 * - NO module mocks: the real delegate methods and the real `readOpsOf`
 *   caching run on a manager instance whose `_readOps` is a recording
 *   collaborator.
 * - RED on unchanged bytes: the delegates forward WITHOUT a session today,
 *   so the recorded positional arguments are one short — a behavioral
 *   failure, never a mock crash.
 * - Passing controls: the `readEpisodeLocator` params pass-through (session
 *   rides inside the params object), the `readFile` facade forwarding, and
 *   the `readOpsOf` instance-reuse cache.
 *
 * This phase is read-only on product bytes: the files pin the missing
 * session plumbing; the product grant that adds it lands later.
 */
import { describe, expect, it, vi } from "vitest"
import type { ManagerReadResult } from "./mongodb-manager-read.js"
import { MongoDBMemoryManager } from "./mongodb-manager.js"

const SESSION = { __locatorReadFenceSession: true }

function miss(path: string): ManagerReadResult {
	return {
		text: "",
		path,
		locator: path,
		source: "conversation",
		sourceType: "conversation",
	}
}

type ReadOpsCollaborator = {
	readFile: ReturnType<typeof vi.fn>
	readConversationChunk: ReturnType<typeof vi.fn>
	readCanonicalEvent: ReturnType<typeof vi.fn>
	readBridgeChunk: ReturnType<typeof vi.fn>
	readEpisodeLocator: ReturnType<typeof vi.fn>
}

/**
 * The three positional delegates gain a trailing `session` parameter in the
 * fenced-read product grant (§8); today they take none.
 */
type PrivateDelegates = {
	readConversationChunk: (
		rawPath: string,
		from?: number,
		lines?: number,
		session?: unknown,
	) => Promise<ManagerReadResult>
	readCanonicalEvent: (
		eventId: string,
		rawPath: string,
		session?: unknown,
	) => Promise<ManagerReadResult>
	readBridgeChunk: (
		rawPath: string,
		from?: number,
		lines?: number,
		session?: unknown,
	) => Promise<ManagerReadResult>
	readEpisodeLocator: (params: {
		rawPath: string
		episodeId: string
		expandEvents: boolean
		session?: unknown
	}) => Promise<ManagerReadResult>
}

function makeManager(): {
	manager: MongoDBMemoryManager
	readOps: ReadOpsCollaborator
} {
	const readOps: ReadOpsCollaborator = {
		readFile: vi.fn(async () => miss("structured:fact:sky")),
		readConversationChunk: vi.fn(async () => miss("conversation:s/1")),
		readCanonicalEvent: vi.fn(async () => miss("event:evt-1")),
		readBridgeChunk: vi.fn(async () => miss("bridge/fallthrough")),
		readEpisodeLocator: vi.fn(async () => miss("episode:ep-1")),
	}
	const manager = Object.assign(
		Object.create(MongoDBMemoryManager.prototype) as MongoDBMemoryManager,
		{
			db: {},
			prefix: "t_",
			agentId: "agent-1",
			_readOps: readOps,
		},
	)
	return { manager, readOps }
}

describe("manager read delegate session forwarding (U6 iii)", () => {
	it("readConversationChunk forwards the caller's session positionally", async () => {
		const { manager, readOps } = makeManager()
		const delegates = manager as unknown as PrivateDelegates

		const result = await delegates.readConversationChunk(
			"conversation:s/1",
			4,
			8,
			SESSION,
		)

		expect(readOps.readConversationChunk).toHaveBeenCalledWith(
			"conversation:s/1",
			4,
			8,
			SESSION,
		)
		expect(result).toEqual(miss("conversation:s/1"))
	})

	it("readCanonicalEvent forwards the caller's session positionally", async () => {
		const { manager, readOps } = makeManager()
		const delegates = manager as unknown as PrivateDelegates

		const result = await delegates.readCanonicalEvent(
			"evt-1",
			"conversation:events/evt-1",
			SESSION,
		)

		expect(readOps.readCanonicalEvent).toHaveBeenCalledWith(
			"evt-1",
			"conversation:events/evt-1",
			SESSION,
		)
		expect(result).toEqual(miss("event:evt-1"))
	})

	it("readBridgeChunk forwards the caller's session positionally", async () => {
		const { manager, readOps } = makeManager()
		const delegates = manager as unknown as PrivateDelegates

		const result = await delegates.readBridgeChunk(
			"bridge/fallthrough",
			2,
			10,
			SESSION,
		)

		expect(readOps.readBridgeChunk).toHaveBeenCalledWith(
			"bridge/fallthrough",
			2,
			10,
			SESSION,
		)
		expect(result).toEqual(miss("bridge/fallthrough"))
	})

	it("control: readEpisodeLocator passes its params object through untouched, session included", async () => {
		const { manager, readOps } = makeManager()
		const delegates = manager as unknown as PrivateDelegates
		const params = {
			rawPath: "episode:ep-1",
			episodeId: "ep-1",
			expandEvents: false,
			session: SESSION,
		}

		const result = await delegates.readEpisodeLocator(params)

		expect(readOps.readEpisodeLocator).toHaveBeenCalledWith(params)
		expect(result).toEqual(miss("episode:ep-1"))
	})

	it("control: the readFile facade forwards its params object to the ops layer", async () => {
		const { manager, readOps } = makeManager()
		const params = { relPath: "structured:fact:sky", from: 1, lines: 5 }

		const result = await manager.readFile(params)

		expect(readOps.readFile).toHaveBeenCalledWith(params)
		expect(result).toEqual(miss("structured:fact:sky"))
	})

	it("control: readOpsOf caches one ops instance on the manager", async () => {
		const { manager, readOps } = makeManager()
		const delegates = manager as unknown as PrivateDelegates
		const holder = manager as unknown as { _readOps?: unknown }

		await delegates.readConversationChunk("conversation:s/1", 4, 8, SESSION)
		const first = holder._readOps
		await delegates.readCanonicalEvent(
			"evt-1",
			"conversation:events/evt-1",
			SESSION,
		)

		expect(first).toBe(readOps)
		expect(holder._readOps).toBe(first)
		expect(readOps.readConversationChunk).toHaveBeenCalledTimes(1)
		expect(readOps.readCanonicalEvent).toHaveBeenCalledTimes(1)
	})
})
