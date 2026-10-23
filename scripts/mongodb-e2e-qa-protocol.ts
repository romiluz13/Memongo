/**
 * The QA protocols this harness runs. custom-v2 is custom-v1 with the
 * question date and each passage's date(s) and role in the answer request,
 * passages kept in rank order. custom-v3 admits round units under the
 * reader token budget and renders them as official dated sessions.
 * custom-v4 sends custom-v3's reader content under the v4 reader contract.
 */
export type E2eQaProtocol =
	| "custom-v1"
	| "custom-v2"
	| "custom-v3"
	| "custom-v4"

const CUSTOM_HARNESS_PROTOCOLS: ReadonlySet<string> = new Set<E2eQaProtocol>([
	"custom-v1",
	"custom-v2",
	"custom-v3",
	"custom-v4",
])

/** Protocols this harness answers and judges (not official or custom-judge). */
export function isCustomHarnessProtocol(
	protocol: string | undefined,
): protocol is E2eQaProtocol {
	return protocol !== undefined && CUSTOM_HARNESS_PROTOCOLS.has(protocol)
}

/** Protocols that admit reader units under the reader token budget. */
export function isReaderBudgetProtocol(
	protocol: string | undefined,
): protocol is "custom-v3" | "custom-v4" {
	return protocol === "custom-v3" || protocol === "custom-v4"
}
