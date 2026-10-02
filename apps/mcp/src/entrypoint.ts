import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

export function isEntrypoint(
	argv1: string | undefined,
	moduleUrl: string,
): boolean {
	if (!argv1) return false
	try {
		return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
	} catch {
		return false
	}
}
