import {
	memongoBridgePreflight,
	memongoBridgeShutdown,
} from "@memongo/memory-bridge"
import { redactSensitiveText } from "@memongo/lib"

// M2 preflight: report every unmet startup requirement for the configured
// deployment without starting the server and without writing anything.
// Exit 0 when boot would pass as-is, 1 otherwise. The report is JSON on
// stdout; messages are redacted, so no URI, key or secret is printed.
const report = await memongoBridgePreflight({})
console.log(redactSensitiveText(JSON.stringify(report, null, 2)))
await memongoBridgeShutdown()
process.exit(report.ok ? 0 : 1)
