import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
	importConversationDataset,
	loadConversationDataset,
	type ConversationReplayBatchTurn,
} from "./mongodb-conversation-import.js"

const SECRET_BODY = "synthetic private body 1148"
const BAD_STAMP = "2024-02-30T10:00:00Z"
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	)
})

async function datasetFile(name: string, content: string): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "memongo-import-integrity-"))
	dirs.push(dir)
	const file = path.join(dir, name)
	await writeFile(file, content)
	return file
}

const valid = (body: string, timestamp?: unknown) => ({
	role: "user",
	body,
	...(timestamp !== undefined ? { timestamp } : {}),
})

// Conversation 0: one good turn, then a bad role, an empty body and an
// impossible date. Conversation 1: every turn bad. Conversation 2: no turns
// array. Conversation 3: all valid, including a missing timestamp.
const conversations = [
	{
		sessionId: "s0",
		turns: [
			valid("ok 0", "2024-01-02T03:04:05Z"),
			{ role: "robot", body: SECRET_BODY },
			{ role: "user", body: "   " },
			valid(SECRET_BODY, BAD_STAMP),
		],
	},
	{ sessionId: "s1", turns: [valid(SECRET_BODY, ""), valid(SECRET_BODY, 17)] },
	{ sessionId: "s2", turns: "not-an-array" },
	{
		sessionId: "s3",
		turns: [valid("ok 3a", "2024-01-02T05:04:05+02:00"), valid("ok 3b")],
	},
]

const EXPECTED_TURN_REJECTIONS = [
	{ conversationIndex: 0, turnIndex: 1, reason: "invalid-role" },
	{ conversationIndex: 0, turnIndex: 2, reason: "empty-body" },
	{ conversationIndex: 0, turnIndex: 3, reason: "invalid-timestamp" },
	{ conversationIndex: 1, turnIndex: 0, reason: "invalid-timestamp" },
	{ conversationIndex: 1, turnIndex: 1, reason: "invalid-timestamp" },
]
const EXPECTED_CONVERSATION_REJECTIONS = [
	{ conversationIndex: 1, turnIndex: null, reason: "no-valid-turns" },
	{ conversationIndex: 2, turnIndex: null, reason: "turns-not-array" },
]

function capture() {
	const written: ConversationReplayBatchTurn[] = []
	return {
		written,
		writeTurns: async (turns: ConversationReplayBatchTurn[]) => {
			written.push(...turns)
			return turns.map(() => ({ ok: true as const }))
		},
	}
}

