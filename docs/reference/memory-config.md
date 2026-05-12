# Memory configuration reference

This is a historical configuration note for earlier OpenClaw-era docs.

Memongo's supported configuration entrypoints are:

- [apps/docs/guides/memory-config.mdx](../../apps/docs/guides/memory-config.mdx)
- [docs/platform/self-host.md](../platform/self-host.md)
- `MEMONGO_MONGODB_URI`
- `MEMONGO_API_KEY`
- `MEMONGO_API_SCOPED_KEYS` - JSON scoped bearer-token policies. Invalid, empty, or unconstrained policies fail closed at API startup.
- `MEMONGO_LLM_ENRICHMENT_MAX_TOKENS` - optional output-token cap for strict LLM session enrichment. Defaults to `1024`; increase for long sessions if strict JSON responses are truncated.
- `MEMONGO_CONFIG_PATH`
- `MEMONGO_WORKSPACE_DIR`

If you are configuring Memongo today, use the supported MongoDB-backed runtime settings documented in the Mintlify app.
