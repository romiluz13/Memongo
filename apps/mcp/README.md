# @memongo/mcp

MCP server for [Memongo](https://github.com/romiluz13/memongo) — exposes
MongoDB-native long-term AI memory (recall, write, lifecycle, import, jobs,
benchmarks) to any MCP-capable agent. It is a thin adapter over the Memongo
HTTP API: every tool call goes through `MEMONGO_API_URL`.

## Install and run

```sh
npx -y @memongo/mcp
```

Or install globally:

```sh
npm install -g @memongo/mcp
memongo-mcp
```

## Configuration

| Variable                | Default                 | Description                                                            |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `MEMONGO_API_URL`       | `http://localhost:3100` | Base URL of the Memongo HTTP API.                                      |
| `MEMONGO_API_KEY`       | —                       | API key sent as `Authorization: Bearer`.                               |
| `MEMONGO_MCP_TRANSPORT` | `stdio`                 | `stdio` (default) or `http`.                                           |
| `MEMONGO_MCP_HTTP_PORT` | `3110`                  | Port for the HTTP transport.                                           |
| `MEMONGO_MCP_HTTP_HOST` | `127.0.0.1`             | Bind address for the HTTP transport.                                   |
| `MEMONGO_MCP_AUTH_TOKEN` | —                     | Client credential for the HTTP transport (`Authorization: Bearer`). Required for non-loopback binds. |
| `MEMONGO_MCP_ADMIN_TOKEN` | —                    | Optional admin credential; requests bearing it unlock admin tools (with `MEMONGO_MCP_ADMIN=1`). |
| `MEMONGO_MCP_ALLOWED_HOSTS` | —                  | Comma-separated extra hostnames the `Host` header (and browser `Origin`) may carry; needed behind reverse proxies. |
| `MEMONGO_MCP_ADMIN`     | off                     | `1`/`true` also registers admin/benchmark tools (status, jobs, traces, relevance/benchmark suites). |
| `MEMONGO_MCP_ALIASES`   | off                     | `1`/`true` registers `memongo_recall_messages`. The `memongo_memory_*` and `memongo_import_conversation_history` aliases also require `MEMONGO_MCP_ADMIN=1` and the admin credential over authenticated HTTP. |

By default only the 12 core tools are advertised (`memongo_search`,
`memongo_search_detailed`, `memongo_add`, `memongo_write_event`,
`memongo_write_structured`, `memongo_recall_conversation`,
`memongo_build_context_bundle`, `memongo_profile`, `memongo_state_unified`,
`memongo_self_edit`, `memongo_memory_feedback`, `memongo_extract`) so MCP hosts
pay prompt tokens only for the write -> extract -> recall loop. Every tool
returns `structuredContent` alongside the text serialization of its JSON
result.

Lifecycle get (including its memory-get alias), active-slate, discovery and
unified-state results carry the same top-level untrusted-memory provenance
notice as the existing search, recall, profile, context-bundle and file-read
results. The notice appears in both JSON text and `structuredContent`; nested
provenance remains intact. It is advisory model context, not an authorization
check or a guarantee against prompt injection. Lifecycle history results remain
outside this change.

The MCP `memongo_quarantine_list` tool rejects a provided status outside
`pending-review`, `promoting`, `promoted`, and `rejected` with `isError: true`
before calling the API. The HTTP endpoint also rejects an unsupported status
with `400`. Omit `status` to list all stages; an empty `?status=` is invalid.

## stdio transport (default)

stdio is the default and intended for local, single-client use per the MCP
spec. Example client config (Claude Code, Cursor, Pi, etc.):

```json
{
	"mcpServers": {
		"memongo": {
			"command": "npx",
			"args": ["-y", "@memongo/mcp"],
			"env": {
				"MEMONGO_API_URL": "http://localhost:3100",
				"MEMONGO_API_KEY": "..."
			}
		}
	}
}
```

## Streamable HTTP transport

For remote or sandboxed agents, opt into the MCP Streamable HTTP transport
(spec 2025-03-26+; the legacy SSE transport is not supported):

```sh
MEMONGO_MCP_TRANSPORT=http MEMONGO_MCP_HTTP_PORT=3110 memongo-mcp
```

The server listens on `http://127.0.0.1:3110/mcp` and speaks stateless
request/response JSON (no session state, no SSE stream required). It still
calls the same Memongo HTTP API — this is a transport adapter, not a second
server implementation.

Point a remote MCP client at `http://<host>:3110/mcp`.

### Authentication

The HTTP transport authenticates callers with a dedicated bearer credential —
distinct from `MEMONGO_API_KEY`, which authenticates this server to the
upstream API and says nothing about who may call this endpoint:

- `MEMONGO_MCP_AUTH_TOKEN` — when set, every request must present
  `Authorization: Bearer <token>`; anything else gets `401` with
  `WWW-Authenticate: Bearer` (the MCP authorization spec's minimum).
  Comparisons are constant-time. A non-loopback bind refuses to start
  without this token.
- `MEMONGO_MCP_ADMIN_TOKEN` — optional admin credential. Requests bearing it
  get the admin tool scope (when `MEMONGO_MCP_ADMIN=1`); the standard token
  never does. `MEMONGO_MCP_ADMIN=1` without an admin token leaves admin
  tools unreachable over HTTP (fail closed).
- No token + loopback bind — local-trust mode, unchanged for development.

Every request (all paths) is also checked against the `Host` header — and
against `Origin` when a browser sends one — returning `403` on mismatch as a
DNS-rebinding defense. Loopback binds allow the loopback names
(`localhost`, `127.0.0.1`, `::1`); a specific non-loopback bind allows its
own hostname; wildcard binds (`0.0.0.0`) allow nothing implicitly, so
declare names via `MEMONGO_MCP_ALLOWED_HOSTS` (reverse proxies rewrite
`Host` to the public name).

## Development (from a monorepo checkout)

```sh
bun install
bun run build
bun run test
node dist/server.js
```

## License

Apache-2.0

Detailed search preserves provided `searchMode` and `searchConfig` constraints
for API validation. Invalid values produce a tool error with the default
non-silent client. An explicitly injected `silent: true` client retains empty
results with a degradation marker. Other top-level numeric and boolean controls
still use the existing type filtering.

The `memongo-mcp` launcher resolves symbolic links before checking its entrypoint, so npm bin links start the stdio server. Importing the package keeps startup explicit.
