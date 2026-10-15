import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, it } from "vitest"
import { loadBenchmarkDataset } from "./mongodb-benchmark-dataset.js"
import { ingestBenchmarkConversations } from "./mongodb-benchmark-harness.js"

async function load(value: unknown, jsonl = false) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "benchmark-loader-date-"))
	try {
		const file = path.join(dir, jsonl ? "synthetic.jsonl" : "synthetic.json")
		await writeFile(file, jsonl ? String(value) : JSON.stringify(value))
		return await loadBenchmarkDataset(file)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}
const entry = () => ({
	question_id: "q",
	question: "synthetic?",
	answer: "synthetic",
	haystack_session_ids: ["s"],
	haystack_sessions: [[{ role: "user", content: "synthetic" }]],
})

it("retains LongMemEval source strings while reporting weekday disagreements", async () => {
	const raw = "2024/06/15 (Mon) 14:30"
	const dataset = await load([
		{
			...entry(),
			haystack_dates: [raw],
			question_date: "2024/06/16 (Sun) 08:00",
		},
	])
	expect(dataset.conversations[0]?.turns[0]?.timestamp).toBe(raw)
	expect(dataset.timestampValidation.weekdayMismatches).toBe(1)
	expect(dataset.evaluations?.[0]?.metadata?.questionDate).toBe(
		"2024/06/16 (Sun) 08:00",
	)
	const instants: string[] = []
	await ingestBenchmarkConversations({
		datasetPath: "synthetic.json",
		datasetKind: dataset.datasetKind,
		conversations: dataset.conversations,
		writeTurn: async (turn) => {
			instants.push(turn.timestamp!.toISOString())
		},
	})
	expect(instants).toEqual(["2024-06-15T14:30:00.000Z"])
})
it.each([
	null,
	[],
	[null],
	[""],
	["2024/02/30 (Fri) 00:00"],
	["2024-01-01", "2024-01-02"],
])("rejects invalid present haystack date field %j", async (haystack_dates) => {
	await expect(load([{ ...entry(), haystack_dates }])).rejects.toThrow(
		"timestamp",
	)
})
it.each([
	null,
	"",
	"bad",
])("rejects invalid present question date %j", async (question_date) => {
	await expect(load([{ ...entry(), question_date }])).rejects.toThrow(
		"timestamp",
	)
})
it("allows an absent date without manufacturing an instant", async () => {
	const dataset = await load([entry()])
	expect(dataset.conversations[0]?.turns[0]?.timestamp).toBeUndefined()
})
it("preflights explicit null on a later JSONL record", async () => {
	const row = (timestamp: unknown) =>
		JSON.stringify({ turns: [{ role: "user", body: "synthetic", timestamp }] })
	await expect(
		load(row("2024-01-01") + "\n" + row(null), true),
	).rejects.toThrow("timestamp")
})
it("validates only selected direct replay turns, with absence retained", async () => {
	const values: unknown[] = []
	await ingestBenchmarkConversations({
		datasetPath: "synthetic.json",
		limitConversations: 1,
		limitTurnsPerConversation: 1,
		conversations: [
			{
				turns: [
					{ role: "user", body: "first" },
					{ role: "user", body: "excluded", timestamp: "bad" },
				],
			},
			{ turns: [{ role: "user", body: "excluded", timestamp: "bad" }] },
		],
		writeTurn: async (turn) => {
			values.push(turn.timestamp)
		},
	})
	expect(values).toEqual([undefined])
})

it("versions benchmark replay keys while keeping repeat replay stable", async () => {
	const keys: string[] = []
	const params = {
		datasetPath: "synthetic.json",
		conversations: [
			{
				sessionId: "s",
				turns: [
					{ role: "user" as const, body: "synthetic", timestamp: "2024-01-01" },
				],
			},
		],
		writeTurns: async (
			turns: import("./mongodb-benchmark-harness.js").ConversationReplayBatchTurn[],
		) => {
			keys.push(...turns.map((turn) => turn.idempotencyKey))
			return turns.map(() => ({ ok: true as const }))
		},
	}
	await ingestBenchmarkConversations(params)
	await ingestBenchmarkConversations(params)
	expect(keys).toHaveLength(2)
	expect(keys[0]).toBe(keys[1])
	// This exact fixture's key under the previous, unversioned benchmark policy.
	expect(keys[0]).not.toBe(
		"dataset-replay-benchmark:24c105a1ea22764b0e70bd6d47689d11f388ed8341773658704c1aefdb4daa70",
	)
})
