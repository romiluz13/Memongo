import { describe, it, expect } from "vitest"
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	OfficialPredictionSidecarError,
	OfficialQaCaptureError,
	createOfficialPredictionSidecar,
	createOfficialQaCaptureWriter,
	deriveOfficialPredictionSidecarPath,
	readOfficialPredictionSidecar,
	recordOfficialAnswer,
	recordOfficialUnreliable,
	recordOfficialVerdict,
	writeOfficialPredictionSidecarAtomic,
} from "./longmemeval-prediction-sidecar.js"

function identity() {
	return {
		runId: "run-1",
		datasetSha256: "a".repeat(64),
		configurationHash: "b".repeat(64),
		answerModel: "answer-model-x",
		judgeModel: "gpt-4o-2024-08-06",
		judgeProtocol: "official-anscheck" as const,
		promptVersion:
			"official-evaluate_qa@9e0b455f4ef0e2ab8f2e582289761153549043fc",
		answerPromptVersion: "dated-v2",
		answerTemperature: "0",
		answerMaxTokens: "4096",
	}
}

async function tempDir(label: string) {
	return mkdtemp(path.join(os.tmpdir(), `memongo-sidecar-${label}-`))
}

describe("deriveOfficialPredictionSidecarPath", () => {
	it("derives the single private sidecar path from the checkpoint path", () => {
		expect(
			deriveOfficialPredictionSidecarPath("/tmp/run/checkpoint.json"),
		).toBe("/tmp/run/checkpoint.json.predictions.json")
	})
})

