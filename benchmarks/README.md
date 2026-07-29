# Benchmarks

The purpose of this directory is that **someone who distrusts our numbers can
reproduce them**. That is the design constraint everything here follows from.

It is worth being explicit about why, because the field's track record is poor:

- One competitor's `BENCHMARKS.md` cites harness files (`memory/runner.py`,
  `crosstool/run.py`) that exist in no git ref of their repository, and their
  `.gitignore` carries the line `# Local benchmark scripts — never commit`.
- mem0's harness is public but downloads its dataset with no checksum and no
  pinned revision, and their own tracker carries an unresolved report that the
  published scores could not be reproduced from it.
- Zep published 84% on LoCoMo, conceded a numerator/denominator error after
  mem0 audited it, and revised to 75.14% ± 0.17. mem0's independent rerun of
  the same system reported 58.44% ± 0.20. Both parties still disagree.

So a headline number is close to worthless on its own. What is worth something
is a number bound to bytes anyone can obtain, produced by the pipeline that
actually ships.

## Getting the dataset

```bash
bun run benchmark:fetch            # LongMemEval_S, ~265 MB
```

The file is downloaded to `benchmarks/data/` (gitignored — too large to vendor)
and its SHA-256 is verified against the digest pinned in
`packages/memory-engine/src/benchmark-quality-contracts.ts`. A mismatch deletes
the download and exits non-zero rather than installing it, because a benchmark
measured on different bytes is not comparable to a published number.

The download lands under a `.partial` name and is only promoted after the digest
matches, so an interrupted transfer can never be mistaken later for the verified
artifact.

| | |
| --- | --- |
| Dataset | LongMemEval_S (`longmemeval_s_cleaned.json`) |
| Source | https://github.com/xiaowu0162/LongMemEval — ICLR 2025 |
| Data | https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned |
| License | MIT |
| Pinned SHA-256 | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |

That digest is the official HuggingFace artifact byte-for-byte. It is not a
hash of some local file only we possess — verify it yourself against the
HuggingFace API before trusting anything else in this directory.

### Why LongMemEval first, and not LoCoMo

LongMemEval is MIT-licensed, peer-reviewed (ICLR 2025), and downloadable in CI
without authentication.

LoCoMo is **CC BY-NC 4.0** — Attribution-**NonCommercial**. GitHub reports the
repository as `NOASSERTION`, so the restriction does not show up in a casual
check. `bun run benchmark:fetch locomo` deliberately refuses and explains why:
whether to benchmark a commercial product against a NonCommercial dataset is a
licensing decision for the project owner, not one a build script should make
silently.

## What a published number must include

A number is only reportable if all of the following hold. These are gates, not
aspirations.

1. **Shipped profile.** The run must execute the pipeline that ships. The
   `diagnostic` profile writes session/userfact/preference evidence documents
   and runs an LLM enrichment pass that production never performs — and the
   shipped scorer then boosts exactly those documents. `shipped` is the default;
   `diagnostic` requires an explicit opt-in and its numbers are not publishable.
2. **Registered quality contract.** Thresholds live in
   `benchmark-quality-contracts.ts` and are bound to the dataset digest. The run
   fails if the contract and the bytes disagree.
3. **Repeated runs.** Report mean ± standard deviation across runs, never a
   single execution. Zep's 84% was one run; the disagreement that followed was
   partly a variance argument.
4. **Pinned judge.** Where answers are LLM-judged, the judge model *and* the
   exact prompt text must be committed and cited. A modified judge prompt was
   one of the specific objections raised against Zep's numbers.
5. **Recorded configuration.** Retrieval lane, top-k, and the physical index
   definition actually used. Note that autoEmbed indexes resolve to
   `quantization: "scalar"` on Atlas, not float32 — reporting float32 would
   misdescribe our own index.
6. **Competitors re-run by us.** Do not quote a competitor's published figure.
   Both leading numbers in this space have been shown to be methodology
   dependent. Same dataset, same judge, same prompt, same top-k, same hardware,
   or it is not a comparison.

## The gate cuts both ways

If the number does not win, publish it anyway and say so. A framework that
reports its real position is worth more than one caught inflating — and given
the record above, being the reproducible one is the more defensible position
regardless of rank.
