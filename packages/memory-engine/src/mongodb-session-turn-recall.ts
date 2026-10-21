/**
 * C-1 stage 2: session-scoped turn recall. Opt-in through
 * `MEMONGO_SESSION_TURN_RECALL=enabled`; unset, nothing here runs and the
 * session cap keeps its original order.
 */

export const SESSION_TURN_RECALL_ENV = "MEMONGO_SESSION_TURN_RECALL"

/** R: stage-1 results scanned for seed sessions. */
export const SESSION_TURN_RECALL_SEED_RESULTS = 20
/** S: seed sessions recalled into. */
export const SESSION_TURN_RECALL_SEED_SESSIONS = 8
/** T: turns kept per seed session. */
export const SESSION_TURN_RECALL_TURNS_PER_SESSION = 3

export function isSessionTurnRecallEnabled(): boolean {
	return process.env[SESSION_TURN_RECALL_ENV] === "enabled"
}
