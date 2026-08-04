import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	importConversationDataset,
	resolveConversationDatasetPath,
	type ConversationReplayBatchTurn,
} from "./mongodb-conversation-import.js"

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
	temporaryDirectories.push(directory)
	return directory
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	)
})

describe("conversation dataset import", () => {
	it("resolves workspace-relative JSON datasets", async () => {
		const workspace = await temporaryDirectory("memongo-import-workspace-")
		const datasetPath = path.join(workspace, "history.json")
		await writeFile(datasetPath, JSON.stringify({ conversations: [] }))

		await expect(
			resolveConversationDatasetPath({
				datasetPath: "history.json",
				baseDir: workspace,
				allowedRoots: [workspace],
			}),
		).resolves.toBe(await realpath(datasetPath))
	})

	it("rejects datasets outside the configured roots", async () => {
		const workspace = await temporaryDirectory("memongo-import-workspace-")
		const outside = await temporaryDirectory("memongo-import-outside-")
		const datasetPath = path.join(outside, "history.json")
		await writeFile(datasetPath, JSON.stringify({ conversations: [] }))

		await expect(
			resolveConversationDatasetPath({
				datasetPath,
				baseDir: workspace,
				allowedRoots: [workspace],
			}),
		).rejects.toThrow(
			"datasetPath must resolve inside the workspace or configured conversation dataset directory",
		)
	})

	it("replays generic conversations in one idempotent batch", async () => {
		const workspace = await temporaryDirectory("memongo-import-workspace-")
		const datasetPath = path.join(workspace, "history.json")
		await writeFile(
			datasetPath,
			JSON.stringify({
				conversations: [
					{
						conversationId: "conversation-1",
						sessionId: "session-1",
						turns: [
							{ role: "user", body: "Remember espresso." },
							{ role: "assistant", body: "I will remember it." },
						],
					},
				],
			}),
		)
		const writeTurns = vi.fn(async (turns: ConversationReplayBatchTurn[]) =>
			turns.map(() => ({
				ok: true as const,
				eventId: "event-1",
				chunkCreated: false,
			})),
		)

		const result = await importConversationDataset({
			datasetPath,
			baseDir: workspace,
			allowedRoots: [workspace],
			scope: "agent",
			writeTurns,
		})

		expect(result).toEqual(
			expect.objectContaining({
				datasetKind: "generic",
				conversationsImported: 1,
				turnsImported: 2,
				failedTurns: 0,
			}),
		)
		expect(writeTurns).toHaveBeenCalledTimes(1)
		const batch = writeTurns.mock.calls[0]?.[0] ?? []
		expect(batch).toHaveLength(2)
		expect(batch[0]).toEqual(
			expect.objectContaining({
				role: "user",
				body: "Remember espresso.",
				sessionId: "session-1",
				scope: "agent",
				idempotencyKey: expect.any(String),
			}),
		)
		expect(batch[0]?.idempotencyKey).not.toBe(batch[1]?.idempotencyKey)
	})
})