describe("official prediction sidecar read/write", () => {
	it("returns null for a fresh run (sidecar file absent)", async () => {
		const dir = await tempDir("fresh")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			const loaded = await readOfficialPredictionSidecar(
				sidecarPath,
				identity(),
			)
			expect(loaded).toBeNull()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("round-trips a written sidecar and leaves the file mode 0600 with no temp remnants", async () => {
		const dir = await tempDir("roundtrip")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			let sidecar = createOfficialPredictionSidecar(identity())
			sidecar = recordOfficialAnswer(sidecar, "q-1", "violet")
			sidecar = recordOfficialVerdict(sidecar, "q-1", "yes")
			await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)

			const loaded = await readOfficialPredictionSidecar(
				sidecarPath,
				identity(),
			)
			expect(loaded?.rows["q-1"]).toMatchObject({
				questionId: "q-1",
				stage: "judged",
				hypothesis: "violet",
				verdict: "yes",
			})

			const info = await stat(sidecarPath)
			expect(info.mode & 0o777).toBe(0o600)
			const entries = await readdir(dir)
			expect(entries.filter((entry) => entry.includes(".tmp"))).toEqual([])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects torn JSON explicitly instead of silently resetting", async () => {
		const dir = await tempDir("torn")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			await writeFile(sidecarPath, "{ not valid json", "utf8")
			await expect(
				readOfficialPredictionSidecar(sidecarPath, identity()),
			).rejects.toThrow(OfficialPredictionSidecarError)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("fails explicitly when the sidecar directory is unwritable", async () => {
		const dir = await tempDir("readonly")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			const sidecar = recordOfficialAnswer(
				createOfficialPredictionSidecar(identity()),
				"q-1",
				"violet",
			)
			await chmod(dir, 0o500)
			await expect(
				writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar),
			).rejects.toThrow()
		} finally {
			await chmod(dir, 0o700)
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects an invalid row shape", async () => {
		const dir = await tempDir("badrow")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			const base = createOfficialPredictionSidecar(identity())
			await writeFile(
				sidecarPath,
				JSON.stringify({
					...base,
					rows: {
						"q-1": { questionId: "q-1", stage: "finished", hypothesis: "x" },
					},
				}),
				"utf8",
			)
			await expect(
				readOfficialPredictionSidecar(sidecarPath, identity()),
			).rejects.toThrow(/row/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("names the mismatching field for every identity mismatch", async () => {
		const dir = await tempDir("identity")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			const original = identity()
			await writeOfficialPredictionSidecarAtomic(
				sidecarPath,
				createOfficialPredictionSidecar(original),
			)
			for (const field of [
				"runId",
				"datasetSha256",
				"configurationHash",
				"answerModel",
				"judgeModel",
				"judgeProtocol",
				"promptVersion",
				"answerPromptVersion",
				"answerTemperature",
				"answerMaxTokens",
			] as const) {
				const mutated = { ...original }
				switch (field) {
					case "datasetSha256":
					case "configurationHash":
						mutated[field] = "c".repeat(64)
						break
					case "judgeProtocol":
						mutated[field] = "custom-v1" as never
						break
					default:
						mutated[field] = `${original[field]}-mutated`
				}
				await expect(
					readOfficialPredictionSidecar(sidecarPath, mutated),
				).rejects.toThrow(new RegExp(field))
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("round-trips an unreliable row with its reason (B8-3)", async () => {
		const dir = await tempDir("unreliable-roundtrip")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			let sidecar = createOfficialPredictionSidecar(identity())
			sidecar = recordOfficialUnreliable(
				sidecar,
				"q-1",
				"answer truncated by the token budget (finishReason=length)",
			)
			await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)
			const loaded = await readOfficialPredictionSidecar(
				sidecarPath,
				identity(),
			)
			expect(loaded?.rows["q-1"]).toMatchObject({
				questionId: "q-1",
				stage: "unreliable",
				hypothesis: "",
				verdict: null,
				reason: "answer truncated by the token budget (finishReason=length)",
			})
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("rejects an unreliable row without a reason or with a verdict", async () => {
		const dir = await tempDir("unreliable-invalid")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			const base = createOfficialPredictionSidecar(identity())
			const handWritten = (row: Record<string, unknown>) =>
				writeFile(
					sidecarPath,
					JSON.stringify({
						version: "v2",
						identity: base.identity,
						rows: { "q-1": row },
					}),
					"utf8",
				)
			await handWritten({
				questionId: "q-1",
				stage: "unreliable",
				hypothesis: "",
				verdict: null,
				updatedAt: new Date().toISOString(),
			})
			await expect(
				readOfficialPredictionSidecar(sidecarPath, identity()),
			).rejects.toThrow(/unreliable row q-1 without a reason/)

			await handWritten({
				questionId: "q-1",
				stage: "unreliable",
				hypothesis: "",
				verdict: "yes",
				reason: "truncated",
				updatedAt: new Date().toISOString(),
			})
			await expect(
				readOfficialPredictionSidecar(sidecarPath, identity()),
			).rejects.toThrow(/unreliable row q-1 with a verdict/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("official prediction sidecar row updates", () => {
	it("records answers and verdicts without mutating the input", () => {
		const base = createOfficialPredictionSidecar(identity())
		const answered = recordOfficialAnswer(base, "q-1", "violet")
		expect(base.rows["q-1"]).toBeUndefined()
		expect(answered.rows["q-1"]).toMatchObject({
			stage: "answered",
			hypothesis: "violet",
		})
		const judged = recordOfficialVerdict(answered, "q-1", "yes")
		expect(answered.rows["q-1"]?.stage).toBe("answered")
		expect(judged.rows["q-1"]).toMatchObject({
			stage: "judged",
			verdict: "yes",
			hypothesis: "violet",
		})
	})

	it("refuses a verdict for a case with no answered row", () => {
		const base = createOfficialPredictionSidecar(identity())
		expect(() => recordOfficialVerdict(base, "q-404", "yes")).toThrow(
			/answered/,
		)
	})

	it("treats unreliable rows as terminal: never re-answered, never judged (B8-3)", () => {
		const base = createOfficialPredictionSidecar(identity())
		const unreliable = recordOfficialUnreliable(base, "q-1", "truncated")
		expect(() => recordOfficialAnswer(unreliable, "q-1", "violet")).toThrow(
			/already unreliable/,
		)
		expect(() => recordOfficialVerdict(unreliable, "q-1", "yes")).toThrow(
			/not answered/,
		)
		expect(() =>
			recordOfficialUnreliable(unreliable, "q-1", "truncated again"),
		).toThrow(/already unreliable/)
		// Fresh (answered) rows can still become unreliable, e.g. a judge-time
		// discovery reclassifies the case before verdict.
		const answered = recordOfficialAnswer(base, "q-2", "violet")
		const reclassified = recordOfficialUnreliable(
			answered,
			"q-2",
			"reclassified",
		)
		expect(reclassified.rows["q-2"]?.stage).toBe("unreliable")
	})
})

describe("official prediction sidecar privacy", () => {
	it("serializes only identities, question ids, hypotheses, stages and verdicts", async () => {
		const dir = await tempDir("privacy")
		try {
			const sidecarPath = path.join(dir, "checkpoint.json.predictions.json")
			const secretMaterial = {
				gold: "GOLD-SECRET-42",
				question: "QUESTION-SECRET-42",
				passage: "PASSAGE-SECRET-42",
				apiKey: "sk-SECRET-42",
			}
			let sidecar = createOfficialPredictionSidecar(identity())
			sidecar = recordOfficialAnswer(
				sidecar,
				"q-1",
				"The user's favorite color is violet",
			)
			await writeOfficialPredictionSidecarAtomic(sidecarPath, sidecar)
			// The gold answer, question text, context passages, and credentials
			// never enter the sidecar API, so none may appear in the file.
			const raw = await readFile(sidecarPath, "utf8")
			expect(raw).not.toContain(secretMaterial.gold)
			expect(raw).not.toContain(secretMaterial.question)
			expect(raw).not.toContain(secretMaterial.passage)
			expect(raw).not.toContain(secretMaterial.apiKey)
			const parsed = JSON.parse(raw) as {
				rows: Record<string, Record<string, unknown>>
			}
			expect(Object.keys(parsed)).toEqual(["version", "identity", "rows"])
			for (const row of Object.values(parsed.rows)) {
				expect(Object.keys(row).sort()).toEqual(
					["hypothesis", "questionId", "stage", "updatedAt", "verdict"].sort(),
				)
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe("private official QA capture persistence", () => {
	it("keeps request and outcome files separate, exclusive and private", async () => {
		const dir = await tempDir("capture")
		try {
			const sidecarPath = path.join(dir, "checkpoint.predictions.json")
			const write = await createOfficialQaCaptureWriter(sidecarPath, identity())
			await write(1, "request", { phase: "preflight", model: "answer" })
			await write(1, "outcome", { status: "succeeded", content: "ok" })
			const capture = `${sidecarPath}.capture`
			expect((await stat(capture)).mode & 0o777).toBe(0o700)
			expect((await readdir(capture)).sort()).toEqual([
				"1.outcome.json",
				"1.request.json",
			])
			for (const name of await readdir(capture)) {
				expect((await stat(path.join(capture, name))).mode & 0o777).toBe(0o600)
			}
			const original = await readFile(
				path.join(capture, "1.request.json"),
				"utf8",
			)
			expect(JSON.parse(original)).toMatchObject({
				sequence: 1,
				kind: "request",
				runId: "run-1",
				datasetSha256: identity().datasetSha256,
				configurationHash: identity().configurationHash,
			})
			await expect(
				write(1, "request", { content: "replacement" }),
			).rejects.toThrow(OfficialQaCaptureError)
			expect(await readFile(path.join(capture, "1.request.json"), "utf8")).toBe(
				original,
			)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it.each([
		"file",
		"directory",
		"symlink",
	])("refuses a preexisting capture %s without altering it", async (kind) => {
		const dir = await tempDir(`capture-existing-${kind}`)
		try {
			const sidecarPath = path.join(dir, "checkpoint.predictions.json")
			const capture = `${sidecarPath}.capture`
			const target = path.join(dir, "protected")
			await writeFile(target, "protected bytes")
			if (kind === "directory") await mkdir(capture)
			else if (kind === "symlink") await symlink(target, capture)
			else await writeFile(capture, "existing capture")
			await expect(
				createOfficialQaCaptureWriter(sidecarPath, identity()),
			).rejects.toThrow(OfficialQaCaptureError)
			expect(await readFile(target, "utf8")).toBe("protected bytes")
			if (kind === "file")
				expect(await readFile(capture, "utf8")).toBe("existing capture")
			if (kind === "directory") expect(await readdir(capture)).toEqual([])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it.each([
		"file",
		"symlink",
		"dangling-symlink",
	])("refuses a preexisting prediction %s", async (kind) => {
		const dir = await tempDir(`capture-prediction-${kind}`)
		try {
			const sidecarPath = path.join(dir, "checkpoint.predictions.json")
			const target = path.join(dir, "protected")
			if (kind !== "dangling-symlink")
				await writeFile(target, "protected bytes")
			if (kind === "file") await writeFile(sidecarPath, "existing prediction")
			else await symlink(target, sidecarPath)
			await expect(
				createOfficialQaCaptureWriter(sidecarPath, identity()),
			).rejects.toThrow(OfficialQaCaptureError)
			expect(await readdir(dir)).not.toContain(
				"checkpoint.predictions.json.capture",
			)
			if (kind !== "dangling-symlink")
				expect(await readFile(target, "utf8")).toBe("protected bytes")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("refuses an individual receipt symlink without creating its target", async () => {
		const dir = await tempDir("capture-receipt-symlink")
		try {
			const sidecarPath = path.join(dir, "checkpoint.predictions.json")
			const write = await createOfficialQaCaptureWriter(sidecarPath, identity())
			const target = path.join(dir, "absent-protected")
			await symlink(target, `${sidecarPath}.capture/1.request.json`)
			await expect(write(1, "request", { content: "private" })).rejects.toThrow(
				OfficialQaCaptureError,
			)
			expect(await readdir(dir)).not.toContain("absent-protected")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it.each([
		"directory",
		"symlink",
		"permissions",
	])("stops after owned directory %s changes", async (kind) => {
		const dir = await tempDir(`capture-owner-${kind}`)
		try {
			const sidecarPath = path.join(dir, "checkpoint.predictions.json")
			const capture = `${sidecarPath}.capture`
			const write = await createOfficialQaCaptureWriter(sidecarPath, identity())
			if (kind === "permissions") await chmod(capture, 0o755)
			else {
				await rename(capture, `${capture}.original`)
				if (kind === "symlink") await symlink(`${capture}.original`, capture)
				else await mkdir(capture, { mode: 0o700 })
			}
			await expect(write(1, "request", { content: "private" })).rejects.toThrow(
				OfficialQaCaptureError,
			)
			expect(await readdir(capture)).toEqual([])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
