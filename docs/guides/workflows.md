# Workflow Engine — Durable, Resumable, Resource-Aware DAG Execution

> *"Long-term, do it the right way: a portable workflow engine that runs locally
> today and on Cloudflare Workflows tomorrow, without rewriting the workflow."*

## Why this exists

agentkit-js already has a wave-based parallel scheduler (`Scheduler`), a
checkpointer (`KvCheckpointer`), and an event log (`EventLog`). What was
missing — until now — is a single primitive that combines them into a
**durable, observable, terminable, resumable** unit of work that runs the same
way on every runtime.

`WorkflowEngine` is that primitive. A user authors one `WorkflowDefinition`
and chooses one of two engines:

| Engine | Where it runs | Persistence | Use it when |
| --- | --- | --- | --- |
| `LocalWorkflowEngine` | Node, Bun, Edge, browser | Any `KvBackend` (memory / fs / Redis / CF KV / Durable Object) | You want a portable runtime, no Cloudflare lock-in, full control over the host process. |
| `CloudflareWorkflowEngine` | Cloudflare Workers | Native CF Workflows storage (mirrored to KvBackend if you want unified observability) | You want the platform to handle hibernation, replay, retries, and 1-year sleeps for free. |

Both engines satisfy the **same four contracts**, every time:

1. **Observable** — typed event stream + persisted record at every step.
2. **Terminable** — `run.cancel()` honoured at every yield point.
3. **Resumable** — `engine.resume(runId)` picks up from the last completed step.
4. **Clear errors** — `WorkflowError` carries `code`, `runId`, `stepId`, `attempts`, `cause`.

## Quick start

```ts
import {
  LocalWorkflowEngine,
  KvWorkflowStateStore,
  MemoryKvBackend,
  ToolRegistry,
  type WorkflowDefinition,
} from "@agentkit-js/core";

const tools = new ToolRegistry();
tools.register({ /* echo, fetch, summarise, … */ });

const engine = new LocalWorkflowEngine({ tools });

const def: WorkflowDefinition = {
  id: "research",
  steps: [
    { id: "fetch", toolName: "fetch_pages", args: { urls: [...] }, dependsOn: [],
      // Cap concurrent network calls across this run AND any other run sharing
      // the same engine pool: only configure() what you actually want gated.
      resourceClaims: [{ key: "net", weight: 1 }] },
    { id: "summarise", toolName: "summarise",
      args: { docs: "$fetch" }, dependsOn: ["fetch"],
      retries: { limit: 3, backoff: "exponential" },
      timeoutMs: 30_000 },
    { id: "review", toolName: "review",
      args: { draft: "$summarise" }, dependsOn: ["summarise"] },
  ],
};

const run = await engine.start(def, { params: { topic: "agent loops" } });

// 1. OBSERVE
for await (const ev of run.events()) {
  console.log(ev);
  // → { type: "run_start", runId }
  //   { type: "step_start", stepId: "fetch", attempt: 1 }
  //   { type: "step_complete", stepId: "fetch", result: [...] }
  //   { type: "step_resource_wait", stepId: "summarise", claims: [...] }
  //   { type: "step_complete", ... }
  //   { type: "run_complete", output: { review: "…" } }
}

// 2. TERMINATE
run.cancel("user-stop");      // cooperative; in-flight tools see signal.aborted

// 3. RESUME (after a process crash, the same store sees completed steps and skips them)
const sameRun = await engine.resume(run.runId);

// 4. CLEAR ERRORS
const final = await run.wait();
if (final.status === "failed") {
  // final.error is the JSON-serialised WorkflowError: { code, runId, stepId, attempts, cause }
}
```

## Portability — same definition, two engines

Switching from local to Cloudflare requires **zero changes** to your
`WorkflowDefinition`. The CF adapter translates each step into the appropriate
`step.do` / `step.sleep` / `step.waitForEvent` call inside a
`WorkflowEntrypoint.run()` body.

```ts
// Cloudflare side — one-line entrypoint:
import { runWorkflowEntrypoint } from "@agentkit-js/cloudflare-worker";

export class ResearchWf extends WorkflowEntrypoint<Env, Params> {
  async run(event, step) {
    return runWorkflowEntrypoint(event, step, definition, {
      resolveTool: ({ step: s, args }) => env.TOOLS.call(s.toolName, args),
      store: new KvWorkflowStateStore(new CloudflareKvBackend(env.WF_STATE)),
    });
  }
}

// Application side — drives the workflow exactly like the local engine:
const engine = new CloudflareWorkflowEngine({
  binding: env.RESEARCH_WF,
  store:   new KvWorkflowStateStore(new CloudflareKvBackend(env.WF_STATE)),
});
const run = await engine.start(definition, { params });
for await (const ev of run.events()) console.log(ev); // same event types
```

The shared `WorkflowStateStore` means external observers (a status dashboard,
Slack notifier, audit log) hit the same KV records regardless of which engine
produced them.

## Resource semantics — the user's mental model

> *"If steps are serial, there is no resource contention to worry about."*

That's exactly how the engine behaves. `ResourcePool` defaults to capacity =
`Infinity`. Acquire takes the fast path whenever there's free capacity, so
sequential chains pay zero overhead even if every step claims the same key:

