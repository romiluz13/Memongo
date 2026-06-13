import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	createLongMemEvalShards,
	writeLongMemEvalShards,
} from "./longmemeval-shards.js"

const tempDirs: string[] = []

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "memongo-longmemeval-shards-"))
	tempDirs.push(dir)
	return dir
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("longmemeval shards", () => {
	it("creates deterministic shards in original dataset order", () => {
		const shards = createLongMemEvalShards({
			entries: [
				{ question_id: "q1", question_type: "single-session-user" },
				{ question_id: "q2", question_type: "multi-session" },
				{ question_id: "q3", question_type: "multi-session" },
			],
			shardSize: 2,
			outDir: "/tmp/out",
			filePrefix: "longmemeval_s_cleaned",
		})

		expect(shards).toHaveLength(2)
		expect(shards[0]).toMatchObject({
			shardId: "shard-00",
			startInclusive: 0,
			endExclusive: 2,
			questionIds: ["q1", "q2"],
			questionTypes: {
				"single-session-user": 1,
				"multi-session": 1,
			},
		})
		expect(shards[1]).toMatchObject({
			shardId: "shard-01",
			startInclusive: 2,
			endExclusive: 3,
			questionIds: ["q3"],
			questionTypes: {
				"multi-session": 1,
			},
		})
	})

	it("writes raw shard datasets and a disclosure manifest", () => {
		const dir = tempDir()
		const datasetPath = join(dir, "longmemeval_s_cleaned.json")
		const outDir = join(dir, "shards")
		writeFileSync(
			datasetPath,
			`${JSON.stringify([
				{ question_id: "q1", question_type: "single-session-user" },
				{ question_id: "q2", question_type: "multi-session" },
				{ question_id: "q3", question_type: "temporal-reasoning" },
			])}\n`,
		)

		const manifest = writeLongMemEvalShards({
			datasetPath,
			outDir,
			shardSize: 2,
			label: "test-sharded-run",
		})

		expect(manifest.totalQuestions).toBe(3)
		expect(manifest.totalShards).toBe(2)
		expect(manifest.disclosure).toContain("Sharded local rehearsal only")
		const firstShard = JSON.parse(
			readFileSync(join(outDir, "longmemeval_s_cleaned-shard-00.json"), "utf8"),
		) as unknown[]
		expect(firstShard).toHaveLength(2)
		expect(
			readFileSync(join(outDir, "longmemeval-shard-manifest.md"), "utf8"),
		).toContain("Do not publish as a single-run result")
	})

	it("rejects invalid shard sizes and duplicate question ids", () => {
		expect(() =>
			createLongMemEvalShards({
				entries: [{ question_id: "q1" }],
				shardSize: 0,
				outDir: "/tmp/out",
				filePrefix: "dataset",
			}),
		).toThrow("positive integer")

		expect(() =>
			createLongMemEvalShards({
				entries: [{ question_id: "q1" }, { question_id: "q1" }],
				shardSize: 1,
				outDir: "/tmp/out",
				filePrefix: "dataset",
			}),
		).toThrow("duplicate question_id")
	})
})
