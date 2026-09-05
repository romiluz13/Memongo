/**
 * Canonical Memongo release version reported by the MCP server handshake.
 * Must equal the root package.json `version`;
 * `scripts/check-publishability.ts` fails the release gate when they drift.
 */
export const MEMONGO_SERVER_VERSION = "2.1.0"
