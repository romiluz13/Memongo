#!/usr/bin/env bash
# Asserts that the environment needed to arm every gated e2e suite is present
# before the nightly runs anything. Without this check, a missing key lets
# describe.skipIf() turn every gated suite into a silent skip and the run
# reports green while testing nothing. Each message names the suites the
# missing variable would disable, so the failure is actionable.
set -euo pipefail

fail() {
	echo "::error::$1"
	exit 1
}

if [[ -z "${VOYAGE_API_KEY:-}" ]]; then
	fail "VOYAGE_API_KEY is empty: e2e-evaluation (real embeddings), real-e2e-v2, embedding-coverage, and production-readiness would all silently skip"
fi

if [[ "${VOYAGE_API_KEY}" != al-* ]]; then
	fail "VOYAGE_API_KEY is not an Atlas Model key (expected 'al-' prefix): hasAtlasModelKey() gates real-e2e-v2, embedding-coverage, and production-readiness on the al- prefix, so those suites would silently skip"
fi

if [[ -z "${MEMONGO_ENRICHMENT_API_KEY:-}" ]]; then
	fail "MEMONGO_ENRICHMENT_API_KEY is empty: temporal-extraction, relation-extraction, contradiction, consolidation-reasoning, temporal-promotion, and the scripts e2e QA would all silently skip"
fi

if [[ -z "${MEMONGO_ENRICHMENT_BASE_URL:-}" ]]; then
	fail "MEMONGO_ENRICHMENT_BASE_URL is empty: resolveEnrichmentProvider() refuses to build a provider without it, so every enrichment-gated suite would silently skip"
fi

if [[ -z "${MEMONGO_ENRICHMENT_MODEL:-}" ]]; then
	fail "MEMONGO_ENRICHMENT_MODEL is empty: resolveEnrichmentProvider() refuses to build a provider without it, so every enrichment-gated suite would silently skip"
fi

echo "e2e gates armed: Atlas Model key (al-*) and enrichment provider (key, base URL, model) all present."
