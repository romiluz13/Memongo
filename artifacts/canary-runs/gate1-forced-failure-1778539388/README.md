# gate1-forced-failure-1778539388 — superseded

Original Task 1.9 forced-failure gate proof run at `2026-05-11T22:43:36Z`. Kept
for history only. The `failureClass: "model-failure"` classification in
`failure.json` was a false-positive under the original taxonomy: the run's
actual failure was a bootstrap/config HTTP 500 ("MongoDB URI required"), not a
Voyage/model error.

Phase 1 silent-failure hunter flagged this as CRITICAL C2 (narrow rule
failure + missing forcing-mechanism record). Remfix landed in commit
`b3e9764348` (taxonomy narrowed so bare 5xx no longer matches
`model-failure` without a voyage/rerank/embedding/LLM/network token).

**Replacement artifact:**
`artifacts/canary-runs/gate1-forced-failure-v2-<timestamp>/` — includes
`forcing-config.json` recording the exact env used and, via the updated
taxonomy, produces a legitimate `model-failure` classification whose message
contains both `voyage` and `ECONNREFUSED`.
