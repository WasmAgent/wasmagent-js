# DevTools — event timeline & time-travel debugging

> **A2** — UI for inspecting an agent's execution trace and forking a fresh
> run from any step. Built on agentkit-js' existing primitives:
> [`EventLog`](../../packages/core/src/streaming/EventLog.ts) +
> [`KvCheckpointer`](../../packages/core/src/checkpoint/index.ts).
> No new persistence needed — the data was already there; this is the
> consumer that turns it into something humans can use.

## What it gives you

- **Event timeline** — every `LoggedEvent` shown in submission order.
- **Step navigator** — click step N, the cursor shows everything up to that
  point. Final answers and prefix-only event lists update instantly.
- **Fork-from-step** — pick a step, optionally override the task / model
  id, and re-run from that prefix. The component surfaces the user's intent
  via the `onFork` callback; the host page is responsible for actually
  spawning a new agent run with the supplied prefix.
- **Pure-logic core** — `EventLogReplay` is plain TypeScript. Server-side
  fork CLIs and tests can use it without React.

## Two import paths

```ts
// Pure logic — no React.
import { EventLogReplay } from "@wasmagent/devtools";

// React UI — opt-in.
import { DevTools } from "@wasmagent/devtools/react";
```

The React subpath is marked as an optional peer dep, so users without
React don't pay the bundle cost.

## Quick start

```tsx
import { DevTools } from "@wasmagent/devtools/react";

function DebugPanel({ events, onFork }) {
  return (
    <DevTools
      events={events}
      traceId="run-abc-123"
      onFork={async (fork) => {
        // Spawn a fresh agent run from `fork.prefixEvents`.
        await fetch("/run", {
          method: "POST",
          body: JSON.stringify({
            task: fork.meta.task ?? originalTask,
            modelId: fork.meta.modelId,
            // Replay the prefix into the new run's MessageAssembler.
            replayEvents: fork.prefixEvents,
          }),
        });
      }}
    />
  );
}
```

## Loading the events

Two common shapes:

**1. From `EventLog.replay()`** (server-side or CF Worker):

```ts
import { EventLog } from "@wasmagent/core";

const log = new EventLog(kvBackend);
const events: LoggedEvent[] = [];
for await (const ev of log.replay(traceId)) events.push(ev);
```

**2. From an SSE response captured in the browser**: tap the same stream
that `useAgentRun` reads, and accumulate events into an array. The
`eventId` is in the SSE `id:` line.

## Engine API

```ts
const replay = new EventLogReplay(events, { traceId: "run-abc-123" });

replay.eventCount;          // total events
replay.stepCount;           // distinct step_start events
replay.steps;               // ReadonlyArray<ReplayStep>
replay.select(2);           // ReplayCursor — prefix up to and incl. step 2
replay.forkAt(2, {          // produce a Fork bundle for step 2
  task: "redo step 3 with claude-haiku",
  modelId: "claude-haiku-4-5",
  note: "investigating regression",
});
replay.stepForEventId(id);  // map an event id back to its step number
```

`select(0)` returns events that happened BEFORE the first `step_start`
(eg `run_start`). `select(stepCount)` returns the entire log.

## Why a fork API at all?

The single biggest UX win from LangGraph Studio's time-travel debugger is
"go back to step N, change something, re-run". agentkit-js already had
the persistence half (EventLog records every event with a stable id;
KvCheckpointer captures assembler state per step). The missing piece was
a small, runtime-agnostic engine that could compute "the prefix up to
step N" and produce a metadata bundle to feed back into a fresh run.

Forking does NOT mutate the original log. The original trace stays
intact; the fork is whatever the host page does with the returned
`prefixEvents` and `meta`.

## Testing

`packages/devtools/src/EventLogReplay.test.ts` covers 9 scenarios incl.
zero-step traces, out-of-range cursor clamping, defensive copies, and
the fork metadata shape. `packages/devtools/src/react/DevTools.test.tsx`
adds 8 jsdom-driven render tests covering initial cursor placement,
step navigation (`aria-pressed` toggling), prelude events, the Fork
panel's task/model/note overrides, empty-overrides defaulting, and
zero-step / empty-trace edge cases. Run with
`pnpm --filter @wasmagent/devtools test`.

## Reference

- `packages/devtools/src/EventLogReplay.ts` — pure replay engine
- `packages/devtools/src/react/DevTools.tsx` — React UI component
- See also: [durable-runtime.md](./durable-runtime.md) — the EventLog +
  Checkpointer story this is built on
