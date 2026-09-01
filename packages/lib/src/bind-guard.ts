/**
 * Guardrail 3: Routable-Bind Refusal
 *
 * Copied from agent-memory's runner.py (_refuse_to_serve_open, lines 104-140),
 * strengthened with a two-flag override model instead of the source's single
 * flag. Prevents the API/MCP server from binding a non-loopback address with
 * authentication disabled — a posture where any network-reachable client can
 * read or permanently erase any user's memories.
 */

/**
 * Addresses that reach only this host. A server bound to one of these is
 * reachable by processes on the same machine and nothing else — the local
 * development posture where unauthenticated access is reasonable.
 *
 * Copied from agent-memory's _LOOPBACK_HOSTS (runner.py:83-87), which includes
 * ::1 and its IPv4-mapped form because uvicorn accepts both. Adapted for
 * Node's @hono/node-server and http.Server, which use the same address forms.
 */
const LOOPBACK_HOSTS = new Set([
	"127.0.0.1",
	"localhost",
	"::1",
	"[::1]",
	"::ffff:127.0.0.1",
])

/**
 * Whether `host` binds loopback only.
 *
 * Anything in 127.0.0.0/8 counts, not just 127.0.0.1 — 127.0.0.2 is as
 * unroutable as its more famous sibling. Everything else is treated as
 * routable, including the empty string and 0.0.0.0: when the address is not
 * recognizably local, the safe reading is that it is reachable.
 *
 * Copied from agent-memory's _is_loopback() (runner.py:93-101).
 */
export function isLoopbackBindHost(host: string): boolean {
	const normalized = (host ?? "")
		.trim()
		.replace(/^\[|\]$/g, "")
		.toLowerCase()
	if (LOOPBACK_HOSTS.has(normalized)) return true
	return normalized.startsWith("127.")
}

/**
 * Refuse to bind a routable address with authentication disabled.
 *
 * With auth off and a non-loopback bind, any client that can route to the
 * process may read any tenant's memories or invoke permanent-erasure paths
 * against them. The default Docker posture (0.0.0.0 +
 * MEMONGO_ALLOW_INSECURE_NO_AUTH) is exactly this: fully open on all
 * interfaces.
 *
 * Two-layer override model (strengthens agent-memory's single-flag design):
 * - MEMONGO_ALLOW_INSECURE_NO_AUTH=true: covers loopback only. The local dev
 *   posture where no auth is convenient and safe.
 * - MEMONGO_ALLOW_INSECURE_REMOTE=true: explicit opt-in for non-loopback +
 *   no auth. For internal-only deployments behind a trusted gateway. Logged
 *   at warning on every start, because "we set that flag for a spike" is how
 *   it survives into production unnoticed.
 *
 * Copied from agent-memory's _refuse_to_serve_open() (runner.py:104-140).
 */
export function refuseToServeOpen(host: string, authConfigured: boolean): void {
	if (authConfigured || isLoopbackBindHost(host)) return

	const allowInsecureNoAuth =
		process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH === "true" ||
		process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH === "1" ||
		process.env.MEMONGO_ALLOW_INSECURE_NO_AUTH === "yes"

	const allowInsecureRemote =
		process.env.MEMONGO_ALLOW_INSECURE_REMOTE === "true" ||
		process.env.MEMONGO_ALLOW_INSECURE_REMOTE === "1" ||
		process.env.MEMONGO_ALLOW_INSECURE_REMOTE === "yes"

	if (allowInsecureNoAuth && allowInsecureRemote) {
		// Deliberate: an internal-only deployment behind its own gateway is a
		// real configuration. Logged at warning on every start, because "we set
		// that flag for a spike" is how it survives into production unnoticed.
		console.warn(
			`WARNING: Serving UNAUTHENTICATED on ${host} — every client that ` +
				`can reach this port can read or permanently erase any user's ` +
				`memories. Permitted by MEMONGO_ALLOW_INSECURE_REMOTE=true.`,
		)
		return
	}

	throw new Error(
		`Refusing to bind ${host} with authentication disabled. Any client ` +
			`that can reach this port could read or permanently erase any user's ` +
			`memories.\n` +
			`  • To secure it: set MEMONGO_API_KEY (or MEMONGO_API_SCOPED_KEYS).\n` +
			`  • For local development (not Docker): set ` +
			`MEMONGO_API_HOST=127.0.0.1 instead of ${host}.\n` +
			`  • Inside Docker: keep MEMONGO_API_HOST=0.0.0.0 and set ` +
			`MEMONGO_API_KEY — binding 127.0.0.1 inside a container makes it ` +
			`unreachable.\n` +
			`  • To accept the risk on a trusted network: set both ` +
			`MEMONGO_ALLOW_INSECURE_NO_AUTH=true and ` +
			`MEMONGO_ALLOW_INSECURE_REMOTE=true.`,
	)
}
