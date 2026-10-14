import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
	ConversationImportRejectedError,
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
				.map((entry) => ({ line: 1, ...entry }))
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
					line: 1,
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

describe("B01 review corrections", () => {
	it("keeps years 0-99, sub-millisecond digits and padded values on the right instant", async () => {
		const { parseExplicitTimestamp } = await import(
			"./conversation-timestamp.js"
		)
		expect(parseExplicitTimestamp("0050-06-01")?.toISOString()).toBe(
			"0050-06-01T00:00:00.000Z",
		)
		expect(parseExplicitTimestamp("0000-02-29")?.toISOString()).toBe(
			"0000-02-29T00:00:00.000Z",
		)
		expect(parseExplicitTimestamp("0100-02-29")).toBeNull()
		expect(
			parseExplicitTimestamp("2024-01-02T03:04:05.123456+00:00")?.toISOString(),
		).toBe("2024-01-02T03:04:05.123Z")
		expect(
			parseExplicitTimestamp(" 2024-01-02T03:04:05Z ")?.toISOString(),
		).toBe("2024-01-02T03:04:05.000Z")
		expect(
			parseExplicitTimestamp("2024-01-01T00:30:00-01:30")?.toISOString(),
		).toBe("2024-01-01T02:00:00.000Z")
		for (const canonical of [
			"2024-02-29T23:59:59.123Z",
			"1999-12-31T23:00:00+05:45",
			"2024-07-01T00:00Z",
		])
			expect(parseExplicitTimestamp(canonical)?.getTime()).toBe(
				new Date(canonical).getTime(),
			)
	})

	it("reports pretty-printed JSON rejections with a null line", async () => {
		const file = await datasetFile(
			"pretty.json",
			JSON.stringify(
				[{ turns: [valid("keep"), { role: "x", body: "y" }] }],
				null,
				2,
			),
		)
		const receipt = await importConversationDataset({
			datasetPath: file,
			writeTurns: capture().writeTurns,
		})
		expect(receipt.rejections).toEqual([
			{
				line: null,
				conversationIndex: 0,
				turnIndex: 1,
				reason: "invalid-role",
			},
		])
	})

	it("says why when every record is rejected, without values", async () => {
		const file = await datasetFile(
			"bad.jsonl",
			[
				JSON.stringify({ turns: [valid(SECRET_BODY, BAD_STAMP)] }),
				"{not json",
			].join("\n"),
		)
		const error = await loadConversationDataset(file).catch((e: Error) => e)
		expect(String(error)).toContain(
			"no valid conversations (failedLines=1, invalid-timestamp=1, no-valid-turns=1)",
		)
		expect(String(error)).not.toContain(SECRET_BODY)
		expect(String(error)).not.toContain(BAD_STAMP)
	})
})

describe("B01 all-invalid imports fail closed with per-record diagnostics", () => {
	async function rejectAll(name: string, content: string) {
		const file = await datasetFile(name, content)
		const sink = capture()
		const error = await importConversationDataset({
			datasetPath: file,
			writeTurns: sink.writeTurns,
		}).catch((e: unknown) => e)
		expect(sink.written).toEqual([])
		expect(error).toBeInstanceOf(ConversationImportRejectedError)
		const rejected = error as ConversationImportRejectedError
		expect(rejected.message).toContain(
			"conversation dataset contains no valid conversations",
		)
		const text = JSON.stringify({
			message: rejected.message,
			rejections: rejected.rejections,
		})
		expect(text).not.toContain(SECRET_BODY)
		expect(text).not.toContain(BAD_STAMP)
		expect(text).not.toContain(path.dirname(file))
		return rejected
	}

	it("JSON: every rejected turn and conversation keeps its coordinates", async () => {
		const error = await rejectAll(
			"all-bad.json",
			JSON.stringify(
				[
					{
						turns: [
							valid(SECRET_BODY, BAD_STAMP),
							{ role: "robot", body: "x" },
						],
					},
					{ turns: "nope" },
				],
				null,
				2,
			),
		)
		expect(error).toMatchObject({
			failedLines: 0,
			rejectedTurns: 2,
			rejectedConversations: 2,
		})
		expect(error.rejections).toEqual([
			{
				line: null,
				conversationIndex: 0,
				turnIndex: 0,
				reason: "invalid-timestamp",
			},
			{
				line: null,
				conversationIndex: 0,
				turnIndex: 1,
				reason: "invalid-role",
			},
			{
				line: null,
				conversationIndex: 0,
				turnIndex: null,
				reason: "no-valid-turns",
			},
			{
				line: null,
				conversationIndex: 1,
				turnIndex: null,
				reason: "turns-not-array",
			},
		])
	})

	it("JSONL semantic: rejections carry physical lines; syntax failures stay failedLines", async () => {
		const error = await rejectAll(
			"all-bad.jsonl",
			[
				"{not json",
				JSON.stringify({ turns: [valid(SECRET_BODY, "")] }),
				"",
				JSON.stringify([1, 2]),
			].join("\n"),
		)
		expect(error).toMatchObject({
			failedLines: 1,
			rejectedTurns: 1,
			rejectedConversations: 2,
		})
		expect(error.rejections).toEqual([
			{
				line: 2,
				conversationIndex: 0,
				turnIndex: 0,
				reason: "invalid-timestamp",
			},
			{
				line: 2,
				conversationIndex: 0,
				turnIndex: null,
				reason: "no-valid-turns",
			},
			{
				line: 4,
				conversationIndex: 1,
				turnIndex: null,
				reason: "conversation-not-object",
			},
		])
	})

	it("JSONL syntax-only: no records, only failedLines", async () => {
		const error = await rejectAll("syntax.jsonl", "{not json\n[oops\n")
		expect(error).toMatchObject({
			failedLines: 2,
			rejectedTurns: 0,
			rejectedConversations: 0,
			rejections: [],
		})
	})
})
