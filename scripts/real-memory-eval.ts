import { randomUUID } from "node:crypto"
import { MemongoClient } from "@memongo/client"

import { runMemoryEvalSuite } from "./memory-eval-core.js"
import { writeProofArtifact } from "./proof-artifacts.js"

const baseUrl = (
	process.env.MEMONGO_API_URL?.trim() ?? "http://127.0.0.1:3847"
).replace(/\/$/, "")
const apiKey = process.env.MEMONGO_API_KEY?.trim() || undefined
const label = process.env.MEMONGO_EVAL_LABEL?.trim() ?? "candidate"
const seed =
	process.env.MEMONGO_EVAL_SEED?.trim() ?? `eval-${randomUUID().slice(0, 8)}`

async function main() {
	const client = new MemongoClient({
		baseUrl,
		apiKey,
		maxRetries: 2,
	})

	const report = await runMemoryEvalSuite({
		client,
		label,
		seed,
	})
	const artifactPath = await writeProofArtifact({
		suite: "real-memory-eval",
		payload: report,
	})

	console.log(
		JSON.stringify(
			artifactPath ? { ...report, artifactPath } : report,
			null,
			2,
		),
	)
}

await main()
