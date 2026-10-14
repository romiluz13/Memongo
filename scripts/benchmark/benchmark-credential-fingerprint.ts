import { createHmac } from "node:crypto"

/**
 * Operator-held key for credential fingerprints: exactly 64 hex characters
 * (32 bytes). Never recorded, logged or generated here.
 */
export const BENCHMARK_FINGERPRINT_KEY_ENV = "MEMONGO_BENCHMARK_FINGERPRINT_KEY"

const FINGERPRINT_LABEL = "memongo.benchmark.credential.v1"
const KEY_ID_LABEL = "memongo.benchmark.credential-key-id.v1"
const HEX_KEY = /^[0-9a-fA-F]{64}$/

/**
 * The fingerprint key from `env`. Throws (without echoing the value) when it
 * is absent or not exactly 64 hex characters: Buffer.from(hex) silently stops
 * at the first invalid character, so the shape is checked first.
 */
export function parseBenchmarkFingerprintKey(
	env: Record<string, string | undefined>,
): Buffer {
	const value = env[BENCHMARK_FINGERPRINT_KEY_ENV]?.trim() ?? ""
	if (!HEX_KEY.test(value))
		throw new Error(
			`${BENCHMARK_FINGERPRINT_KEY_ENV} must be exactly 64 hex characters (32 bytes); credential identity cannot be bound without it`,
		)
	return Buffer.from(value, "hex")
}

/** Equality-domain tag for fingerprints made under `key`; not provenance. */
export function benchmarkCredentialKeyId(key: Buffer): string {
	return createHmac("sha256", key).update(KEY_ID_LABEL).digest("hex")
}

/**
 * Keyed fingerprint of one credential setting. `field` is a fixed NUL-free
 * name and the value is the suffix, so the encoding is unambiguous.
 */
export function benchmarkCredentialFingerprint(
	key: Buffer,
	field: string,
	value: string,
): string {
	return createHmac("sha256", key)
		.update(`${FINGERPRINT_LABEL}\0${field}\0${value}`)
		.digest("hex")
}
