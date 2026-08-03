# Reference

Lookup material for operators and contributors. Everything here traces to a source file; when this section and the code disagree, the code wins.

## Pages

- [Configuration](configuration.md) — every `MEMONGO_*` environment variable, the `MemongoConfig` shape, capability detection, and version gating
- [Data models](data-models.md) — MongoDB collections, indexes, `$jsonSchema` validators, and the six memory types
- [Dependencies](dependencies.md) — external dependencies per package with pinned versions

## Quick answers

| Question | Where |
|----------|-------|
| Which env vars does the API read? | [Configuration](configuration.md#api-server) |
| What collections exist in MongoDB? | [Data models](data-models.md#collections) |
| What MongoDB version do I need? | [Configuration](configuration.md#capability-detection-and-version-gating) |
| What scopes are valid? | [Data models](data-models.md#scopes) |
| Which MongoDB driver version? | [Dependencies](dependencies.md) |

## Related pages

- [Security](../security.md) — auth and SSRF configuration
- [Deployment](../deployment.md) — container environment
- [REST API](../api/index.md) — endpoint-level contract
