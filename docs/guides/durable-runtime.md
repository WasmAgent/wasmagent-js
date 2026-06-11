# Durable runtime — checkpoints, SSE resume, HITL

This guide covers the three primitives that turn a stateless agent loop into
a true runtime: durable checkpoints (A1), Last-Event-ID SSE resume (A2), and
human-in-the-loop suspend/resume (A3). All three share the same canonical
{@link KvBackend} contract — pick one backend (Cloudflare KV, Durable Objects,
Redis, in-memory) and every primitive uses it.

## TL;DR

```ts
import {
  CheckpointableRun,
  EventLog,
  KvCheckpointer,
  resumeFromHuman,
  applyHumanResponse,
  restoreFromSnapshot,
} from "@agentkit-js/core";
import { CloudflareKvBackend } from "@agentkit-js/cloudflare-worker";

// One adapter, three uses.
const kv = new CloudflareKvBackend(env.MY_KV);

// 1) Durable checkpoints
const checkpointer = new KvCheckpointer(kv);
const run = new CheckpointableRun({ checkpointer }, agent.assembler);
for await (const ev of run.run(agent.run(task), task, traceId)) { ... }

// 2) SSE resume
const log = new EventLog(kv);
for await (const { eventId, event } of log.tap(agent.run(task), traceId)) {
  // emit `id: ${eventId}\nevent: ${event.event}\ndata: ${...}\n\n` over SSE
}

// 3) HITL resume (separate process, hours later)
const ok = await resumeFromHuman(checkpointer, traceId, promptId, response);
```

## A1 — Durable checkpoints

Wrap any agent stream with `CheckpointableRun` to checkpoint after every step.
On crash, load the snapshot and continue from where it stopped.

### Backends

| Backend | Use when |
|---|---|
| `InMemoryCheckpointer` | Tests, local dev |
| `KvCheckpointer(new CloudflareKvBackend(env.KV))` | Workers — eventual consistency, multi-region |
| `KvCheckpointer(new DurableObjectKvBackend(state.storage))` | Workers — strong consistency, single instance per run |
| `KvCheckpointer(new RedisKvBackend(client))` | Node/Bun with Redis |
| `KvCheckpointer(new RedisRestKvBackend({url, token}))` | Edge with Upstash REST |

### Resume after restart

```ts
const snap = await checkpointer.load(traceId);
if (snap) {
  restoreFromSnapshot(snap, agent.assembler);
  // Continue with the same traceId so future events line up.
  for await (const ev of run.run(agent.run(snap.task, traceId), snap.task, traceId)) { ... }
}
```

The `final_answer` event triggers `checkpointer.delete(traceId)` automatically,
so completed runs don't accumulate.

## A2 — SSE Last-Event-ID resume

When a long stream gets cut (network blip, worker recycle), the client
reconnects with `Last-Event-ID`. The server replays from the persisted log
without gaps or duplicates.

### Server (Cloudflare Worker)

The reference worker (`packages/cloudflare-worker/src/index.ts`) does this for
you when you bind `AGENTKIT_EVENT_LOG`:

```toml
# wrangler.toml
[[kv_namespaces]]
binding = "AGENTKIT_EVENT_LOG"
id = "..."
```

Each response includes an `X-Agentkit-Trace-Id` header. The client should
keep it and the highest seen `id:` line.

### Client (`@agentkit-js/react`)

```tsx
const { messages, run } = useAgentRun("/run", {
  resume: { maxAttempts: 3, delayMs: 1000 },
});
```

The hook now sends `Last-Event-ID` automatically on retry. With `maxAttempts:
0` (default) the legacy single-attempt behaviour is preserved.

### Manual replay

```ts
const log = new EventLog(kv);
for await (const { eventId, event } of log.replay(traceId, lastSeenId)) {
  // emit
}
// Then continue tapping live events:
const startSeq = await log.nextSeq(traceId);
for await (const { eventId, event } of log.tap(agent.run(task), traceId, { startSeq })) {
  // emit
}
```

## A3 — Human-in-the-loop suspend / resume

When the agent emits `await_human_input`, `CheckpointableRun` saves a snapshot
with `pendingHumanInput` and exits the iterator. The worker can then exit;
the run survives in KV until a human responds.

### The pause path

The agent (or any tool) yields:

```ts
yield {
  channel: "status",
  event: "await_human_input",
  data: {
    promptId: "approve-pr",
    prompt: "About to push PR #42 — approve?",
    step: currentStep,
  },
} as AgentEvent;
```

`CheckpointableRun.run()` catches it, saves, and returns. The HTTP response
ends; the worker is free.

### The resume path

Hours or days later the operator hits `POST /resume` (built into the
reference Cloudflare worker):

```bash
curl -X POST https://your-worker/resume \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"traceId":"...","promptId":"approve-pr","response":"approve"}'
```

That call writes the response into the snapshot. The next time something
loads the snapshot, the agent picks up via:

```ts
const snap = await checkpointer.load(traceId);
restoreFromSnapshot(snap, agent.assembler);
applyHumanResponse(snap, agent.assembler); // injects user_message into history
for await (const ev of run.run(agent.run(snap.task, traceId), snap.task, traceId)) { ... }
```

`applyHumanResponse` adds the response as a user_message step so the model
sees it in the next round.

## Cross-cutting gates

The plan requires:
- All three primitives go through the **single** `KvBackend` contract — no
  parallel KV abstractions. The exported `KvBackend` (with optional
  `list?(prefix)`) is the only contract; legacy `StructuredKvBackend`
  is a deprecated alias kept for one major version.
- HITL gates risky tool calls. Mark a tool with `needsApproval: true` and
  the agent will emit `await_human_input` before invoking it.
- Every PR shipping a new persistence backend must include a kill-and-resume
  integration test (see `packages/core/src/checkpoint/redis.test.ts` and
  `packages/cloudflare-worker/src/kvAdapters.test.ts` for the shape).

## What's verified today

| Claim | Test | Notes |
|---|---|---|
| Snapshot survives across two adapter instances (Redis) | `packages/core/src/checkpoint/redis.test.ts` → "kill and resume" | Two REST clients sharing one map; second loads what the first saved. |
| Snapshot survives across two adapter instances (CF KV) | `packages/cloudflare-worker/src/kvAdapters.test.ts` → "snapshot survives across adapter instances" | Same but with `CloudflareKvBackend` against a fake `KVNamespace`. |
| Snapshot survives across two adapter instances (DO storage) | `packages/cloudflare-worker/src/kvAdapters.test.ts` → "DurableObjectKvBackend: snapshot survives" | Strong-consistency variant. |
| `Last-Event-ID` replay is gap- and duplicate-free | `packages/core/src/streaming/EventLog.test.ts` → "the kill-and-replay round trip is gap- and duplicate-free" | Combined live + replay sequence is monotonic + unique. |
| HITL pause / resume across three processes | `packages/core/src/checkpoint/hitl.test.ts` → "resumeFromHuman in a fresh process marks the snapshot ready" | Process 1 pauses → drops; process 2 submits response; process 3 reads + continues. |
| Same contract holds in bscode after `createApp()` recycle | `bscode/apps/worker/src/app.test.ts` → "snapshot saved via one createApp() instance is readable by a fresh instance" | Production-shape worker, one shared `MemKvStore`. |
