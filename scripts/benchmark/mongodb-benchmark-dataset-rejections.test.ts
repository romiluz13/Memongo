import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
} from "vitest"
import { describeIngestFailures } from "./benchmark-answer-quality.js"
import { loadBenchmarkDataset } from "./mongodb-benchmark-dataset.js"
import { ingestBenchmarkDataset } from "./mongodb-benchmark-harness.js"
import {
	isLegacyBenchmarkFallbackCandidate,
	type MongoDBManagerBenchmarkOps,
} from "./mongodb-manager-benchmark.js"

// Malformed generic input is reported with stable coordinates instead
// of disappearing, and the counts reach the ingest receipt.
let dir = ""
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "benchmark-rejections-"))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

async function file(name: string, content: string): Promise<string> {
	const target = path.join(dir, name)
	await writeFile(target, content)
	return target
}

const JSON_DOCUMENT = JSON.stringify({
	conversations: [
		{
			turns: [
				{ role: "user", body: "kept" },
				"not a turn",
				{ role: "user", body: "   " },
			],
		},
		5,
	],
})

const JSONL = [
	JSON.stringify({ turns: [{ role: "user", body: "kept" }] }),
	JSON.stringify({ turns: "not an array" }),
	"{not json",
	JSON.stringify({ turns: [{ role: "robot", body: "x" }] }),
].join("\n")

describe("generic benchmark loader rejections", () => {
	it("locates every rejected turn and conversation in a JSON document", async () => {
		const dataset = await loadBenchmarkDataset(
			await file("d.json", JSON_DOCUMENT),
		)
		expect(dataset.conversations).toHaveLength(1)
		expect(dataset.conversations[0]?.turns.map((turn) => turn.body)).toEqual([
			"kept",
		])
		expect(dataset.rejections).toEqual([
			{
				line: null,
				conversationIndex: 0,
				turnIndex: 1,
				reason: "turn-not-object",
			},
			{ line: null, conversationIndex: 0, turnIndex: 2, reason: "empty-body" },
			{
				line: null,
				conversationIndex: 1,
				turnIndex: null,
				reason: "conversation-not-object",
			},
		])
	})

	it("counts only unparseable JSONL lines as failedLines", async () => {
		const dataset = await loadBenchmarkDataset(await file("d.jsonl", JSONL))
		expect(dataset.failedLines).toBe(1)
		expect(dataset.rejections).toEqual([
			{
				line: 2,
				conversationIndex: 1,
				turnIndex: null,
				reason: "turns-not-array",
			},
			{ line: 4, conversationIndex: 2, turnIndex: 0, reason: "invalid-role" },
			{
				line: 4,
				conversationIndex: 2,
				turnIndex: null,
				reason: "no-valid-turns",
			},
		])
	})

	it("carries diagnostics when no conversation survives", async () => {
		const error = await loadBenchmarkDataset(
			await file(
				"bad.jsonl",
				[JSON.stringify({ turns: [] }), JSON.stringify({ turns: "x" })].join(
					"\n",
				),
			),
		).catch((caught: unknown) => caught)
		expect(error).toMatchObject({
			message: expect.stringContaining("contains no valid conversations"),
			rejections: [
				{
					line: 1,
					conversationIndex: 0,
					turnIndex: null,
					reason: "no-valid-turns",
				},
				{
					line: 2,
					conversationIndex: 1,
					turnIndex: null,
					reason: "turns-not-array",
				},
			],
		})
	})

	it("reports no rejections for valid input", async () => {
		const dataset = await loadBenchmarkDataset(
			await file(
				"ok.json",
				JSON.stringify({
					conversations: [{ turns: [{ role: "user", body: "a" }] }],
				}),
			),
		)
		expect(dataset.rejections).toEqual([])
	})
})

describe("rejection totals reach receipts and completeness", () => {
	it("adds rejected counts to the ingest receipt beside failedLines", async () => {
		const receipt = await ingestBenchmarkDataset({
			datasetPath: await file("d.jsonl", JSONL),
			writeTurn: async () => {},
		})
		expect(receipt).toMatchObject({
			failedLines: 1,
			rejectedTurns: 1,
			rejectedConversations: 2,
			turnsIngested: 1,
		})
	})

	it("names rejected input as an ingest failure", () => {
		expect(
			describeIngestFailures({
				failedLines: 0,
				failedTurns: 0,
				rejectedTurns: 2,
				rejectedConversations: 1,
			}),
		).toEqual([
			"1 dataset conversations were rejected",
			"2 dataset turns were rejected",
		])
	})
})

describe("legacy-query fallback", () => {
	it("still recognizes a dataset with no conversations as a legacy candidate", async () => {
		const error = await loadBenchmarkDataset(
			await file(
				"legacy.json",
				JSON.stringify([{ query: "q", expected: ["e"] }]),
			),
		).catch((caught: unknown) => caught)
		expect(isLegacyBenchmarkFallbackCandidate(error)).toBe(true)
	})
})

// Compile-time contract: checked by tsc, not by the Vitest transform.
it("exposes rejection counters on the public relevance benchmark result", () => {
	type Ingest = NonNullable<
		Awaited<
			ReturnType<MongoDBManagerBenchmarkOps["relevanceBenchmark"]>
		>["ingest"]
	>
	expectTypeOf<Ingest["rejectedTurns"]>().toEqualTypeOf<number | undefined>()
	expectTypeOf<Ingest["rejectedConversations"]>().toEqualTypeOf<
		number | undefined
	>()
})
