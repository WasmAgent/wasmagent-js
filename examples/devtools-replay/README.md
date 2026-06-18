# DevTools replay example

End-to-end demo of A2's fork-from-step engine. No model calls — runs
entirely offline with a synthetic event trace, so it doubles as a smoke
test for the replay engine.

## Run

```bash
bun install        # from the repo root, if not already
node examples/devtools-replay/index.mjs
```

Expected output (excerpt):

```
Recorded 8 events under traceId=demo-trace-1
stepCount=3 eventCount=8
select(0): [ 'run_start' ]
select(2): [ 'run_start', 'step_start', 'tool_call_start', 'tool_call_end', 'step_start', 'model_done' ]
finalAnswer: shipped feature X via patch_file

Fork bundle:
  forkedAtStep:    2
  forkedAtEventId: 000006
  prefixEvents:    6
  meta: {
    task: 'Re-do step 3 — but use claude-haiku and aim for a one-line summary',
    modelId: 'claude-haiku-4-5',
    note: 'investigating verbose output',
    forkedFromTraceId: 'demo-trace-1'
  }
```

## What it shows

- `EventLog.tap(...)` records the synthetic agent stream into a
  `MapKvBackend`. Every yielded event gets a monotonic `eventId`.
- `EventLogReplay` consumes those `LoggedEvent`s and exposes a
  step-by-step navigable cursor.
- `select(N)` returns the prefix up to (and including) step N. The
  `finalAnswer` field is filled when a `final_answer` event lives in the
  prefix.
- `forkAt(N, opts)` produces a bundle containing the prefix events plus
  metadata (task / model / note overrides) ready for the host page to
  feed into a fresh agent run.

## Where to plug in the React UI

The pure logic above is enough for CLIs, server-side fork tools, and
batch debugging. To see the timeline in a browser, import the React
component:

```tsx
import { DevTools } from "@wasmagent/devtools/react";
<DevTools events={collected} traceId="demo-trace-1" onFork={handleFork} />
```

See [docs/guides/devtools.md](../../docs/guides/devtools.md) for full
notes on wiring the React component into a host application.
