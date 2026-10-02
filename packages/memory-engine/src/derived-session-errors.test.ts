import type { ClientSession, Db } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	persistPreparedDerivedMemoryPromotion,
	type PreparedDerivedMemoryPromotion,
} from "./mongodb-derived-memory.js"

const mocks = vi.hoisted(() => ({
	structured: vi.fn(),
	procedure: vi.fn(),
	projection: vi.fn(),
}))
vi.mock("./mongodb-structured-memory.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-structured-memory.js")>()),
	writeStructuredMemory: mocks.structured,
}))
vi.mock("./mongodb-procedures.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mongodb-procedures.js")>()),
	writeProcedure: mocks.procedure,
}))
vi.mock("./mongodb-ops.js", () => ({ recordProjectionRun: mocks.projection }))
beforeEach(() => {
	vi.clearAllMocks()
	mocks.structured.mockResolvedValue({ upserted: true, id: "memory" })
	mocks.procedure.mockResolvedValue({ upserted: true, id: "procedure" })
	mocks.projection.mockResolvedValue("run")
})
const event = {
	eventId: "event1",
	agentId: "agent1",
	role: "user" as const,
	body: "remember this",
	timestamp: new Date(),
	scope: "agent" as const,
	scopeRef: "agent:agent1",
}
function fixture() {
	const structuredRead = vi.fn(async () => null)
	const procedureRead = vi.fn(async () => null)
	const db = {
		collection: (name: string) => ({
			findOne: name.endsWith("structured_mem") ? structuredRead : procedureRead,
		}),
	} as unknown as Db
	const prepared: PreparedDerivedMemoryPromotion = {
		structuredCandidates: ["first", "second"].map((key) => ({
			agentId: "agent1",
			scope: "agent",
			scopeRef: "agent:agent1",
			type: "fact",
			key,
			value: key,
		})),
		procedureCandidates: ["first", "second"].map((procedureId) => ({
			agentId: "agent1",
			scope: "agent",
			scopeRef: "agent:agent1",
			procedureId,
			name: procedureId,
			steps: [],
		})),
		promotionGuards: {
			"fact\0first": { kind: "immediate" },
			"fact\0second": { kind: "immediate" },
		},
	}
	const run = (session?: ClientSession) =>
		persistPreparedDerivedMemoryPromotion({
			db,
			prefix: "test_",
			session,
			embeddingMode: "automated",
			event,
			prepared,
		})
	return { run, structuredRead, procedureRead }
}
describe("derived promotion session errors", () => {
	it("rethrows the original structured failure before more session work", async () => {
		const { run, structuredRead, procedureRead } = fixture()
		const error = Object.assign(new Error("duplicate"), {
			code: 11000,
			errorLabels: [],
		})
		mocks.structured.mockRejectedValueOnce(error)
		await expect(run({} as ClientSession)).rejects.toBe(error)
		expect(mocks.structured).toHaveBeenCalledTimes(1)
		expect(structuredRead).toHaveBeenCalledTimes(1)
		expect(procedureRead).not.toHaveBeenCalled()
		expect(mocks.procedure).not.toHaveBeenCalled()
		expect(mocks.projection).not.toHaveBeenCalled()
	})
	it("rethrows the original procedure failure before a second procedure or its projection", async () => {
		const { run, procedureRead } = fixture()
		const error = Object.assign(new Error("duplicate procedure"), {
			code: 11000,
			errorLabels: [],
		})
		mocks.procedure.mockRejectedValueOnce(error)
		await expect(run({} as ClientSession)).rejects.toBe(error)
		expect(mocks.structured).toHaveBeenCalledTimes(2)
		expect(mocks.procedure).toHaveBeenCalledTimes(1)
		expect(procedureRead).toHaveBeenCalledTimes(1)
		expect(mocks.projection).toHaveBeenCalledTimes(1)
		expect(mocks.projection.mock.calls[0][0].run.projectionType).toBe(
			"structured-promotion",
		)
	})
	it.each([
		"structured",
		"procedure",
	] as const)("keeps sessionless aggregation after %s failure", async (kind) => {
		const { run } = fixture()
		const error = Object.assign(new Error("original"), { code: 11000 })
		mocks[kind].mockRejectedValueOnce(error)
		await expect(run()).rejects.toBe(error)
		expect(mocks.structured).toHaveBeenCalledTimes(2)
		expect(mocks.procedure).toHaveBeenCalledTimes(2)
		expect(mocks.projection).toHaveBeenCalledTimes(2)
		expect(
			mocks.projection.mock.calls[kind === "structured" ? 0 : 1][0].run.status,
		).toBe("failed")
	})
	it("keeps successful session work and projections", async () => {
		const { run } = fixture()
		const session = {} as ClientSession
		await expect(run(session)).resolves.toMatchObject({
			structuredCreated: 2,
			proceduresCreated: 2,
			skipped: false,
		})
		expect(mocks.structured).toHaveBeenCalledTimes(2)
		expect(mocks.procedure).toHaveBeenCalledTimes(2)
		expect(mocks.projection).toHaveBeenCalledTimes(2)
		for (const [params] of mocks.projection.mock.calls)
			expect(params.session).toBe(session)
	})
})
