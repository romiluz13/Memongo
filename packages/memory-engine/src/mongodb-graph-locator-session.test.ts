/**
 * U6(ii) — `findRelationByLocatorId` must run every relation read inside the
 * same fenced session the caller opened, so an erasure worker that marks a
 * gate sees a locator read either entirely before or entirely after the mark.
 *
 * Design (plan `6c755bcf` §15, harness-plan.md File 2):
 * - File-local `vi.mock("./mongodb-schema.js", importOriginal)` overrides ONLY
 *   `relationsCollection`; the REAL `findRelationByLocatorId` runs against a
 *   recording, scripted fake.
 * - All three read sites must observe the SAME session: the typed `$or`
 *   findOne, the direct findOne, and the legacy candidates `find`
 *   (sort/limit 50 + JS matching).
 * - RED on unchanged bytes: the function takes no session today, so no call
 *   options carry one. The failures below are behavioral (recorded options
 *   lack the session) — never a mock crash.
 * - Passing controls: the untyped-direct serve and the legacy pair
 *   resolution still find their documents.
 *
 * This phase is read-only on product bytes: the files pin the missing
 * session plumbing; the product grant that adds it lands later.
 */
import { describe, expect, it, vi } from "vitest"
import type { ClientSession } from "mongodb"

const { relationsFake } = vi.hoisted(() => {
	type CallRecord = {
		filter: Record<string, unknown>
		options?: Record<string, unknown>
	}

	const findOneCalls: CallRecord[] = []
	const findCalls: CallRecord[] = []
	let findOneScript: Array<unknown> = []
	let findScript: Array<Array<unknown>> = []

	const relationsFake = {
		findOneCalls,
		findCalls,
		scriptFindOne(results: Array<unknown>) {
			findOneScript = [...results]
		},
		scriptFind(results: Array<Array<unknown>>) {
			findScript = [...results]
		},
		reset() {
			findOneCalls.length = 0
			findCalls.length = 0
			findOneScript = []
			findScript = []
		},
		findOne: async (
			filter: Record<string, unknown>,
			options?: Record<string, unknown>,
		) => {
			findOneCalls.push({ filter, options })
			const next = findOneScript.shift()
			if (next instanceof Error) throw next
			return (next === undefined ? null : next) as unknown
		},
		find: (
			filter: Record<string, unknown>,
			options?: Record<string, unknown>,
		) => {
			findCalls.push({ filter, options })
			const docs = findScript.shift() ?? []
			const cursor = {
				sort: () => cursor,
				limit: () => cursor,
				toArray: async () => [...docs],
			}
			return cursor
		},
	}

	return { relationsFake }
})

vi.mock("./mongodb-schema.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-schema.js")>()
	return { ...actual, relationsCollection: () => relationsFake }
})

import { findRelationByLocatorId } from "./mongodb-graph.js"

const SESSION = { __locatorGraphReadSession: true } as unknown as ClientSession
const BASE = {
	db: {} as never,
	prefix: "t_",
	agentId: "agent-1",
	scope: "agent",
	scopeRef: "agent-1",
}

describe("findRelationByLocatorId session fencing (U6 ii)", () => {
	it("runs the typed-locator findOne inside the caller's session", async () => {
		relationsFake.reset()
		const typedDoc = {
			_id: "r1",
			agentId: "agent-1",
			relationId: "ent-a-ent-b-similar_to",
			fromEntityId: "ent-a",
			toEntityId: "ent-b",
			type: "similar_to",
		}
		relationsFake.scriptFindOne([typedDoc])

		const record = await findRelationByLocatorId({
			...BASE,
			relationId: "ent-a-ent-b",
			type: "similar_to",
			session: SESSION,
		} as Parameters<typeof findRelationByLocatorId>[0] & { session?: unknown })

		expect(record).toBe(typedDoc)
		expect(relationsFake.findOneCalls).toHaveLength(1)
		expect(relationsFake.findOneCalls[0]?.options?.session).toBe(SESSION)
		expect(relationsFake.findOneCalls[0]?.filter).toEqual({
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
			$or: [
				{ relationId: "ent-a-ent-b-similar_to" },
				{ relationId: "ent-a-ent-b", type: "similar_to" },
			],
		})
		expect(relationsFake.findOneCalls[0]?.options?.sort).toEqual({
			updatedAt: -1,
			_id: 1,
		})
		expect(relationsFake.findCalls).toHaveLength(0)
	})

	it("runs the direct untyped findOne inside the caller's session", async () => {
		relationsFake.reset()
		const directDoc = {
			_id: "r2",
			agentId: "agent-1",
			relationId: "ent-a-ent-b",
			fromEntityId: "ent-a",
			toEntityId: "ent-b",
		}
		relationsFake.scriptFindOne([directDoc])

		const record = await findRelationByLocatorId({
			...BASE,
			relationId: "ent-a-ent-b",
			session: SESSION,
		} as Parameters<typeof findRelationByLocatorId>[0] & { session?: unknown })

		expect(record).toBe(directDoc)
		expect(relationsFake.findOneCalls).toHaveLength(1)
		expect(relationsFake.findOneCalls[0]?.options?.session).toBe(SESSION)
		expect(relationsFake.findOneCalls[0]?.filter).toEqual({
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
			relationId: "ent-a-ent-b",
		})
		expect(relationsFake.findCalls).toHaveLength(0)
	})

	it("runs the legacy candidates find inside the caller's session and still resolves a pre-relationId document", async () => {
		relationsFake.reset()
		const legacyDoc = {
			_id: "r3",
			agentId: "agent-1",
			fromEntityId: "ent-a",
			toEntityId: "ent-b",
		}
		relationsFake.scriptFindOne([null])
		relationsFake.scriptFind([[legacyDoc]])

		const record = await findRelationByLocatorId({
			...BASE,
			relationId: "ent-a-ent-b",
			session: SESSION,
		} as Parameters<typeof findRelationByLocatorId>[0] & { session?: unknown })

		expect(record).toBe(legacyDoc)
		expect(relationsFake.findOneCalls).toHaveLength(1)
		expect(relationsFake.findOneCalls[0]?.options?.session).toBe(SESSION)
		expect(relationsFake.findCalls).toHaveLength(1)
		expect(relationsFake.findCalls[0]?.options?.session).toBe(SESSION)
		expect(relationsFake.findCalls[0]?.options?.limit).toBe(50)
		expect(relationsFake.findCalls[0]?.filter).toEqual({
			agentId: "agent-1",
			scope: "agent",
			scopeRef: "agent-1",
		})
	})

	it("runs the legacy candidates find inside the caller's session after a typed-locator miss", async () => {
		relationsFake.reset()
		const legacyDoc = {
			_id: "r4",
			agentId: "agent-1",
			fromEntityId: "ent-a",
			toEntityId: "ent-b",
			type: "similar_to",
		}
		relationsFake.scriptFindOne([null])
		relationsFake.scriptFind([[legacyDoc]])

		const record = await findRelationByLocatorId({
			...BASE,
			relationId: "ent-a-ent-b",
			type: "similar_to",
			session: SESSION,
		} as Parameters<typeof findRelationByLocatorId>[0] & { session?: unknown })

		expect(record).toBe(legacyDoc)
		expect(relationsFake.findOneCalls).toHaveLength(1)
		expect(relationsFake.findOneCalls[0]?.options?.session).toBe(SESSION)
		expect(relationsFake.findCalls).toHaveLength(1)
		expect(relationsFake.findCalls[0]?.options?.session).toBe(SESSION)
	})
})
