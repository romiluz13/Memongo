import {
	memongoBridgePreflight,
	memongoBridgeShutdown,
	safeBootText,
} from "@memongo/memory-bridge"
import { formatErrorMessage } from "@memongo/lib"
import { formatPreflightReport } from "./lib/capabilities.js"

// M2 preflight: report every unmet startup requirement for the configured
// deployment without starting the server and without writing anything.
// Exit 0 when boot would pass as-is, 1 otherwise. The report is JSON on
// stdout; every string goes through the boot safe renderer, so no URI, host
// or secret is printed.
try {
	const report = await memongoBridgePreflight({})
	console.log(formatPreflightReport(report))
	await memongoBridgeShutdown()
	process.exit(report.ok ? 0 : 1)
} catch (err) {
	console.error(`preflight failed: ${safeBootText(formatErrorMessage(err))}`)
	process.exit(1)
}
