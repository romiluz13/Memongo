// M2 T13 (review F2): the direct KB read honors retention and erasure at the
// return boundary. The REAL KB core and the REAL manager search ops run over a
// kb_chunks double that evaluates the fusion aggregate; only the erasure gate
// is modeled (a flag the fence mocks read), because the gate is the subject of
// its own tests in mongodb-write-fence.test.ts.
import type { Db } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isErasureGateConflictError } from "./mongodb-erasure-epoch.js"
import type { MongoDBManagerHost } from "./mongodb-manager-host.js"
import { MongoDBManagerSearchOps } from "./mongodb-manager-search.js"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import type { SearchOutcomeSummary } from "./search-outcomes.js"
import {
	type KbFusionDouble,
	createKbFusionDouble,
} from "./test-helpers/kb-fusion-double.js"

const gate = vi.hoisted(() => ({ erasing: false }))
const kb = vi.hoisted(() => ({ double: undefined as unknown }))

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
			return { kind: "admission" as const, agentId, epoch: 0 }
		}),
		withFencedWrite: vi.fn(
			async ({
				token,
				fn,
			}: {
				token: { agentId: string }
				fn: (session: unknown) => Promise<unknown>
			}) => {
				if (gate.erasing) throw new Conflict(token.agentId)
				return fn({})
			},
		),
	}
})
vi.mock("./mongodb-schema.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	kbChunksCollection: () => (kb.double as KbFusionDouble).collection,
	kbCollection: () => ({}),
}))
vi.mock("./mongodb-telemetry.js", () => ({
	emitTelemetry: vi.fn(async () => undefined),
}))

const day = 24 * 60 * 60 * 1000
const SCOPE_REF = "agent:kb-lifecycle"

function chunk(path: string, expiresAt?: Date): Record<string, unknown> {
	return {
		scopeRef: SCOPE_REF,
		docId: "doc-1",
		path,
		startLine: 1,
		endLine: 2,
		text: `text of ${path}`,
		...(expiresAt ? { expiresAt } : {}),
	}
}

function searchOps(fusionMethod: "scoreFusion" | "rankFusion") {
	const host = {
		db: {} as Db,
		prefix: "t_",
		agentId: "kb-lifecycle",
		agentScopeRef: SCOPE_REF,
		config: {
			mongodb: {
				embeddingMode: "automated",
				fusionMethod,
				numCandidates: 100,
			},
		},
		setLastSearchMode: vi.fn(),
	} as unknown as MongoDBManagerHost
	return new MongoDBManagerSearchOps(host)
}

function useChunks(chunks: Record<string, unknown>[]): KbFusionDouble {
	const double = createKbFusionDouble(chunks)
	kb.double = double
	return double
}

beforeEach(() => {
	gate.erasing = false
	resetSearchAdmissionForTests(Date.now())
})

describe.each([
	"scoreFusion",
	"rankFusion",
] as const)("direct KB search (%s) at the return boundary", (fusionMethod) => {
	it("returns unexpired and permanent chunks and never an expired one", async () => {
		useChunks([
			chunk("expired.md", new Date(Date.now() - day)),
			chunk("future.md", new Date(Date.now() + day)),
			chunk("permanent.md"),
		])

		const results = await searchOps(fusionMethod).searchKB("policy", {
			minScore: 0,
		})

		expect(results.map((result) => result.path).toSorted()).toEqual([
			"kb:future.md",
			"kb:permanent.md",
		])
	})

	it("is a typed erasure conflict when erasure began while Search ran, never the chunks", async () => {
		const double = useChunks([chunk("permanent.md")])
		double.duringSearch.hook = () => {
			gate.erasing = true
		}
		const outcomes: SearchOutcomeSummary[] = []

		const failure = await searchOps(fusionMethod)
			.searchKB("policy", { minScore: 0, onOutcomes: (o) => outcomes.push(o) })
			.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			)

		expect(failure).toHaveProperty("error")
		expect(
			isErasureGateConflictError((failure as { error: unknown }).error),
		).toBe(true)
		expect(outcomes).toEqual([])
	})

	it("is the same typed conflict, before any Search, when erasure is already in progress", async () => {
		const double = useChunks([chunk("permanent.md")])
		gate.erasing = true

		const failure = await searchOps(fusionMethod)
			.searchKB("policy", { minScore: 0 })
			.then(
				() => undefined,
				(error: unknown) => error,
			)

		expect(isErasureGateConflictError(failure)).toBe(true)
		expect(double.pipelines).toEqual([])
	})

	it("reports the lane outcome once on a read that no erasure interrupted", async () => {
		useChunks([chunk("permanent.md")])
		const outcomes: SearchOutcomeSummary[] = []

		await searchOps(fusionMethod).searchKB("policy", {
			minScore: 0,
			onOutcomes: (o) => outcomes.push(o),
		})

		expect(outcomes).toHaveLength(1)
		expect(outcomes[0].status).toBe("complete")
	})
})
