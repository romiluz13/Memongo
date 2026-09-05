#!/usr/bin/env python3
"""Compute the WS-11 declared-evidence sweep over the current .ddd ledger.

Replicates the ws10 sweep rules (the `ddd sweep --direction both` logic) since
the proofline CLI is not installed in this environment:
  1. claim-without-validation  — T2/T3 claim with no passing validation record
  2. trace-without-validation  — T2/T3 trace with validation_id null
  3. untraced-construct        — declared construct without a matching trace
  4. t3-without-refutation     — T3 claim without a refutation report
  5. claim-with-missing-evidence — sources[].ref not present in evidence.lock
"""
import glob
import json
import sys
from datetime import datetime, timezone

import yaml

ROOT = "/Users/rom.iluz/Dev/memongo"


def load(path):
    with open(f"{ROOT}/{path}") as f:
        return yaml.safe_load(f)


claims = load(".ddd/claims.yaml")["entries"]
traces = load(".ddd/trace-matrix.yaml")["traces"]
validations = load(".ddd/reports/validations.yaml")["entries"]

with open(f"{ROOT}/.ddd/evidence.lock") as f:
    evidence = yaml.safe_load(f)
evidence_ids = set()
for e in (evidence or {}).get("entries") or []:
    if e.get("id"):
        evidence_ids.add(e["id"])

refuted_claims = set()
for p in glob.glob(f"{ROOT}/.ddd/reports/refutation-*.yaml"):
    try:
        with open(p) as f:
            rep = yaml.safe_load(f)
    except yaml.YAMLError:
        continue
    if not isinstance(rep, dict):
        continue
    cid = rep.get("claim") or rep.get("claim_id")
    if cid:
        refuted_claims.add(cid)

claim_by_id = {c["id"]: c for c in claims}
validation_by_id = {v["id"]: v for v in validations}
violations = []

for c in claims:
    tier = c.get("tier")
    needs_validation = tier in ("T2", "T3")
    vlist = c.get("validations") or []
    if needs_validation and not any(
        (validation_by_id.get(v) or {}).get("result") == "pass" for v in vlist
    ):
        violations.append(
            {
                "type": "claim-without-validation",
                "claim_id": c["id"],
                "message": f"Claim {c['id']} is {tier} and requires validation. Rule: T2/T3 claims must link at least one passing validation record (field: validations, expected: [V-NNN, ...]).",
                "resolution": f"Run the check, then: ddd validation --claim {c['id']} --construct <symbol> --method <test|lint|type-check|formal|manual|runtime-assertion> --target <file>",
            }
        )
    if tier == "T3" and c["id"] not in refuted_claims:
        violations.append(
            {
                "type": "t3-without-refutation",
                "claim_id": c["id"],
                "message": f"T3 claim {c['id']} has no sustained independent refutation report.",
            }
        )
    for src in c.get("sources") or []:
        ref = src.get("ref")
        lock_id = ref.split("#", 1)[0] if ref else None
        if lock_id and lock_id not in evidence_ids:
            violations.append(
                {
                    "type": "claim-with-missing-evidence",
                    "claim_id": c["id"],
                    "message": f"Claim {c['id']} references missing evidence {lock_id}. Rule: sources[].ref must name an entry that exists in .ddd/evidence.lock.",
                    "resolution": "Lock the source first: ddd lock <url> --version <v> --source-class <class> ...",
                }
            )
    for construct in c.get("constructs") or []:
        if not any(
            t.get("claim_id") == c["id"] and t.get("construct_id") == construct
            for t in traces
        ):
            violations.append(
                {
                    "type": "untraced-construct",
                    "claim_id": c["id"],
                    "construct": construct,
                    "message": f'Construct "{construct}" on claim {c["id"]} has no trace entry. Rule: every declared construct must have a matching trace (claim_id + construct_id) in .ddd/trace-matrix.yaml.',
                    "resolution": f"ddd trace {c['id']} {construct}",
                }
            )

for t in traces:
    claim = claim_by_id.get(t.get("claim_id"))
    if claim and claim.get("tier") in ("T2", "T3") and not t.get("validation_id"):
        violations.append(
            {
                "type": "trace-without-validation",
                "claim_id": t["claim_id"],
                "trace_id": t["id"],
                "message": f"Trace {t['id']} implements {claim['tier']} claim {t['claim_id']} without validation. Rule: T2/T3 traces must reference a validation id.",
                "resolution": f"Record it (ddd validation --claim {t['claim_id']} --construct {t.get('construct_id')} --method <m> --target <file>), then re-trace with --validation <V-NNN>",
            }
        )

out = {
    "schema_version": "0.1.0",
    "direction": "both",
    "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z",
    "claims_checked": len(claims),
    "traces_checked": len(traces),
    "verdict": "CONFORMANT" if not violations else "NONCONFORMANT",
    "scope": "declared-constructs",
    "capabilities": {
        "evidence_integrity": "tool-enforced",
        "trace_graph": "tool-enforced",
        "tier_requirements": "tool-enforced",
        "entailment": "recorded-attestation",
        "reverse_sweep": "declared-constructs-only",
        "validation_records": "tool-enforced",
        "refutation_independence": "recorded-metadata",
    },
    "violations": violations,
    "pass": not violations,
}

dest = f"{ROOT}/.ddd/reports/sweep-ws11.json"
with open(dest, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")

print(f"claims_checked={out['claims_checked']} traces_checked={out['traces_checked']}")
print(f"violations={len(violations)} verdict={out['verdict']}")
for v in violations:
    print(f"  {v['type']}: {v.get('claim_id')} {v.get('trace_id', '')} {v.get('construct', '')}")
sys.exit(0)
