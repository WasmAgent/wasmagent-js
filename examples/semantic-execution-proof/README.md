# Cross-repository semantic execution proof (Workstream C)

One bounded synthetic scenario — a sales-like state-changing CRM update under
`sales-policy@1.2.0` — executed through the full governed-execution chain:

```text
work/task context → principal identity → delegated authority (approval +
consent) → policy/risk → MCPGateway commit-time decision → tool effect →
AEP evidence (signed record) → AEP verification layers
```

Run:

```sh
bun examples/semantic-execution-proof/run-proof.ts
```

writes `results.json` and prints the five axes for every case. Exits non-zero
if the proof's own structural expectations are violated.

## The seven cases and what each demonstrates

| case | change between plan and commit | firewall | effect | evidence |
| --- | --- | --- | --- | --- |
| 01-allowed | nothing — exact args, live approval, policy 1.2.0 | allow | executed | signed record, exact binding |
| 02-stale-approval | approval TTL expires | ask_user (held) | not executed | held decision evidenced |
| 03-policy-changed | policy 1.2.0 → 1.3.0 adds a desk amount cap | deny | not executed | denial evidenced |
| 04-descriptor-rug-pull | tool descriptor description mutated | ask_user (held) | not executed | hold evidenced |
| 05-target-argument-substitution | committed args swap opp-1234 → opp-9999 | ask_user (held) | not executed | hold evidenced |
| 06-result-taint-to-prohibited-sink | allowed read returns a secret; next call pushes it outward | deny (structural value boundary) | not executed | denial evidenced |
| 07-evidence-emission-fails | the AEP signer faults | allow | executed but **unattested** — run FAILS: no further action proceeds | emission failed (loud) |

## What the reader should see

A reader can trace **why each specific business execution was or was not
allowed** — approval state, descriptor snapshot, arg scope, policy version,
taint/value boundary — not merely whether a tool name appeared on a list.

## Honest boundaries (recorded, not rounded)

- **No aggregate "secure" verdict** is produced; every axis
  (`authority_result | firewall_result | effect_result | aep_record_result |
  aep_verification_result`) is reported per case.
- **Case 07**: this architecture has no transactional rollback. A policy
  requiring evidence makes emission failure fail the RUN (loud, no further
  action), but the already-executed effect cannot be un-executed. Recorded as
  `unattested: true`.
- **AEP layers**: authenticity/binding + chain are verified HERE via
  `@wasmagent/aep`'s own verifier; structural/semantic layers for this record
  family are executed by the `WasmAgent/wasmagent-protocol` conformance corpus
  (cross-repo scope). `chain_status: not-present` on the FIRST record is chain
  semantics (no upstream link to check), not a failure; records 2–6 report
  `intact`.
- Records are a **run-level evidence ledger**: record N snapshots actions
  1..N (the emitter chains its own successive records).
- Synthetic scenario — demonstrates the governed-execution chain; not a
  certification.
