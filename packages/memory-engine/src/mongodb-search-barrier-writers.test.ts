import { describe, expect, it } from "vitest"
import { writeProcedure } from "./mongodb-procedures.js"
import { mintSearchWriteToken } from "./mongodb-search-barrier.js"
import { writeStructuredMemory } from "./mongodb-structured-memory.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const PREFIX = "test_"
const IDENTITY = { type: "fact" as const, key: "deploy.day" }

function structured(value: string, extra: Record<string, unknown> = {}) {
	return {
		...IDENTITY,
		value,
		agentId: "agent-1",
		...extra,
	}
}

function procedure(steps: string[]) {
	return {
		procedureId: "rotate-keys",
		name: "Rotate keys",
		steps,
		agentId: "agent-1",
	}
}

describe("structured write stamps the barrier witness", () => {
	it("stamps the token with the content on create, update and reinforcement", async () => {
		const f = createStatefulMongoFake()
		const write = (value: string, token: string) =>
			writeStructuredMemory({
				db: f.db,
				prefix: PREFIX,
				entry: structured(value),
				embeddingMode: "automated",
				searchWriteToken: token,
			})
		const created = mintSearchWriteToken()
		await write("Friday", created)
		expect(f.findDoc("structured_mem", IDENTITY)).toMatchObject({
			value: "Friday",
			searchWriteToken: created,
		})
		const updated = mintSearchWriteToken()
		await write("Monday", updated)
		expect(f.findDoc("structured_mem", IDENTITY)).toMatchObject({
			value: "Monday",
			revision: 2,
			searchWriteToken: updated,
		})
		const reinforced = mintSearchWriteToken()
		await write("Monday", reinforced)
		expect(f.findDoc("structured_mem", IDENTITY)).toMatchObject({
			value: "Monday",
			reinforcementCount: 2,
			searchWriteToken: reinforced,
		})
	})

	it("re-stamps a write that changes no content with a token-only update", async () => {
		const f = createStatefulMongoFake()
		const inferred = (token?: string) =>
			writeStructuredMemory({
				db: f.db,
				prefix: PREFIX,
				entry: structured("Friday", {
					provenance: { origin: "llm-inference" },
					reinforcementCount: 0,
				}),
				embeddingMode: "automated",
				...(token ? { searchWriteToken: token } : {}),
			})
		await inferred(mintSearchWriteToken())
		const before = f.findDoc("structured_mem", IDENTITY)
		const fresh = mintSearchWriteToken()
		const replay = await inferred(fresh)
		expect(replay.changed).toBe(false)
		const after = f.findDoc("structured_mem", IDENTITY)
		expect(after).toEqual({ ...before, searchWriteToken: fresh })
	})

	it("writes no witness on an ordinary write", async () => {
		const f = createStatefulMongoFake()
		await writeStructuredMemory({
			db: f.db,
			prefix: PREFIX,
			entry: structured("Friday"),
			embeddingMode: "automated",
		})
		expect(f.findDoc("structured_mem", IDENTITY)).not.toHaveProperty(
			"searchWriteToken",
		)
	})
})

describe("procedure write stamps the barrier witness", () => {
	const ID = { procedureId: "rotate-keys" }

	it("stamps the token with the content on create and update", async () => {
		const f = createStatefulMongoFake()
		const write = (steps: string[], token: string) =>
			writeProcedure({
				db: f.db,
				prefix: PREFIX,
				entry: procedure(steps),
				embeddingMode: "automated",
				searchWriteToken: token,
			})
		const created = mintSearchWriteToken()
		await write(["revoke", "issue"], created)
		expect(f.findDoc("procedures", ID)).toMatchObject({
			steps: ["revoke", "issue"],
			searchWriteToken: created,
		})
		const updated = mintSearchWriteToken()
		await write(["revoke", "issue", "verify"], updated)
		expect(f.findDoc("procedures", ID)).toMatchObject({
			steps: ["revoke", "issue", "verify"],
			revision: 2,
			searchWriteToken: updated,
		})
	})

	it("re-stamps an unchanged procedure with a token-only update", async () => {
		const f = createStatefulMongoFake()
		const write = (token: string) =>
			writeProcedure({
				db: f.db,
				prefix: PREFIX,
				entry: procedure(["revoke", "issue"]),
				embeddingMode: "automated",
				searchWriteToken: token,
			})
		await write(mintSearchWriteToken())
		const before = f.findDoc("procedures", ID)
		const fresh = mintSearchWriteToken()
		const replay = await write(fresh)
		expect(replay.changed).toBe(false)
		expect(f.findDoc("procedures", ID)).toEqual({
			...before,
			searchWriteToken: fresh,
		})
	})

	it("writes no witness on an ordinary write", async () => {
		const f = createStatefulMongoFake()
		await writeProcedure({
			db: f.db,
			prefix: PREFIX,
			entry: procedure(["revoke"]),
			embeddingMode: "automated",
		})
		expect(f.findDoc("procedures", ID)).not.toHaveProperty("searchWriteToken")
	})
})