describe("B01 malformed import rejections", () => {
	it("JSON: keeps valid turns and reports every rejection with value-free coordinates", async () => {
		const file = await datasetFile(
			"history.json",
			JSON.stringify({ conversations }),
		)
		const sink = capture()
		const receipt = await importConversationDataset({
			datasetPath: file,
			writeTurns: sink.writeTurns,
		})
		expect(sink.written.map((turn) => turn.body)).toEqual([
			"ok 0",
			"ok 3a",
			"ok 3b",
		])
		expect(receipt).toMatchObject({
			conversationsImported: 2,
			turnsImported: 3,
			failedLines: 0,
			rejectedTurns: 5,
			rejectedConversations: 2,
		})
		expect(receipt.rejections).toEqual(
			[...EXPECTED_TURN_REJECTIONS, ...EXPECTED_CONVERSATION_REJECTIONS]
				.map((entry) => ({ line: null, ...entry }))
				.toSorted(
					(a, b) =>
						a.conversationIndex - b.conversationIndex ||
						(a.turnIndex ?? 99) - (b.turnIndex ?? 99),
				),
		)
		const text = JSON.stringify(receipt)
		expect(text).not.toContain(SECRET_BODY)
		expect(text).not.toContain(BAD_STAMP)
		// datasetPath is a pre-existing receipt field; the new diagnostics
		// themselves carry no path.
		expect(JSON.stringify(receipt.rejections)).not.toContain(path.dirname(file))
	})

	it("JSONL: same rejections with physical line numbers; parse failures stay failedLines", async () => {
		const lines = [
			"# comment",
			JSON.stringify(conversations[0]),
			"{not json",
			"",
			JSON.stringify(conversations[1]),
			JSON.stringify(conversations[2]),
			JSON.stringify(conversations[3]),
		]
		const lineOf = [2, 5, 6, 7]
		const file = await datasetFile("history.jsonl", lines.join("\n"))
		const sink = capture()
		const receipt = await importConversationDataset({
			datasetPath: file,
			writeTurns: sink.writeTurns,
		})
		expect(sink.written.map((turn) => turn.body)).toEqual([
			"ok 0",
			"ok 3a",
			"ok 3b",
		])
		expect(receipt).toMatchObject({
			failedLines: 1,
			rejectedTurns: 5,
			rejectedConversations: 2,
		})
		expect(receipt.rejections).toEqual(
			[...EXPECTED_TURN_REJECTIONS, ...EXPECTED_CONVERSATION_REJECTIONS]
				.map((entry) => ({
					line: lineOf[entry.conversationIndex],
					...entry,
				}))
				.toSorted(
					(a, b) =>
						a.conversationIndex - b.conversationIndex ||
						(a.turnIndex ?? 99) - (b.turnIndex ?? 99),
				),
		)
	})

	it("never turns an invalid explicit timestamp into the current time", async () => {
		for (const bad of [
			BAD_STAMP,
			"2023-02-29T00:00:00Z",
			"2024-01-02T24:00:00Z",
			"2024-01-02T10:00:00",
			"2024-01-02 10:00:00Z",
			"yesterday",
			"",
			null,
			0,
		]) {
			const file = await datasetFile(
				"one.json",
				JSON.stringify([{ turns: [valid("keep"), valid(SECRET_BODY, bad)] }]),
			)
			const sink = capture()
			const receipt = await importConversationDataset({
				datasetPath: file,
				writeTurns: sink.writeTurns,
			})
			expect(sink.written.map((turn) => turn.body)).toEqual(["keep"])
			expect(sink.written[0]?.timestamp).toBeUndefined()
			expect(receipt.rejections).toEqual([
				{
					line: null,
					conversationIndex: 0,
					turnIndex: 1,
					reason: "invalid-timestamp",
				},
			])
		}
	})

	it("preserves valid UTC, offset and date-only timestamps and missing-timestamp behavior", async () => {
		const file = await datasetFile(
			"ok.json",
			JSON.stringify([
				{
					turns: [
						valid("utc", "2024-02-29T23:59:59.123Z"),
						valid("offset", "2024-03-01T01:59:59.123+02:00"),
						valid("date", "2024-02-29"),
						valid("missing"),
					],
				},
			]),
		)
		const loaded = await loadConversationDataset(file)
		expect(
			loaded.conversations[0]?.turns.map((turn) => turn.timestamp),
		).toEqual([
			"2024-02-29T23:59:59.123Z",
			"2024-03-01T01:59:59.123+02:00",
			"2024-02-29",
			undefined,
		])
		const sink = capture()
		const receipt = await importConversationDataset({
			datasetPath: file,
			writeTurns: sink.writeTurns,
		})
		expect(sink.written.map((turn) => turn.timestamp?.toISOString())).toEqual([
			"2024-02-29T23:59:59.123Z",
			"2024-02-29T23:59:59.123Z",
			"2024-02-29T00:00:00.000Z",
			undefined,
		])
		expect(receipt).toMatchObject({
			rejectedTurns: 0,
			rejectedConversations: 0,
			rejections: [],
		})
	})

	it("keeps idempotency keys stable across reruns", async () => {
		const file = await datasetFile(
			"history.json",
			JSON.stringify({ conversations }),
		)
		const first = capture()
		const second = capture()
		await importConversationDataset({
			datasetPath: file,
			writeTurns: first.writeTurns,
		})
		await importConversationDataset({
			datasetPath: file,
			writeTurns: second.writeTurns,
		})
		expect(second.written.map((turn) => turn.idempotencyKey)).toEqual(
			first.written.map((turn) => turn.idempotencyKey),
		)
	})
})

describe("B01 timestamp parsing is independent of host TZ", () => {
	it("parses the same instants under UTC and a non-UTC host zone", () => {
		const helper = fileURLToPath(
			new URL("./conversation-timestamp.ts", import.meta.url),
		)
		const inputs = [
			"2024-02-29T23:59:59.123Z",
			"2024-03-01T01:59:59+02:00",
			"2024-02-29",
			"2024-01-02T10:00:00",
		]
		const script = `const { parseExplicitTimestamp } = await import(${JSON.stringify(helper)}); console.log(JSON.stringify(${JSON.stringify(inputs)}.map((v) => parseExplicitTimestamp(v)?.toISOString() ?? null)))`
		const run = (tz: string) => {
			const child = spawnSync(
				process.execPath,
				["--import", "tsx", "--input-type=module", "-e", script],
				{
					cwd: path.resolve(path.dirname(helper), "../../.."),
					env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), TZ: tz },
					encoding: "utf8",
					timeout: 30_000,
				},
			)
			expect(child.status, child.stderr).toBe(0)
			return JSON.parse(child.stdout.trim()) as Array<string | null>
		}
		const utc = run("UTC")
		const far = run("Pacific/Kiritimati")
		expect(utc).toEqual([
			"2024-02-29T23:59:59.123Z",
			"2024-02-29T23:59:59.000Z",
			"2024-02-29T00:00:00.000Z",
			null,
		])
		expect(far).toEqual(utc)
	})
})
