#!/usr/bin/env bash
# Runs the api-contract proof-pack against this checkout's built API
# (apps/api/dist, the same entry the API image runs) on loopback, backed by
# the job's MongoDB service. The run gets its own database, agent, session and
# API key. The API process gets no provider key: embeddings come from the
# MongoDB service. Only the PID recorded here is stopped.
#
# Inputs: MEMONGO_MONGODB_URI, PROOF_PACK_OUT_DIR. The scrubbed API log, the recorded
# PID, the database name (read by the failure diagnostics) and the proof-pack
# verdict JSON land in PROOF_PACK_OUT_DIR.
set -euo pipefail

: "${MEMONGO_MONGODB_URI:?MEMONGO_MONGODB_URI must point at the job MongoDB}"
: "${PROOF_PACK_OUT_DIR:?PROOF_PACK_OUT_DIR must name the evidence directory}"
# Strict readiness: the API waits up to 180 s for every search index to be
# queryable and refuses to start otherwise, instead of booting with lanes off.
ready_timeout_seconds="${PROOF_PACK_READY_TIMEOUT_SECONDS:-240}"
run_tag="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

export MEMONGO_STRICT_SEARCH_INDEX_READY=1
export MEMONGO_API_HOST=127.0.0.1
export MEMONGO_API_PORT=3847
export MEMONGO_API_URL="http://${MEMONGO_API_HOST}:${MEMONGO_API_PORT}"
export MEMONGO_MONGODB_DATABASE="memongo_proof_${run_tag//-/_}"
export MEMONGO_AGENT_ID="proof-ci-${run_tag}"
export MEMONGO_SESSION_ID="proof-ci-session-${run_tag}"
export MEMONGO_PROOF_ARTIFACT_DIR="${PROOF_PACK_OUT_DIR}/verdict"
MEMONGO_API_KEY="$(openssl rand -hex 32)"
export MEMONGO_API_KEY
echo "::add-mask::${MEMONGO_API_KEY}"

fail() {
	echo "::error::$1"
	exit 1
}

mkdir -p "${PROOF_PACK_OUT_DIR}"
echo "${MEMONGO_MONGODB_DATABASE}" >"${PROOF_PACK_OUT_DIR}/database.txt"
api_log="${PROOF_PACK_OUT_DIR}/api.log"

# A process already answering on the port would satisfy the readiness wait
# without this checkout's API ever starting.
if curl --silent --max-time 2 "${MEMONGO_API_URL}/health" >/dev/null; then
	fail "something already answers on ${MEMONGO_API_URL} before the API started"
fi

node apps/api/dist/server.js >"${api_log}" 2>&1 &
api_pid=$!
echo "${api_pid}" >"${PROOF_PACK_OUT_DIR}/api.pid"
echo "API started: pid=${api_pid} database=${MEMONGO_MONGODB_DATABASE} agent=${MEMONGO_AGENT_ID}"

stop_api() {
	if kill -0 "${api_pid}" 2>/dev/null; then
		kill -TERM "${api_pid}"
		for _ in $(seq 1 20); do
			kill -0 "${api_pid}" 2>/dev/null || break
			sleep 1
		done
		if kill -0 "${api_pid}" 2>/dev/null; then
			kill -KILL "${api_pid}"
		fi
	fi
	# The log is printed and uploaded on failure, so it is scrubbed first; an
	# unscrubbed log is removed rather than exposed.
	if ! bun scripts/ci/scrub-api-log.ts "${api_log}"; then
		rm -f "${api_log}"
		echo "::error::API log scrub failed; the raw log was removed, not printed"
		exit 1
	fi
	echo "--- API log (pid ${api_pid}, scrubbed) ---"
	cat "${api_log}"
}
trap stop_api EXIT

# /health is liveness; /ready stays 503 offline because it requires the
# vector and embedding lanes, which need a provider key.
deadline=$((SECONDS + ready_timeout_seconds))
until curl --silent --fail --max-time 5 "${MEMONGO_API_URL}/health" >/dev/null; do
	if ! kill -0 "${api_pid}" 2>/dev/null; then
		fail "API pid ${api_pid} exited before becoming ready"
	fi
	if ((SECONDS >= deadline)); then
		fail "API pid ${api_pid} not ready within ${ready_timeout_seconds}s"
	fi
	sleep 2
done

kill -0 "${api_pid}" 2>/dev/null || fail "API pid ${api_pid} not alive before the proof-pack"
echo "API pid ${api_pid} alive and serving /health before the proof-pack"

# Zero fallbacks: the engine silently degrades search to $text when the
# vector lane is missing, so a green run must come from the vector and
# hybrid lanes the boot capability table reports.
for lane in hybrid vector; do
	grep -Eq "^  ${lane}: +available$" "${api_log}" ||
		fail "API capability table does not report the ${lane} lane available; refusing a \$text-fallback run"
done
echo "API capability table reports the hybrid and vector lanes available"

proof_status=0
bun run proof-pack || proof_status=$?

kill -0 "${api_pid}" 2>/dev/null || fail "API pid ${api_pid} died during the proof-pack"
curl --silent --fail --max-time 5 "${MEMONGO_API_URL}/health" >/dev/null ||
	fail "API pid ${api_pid} stopped serving /health during the proof-pack"
echo "API pid ${api_pid} alive and serving /health after the proof-pack"

if ((proof_status != 0)); then
	fail "proof-pack verdict failed (exit ${proof_status})"
fi

# Pinned independently of scripts/proof-pack-baseline.ts, so shrinking the
# baseline cannot weaken this gate without a visible CI change.
required_checks='["health","openapi","writeEvent","add","writeStructured","writeProcedure","search","searchDetailed","hydrateActiveSlate","discoveryProjection","contextBundle","profile","status","stats","relevanceReport"]'
shopt -s nullglob
verdicts=("${MEMONGO_PROOF_ARTIFACT_DIR}"/proof-pack/*.json)
((${#verdicts[@]} == 1)) || fail "expected one proof-pack verdict file, found ${#verdicts[@]}"
missing="$(jq -r --argjson required "${required_checks}" \
	'if .ok != true then "verdict ok is not true" else
	 ($required - [.checks[] | select(.ok == true) | .name]) | join(", ") end' \
	"${verdicts[0]}")"
[[ -z "${missing}" ]] || fail "proof-pack verdict lacks passing required checks: ${missing}"
echo "proof-pack verdict: all 15 required api-contract checks passed (${verdicts[0]})"
