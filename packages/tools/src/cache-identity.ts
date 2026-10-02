/** WebCrypto keeps capture idempotency hashing usable in browser and Node runtimes. */
export async function sha256Hex(text: string): Promise<string | undefined> {
	const subtle = globalThis.crypto?.subtle
	if (!subtle) {
		return undefined
	}
	const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text))
	let hex = ""
	for (const byte of new Uint8Array(digest)) {
		hex += byte.toString(16).padStart(2, "0")
	}
	return hex
}

/** Retained for callers of the published export; context is no longer cached. */
export function _clearCache(): void {}
