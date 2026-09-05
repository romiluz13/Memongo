/**
 * Canonical Memongo release version reported by the HTTP API (OpenAPI info,
 * `/v1/status`). Must equal the root package.json `version`;
 * `scripts/check-publishability.ts` fails the release gate when they drift.
 */
export const MEMONGO_API_VERSION = "2.1.0"
