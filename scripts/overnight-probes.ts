import { main } from "./overnight-probes/cli.ts"
import { createLiveIo } from "./overnight-probes/harness-live.ts"

export { main }

const EXIT_GRACE_MS = 5_000

if (import.meta.main) {
	const code = await main(process.argv.slice(2), process.env, createLiveIo())
	process.exitCode = code
	setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref()
}
