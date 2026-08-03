import { beforeEach, describe, expect, it, vi } from "vitest"

// Kept separate from mongodb-manager.test.ts (which does not mock the KB
// module): verifies the manager threads the configured fusionMethod into the
// KB lane, with a per-call override — P0.10 plumbing.
const { searchKBFake } = vi.hoisted(() => ({ searchKBFake: vi.fn() }))
vi.mock("./mongodb-kb-search.js", () => ({ searchKB: searchKBFake }))
vi.mock("./mongodb-schema.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mongodb-schema.js")>()
	return {
		...actual,
		kbChunksCollection: vi.fn(() => ({})),
		kbCollection: vi.fn(() => ({})),
	}
})

import { MongoDBMemoryManager } from "./mongodb-manager.js"

function makeManagerStub(
	fusionMethod: "scoreFusion" | "rankFusion" | "js-merge",
) {
	return {
		db: {},
		prefix: "test_",
		config: {
			mongodb: {
				fusionMethod,
				embeddingMode: "automated",
			},
		},
		capabilities: {
			vectorSearch: true,
			textSearch: true,
			scoreFusion: true,
			rankFusion: true,
			storedSource: false,
			vectorIndexMethod: false,
		},
		agentScopeRef: "agent:agent-1",
	}
}

describe("MongoDBMemoryManager.searchKB fusionMethod plumbing (P0.10)", () => {
	beforeEach(() => {
		searchKBFake.mockReset()
		searchKBFake.mockResolvedValue([])
	})

	it("defaults the KB lane to the resolved config fusionMethod", async () => {
		const stub = makeManagerStub("scoreFusion")
		await MongoDBMemoryManager.prototype.searchKB.call(
			stub as never,
			"architecture",
		)

		expect(searchKBFake).toHaveBeenCalledOnce()
		const opts = searchKBFake.mock.calls[0][3] as { fusionMethod?: string }
		expect(opts.fusionMethod).toBe("scoreFusion")
	})

	it("honors a per-call fusionMethod override over the config default", async () => {
		const stub = makeManagerStub("rankFusion")
		await MongoDBMemoryManager.prototype.searchKB.call(
			stub as never,
			"architecture",
			{ fusionMethod: "scoreFusion" },
		)

		const opts = searchKBFake.mock.calls[0][3] as { fusionMethod?: string }
		expect(opts.fusionMethod).toBe("scoreFusion")
	})
})
