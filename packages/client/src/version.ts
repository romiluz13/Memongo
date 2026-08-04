/**
 * Version of this client package, sent as the `x-memongo-client-version`
 * header on every request so servers can log client/server version skew.
 * Must equal packages/client/package.json `version`;
 * `scripts/check-publishability.ts` fails the release gate when they drift.
 */
export const MEMONGO_CLIENT_VERSION = "2.0.1"
