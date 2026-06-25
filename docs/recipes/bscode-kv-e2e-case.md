# End-to-End Case: Governed Code Edit with Verifiable Rollout

> **Format**: task → runtime policy → execution evidence → rollout export → evomerge output → evaluation conclusion.
>
> This case demonstrates the full WasmAgent training loop on a realistic bscode coding task.

---

## Task

**User query** (from `bscode-worker-kv-001`):

> The worker's KV read path throws a TypeError when buildResultsKv is undefined.
> Fix it so the /build-result endpoint returns a 503 with `{"error":"kv_unavailable"}` instead of crashing.

**Repo snapshot**: `WasmAgent/bscode@HEAD`  
**Agent**: `ToolCallingAgent` with `@wasmagent/aisdk` + `QuickJSKernel`

---

## Runtime Policy (CapabilityManifest)

```ts
import { compileToPolicy } from "@wasmagent/capability-compiler";

const manifest = {
  allowedHosts: [],                    // no outbound network
  allowedReadPaths: ["/workspace"],    // read bscode source only
  allowedWritePaths: ["/workspace"],   // write within workspace only
  extraCapabilities: [],
  cpuMs: 5000,
  memoryLimitBytes: 64 * 1024 * 1024,
};

const policy = compileToPolicy(manifest);
```

The compiled policy enforces:
- **network:deny-all** — agent cannot call external APIs
- **fs:read-allowlist** — reads only under `/workspace`
- **fs:write-allowlist** — writes only under `/workspace`

Any attempt to write to `/etc/` or call `fetch("https://...")` is blocked with `decision: "deny"` before the tool call executes.

---

## Execution Evidence

The agent completed the task in 4 tool calls. Build verifier result:

```json
{
  "build_result": {
    "status": "pass",
    "exit_code": 0,
    "stderr": ""
  },
  "objective_score": 1,
  "objective_status": "pass"
}
```

Policy log (all calls allowed):

| Step | Tool | Policy decision |
|---|---|---|
| 0 | `read_file` (apps/worker/src/build-results.ts) | allow |
| 1 | `write_file` (apps/worker/src/build-results.ts) | allow |
| 2 | `run_tests` (bun test apps/worker/src/) | allow |
| 3 | `read_file` (apps/worker/src/routes/buildResult.ts) | allow |

---

## Rollout Export (`rollout-wire/v1`)

```bash
# Export from bscode (Training Data Mode)
curl https://bscode-worker.example.com/rollouts/export \
  -H "X-Session-Id: sess-abc123" \
  -o rollout.jsonl
```

Sample record structure:

```json
{
  "schema_version": "rollout-wire/v1",
  "rollout_id": "bscode-worker-kv-001-run-1",
  "task": "Fix KV read path to return 503 instead of crashing",
  "branch_index": 0,
  "temperature": 0.7,
  "session_id": "sess-abc123",
  "tool_call_sequence": [
    {"tool_name": "read_file", "arguments": {"path": "/workspace/apps/worker/src/build-results.ts"}, "result": "..."},
    {"tool_name": "write_file", "arguments": {"path": "/workspace/apps/worker/src/build-results.ts", "content": "..."}, "result": "ok"},
    {"tool_name": "run_tests",  "arguments": {"command": "bun test apps/worker/src/"}, "result": "exit:0\n2 pass"},
    {"tool_name": "read_file",  "arguments": {"path": "/workspace/apps/worker/src/routes/buildResult.ts"}, "result": "..."}
  ],
  "final_answer": "Fixed: added null check for buildResultsKv, returns 503 with error JSON when KV is unavailable.",
  "build_result": {"status": "pass", "exit_code": 0},
  "objective_score": 1,
  "objective_status": "pass",
  "total_score": 1.0
}
```

---

## evomerge Output

```bash
# Convert to SFT training record
python -m evomerge export \
  --rollout rollout.jsonl \
  --out-dir data/training/kv-001/

# ADP episode (for router/critic training)
python -m evomerge adp-export \
  --rollout rollout.jsonl \
  --out data/adp/kv-001-adp.jsonl

# RL transitions with reward decomposition
python -m evomerge rl-export \
  --rollout rollout.jsonl \
  --reward build,policy,cost \
  --out data/rl/kv-001-transitions.jsonl

# Long-context QA (for small-model reading comprehension)
python -m evomerge compile-context \
  --rollout rollout.jsonl \
  --mode long_context_qa \
  --out data/context/kv-001-qa.jsonl

# Capability attribution (if paired with a failing branch)
python -c "
from evomerge.capability.attribution import mine_capability_gaps
from evomerge.io import load_rollouts
gaps = mine_capability_gaps(load_rollouts('rollout.jsonl'))
print(f'{gaps.n_compared_pairs} pairs, {gaps.suggested_dpo_pairs} DPO suggestions')
"
```

Training outputs produced:

| File | Records | Use |
|---|---|---|
| `data/training/kv-001/sft.jsonl` | 1 | SFT: task → fix conversation |
| `data/adp/kv-001-adp.jsonl` | 9 | 4 tool steps × 2 + 1 terminal |
| `data/rl/kv-001-transitions.jsonl` | 5 | RL: (state, action, reward, done) |
| `data/context/kv-001-qa.jsonl` | 1 | Long-context QA record |

RL terminal reward:

```json
{
  "reward": {
    "build": 1.0,
    "policy": 1.0,
    "cost_penalty": -0.03
  }
}
```

---

## Evidence Admission Gate

```ts
import { admitRows, gateReport } from "@wasmagent/evals-runner";

const contract = {
  workloadId: "bscode-worker-kv-001",
  driverName: "claude-sonnet-4-6",
  runtimeSetting: "sandbox",
  schemaVersion: "evidence-admission/v1",
  replayPolicy: "deterministic",
  admissionRules: [
    {
      ruleId: "build-must-pass",
      description: "Build exit code must be 0",
      evaluator: (row) => row.evidenceRef.includes("pass"),
    },
  ],
  redactionPolicy: "none",
};

const rows = [{ rowId: "kv-001-run-1", type: "admitted", evidenceRef: "sha256:build=pass", admittedAt: Date.now() }];
const result = admitRows(contract, rows);
console.log(gateReport(result));
```

Output: `admitted: 1 / 1 (100.0%)` — row is claim-eligible.

---

## Evaluation Conclusion

| Metric | Value |
|---|---|
| Task completion | ✅ Pass (build_result.status = pass) |
| Policy compliance | ✅ All 4 tool calls within manifest |
| Capability tags | `file_localization`, `build_repair`, `argument_generation`, `state_tracking` |
| RL reward | build=1.0, policy=1.0, cost=−0.03 → total=1.97 |
| Evidence admission | Admitted (claim-eligible) |
| Training records produced | SFT×1, ADP×9, RL×5, context-QA×1 |

---

## Reproducing this case

```bash
# 1. Run the task
bun run examples/recipes/bscode-bench/run.ts \
  --task-id bscode-worker-kv-001

# 2. Export rollout
# (see bscode docs/DATA-GOVERNANCE.md for consent requirements)

# 3. Run the full evomerge pipeline
python -m evomerge export --rollout rollout.jsonl --out-dir data/

# 4. Check admission
npx wasmagent-evals evidence-gate --manifest data/manifest.json

# 5. Verify dataset card
python scripts/generate-dataset-card.py \
  --manifest data/manifest.json \
  --name bscode-kv-case-v1 \
  --date 2026-06-25
```
