// Usage: bun scripts/ci/scrub-api-log.ts <api-log>
// Rewrites the proof-pack API log in place, scrubbed and bounded like the
// service log, before the job prints or uploads it.
// Reads MEMONGO_API_KEY and MEMONGO_MONGODB_URI only to scrub them.
import { readFile, writeFile } from "node:fs/promises"

import { boundTail, scrubLogText } from "./proof-pack-diagnostics.js"

const MAX_FILE_BYTES = 1_048_576

const [apiLog] = process.argv.slice(2)
if (!apiLog) {
	console.error("usage: scrub-api-log.ts <api-log>")
	process.exit(2)
}
const secrets = [
	process.env.MEMONGO_API_KEY ?? "",
	process.env.MEMONGO_MONGODB_URI ?? "",
]
const raw = await readFile(apiLog, "utf8")
await writeFile(apiLog, boundTail(scrubLogText(raw, secrets), MAX_FILE_BYTES))
