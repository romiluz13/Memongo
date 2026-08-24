# Lore

A history of Memongo as told by its own commit log — 219 commits, one author (Rom Iluz), 2026-05-06 to 2026-08-24. See [Background](background/index.md) for the ADR and benchmark story behind some of these events, and [By the numbers](by-the-numbers.md) for the activity data these eras are built from.

## Era 1: initial release and checkpoint scaffolding (2026-05-06 to 2026-05-12)

The repository opens with `65d193d chore: initial Memongo release` on 2026-05-06. The very next commits, all on 2026-05-12, are dozens of `scope-1:`, `scope-2:`, `scope-3:`, `scope-4:` prefixed commits carrying explicit task numbers (`Task 0.1`, `Task 0.5`, `Task 1.-1` through `Task 1.9`) and "remfix" (remediation-fix) follow-ups against a "Phase 1 Gate 1" checkpoint. This pattern — parallel scoped workstreams merged back with `Merge pull request` / `Merge branch` commits — appears nowhere else in the history at this density, and reads like a structured, agent-driven build-out against a written plan rather than organic day-to-day development.

## Era 2: benchmark hardening and evidence discipline (2026-05-12 to 2026-06-24)

From mid-May onward the commit messages shift toward benchmark integrity: `ab8be35 mongodb: add managed atlas runtime checks`, `ef227e5 benchmarks: enforce strict artifact gates`, `bf4c9b4 benchmarks: lock full runs behind canary size`, `86a6aa6 docs: add mongodb flaws ledger`, culminating in `5036ec0 license: switch Memongo to BSL 1.1` and `47b9869 docs: replace unproven benchmark claims` on 2026-05-27. Mem0-comparison evidence work continues into June (`82bf4c5 benchmark: add mem0 evidence proof pack`, `630ad27 benchmarks: disclose mem0 evidence pack`, both 2026-06-13/14). The project appears to have spent this era making sure its benchmark claims could survive scrutiny before going public.

## Era 3: public OSS launch (2026-06-24 to 2026-06-25)

A tight two-day burst: `ef1d9e9 launch: prepare open source release`, `6d6ac17 web: add animated launch landing page`, `0fdd7b0 web: add Cloudflare deployment config` (2026-06-24), then on 2026-06-25 a sequence of `release:` commits (`093477d release: publish packages with npm`, `7a681cf release: make npm publish idempotent`, `a99d325 release: tolerate published npm versions`) and `a162a3d launch: clean public release surface` / `dcf9180 chore: final OSS polish — logger, NOTICE, README, drop internal tags`. `CHANGELOG.md` records this as **1.1.0 (2026-06-24)**: "Prepared the public Apache-2.0 open-source release."

## Era 4: security and tenant-isolation hardening (2026-07-19 to 2026-07-31)

The largest sustained push in the history. Commit messages carry consistent `fix(security):` / `feat(security):` tags: `0b13acc feat(security): enforce scope/scopeRef as a hard tenant-isolation boundary`, `6754ed6 feat(security): baseline network hardening — SSRF guard, body cap, rate limit (#28)`, `356e8da feat(security): retrieval-path prompt-injection defense (#29)`, alongside engine-correctness work tagged with numbered issues (`#30`–`#71`) covering bi-temporal recall, contradiction-driven invalidation, LLM fact extraction, and change-stream robustness. This era closes with `bdad0fb release: bump all public packages to 2.0.0` on 2026-07-31. `CHANGELOG.md`'s **2.0.0** entry matches the commit messages closely: "Major release: security hardening, tenant isolation, and engine robustness," including the explicitly breaking tenant-write identity fix.

## Era 5: builder-queue, pi-extension, and wiki (2026-08-01 to 2026-08-24)

August opens with `737b9fe pi-extension: add @memongo/pi-extension — Pi coding-agent memory bridge` (2026-08-01) and a short pi-extension polish run, then a `builder-queue` batch (`fad3a3f feat: builder-queue contract and surface parity`, `a5b0473 fix: builder-queue correctness batch`, `ab68243 chore: builder-queue architecture and deploy`, 2026-08-03 to 2026-08-04) — another plan-driven, lettered-batch (`B1`–`B15`) workstream in the same style as Era 1's scoped tasks. The month tapers into scattered `feat(memory):`/`fix(memory):` hardening commits through mid-August, then closes with the CI/wiki infrastructure that produced this page: `5cfadda ci: add Droid Wiki refresh action` (2026-08-23) through `500ac6d ci: use Grove custom model for wiki refresh` (2026-08-24, the latest commit in the repo at time of writing).

## Longest-standing features

`packages/memory-engine/src/mongodb-manager.ts` and the core search/write path trace back to the initial commit (`65d193d`, 2026-05-06) and have been the single most-touched file in the entire history since — 40 commits in the last 90 days alone (see [By the numbers](by-the-numbers.md)). The manager has effectively been under continuous revision for the whole 4-month life of the project rather than being written once and left alone.

## Deprecated and scoped-out surfaces

`CONTRIBUTING.md` states plainly: "Historical, experimental, or comparison material should not be expanded into first-class product scope unless there is a clear ownership decision first." `docs/platform/PLATFORM-README.md` names the concrete surfaces this applies to: `apps/browser-extension`, `apps/memory-graph-playground`, and `packages/memory-graph` are called out as "not part of the supported product core" — optional or historical surfaces that exist in the codebase's history or periphery but were deliberately kept out of the maintained product.

## Major rewrites

No commit message at the scale of "rewrite" or "migration" turns up in `git log --oneline | grep -iE "rewrite|migrat|refactor"` across the 219 commits. The history instead shows continuous, incrementally numbered hardening batches (the `#30`–`#71` issue-tagged fixes of Era 4, the `B1`–`B15` builder-queue batches of Era 5) rather than any single big-bang rewrite of a subsystem.

## Growth trajectory

A 4-month, single-branch, single-contributor history doesn't show much workspace-member growth to trace: the package/app layout visible today was largely present from the early scope-checkpoint commits, with `@memongo/pi-extension` (2026-08-01) the one clearly new package added after initial release. This section stays short because there isn't more honest signal to report at this project's age.
