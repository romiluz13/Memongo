# Project memory and safe resume

Recorded 2026-10-02. This is current handoff state; original plans and task Returns remain historical evidence.

## Decisions and authority

- Primary target: production agent memory plus broad benchmark coverage across conversations, coding-agent workloads and scale. Each evidence track is separate.
- Preserve MongoDB-native storage and evolve public APIs compatibly.
- Earlier “no fixed deadline/budget” is superseded by the owner's manager-directed stop. New development, model calls, benchmark runs, comparisons and rejudges require fresh owner/manager authorization.
- Existing B2 may finish. Preserve terminal evidence; no new repetition. Campaign analysis after terminal requires fresh authorization.
- Legacy history ambiguity is resolved: exclude snapshots that cannot be bound to the current document from its history, while preserving them in storage. E257 is deferred, not implemented.
- U04 (agent versus session grants) and U05 (retention, granular erasure, expiry and backups) remain held. Rationale/self-edit policy and unsupported-topology choices need explicit intent.
- Final closeout documentation, context preservation, project memory and npm distribution follow-up are authorized. npm requires actual access; credentials stay outside chat, logs and reviewer bundles.

## Identity of delivered work

The engineering release/tag `v2.2.0` is commit `d2579054a4488e2c4d301c0bcd7c58d20baef36c`. The release was squashed atop `925e8135` so the raw local audit history was not pushed. The original accepted snapshot has 305 paths from 140 bounded repair changes; four audit inventory paths were excluded from published code.

Campaign and release checkouts are separate. The live campaign uses pinned earlier revisions, not released code. Its local source pin must remain unchanged until B2 finishes. Exact campaign revisions and local preservation instructions are retained in the private archive's `campaign/HANDOFF.md`. Refresh them before acting; do not use B2 as release validation.

Public deliverables are the GitHub release's eight downloadable packages, GHCR image `2.2.0`, and the existing Cloudflare web worker. No hosted API deployment target is configured. All eight npm `2.2.0` packages are published with provenance after access restoration. Exact downloaded tarballs match the verified release; fresh-cache install/import/Pi source/MCP initialize passed. Publish workflow attempt 2 failed only at its immediate registry-install smoke after ten version-not-found retries; that failure remains recorded. The original HTTP 404 cause was not established. A Sigstore record alone is not registry publication.

## Before any resume

1. Read this handoff, the task ledger, the target task and applicable repo rules. Obtain new manager/owner authority and bounded spending for dependent work.
2. Verify live Git, process and campaign facts. These documents are timestamped snapshots. Preserve user changes, campaign credentials and data. Use a separate isolated checkout; keep the pinned measurement surface intact while live.
3. Use one writer per file and the official source registers. Compare installed versions with documentation before relying on APIs. Skill guidance is advisory; code and version-matched official contracts decide technical behavior.
4. Select one task and bind each relevant acceptance criterion to exact revision evidence. Preserve refuted and deferred findings. Do not infer closure of 381 audit routes from 140 accepted changes.
5. Stop repeated attempts that produce no new evidence; record the failure and unblock condition. A valid negative experiment is a result. Avoid recursive audits and unbounded research.

## Context locations and limits

The public source contains product code and curated documents. The private handoff context contains original task briefs, consensus routing, execution Returns, snapshot manifests, source-document copies and audit inputs. Its paths are mapped in [EVIDENCE.json](EVIDENCE.json). The clean source comes from committed Git, not an overlay of old snapshots.

Private campaign evidence remains on the owner's machine under `tmp/team/run`. Release evidence remains under `tmp/team/execution/evidence/release-20261002`. These are local-only references. Credentials, mutable checkpoint payloads and raw benchmark personal text are excluded from the reviewer bundle. Some historical links require local evidence access and are explicitly not certified portable.

Formal parent closure is 0/58 at the conservative evidence bar; that is not an implementation count. Competitive gains, full production readiness, exhaustive security, cost reconciliation and a hosted API SLA are unproven. Original task estimates are provisional historical planning values, not an approved schedule.

## Additional technical holds

F049's proposed read-only gate optimization is excluded because the serial write participates in erasure correctness. Any replacement needs measured equivalent proof. F263/F264 depend on campaign evidence; F306 needs an isolated supported-server reproduction. O03's OpenTelemetry GenAI schema was Development at research time; content export and total cost accounting require privacy/schema validation. Atlas Automated Embedding is Preview; production-supported embedding and matching capability/version probes remain open.

The 25 original residual finding decisions span X02 (15), X04 (4), X06 (1), X07 (3), X08 (1) and X12 (1). Their full statements and routing are preserved in the original plan's `tasks/RESIDUAL-DECISIONS.md` in the private archive. They are historical proposals/holds, not 25 newly reproduced release defects.
