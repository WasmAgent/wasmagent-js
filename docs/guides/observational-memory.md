# Observational Memory

> **A1** — continuous-observation alternative to one-shot
> `MessageAssembler.compact()`. A cheap "observer" model compresses
> long histories into ranked observation paragraphs in the background;
> the main agent keeps running on its expensive model while context
> stays bounded and prompt-cache-friendly.

## What it gives you

- **5–40× compression** comparable to Mastra's Observational Memory
  (LongMemEval 94.87% reference; we don't claim a number — we expose the
  primitive and ship a benchmark you can run).
- **Cheap observer + expensive agent** — the observer runs on a small
  model (Haiku, Doubao, DeepSeek). The agent keeps running on whichever
  model you set. agentkit's multi-model layer makes this a one-liner.
- **Prompt-cache aware** — compressed observations land at the front of
  the assembler so the prefix stays byte-stable across subsequent agent
  calls. This is the angle vendors with no `cache_control` awareness
  cannot hit.
- **Asynchronous + non-blocking** — `noteStep()` schedules a pass and
  returns immediately. The agent never waits for compression.
- **Persistent** — when a `KvBackend` is bound, observations are stored
  under `obs:<sessionId>:<seqId>` and survive a worker recycle.

## Quick start

```ts
import {
  MessageAssembler,
  ObservationalMemory,
  MapKvBackend,
} from "@wasmagent/core";

const assembler = new MessageAssembler({
  systemPrompt,
  toolsSchema,
  chunkSizeSteps: 5,
  systemPrefixTtl: "1h",
});

const memory = new ObservationalMemory({
  assembler,
  model: agentModel,           // Sonnet / Opus
  observerModel: cheapModel,   // Haiku / Doubao
  sessionId: req.sessionId,
  kv: kvBackend,               // optional; falls back to in-memory
  tokenThreshold: 6000,
  keepRecentSteps: 5,
});

for await (const event of agent.run(task, traceId)) {
  // …handle events…
  if (event.event === "step_end") memory.noteStep();
}
await memory.flush();           // wait for any in-flight observation
const observations = await memory.list();
```

## Observation shape

```ts
interface Observation {
  seqId: number;                    // monotonic id within a session
  createdAtMs: number;
  text: string;                     // one-paragraph summary
  priority: "high" | "medium" | "low";
  coversSteps: { from: number; to: number };
}
```

The observer is asked to produce JSON of shape
`{ priority, text }`. If the model ignores the contract — which they do
sometimes, especially the smaller ones — the parser falls through to a
`"low"` priority observation containing the raw text. Robustness over
strictness.

## When to use this vs `compact()`

- **Use `compact()`** when you want a single one-shot summary at a known
  point (eg right before a long-running step, or on an explicit user
  command). It blocks until done.
- **Use `ObservationalMemory`** when the conversation might run for a
  while and you want continuous compression in the background. Pair it
  with an automatic trigger like `noteStep()` after every agent step
  and forget about it.

The two are not exclusive — you can run the observer continuously AND
issue an explicit `compact()` before a sensitive operation.

## Why a separate class instead of bolting it onto MessageAssembler?

`MessageAssembler` is the cache-friendly prefix builder. Compression is a
policy choice (which observer model? when to trigger? where to persist?)
that not every consumer wants. Splitting them keeps the assembler small
and lets users opt into observation as a separate object when they need
it.

## Reference

- `packages/core/src/memory/ObservationalMemory.ts`
- `packages/core/src/memory/ObservationalMemory.test.ts` — 7 unit tests
  cover threshold gating, observer override, error capture, KV mirror,
  sliding `coversSteps`, and concurrent-trigger no-op behaviour.
- See also: [memory-patterns.md](./memory-patterns.md)