```ts
const pool = new InMemoryResourcePool();
pool.configure("openai", { capacity: 5 });   // cap concurrent OpenAI calls

// Serial chain — runs in 3 × stepTime, no waiters.
[ "a", "b", "c" ].forEach((id, i) => steps.push({
  id, toolName: "complete", args: {...},
  dependsOn: i === 0 ? [] : [steps[i-1].id],
  resourceClaims: [{ key: "openai" }],
}));

// Parallel siblings — capped at 5; sixth blocks until one releases.
for (let i = 0; i < 10; i++) steps.push({
  id: `parallel-${i}`, toolName: "complete", args: {...},
  dependsOn: [], resourceClaims: [{ key: "openai" }],
});
```

You only configure pools for resources that genuinely have a global ceiling
(GPU slots, API quota, sandbox processes). Everything else stays unbounded
and zero-cost.

## Persistence and crash-resume

Every step transition is written to the `WorkflowStateStore` *before* the next
step runs. The store is keyed by `runId`, so a fresh process can call
`engine.resume(runId)` and the engine will:

1. Reload the run record + definition + every step record.
2. Replay completed steps' results into a working set (no re-execution).
3. Treat any step left in `running` status (the previous process crashed
   mid-execution) as not-yet-attempted — re-running from attempt 1 if the step
   is `idempotent: true` (the default), or failing fast otherwise.
4. Continue execution from the first not-yet-completed step.

The persistence layer is a thin shell over `KvBackend`, so:

| `KvBackend` | Where it lives | Use for |
| --- | --- | --- |
| `MemoryKvBackend` | RAM only | Tests, single-process throw-away runs |
| FS (host-supplied) | Local filesystem | Crash-resume on a single machine |
| `RedisKvBackend` | Redis | Multi-worker fleets, fan-out coordination |
| `CloudflareKvBackend` | Cloudflare Workers KV | Workers / Pages with eventual consistency |
| `DurableObjectKvBackend` | Cloudflare Durable Object storage | Workers with strong consistency |

## Cancellation — every yield point honoured

A workflow run is cancellable at every async boundary:

- Between waves (`signal.aborted` checked at the top of each loop iteration).
- Inside `ResourcePool.acquire` (waiters reject on signal abort).
- Inside `ToolRegistry.call` (signal forwarded so `fetch` and friends bail).
- Inside retry-backoff sleeps and deferred-step polling.

`run.cancel(reason)` runs synchronously; the run reaches `cancelled` status
within one wave iteration. Cancelled runs are explicitly **resumable** — the
operator may later choose to continue from the same checkpoint. (`failed`
runs are terminal: re-creation requires a new `runId`.)

## Errors — code-first, post-mortem-friendly

Every failure surfaces as a `WorkflowError`:

```ts
class WorkflowError extends Error {
  code: WorkflowErrorCode;       // "step_failed" | "step_timeout" | "deadlock" | "cancelled" | …
  runId?: string;
  stepId?: string;
  attempts?: number;
  cause?: unknown;               // original error preserved
  toJSON(): { … };               // round-trips through KV / D1 unchanged
}
```

The persisted step record stores `error: describeError(err)` — a JSON-safe
serialisation including the cause chain. You can recover any failure
post-mortem from KV alone.

## Step types

| `toolName` | Semantics |
| --- | --- |
| Any registered tool | Normal tool call. Resolves `$<refId>` placeholders in `args` from prior step results before dispatch. |
| `$sleep` | Engine sleeps for `args.ms` and persists `wakeAt`. Resumable across crashes — the engine recomputes "is wakeAt past?" on resume. |
| `$waitForEvent` | Engine blocks until `engine.sendEvent(runId, type, payload)` is called. Stored in the same KV namespace; resume picks up undelivered events. |

## What we deliberately do *not* do

- **Cross-process concurrency limits** in the shipped `InMemoryResourcePool`.
  The interface allows future Redis / Durable Object backends; the in-memory
  implementation covers >80% of users (single-worker / single-CLI). Configure
  `pool.configure(...)` per-process; if you need fleet-wide caps, swap the
  backend.
- **Workflow DSLs** (YAML, BPMN, etc.). The DAG *is* the DSL, expressed in
  TypeScript with full IDE support and zero parser overhead.
- **CPU/GPU/RAM modelling**. `resourceClaims` are advisory weights; the engine
  doesn't sample OS counters. If you need that, build a custom `ResourcePool`
  that gates `acquire()` on a probe.

## Tests

44 unit + integration tests in `packages/core/src/workflow/`, 6 in
`packages/cloudflare-worker/src/CloudflareWorkflowEngine.test.ts`. Coverage
includes:

- Decomposition (serial chain, parallel siblings).
- Resource awareness (the user's *"serial doesn't compete"* claim is a
  dedicated test that fails the build if violated).
- Persistence + crash-resume across two engine instances sharing one store.
- Retry with exponential backoff; failure exhaustion path.
- `$sleep` and `$waitForEvent`, including the event-arrives-before-subscription
  path.
- Cancellation status transitions.
- Definition validation (duplicate ids, unknown deps, cycles).
- Cross-backend store parity (`MemoryKvBackend` and a filesystem KV both pass
  the same test suite).

Run them with `npm test --workspace @agentkit-js/core` and
`npm test --workspace @agentkit-js/cloudflare-worker`.
