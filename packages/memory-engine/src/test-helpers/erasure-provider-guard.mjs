import fs from "node:fs"
import { isMainThread, threadId } from "node:worker_threads"
const evidence = process.env.E22_FETCH_EVIDENCE_DIR
if (!evidence) throw new Error("E22 requires fetch evidence directory")
const record = (entry) =>
	fs.appendFileSync(
		`${evidence}/${process.pid}-${threadId}.jsonl`,
		JSON.stringify(entry) + "\n",
	)
record({ kind: "preload", pid: process.pid, threadId, isMainThread })
globalThis.fetch = async (input) => {
	const host = new URL(
		typeof input === "string" || input instanceof URL ? input : input.url,
	).hostname
	record({ kind: "fetch-denied", host })
	throw new Error(`E22 provider fetch denied: ${host}`)
}
