# durable-runtime — checkpoint + SSE resume + HITL e2e

Demonstrates the agentkit-js durable runtime primitives without any model
calls. Three "processes" share one in-memory `KvBackend` to prove the
contract: kill a worker, spawn a new one, the run continues.

## Run

```bash
# From the repo root after `pnpm install`:
node examples/durable-runtime/index.mjs
```

Output (snipped):

```
── Process 1: run, then suspend on await_human_input ──
  id=000000000000 event=step_start
  id=000000000001 event=step_start
  id=000000000002 event=step_start
  id=000000000003 event=await_human_input
  → suspended; lastSeen = 000000000003

── Process 2: operator submits human response ──
  resumeFromHuman → true

── Process 3: fresh worker resumes the run ──
  Replay: …
  Live tail:
    id=000000000004 event=step_start
    id=000000000005 event=final_answer

✅ Run completed end-to-end across three simulated processes.
```

The full guide lives in [docs/guides/durable-runtime.md](../../docs/guides/durable-runtime.md).
